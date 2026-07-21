import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type {
  BootstrapState,
  RetrievedContextItem,
  SearchResult,
  VaultStatus
} from '../shared/contracts'
import type { AppSettings, Chat, Memory, Message, Project } from '../shared/schemas'

type Panel = 'memory' | 'search' | 'settings'

export function App(): React.JSX.Element {
  const [state, setState] = useState<BootstrapState | null>(null)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null | 'all'>('all')
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [memories, setMemories] = useState<Memory[]>([])
  const [panel, setPanel] = useState<Panel>('memory')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [contextUsed, setContextUsed] = useState<RetrievedContextItem[]>([])
  const [contextExpanded, setContextExpanded] = useState(false)
  const [sourceMessageId, setSourceMessageId] = useState<string | null>(null)
  const [projectDialogOpen, setProjectDialogOpen] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const messagesEnd = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    const next = await window.memoryBridge.bootstrap()
    setState(next)
    if (next.vault.connected) setMemories(await window.memoryBridge.listMemories())
  }, [])

  useEffect(() => {
    void refresh().catch((error: unknown) => setNotice(errorMessage(error)))
    const offStream = window.memoryBridge.onStream((message) => {
      setMessages((current) => upsertMessage(current, message))
    })
    const offVault = window.memoryBridge.onVaultStatus((vault) => {
      setState((current) => (current ? { ...current, vault } : current))
    })
    return () => {
      offStream()
      offVault()
    }
  }, [refresh])

  useEffect(() => {
    if (!selectedChatId) {
      setMessages([])
      return
    }
    void window.memoryBridge
      .getMessages(selectedChatId)
      .then(setMessages)
      .catch((error: unknown) => setNotice(errorMessage(error)))
  }, [selectedChatId])

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    if (!sourceMessageId) return
    document.getElementById(`message-${sourceMessageId}`)?.scrollIntoView({
      behavior: 'smooth',
      block: 'center'
    })
  }, [messages, sourceMessageId])

  if (!state) return <LoadingScreen />
  if (!state.vault.connected && !state.vault.path) {
    return <VaultWelcome onState={setState} onError={setNotice} notice={notice} />
  }

  const selectedChat = state.chats.find((chat) => chat.chat_id === selectedChatId) ?? null
  const filteredChats = state.chats.filter((chat) => {
    if (selectedProjectId === 'all') return true
    return chat.project_id === selectedProjectId
  })

  const selectChat = (chatId: string, messageId?: string): void => {
    setSelectedChatId(chatId)
    setSourceMessageId(messageId ?? null)
    setContextUsed([])
    setContextExpanded(false)
  }

  const createChat = async (): Promise<void> => {
    try {
      const projectId = selectedProjectId === 'all' ? null : selectedProjectId
      const chat = await window.memoryBridge.createChat({ projectId })
      setState((current) => (current ? { ...current, chats: [chat, ...current.chats] } : current))
      selectChat(chat.chat_id)
    } catch (error) {
      setNotice(errorMessage(error))
    }
  }

  const createProject = async (nameValue: string): Promise<void> => {
    const name = nameValue.trim()
    if (!name) return
    try {
      const project = await window.memoryBridge.createProject({ name, description: '' })
      setState((current) =>
        current ? { ...current, projects: [...current.projects, project].sort(sortProjects) } : current
      )
      setSelectedProjectId(project.project_id)
      setProjectDialogOpen(false)
      setNewProjectName('')
    } catch (error) {
      setNotice(errorMessage(error))
    }
  }

  const send = async (content: string): Promise<void> => {
    if (!selectedChatId || !state.vault.connected) return
    setBusy(true)
    setNotice(null)
    try {
      const result = await window.memoryBridge.sendMessage({ chatId: selectedChatId, content })
      setMessages((current) =>
        upsertMessage(upsertMessage(current, result.userMessage), result.assistantMessage)
      )
      setContextUsed(result.retrievedContext)
      setMemories(await window.memoryBridge.listMemories())
      const chats = await window.memoryBridge.listChats()
      setState((current) => (current ? { ...current, chats } : current))
      if (result.assistantMessage.status !== 'complete') {
        setNotice(`Response ${result.assistantMessage.status}. Partial text was preserved.`)
      }
    } catch (error) {
      setNotice(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="app-shell">
      {!state.vault.connected && (
        <DisconnectedBanner vault={state.vault} onReconnect={async () => setState(await window.memoryBridge.chooseAndOpenVault())} />
      )}
      <Sidebar
        projects={state.projects}
        chats={filteredChats}
        selectedProjectId={selectedProjectId}
        selectedChatId={selectedChatId}
        vault={state.vault}
        onProject={setSelectedProjectId}
        onChat={selectChat}
        onClear={() => {
          setSelectedChatId(null)
          setSourceMessageId(null)
          setContextUsed([])
        }}
        onNewChat={() => void createChat()}
        onNewProject={() => setProjectDialogOpen(true)}
        onPanel={setPanel}
      />
      <main className="chat-area">
        {selectedChat ? (
          <>
            <ChatHeader
              key={selectedChat.chat_id}
              chat={selectedChat}
              projects={state.projects}
              onUpdated={(chat) => {
                setState((current) =>
                  current
                    ? { ...current, chats: current.chats.map((item) => (item.chat_id === chat.chat_id ? chat : item)) }
                    : current
                )
              }}
            />
            <div className="messages" aria-live="polite">
              {messages.length === 0 && <EmptyChat />}
              {messages.map((message) => (
                <MessageCard
                  key={message.message_id}
                  message={message}
                  retrievedCount={
                    message.retrieved_context_ids.length || message.retrieved_memory_ids.length
                  }
                  highlighted={message.message_id === sourceMessageId}
                  onOpenMemory={() => setPanel('memory')}
                  onRetry={
                    message.role === 'assistant' && ['failed', 'interrupted', 'cancelled'].includes(message.status)
                      ? async () => {
                          const index = messages.findIndex((item) => item.message_id === message.message_id)
                          const user = [...messages.slice(0, index)].reverse().find((item) => item.role === 'user')
                          if (!user) return
                          setBusy(true)
                          try {
                            const result = await window.memoryBridge.retryMessage({
                              chatId: selectedChat.chat_id,
                              userMessageId: user.message_id
                            })
                            setMessages((current) => upsertMessage(current, result.assistantMessage))
                            setMemories(await window.memoryBridge.listMemories())
                          } catch (error) {
                            setNotice(errorMessage(error))
                          } finally {
                            setBusy(false)
                          }
                        }
                      : undefined
                  }
                />
              ))}
              <div ref={messagesEnd} />
            </div>
            {contextUsed.length > 0 && (
              <div className="context-wrap">
                <button className="context-strip" onClick={() => setContextExpanded((value) => !value)}>
                  <span>Bridge context</span>
                  {contextUsed.length} cited context {contextUsed.length === 1 ? 'item' : 'items'} supplied
                </button>
                {contextExpanded && (
                  <div className="context-details">
                    {contextUsed.map((item) => (
                      <button
                        key={item.contextId}
                        onClick={() => selectChat(item.sourceChatId, item.sourceMessageIds[0])}
                      >
                        <span>{item.kind === 'memory' ? item.memoryType : 'transcript excerpt'}</span>
                        <b>{item.statement}</b>
                        <small>↗ {item.sourceChatTitle} · exact source</small>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <Composer
              disabled={!state.vault.connected}
              busy={busy}
              onSend={send}
              onStop={() => selectedChatId && window.memoryBridge.stopGeneration(selectedChatId)}
            />
          </>
        ) : (
          <NoChat onNew={() => void createChat()} disabled={!state.vault.connected} />
        )}
      </main>
      <Inspector
        panel={panel}
        setPanel={setPanel}
        state={state}
        memories={memories}
        selectedChatId={selectedChatId}
        selectedProjectId={selectedProjectId}
        onMemories={setMemories}
        onSelectChat={selectChat}
        onSettings={(settings) => setState((current) => (current ? { ...current, settings } : current))}
        onProjectUpdated={(project) =>
          setState((current) =>
            current
              ? {
                  ...current,
                  projects: current.projects.map((item) =>
                    item.project_id === project.project_id ? project : item
                  )
                }
              : current
          )
        }
        onBootstrap={setState}
        onNotice={setNotice}
      />
      {notice && (
        <div className="toast" role="status">
          {notice}
          <button onClick={() => setNotice(null)} aria-label="Dismiss">×</button>
        </div>
      )}
      {projectDialogOpen && (
        <div className="modal-backdrop" onMouseDown={() => setProjectDialogOpen(false)}>
          <form
            className="modal-card"
            onMouseDown={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault()
              void createProject(newProjectName)
            }}
          >
            <p className="eyebrow">NEW WORKSPACE</p>
            <h2>Create a project</h2>
            <p>Group related conversations and memories under one durable context.</p>
            <input
              data-testid="project-name"
              autoFocus
              value={newProjectName}
              onChange={(event) => setNewProjectName(event.target.value)}
              placeholder="Project name"
            />
            <div>
              <button type="button" className="secondary" onClick={() => setProjectDialogOpen(false)}>Cancel</button>
              <button data-testid="create-project" className="primary" type="submit" disabled={!newProjectName.trim()}>Create project</button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}

function LoadingScreen(): React.JSX.Element {
  return (
    <div className="loading-screen">
      <BrandMark />
      <p>Opening your bridge…</p>
    </div>
  )
}

function VaultWelcome({
  onState,
  onError,
  notice
}: {
  onState: (state: BootstrapState) => void
  onError: (message: string) => void
  notice: string | null
}): React.JSX.Element {
  const run = async (action: () => Promise<BootstrapState>): Promise<void> => {
    try {
      onState(await action())
    } catch (error) {
      onError(errorMessage(error))
    }
  }
  return (
    <div className="welcome">
      <div className="welcome-copy">
        <BrandMark large />
        <p className="eyebrow">YOUR CONTEXT, WITH ROOTS</p>
        <h1>Conversations that<br />remember where they came from.</h1>
        <p className="lede">
          Choose a folder you control. MemoryBridge keeps the original conversation, extracts durable
          decisions, and brings back only what matters—with exact sources.
        </p>
        <div className="welcome-actions">
          <button className="primary" data-testid="create-vault" onClick={() => void run(window.memoryBridge.chooseAndCreateVault)}>
            Create a new vault
          </button>
          <button className="secondary" onClick={() => void run(window.memoryBridge.chooseAndOpenVault)}>
            Open an existing vault
          </button>
        </div>
        <p className="privacy-note">No account. No telemetry. Mock mode works without an API key.</p>
        {notice && <p className="inline-error">{notice}</p>}
      </div>
      <div className="bridge-visual" aria-hidden="true">
        <span className="shore shore-a" />
        <span className="shore shore-b" />
        <span className="bridge-line one" />
        <span className="bridge-line two" />
        <span className="bridge-line three" />
        <div className="memory-chip chip-a">Decision <b>cited</b></div>
        <div className="memory-chip chip-b">Preference <b>active</b></div>
        <div className="memory-chip chip-c">Milestone <b>complete</b></div>
      </div>
    </div>
  )
}

function BrandMark({ large = false }: { large?: boolean }): React.JSX.Element {
  return (
    <div className={`brand ${large ? 'large' : ''}`}>
      <span className="brand-icon"><i /><i /><i /></span>
      <span>MemoryBridge</span>
    </div>
  )
}

function Sidebar(props: {
  projects: Project[]
  chats: Chat[]
  selectedProjectId: string | null | 'all'
  selectedChatId: string | null
  vault: VaultStatus
  onProject: (id: string | null | 'all') => void
  onChat: (id: string, messageId?: string) => void
  onClear: () => void
  onNewChat: () => void
  onNewProject: () => void
  onPanel: (panel: Panel) => void
}): React.JSX.Element {
  return (
    <aside className="sidebar">
      <BrandMark />
      <button className="new-chat" data-testid="new-chat" onClick={props.onNewChat} disabled={!props.vault.connected}>＋ New conversation</button>
      <nav className="project-nav">
        <div className="nav-label"><span>Workspaces</span><button onClick={props.onNewProject}>＋</button></div>
        <button className={props.selectedProjectId === 'all' ? 'active' : ''} onClick={() => props.onProject('all')}>
          <span>◫</span> All conversations
        </button>
        <button className={props.selectedProjectId === null ? 'active' : ''} onClick={() => props.onProject(null)}>
          <span>◇</span> Unassigned
        </button>
        {props.projects.map((project) => (
          <button key={project.project_id} className={props.selectedProjectId === project.project_id ? 'active' : ''} onClick={() => props.onProject(project.project_id)}>
            <span className="project-dot" /> {project.name}
          </button>
        ))}
      </nav>
      <div className="nav-label chat-label"><span>Recent</span>{props.selectedChatId && <button className="clear-chat" onClick={props.onClear}>Clear</button>}</div>
      <div className="chat-list">
        {props.chats.map((chat) => (
          <button key={chat.chat_id} className={props.selectedChatId === chat.chat_id ? 'active' : ''} onClick={() => props.onChat(chat.chat_id)}>
            <span className="chat-title">{chat.title}</span>
            <time>{relativeDate(chat.updated_at)}</time>
          </button>
        ))}
        {props.chats.length === 0 && <p className="empty-list">No conversations here yet.</p>}
      </div>
      <div className="sidebar-foot">
        <button onClick={() => props.onPanel('search')}>⌕ Search archive</button>
        <button onClick={() => props.onPanel('settings')}>⚙ Settings</button>
        <div className={`vault-pill ${props.vault.connected ? 'connected' : 'disconnected'}`}>
          <span />
          <div><b>{props.vault.connected ? 'Vault connected' : 'Vault offline'}</b><small>{formatBytes(props.vault.freeBytes)} free</small></div>
        </div>
      </div>
    </aside>
  )
}

function ChatHeader({ chat, projects, onUpdated }: { chat: Chat; projects: Project[]; onUpdated: (chat: Chat) => void }): React.JSX.Element {
  const [title, setTitle] = useState(chat.title)
  const saveTitle = async (): Promise<void> => {
    if (title.trim() && title.trim() !== chat.title) onUpdated(await window.memoryBridge.updateChat({ chatId: chat.chat_id, title: title.trim() }))
  }
  return (
    <header className="chat-header">
      <div>
        <input aria-label="Chat title" value={title} onChange={(event) => setTitle(event.target.value)} onBlur={() => void saveTitle()} onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()} />
        <p>Original transcript saved automatically</p>
      </div>
      <select aria-label="Assign project" value={chat.project_id ?? ''} onChange={async (event) => onUpdated(await window.memoryBridge.updateChat({ chatId: chat.chat_id, projectId: event.target.value || null }))}>
        <option value="">Unassigned</option>
        {projects.map((project) => <option key={project.project_id} value={project.project_id}>{project.name}</option>)}
      </select>
    </header>
  )
}

function MessageCard({ message, retrievedCount, highlighted, onOpenMemory, onRetry }: { message: Message; retrievedCount: number; highlighted: boolean; onOpenMemory: () => void; onRetry?: () => void }): React.JSX.Element {
  return (
    <article id={`message-${message.message_id}`} className={`message ${message.role} ${highlighted ? 'source-highlight' : ''}`} data-status={message.status}>
      <div className="avatar">{message.role === 'user' ? 'You' : 'MB'}</div>
      <div className="bubble">
        <div className="message-meta"><b>{message.role === 'user' ? 'You' : 'MemoryBridge'}</b><time>{formatTime(message.created_at)}</time></div>
        <p>{message.content || (message.status === 'pending' ? 'Preparing a response…' : '…')}</p>
        {message.role === 'assistant' && message.status === 'streaming' && <span className="stream-cursor" />}
        {retrievedCount > 0 && <button className="citation-button" onClick={onOpenMemory}>↗ Used {retrievedCount} cited context {retrievedCount === 1 ? 'item' : 'items'}</button>}
        {!['complete', 'streaming', 'pending'].includes(message.status) && (
          <div className="message-state"><span>{message.status}</span>{message.content && ' · partial response preserved'}{onRetry && <button onClick={onRetry}>Retry</button>}</div>
        )}
      </div>
    </article>
  )
}

function Composer({ disabled, busy, onSend, onStop }: { disabled: boolean; busy: boolean; onSend: (content: string) => Promise<void>; onStop: () => void }): React.JSX.Element {
  const [content, setContent] = useState('')
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const value = content.trim()
    if (!value || disabled || busy) return
    setContent('')
    void onSend(value)
  }
  return (
    <form className="composer" onSubmit={submit}>
      <textarea data-testid="composer" value={content} onChange={(event) => setContent(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} placeholder={disabled ? 'Reconnect your vault to continue' : 'Continue the conversation…'} disabled={disabled} />
      {busy ? <button type="button" className="stop" onClick={onStop}>■ Stop</button> : <button data-testid="send" className="send" type="submit" disabled={disabled || !content.trim()}>↑</button>}
      <small>Messages are saved to your vault before they are sent.</small>
    </form>
  )
}

function Inspector({ panel, setPanel, state, memories, selectedChatId, selectedProjectId, onMemories, onSelectChat, onSettings, onProjectUpdated, onBootstrap, onNotice }: {
  panel: Panel; setPanel: (panel: Panel) => void; state: BootstrapState; memories: Memory[]; selectedChatId: string | null; selectedProjectId: string | null | 'all'; onMemories: (memories: Memory[]) => void; onSelectChat: (id: string, messageId?: string) => void; onSettings: (settings: AppSettings) => void; onProjectUpdated: (project: Project) => void; onBootstrap: (state: BootstrapState) => void; onNotice: (message: string) => void
}): React.JSX.Element {
  return (
    <aside className="inspector">
      <div className="inspector-tabs">
        <button className={panel === 'memory' ? 'active' : ''} onClick={() => setPanel('memory')}>Memory</button>
        <button className={panel === 'search' ? 'active' : ''} onClick={() => setPanel('search')}>Search</button>
        <button className={panel === 'settings' ? 'active' : ''} onClick={() => setPanel('settings')}>Settings</button>
      </div>
      {panel === 'memory' && <MemoryPanel memories={memories} selectedChatId={selectedChatId} selectedProjectId={selectedProjectId} projects={state.projects} chats={state.chats} onMemories={onMemories} onSelectChat={onSelectChat} />}
      {panel === 'search' && <SearchPanel projects={state.projects} chats={state.chats} onSelectChat={onSelectChat} />}
      {panel === 'settings' && <SettingsPanel state={state} selectedChatId={selectedChatId} onSettings={onSettings} onProjectUpdated={onProjectUpdated} onBootstrap={onBootstrap} onNotice={onNotice} />}
    </aside>
  )
}

function MemoryPanel({ memories, selectedChatId, selectedProjectId, projects, chats, onMemories, onSelectChat }: { memories: Memory[]; selectedChatId: string | null; selectedProjectId: string | null | 'all'; projects: Project[]; chats: Chat[]; onMemories: (items: Memory[]) => void; onSelectChat: (id: string, messageId?: string) => void }): React.JSX.Element {
  const [scope, setScope] = useState<'chat' | 'project' | 'all'>('chat')
  const visible = memories
    .filter((memory) => {
      if (scope === 'all') return true
      if (scope === 'project') return selectedProjectId === 'all' ? true : memory.project_id === selectedProjectId
      return memory.chat_id === selectedChatId
    })
    .filter((memory) => memory.state !== 'deleted')
  const act = async (input: Parameters<typeof window.memoryBridge.memoryAction>[0]): Promise<void> => onMemories(await window.memoryBridge.memoryAction(input))
  return (
    <div className="panel-content">
      <div className="panel-heading"><div><p className="eyebrow">EVIDENCE-BACKED</p><h2>Memory ledger</h2></div><span>{visible.length}</span></div>
      <div className="segmented three"><button className={scope === 'chat' ? 'active' : ''} onClick={() => setScope('chat')}>This chat</button><button className={scope === 'project' ? 'active' : ''} onClick={() => setScope('project')}>Project</button><button className={scope === 'all' ? 'active' : ''} onClick={() => setScope('all')}>All</button></div>
      <div className="memory-list">
        {visible.map((memory) => {
          const chat = chats.find((item) => item.chat_id === memory.chat_id)
          const project = projects.find((item) => item.project_id === memory.project_id)
          return <MemoryCard key={memory.memory_id} memory={memory} allMemories={memories} project={project} chat={chat} act={act} onSelectChat={onSelectChat} />
        })}
        {visible.length === 0 && <PanelEmpty icon="⌁" title="No durable memories yet" copy="Decisions, preferences, completed work, and open questions will appear here with their sources." />}
      </div>
    </div>
  )
}

function MemoryCard({ memory, allMemories, project, chat, act, onSelectChat }: {
  memory: Memory
  allMemories: Memory[]
  project?: Project
  chat?: Chat
  act: (input: Parameters<typeof window.memoryBridge.memoryAction>[0]) => Promise<void>
  onSelectChat: (id: string, messageId?: string) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [statement, setStatement] = useState(memory.statement)
  const [relationship, setRelationship] = useState<'merge' | 'supersede' | null>(null)
  const [targetId, setTargetId] = useState('')
  const [sourceExcerpt, setSourceExcerpt] = useState('Loading source…')
  useEffect(() => {
    void window.memoryBridge.getMessages(memory.chat_id).then((messages) => {
      const text = messages
        .filter((message) => memory.source_message_ids.includes(message.message_id))
        .map((message) => message.content)
        .join(' ')
      setSourceExcerpt(text || 'Source message unavailable')
    })
  }, [memory.chat_id, memory.source_message_ids])
  const targets = allMemories.filter(
    (item) => item.memory_id !== memory.memory_id && item.state !== 'deleted'
  )
  return (
    <article className="memory-card" data-state={memory.state}>
      <div className="memory-top"><span className={`type type-${memory.type}`}>{memory.type.replace('_', ' ')}</span><span className="state">{memory.state}</span></div>
      {editing ? (
        <div className="memory-editor">
          <textarea value={statement} onChange={(event) => setStatement(event.target.value)} />
          <div><button onClick={() => { setStatement(memory.statement); setEditing(false) }}>Cancel</button><button onClick={() => { if (statement.trim()) void act({ memoryId: memory.memory_id, action: 'edit', statement: statement.trim() }).then(() => setEditing(false)) }}>Save correction</button></div>
        </div>
      ) : <p>{memory.statement}</p>}
      <div className="confidence"><i style={{ width: `${memory.confidence * 100}%` }} /><span>{Math.round(memory.confidence * 100)}%</span></div>
      <blockquote>“{sourceExcerpt.length > 180 ? `${sourceExcerpt.slice(0, 179)}…` : sourceExcerpt}”</blockquote>
      <button className="source" onClick={() => onSelectChat(memory.chat_id, memory.source_message_ids[0])}>↗ {project?.name ?? 'Unassigned'} · {chat?.title ?? 'Source chat'} · exact message</button>
      <div className="memory-dates"><span>Updated {new Date(memory.updated_at).toLocaleDateString()}</span>{memory.superseded_by && <span>Superseded by {memory.superseded_by.slice(0, 16)}…</span>}</div>
      <div className="memory-actions">
        {!memory.user_confirmed && <button onClick={() => void act({ memoryId: memory.memory_id, action: 'confirm' })}>Confirm</button>}
        <button onClick={() => setEditing(true)}>Edit</button>
        <button onClick={() => void act({ memoryId: memory.memory_id, action: memory.pinned ? 'unpin' : 'pin' })}>{memory.pinned ? 'Unpin' : 'Pin'}</button>
        <button onClick={() => void act({ memoryId: memory.memory_id, action: 'reject' })}>Reject</button>
        <button onClick={() => void act({ memoryId: memory.memory_id, action: 'delete' })}>Delete</button>
        {targets.length > 0 && <button onClick={() => setRelationship(relationship ? null : 'merge')}>Relate</button>}
      </div>
      {relationship && (
        <div className="relationship-editor">
          <select value={relationship} onChange={(event) => setRelationship(event.target.value as 'merge' | 'supersede')}><option value="merge">Merge into</option><option value="supersede">Mark superseded by</option></select>
          <select value={targetId} onChange={(event) => setTargetId(event.target.value)}><option value="">Choose memory…</option>{targets.map((target) => <option key={target.memory_id} value={target.memory_id}>{target.statement.slice(0, 70)}</option>)}</select>
          <button disabled={!targetId} onClick={() => { if (!targetId) return; void act(relationship === 'merge' ? { memoryId: memory.memory_id, action: 'merge', targetId } : { memoryId: memory.memory_id, action: 'supersede', replacementId: targetId }).then(() => setRelationship(null)) }}>Apply</button>
        </div>
      )}
    </article>
  )
}

function SearchPanel({ projects, chats, onSelectChat }: { projects: Project[]; chats: Chat[]; onSelectChat: (id: string, messageId?: string) => void }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [projectId, setProjectId] = useState<string>('')
  const [chatId, setChatId] = useState('')
  const [memoryType, setMemoryType] = useState<Memory['type'] | ''>('')
  const [memoryState, setMemoryState] = useState<Memory['state'] | ''>('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [includeHistory, setIncludeHistory] = useState(false)
  const [results, setResults] = useState<SearchResult[]>([])
  const search = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!query.trim()) return
    setResults(
      await window.memoryBridge.search({
        query,
        projectId: projectId || undefined,
        chatId: chatId || undefined,
        memoryType: memoryType || undefined,
        state: memoryState || undefined,
        fromDate: fromDate || undefined,
        toDate: toDate || undefined,
        includeHistory,
        limit: 40
      })
    )
  }
  return (
    <div className="panel-content">
      <div className="panel-heading"><div><p className="eyebrow">LOCAL FTS5</p><h2>Search archive</h2></div></div>
      <form className="search-form" onSubmit={(event) => void search(event)}>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search messages and memories" />
        <div className="search-filter-grid">
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">All projects</option>{projects.map((project) => <option key={project.project_id} value={project.project_id}>{project.name}</option>)}</select>
          <select value={chatId} onChange={(event) => setChatId(event.target.value)}><option value="">All chats</option>{chats.filter((chat) => !projectId || chat.project_id === projectId).map((chat) => <option key={chat.chat_id} value={chat.chat_id}>{chat.title}</option>)}</select>
          <select aria-label="Memory type" value={memoryType} onChange={(event) => setMemoryType(event.target.value as Memory['type'] | '')}><option value="">All memory types</option>{['decision', 'agreement', 'completed_item', 'fact', 'preference', 'instruction', 'commitment', 'open_question', 'project_state', 'rejected_option'].map((type) => <option key={type} value={type}>{type.replace('_', ' ')}</option>)}</select>
          <select aria-label="Memory state" value={memoryState} onChange={(event) => setMemoryState(event.target.value as Memory['state'] | '')}><option value="">All active states</option>{['active', 'confirmed', 'completed', 'superseded', 'rejected', 'disputed'].map((state) => <option key={state} value={state}>{state}</option>)}</select>
          <label>From<input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} /></label>
          <label>Through<input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} /></label>
        </div>
        <div className="search-history-row"><label><input type="checkbox" checked={includeHistory} onChange={(event) => setIncludeHistory(event.target.checked)} /> Include rejected and superseded history</label><button type="submit">Search</button></div>
      </form>
      <div className="search-results">
        {results.map((result) => <button key={`${result.kind}-${result.id}`} onClick={() => onSelectChat(result.chatId, result.sourceMessageIds[0])}><span className="result-kind">{result.kind}</span><b>{result.title}</b><p>{result.excerpt}</p>{result.memoryType && <small>{result.memoryType} · {result.state}</small>}</button>)}
        {results.length === 0 && <PanelEmpty icon="⌕" title="Search stays on your device" copy="Keyword search works without an API key. Historical and rejected memories are hidden by default." />}
      </div>
    </div>
  )
}

function SettingsPanel({ state, selectedChatId, onSettings, onProjectUpdated, onBootstrap, onNotice }: { state: BootstrapState; selectedChatId: string | null; onSettings: (settings: AppSettings) => void; onProjectUpdated: (project: Project) => void; onBootstrap: (state: BootstrapState) => void; onNotice: (message: string) => void }): React.JSX.Element {
  const [settings, setSettings] = useState(state.settings)
  const [apiKey, setApiKey] = useState('')
  const save = async (): Promise<void> => { const saved = await window.memoryBridge.updateSettings(settings); onSettings(saved); onNotice('Settings saved.') }
  return (
    <div className="panel-content settings">
      <div className="panel-heading"><div><p className="eyebrow">CONTROL & TRANSPARENCY</p><h2>Settings</h2></div></div>
      <section><h3>Provider</h3><label>Mode<select value={settings.mockMode ? 'mock' : 'openai-compatible'} onChange={(event) => setSettings({ ...settings, mockMode: event.target.value === 'mock', provider: event.target.value as AppSettings['provider'] })}><option value="mock">Mock — no key required</option><option value="openai-compatible">OpenAI-compatible</option></select></label><label>API base URL<input value={settings.apiBaseUrl} onChange={(event) => setSettings({ ...settings, apiBaseUrl: event.target.value })} /></label><label>Chat model<input value={settings.chatModel} onChange={(event) => setSettings({ ...settings, chatModel: event.target.value })} /></label><label>Extraction model<input value={settings.extractionModel} onChange={(event) => setSettings({ ...settings, extractionModel: event.target.value })} /></label><label>Embedding model<input value={settings.embeddingModel} onChange={(event) => setSettings({ ...settings, embeddingModel: event.target.value })} /></label><label>API key<input type="password" autoComplete="off" value={apiKey} placeholder={state.hasStoredApiKey ? 'Stored securely — enter to replace' : 'Not stored'} onChange={(event) => setApiKey(event.target.value)} /></label><div className="row-actions"><button onClick={async () => { if (apiKey) { await window.memoryBridge.saveApiKey(apiKey); setApiKey(''); onNotice('API key encrypted with Windows secure storage.') } }}>Save key</button><button onClick={async () => onNotice((await window.memoryBridge.testConnection()).message)}>Test</button><button onClick={async () => { await window.memoryBridge.clearApiKey(); onNotice('Stored API key removed.') }}>Clear key</button></div></section>
      <section><h3>Memory</h3><Toggle label="Automatic extraction" checked={settings.memoryExtractionEnabled} onChange={(value) => setSettings({ ...settings, memoryExtractionEnabled: value })} /><Toggle label="Semantic indexing" checked={settings.semanticIndexingEnabled} onChange={(value) => setSettings({ ...settings, semanticIndexingEnabled: value })} /><label>Maximum retrieved memories<input type="number" min="0" max="50" value={settings.maximumRetrievedMemories} onChange={(event) => setSettings({ ...settings, maximumRetrievedMemories: Number(event.target.value) })} /></label><label>Context character budget<input type="number" min="0" max="50000" value={settings.retrievalCharacterBudget} onChange={(event) => setSettings({ ...settings, retrievalCharacterBudget: Number(event.target.value) })} /></label></section>
      <ProjectEditor projects={state.projects} onUpdated={onProjectUpdated} />
      <section><h3>Vault & maintenance</h3><p className="path-copy">{state.vault.path}</p><button onClick={async () => { onBootstrap(await window.memoryBridge.chooseAndOpenVault()); onNotice('Vault location reconnected.') }}>Reconnect or locate vault</button><button onClick={async () => onNotice(`Rebuilt index: ${JSON.stringify(await window.memoryBridge.rebuildIndex())}`)}>Rebuild local index</button>{selectedChatId && <button onClick={async () => onNotice(`Extraction complete: ${(await window.memoryBridge.rerunExtraction(selectedChatId)).length} new memories`) }>Re-run extraction for selected chat</button>}<button onClick={async () => onNotice(`Diagnostics saved to ${(await window.memoryBridge.exportDiagnostics()).path}`)}>Export content-free diagnostics</button></section>
      <section className="transparency"><h3>What leaves this device?</h3><p>Chat text goes only to your configured provider when you send it. Extraction and embeddings may send selected text when enabled. The vault, indexes, and transcripts remain in your chosen folder. API keys are stored separately with Windows encryption. Disabling extraction never disables transcript saving.</p></section>
      <button className="primary save-settings" onClick={() => void save()}>Save settings</button>
    </div>
  )
}

function ProjectEditor({ projects, onUpdated }: { projects: Project[]; onUpdated: (project: Project) => void }): React.JSX.Element {
  const [projectId, setProjectId] = useState(projects[0]?.project_id ?? '')
  const selected = projects.find((project) => project.project_id === projectId)
  const [name, setName] = useState(selected?.name ?? '')
  const [description, setDescription] = useState(selected?.description ?? '')
  const choose = (id: string): void => {
    const project = projects.find((item) => item.project_id === id)
    setProjectId(id)
    setName(project?.name ?? '')
    setDescription(project?.description ?? '')
  }
  return (
    <section>
      <h3>Projects</h3>
      {projects.length === 0 ? <p className="path-copy">Create a project from the sidebar to edit it here.</p> : <>
        <label>Project<select value={projectId} onChange={(event) => choose(event.target.value)}>{projects.map((project) => <option key={project.project_id} value={project.project_id}>{project.name}</option>)}</select></label>
        <label>Name<input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} /></label>
        <button onClick={async () => { if (!projectId || !name.trim()) return; onUpdated(await window.memoryBridge.updateProject({ projectId, name: name.trim(), description })) }}>Save project details</button>
      </>}
    </section>
  )
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }): React.JSX.Element {
  return <label className="toggle"><span>{label}</span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><i /></label>
}

function PanelEmpty({ icon, title, copy }: { icon: string; title: string; copy: string }): React.JSX.Element {
  return <div className="panel-empty"><span>{icon}</span><h3>{title}</h3><p>{copy}</p></div>
}

function EmptyChat(): React.JSX.Element {
  return <div className="empty-chat"><span>⌁</span><h2>A clean thread, backed by memory.</h2><p>Write a message. It will be saved before a response begins.</p></div>
}

function NoChat({ onNew, disabled }: { onNew: () => void; disabled: boolean }): React.JSX.Element {
  return <div className="no-chat"><BrandMark large /><h1>Where should we pick up?</h1><p>Start a focused conversation or choose one from your archive.</p><button className="primary" onClick={onNew} disabled={disabled}>New conversation</button></div>
}

function DisconnectedBanner({ vault, onReconnect }: { vault: VaultStatus; onReconnect: () => Promise<void> }): React.JSX.Element {
  return <div className="disconnect-banner"><b>Vault disconnected</b><span>{vault.path ? 'The selected drive or folder is unavailable.' : 'Locate your vault to continue.'} New messages are blocked and nothing is saved elsewhere.</span><button onClick={() => void onReconnect()}>Locate vault</button></div>
}

function upsertMessage(messages: Message[], message: Message): Message[] {
  const found = messages.some((item) => item.message_id === message.message_id)
  const next = found ? messages.map((item) => (item.message_id === message.message_id ? message : item)) : [...messages, message]
  return next.sort((a, b) => a.sequence - b.sequence)
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': /, '') : 'Something went wrong.' }
function formatBytes(bytes: number | null): string { if (bytes === null) return 'Unknown'; const gb = bytes / 1024 ** 3; return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB` }
function relativeDate(value: string): string { const days = Math.floor((Date.now() - Date.parse(value)) / 86_400_000); return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : `${days}d` }
function formatTime(value: string): string { return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(value)) }
function sortProjects(a: Project, b: Project): number { return a.name.localeCompare(b.name) }
