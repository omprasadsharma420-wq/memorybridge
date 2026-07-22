import { dialog, ipcMain } from 'electron'
import {
  apiKeyInputSchema,
  chatOnlyInputSchema,
  createChatInputSchema,
  createProjectInputSchema,
  memoryActionInputSchema,
  memoryOnlyInputSchema,
  messageRangeInputSchema,
  retryMessageInputSchema,
  searchInputSchema,
  sendMessageInputSchema,
  settingsInputSchema,
  importTokenInputSchema,
  updateChatInputSchema,
  updateProjectInputSchema
} from '../shared/contracts'
import { AppService } from './app-service'

export function registerIpc(service: AppService): void {
  ipcMain.handle('app:bootstrap', () => service.bootstrap())
  ipcMain.handle('vault:create', async () => {
    const selection = await dialog.showOpenDialog({
      title: 'Choose a folder for your MemoryBridge vault',
      properties: ['openDirectory', 'createDirectory']
    })
    if (selection.canceled || !selection.filePaths[0]) return service.bootstrap()
    return service.createVault(selection.filePaths[0])
  })
  ipcMain.handle('vault:open', async () => {
    const selection = await dialog.showOpenDialog({
      title: 'Locate an existing MemoryBridge vault',
      properties: ['openDirectory']
    })
    if (selection.canceled || !selection.filePaths[0]) return service.bootstrap()
    return service.openVault(selection.filePaths[0])
  })
  ipcMain.handle('project:create', (_event, input: unknown) =>
    service.createProject(createProjectInputSchema.parse(input))
  )
  ipcMain.handle('project:update', (_event, input: unknown) =>
    service.updateProject(updateProjectInputSchema.parse(input))
  )
  ipcMain.handle('chat:create', (_event, input: unknown) =>
    service.createChat(createChatInputSchema.parse(input))
  )
  ipcMain.handle('chat:update', (_event, input: unknown) =>
    service.updateChat(updateChatInputSchema.parse(input))
  )
  ipcMain.handle('chat:list', () => service.listChats())
  ipcMain.handle('chat:messages', (_event, input: unknown) => {
    const { chatId } = chatOnlyInputSchema.parse(input)
    return service.getMessages(chatId)
  })
  ipcMain.handle('chat:message-range', (_event, input: unknown) => {
    const parsed = messageRangeInputSchema.parse(input)
    return service.getMessageRange(parsed.chatId, parsed.afterSequence, parsed.limit)
  })
  ipcMain.handle('chat:send', (_event, input: unknown) =>
    service.sendMessage(sendMessageInputSchema.parse(input))
  )
  ipcMain.handle('chat:retry', (_event, input: unknown) =>
    service.retryMessage(retryMessageInputSchema.parse(input))
  )
  ipcMain.handle('chat:stop', (_event, input: unknown) => {
    const { chatId } = chatOnlyInputSchema.parse(input)
    service.stopGeneration(chatId)
  })
  ipcMain.handle('memory:list', (_event, input: unknown) => {
    const parsed = chatOnlyInputSchema.partial().parse(input ?? {})
    return service.listMemories(parsed.chatId)
  })
  ipcMain.handle('memory:action', (_event, input: unknown) =>
    service.memoryAction(memoryActionInputSchema.parse(input))
  )
  ipcMain.handle('search:run', (_event, input: unknown) =>
    service.search(searchInputSchema.parse(input))
  )
  ipcMain.handle('settings:update', (_event, input: unknown) =>
    service.updateSettings(settingsInputSchema.parse(input))
  )
  ipcMain.handle('credentials:save', (_event, input: unknown) => {
    const { apiKey } = apiKeyInputSchema.parse(input)
    return service.saveApiKey(apiKey)
  })
  ipcMain.handle('credentials:clear', () => service.clearApiKey())
  ipcMain.handle('provider:test', () => service.testConnection())
  ipcMain.handle('index:rebuild', () => service.rebuildIndex())
  ipcMain.handle('extraction:rerun', (_event, input: unknown) => {
    const { chatId } = chatOnlyInputSchema.parse(input)
    return service.rerunExtraction(chatId)
  })
  ipcMain.handle('processing:chat', (_event, input: unknown) => {
    const { chatId } = chatOnlyInputSchema.parse(input)
    return service.reprocessChat(chatId)
  })
  ipcMain.handle('processing:cancel', (_event, input: unknown) => {
    const { chatId } = chatOnlyInputSchema.parse(input)
    service.cancelReprocessing(chatId)
  })
  ipcMain.handle('connector:list', () => service.listConnectors())
  ipcMain.handle('import:choose', () => service.chooseImport())
  ipcMain.handle('import:execute', (_event, input: unknown) => {
    const { token } = importTokenInputSchema.parse(input)
    return service.executeImport(token)
  })
  ipcMain.handle('import:scan-inbox', () => service.scanImportInbox())
  ipcMain.handle('topic:list', (_event, input: unknown) => {
    const { chatId } = chatOnlyInputSchema.partial().parse(input ?? {})
    return service.listTopics(chatId)
  })
  ipcMain.handle('evidence:list', (_event, input: unknown) => {
    const { memoryId } = memoryOnlyInputSchema.partial().parse(input ?? {})
    return service.listEvidence(memoryId)
  })
  ipcMain.handle('provider-memory:list', () => service.listProviderMemories())
  ipcMain.handle('mcp:configuration', () => service.getMcpConfiguration())
  ipcMain.handle('diagnostics:export', () => service.exportDiagnostics())
}

export function unregisterIpc(): void {
  const channels = [
    'app:bootstrap',
    'vault:create',
    'vault:open',
    'project:create',
    'project:update',
    'chat:create',
    'chat:update',
    'chat:list',
    'chat:messages',
    'chat:message-range',
    'chat:send',
    'chat:retry',
    'chat:stop',
    'memory:list',
    'memory:action',
    'search:run',
    'settings:update',
    'credentials:save',
    'credentials:clear',
    'provider:test',
    'index:rebuild',
    'extraction:rerun',
    'processing:chat',
    'processing:cancel',
    'connector:list',
    'import:choose',
    'import:execute',
    'import:scan-inbox',
    'topic:list',
    'evidence:list',
    'provider-memory:list',
    'mcp:configuration',
    'diagnostics:export'
  ]
  channels.forEach((channel) => ipcMain.removeHandler(channel))
}
