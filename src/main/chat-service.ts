import { createId } from '../shared/ids'
import type {
  AppSettings,
  Chat,
  Memory,
  Message,
  MessageStatus
} from '../shared/schemas'
import type { ChatTurnResult, RetrievedContextItem } from '../shared/contracts'
import { deterministicTitle } from '../shared/text'
import { safeErrorCategory } from '../shared/security'
import { AppError } from './errors'
import { MemoryEngine } from './memory/memory-engine'
import type { AIProvider, ProviderMessage } from './providers/provider'
import { RetrievalEngine } from './retrieval/retrieval-engine'
import { VaultRepository } from './storage/repository'

type StreamListener = (message: Message) => void

export class ChatService {
  private readonly controllers = new Map<string, AbortController>()

  constructor(
    private readonly repository: VaultRepository,
    private readonly memoryEngine: MemoryEngine,
    private readonly retrieval: RetrievalEngine,
    private readonly getSettings: () => AppSettings,
    private readonly getProvider: () => Promise<AIProvider>,
    private readonly onStream: StreamListener = () => undefined
  ) {}

  async sendMessage(chatId: string, content: string): Promise<ChatTurnResult> {
    const settings = this.getSettings()
    const chat = await this.repository.getChat(chatId)
    const now = new Date().toISOString()
    const userMessage: Message = {
      message_id: createId('msg'),
      chat_id: chatId,
      role: 'user',
      content,
      created_at: now,
      updated_at: now,
      provider: settings.provider,
      model: settings.chatModel,
      status: 'complete',
      sequence: await this.repository.nextSequence(chatId),
      retrieved_memory_ids: []
    }

    await this.repository.appendMessage(userMessage)
    let activeChat = chat
    const previousMessages = await this.repository.readMessages(chatId)
    if (chat.title === 'New chat' && previousMessages.filter((message) => message.role === 'user').length === 1) {
      activeChat = await this.repository.updateChat(chatId, { title: deterministicTitle(content) })
    }
    return this.generateAssistant(activeChat, userMessage)
  }

  async retryMessage(chatId: string, userMessageId: string): Promise<ChatTurnResult> {
    const chat = await this.repository.getChat(chatId)
    const userMessage = (await this.repository.readMessages(chatId)).find(
      (message) => message.message_id === userMessageId && message.role === 'user'
    )
    if (!userMessage) throw new AppError('MESSAGE_NOT_FOUND', 'The original user message could not be found.')
    return this.generateAssistant(chat, userMessage)
  }

  stop(chatId: string): void {
    this.controllers.get(chatId)?.abort()
  }

  private async generateAssistant(chat: Chat, userMessage: Message): Promise<ChatTurnResult> {
    if (this.controllers.has(chat.chat_id)) {
      throw new AppError('CHAT_BUSY', 'This chat already has a response in progress.', true)
    }
    const settings = this.getSettings()
    const provider = await this.getProvider()
    const retrievedContext = await this.retrieval.retrieve(
      userMessage.content,
      chat.project_id,
      settings,
      provider
    )
    const now = new Date().toISOString()
    let assistantMessage: Message = {
      message_id: createId('msg'),
      chat_id: chat.chat_id,
      role: 'assistant',
      content: '',
      created_at: now,
      updated_at: now,
      provider: provider.id,
      model: settings.chatModel,
      status: 'pending',
      sequence: await this.repository.nextSequence(chat.chat_id),
      retrieved_memory_ids: retrievedContext.map((item) => item.memoryId)
    }
    await this.repository.appendMessage(assistantMessage)
    this.onStream(assistantMessage)

    const controller = new AbortController()
    this.controllers.set(chat.chat_id, controller)
    let lastCheckpointLength = 0
    let lastCheckpointAt = Date.now()
    let terminalStatus: MessageStatus = 'complete'
    let errorCategory: string | undefined
    try {
      const requestMessages = await this.buildProviderMessages(
        chat.chat_id,
        userMessage.message_id,
        retrievedContext
      )
      assistantMessage = { ...assistantMessage, status: 'streaming', updated_at: new Date().toISOString() }
      await this.repository.appendMessage(assistantMessage)
      for await (const chunk of provider.streamChat({
        model: settings.chatModel,
        messages: requestMessages,
        signal: controller.signal
      })) {
        assistantMessage = {
          ...assistantMessage,
          content: assistantMessage.content + chunk,
          status: 'streaming',
          updated_at: new Date().toISOString()
        }
        this.onStream(assistantMessage)
        if (
          lastCheckpointLength === 0 ||
          assistantMessage.content.length - lastCheckpointLength >= 192 ||
          Date.now() - lastCheckpointAt >= 500
        ) {
          await this.repository.appendMessage(assistantMessage)
          lastCheckpointLength = assistantMessage.content.length
          lastCheckpointAt = Date.now()
        }
      }
    } catch (error) {
      terminalStatus = classifyTerminalStatus(error, controller.signal.aborted)
      errorCategory = safeErrorCategory(error)
    } finally {
      this.controllers.delete(chat.chat_id)
    }

    assistantMessage = {
      ...assistantMessage,
      status: terminalStatus,
      updated_at: new Date().toISOString(),
      ...(errorCategory ? { error_category: errorCategory } : {})
    }
    await this.repository.appendMessage(assistantMessage)
    this.onStream(assistantMessage)

    let memories: Memory[] = []
    if (assistantMessage.status === 'complete') {
      memories = await this.memoryEngine.extractTurn(chat.chat_id, provider, settings)
    }
    return { userMessage, assistantMessage, retrievedContext, memories }
  }

  private async buildProviderMessages(
    chatId: string,
    throughUserMessageId: string,
    context: RetrievedContextItem[]
  ): Promise<ProviderMessage[]> {
    const history = await this.repository.readMessages(chatId)
    const throughIndex = history.findIndex((message) => message.message_id === throughUserMessageId)
    const bounded = history
      .slice(Math.max(0, throughIndex - 19), throughIndex + 1)
      .filter((message) => message.status === 'complete' && message.role !== 'system')
      .map((message) => ({ role: message.role as 'user' | 'assistant', content: message.content }))
    if (context.length === 0) return bounded
    const contextText = context
      .map(
        (item, index) =>
          `[Memory ${index + 1}; ${item.memoryType}; ${item.state}; source ${item.sourceChatTitle}/${item.sourceMessageIds.join(',')}]: ${item.statement}`
      )
      .join('\n')
    return [
      {
        role: 'system',
        content: `Use the following cited MemoryBridge context only when relevant. Do not treat rejected or historical options as current.\n${contextText}`
      },
      ...bounded
    ]
  }
}

function classifyTerminalStatus(error: unknown, aborted: boolean): MessageStatus {
  if (aborted || (error instanceof DOMException && error.name === 'AbortError')) return 'cancelled'
  if (error instanceof Error && /interrupt/i.test(error.message)) return 'interrupted'
  return 'failed'
}
