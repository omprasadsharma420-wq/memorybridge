import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type {
  BootstrapState,
  ConnectorCapabilitiesView,
  ImportPreviewResult,
  ImportProgressView,
  McpConfiguration,
  RetrievedContextItem,
  SearchResult,
  StorageProgress,
  VaultStorageStats,
  VaultStatus
} from '../shared/contracts'
import type {
  AppSettings,
  Chat,
  ImportRecord,
  Memory,
  MemoryEvidence,
  Message,
  Project,
  ProviderMemory,
  TopicSegment
} from '../shared/schemas'

type Panel =
  'memory' | 'search' | 'providers' | 'topics' | 'imports' | 'storage' | 'mcp' | 'settings'

export function App(): React.JSX.Element {
  const [state, setState] = useState<BootstrapState | null>(null)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null | 'all'>('all')
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [memories, setMemories] = useState<Memory[]>([])
  const [panel, setPanel] = useState<Panel>('memory')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [activeProcessingScopeId, setActiveProcessingScopeId] = useState<string | null>(null)
  const [contextUsed, setContextUsed] = useState<RetrievedContextItem[]>([])
  const [contextExpanded, setContextExpanded] = useState(false)
  const [sourceMessageId, setSourceMessageId] = useState<string | null>(null)
  const [projectDialogOpen, setProjectDialogOpen] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const messagesEnd = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    const next = await window.memoryBridge.bootstrap()
    setState(next)
    if (next.vault.writable) setMemories(await window.memoryBridge.listMemories())
  }, [])

  useEffect(() => {
    void refresh().catch((error: unknown) => setNotice(errorMessage(error)))
    const offStream = window.memoryBridge.onStream((message) => {
      setMessages((current) => upsertMessage(current, message))
    })
    const offVault = window.memoryBridge.onVaultStatus((vault) => {
      setState((current) => {
        if (vault.writable && current && !current.vault.writable) {
          void refresh().catch((error: unknown) => setNotice(errorMessage(error)))
        }
        return current ? { ...current, vault } : current
      })
    })
    const offProcessing = window.memoryBridge.onProcessingProgress((progress) => {
      if (progress.status === 'running') {
        setActiveProcessingScopeId(progress.scopeId)
        setNotice(
          `Processing ${progress.scope}: chat ${progress.completedChats + 1} of ${Math.max(progress.totalChats, 1)}, segment ${progress.completedSegments} of ${Math.max(progress.totalSegments, 1)}…`
        )
      } else {
        setActiveProcessingScopeId(null)
        if (progress.status === 'cancelled') setNotice('Processing cancelled safely.')
        else if (progress.status === 'complete')
          setNotice(
            `Processing complete: ${progress.completedChats} chat(s), ${progress.completedSegments} segment(s).`
          )
        else if (progress.status === 'failed') setNotice('Processing stopped after a failure.')
      }
    })
    return () => {
      offStream()
      offVault()
      offProcessing()
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
    if (!state?.vault.writable || !state.settings.onboardingCompleted) return
    void window.memoryBridge
      .listMemories()
      .then(setMemories)
      .catch((error: unknown) => setNotice(errorMessage(error)))
  }, [state?.vault.manifest?.vault_id, state?.vault.writable, state?.settings.onboardingCompleted])

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
  if (state.vault.connected && !state.vault.writable && state.vault.reason === 'locked') {
    return (
      <LockedVaultScreen
        vault={state.vault}
        onReconnect={async () => setState(await window.memoryBridge.chooseAndOpenVault())}
        notice={notice}
        onError={(message) => setNotice(message)}
      />
    )
  }
  if (state.vault.writable && !state.settings.onboardingCompleted) {
    return (
      <FirstRunOnboarding
        state={state}
        onState={setState}
        onError={(message) => setNotice(message)}
        notice={notice}
      />
    )
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
        current
          ? { ...current, projects: [...current.projects, project].sort(sortProjects) }
          : current
      )
      setSelectedProjectId(project.project_id)
      setProjectDialogOpen(false)
      setNewProjectName('')
    } catch (error) {
      setNotice(errorMessage(error))
    }
  }

  const send = async (content: string): Promise<void> => {
    if (!selectedChatId || !state.vault.writable) return
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
      {!state.vault.writable && (
        <DisconnectedBanner
          vault={state.vault}
          onReconnect={async () => setState(await window.memoryBridge.chooseAndOpenVault())}
        />
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
                    ? {
                        ...current,
                        chats: current.chats.map((item) =>
                          item.chat_id === chat.chat_id ? chat : item
                        )
                      }
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
                    message.role === 'assistant' &&
                    ['failed', 'interrupted', 'cancelled'].includes(message.status)
                      ? async () => {
                          const index = messages.findIndex(
                            (item) => item.message_id === message.message_id
                          )
                          const user = [...messages.slice(0, index)]
                            .reverse()
                            .find((item) => item.role === 'user')
                          if (!user) return
                          setBusy(true)
                          try {
                            const result = await window.memoryBridge.retryMessage({
                              chatId: selectedChat.chat_id,
                              userMessageId: user.message_id
                            })
                            setMessages((current) =>
                              upsertMessage(current, result.assistantMessage)
                            )
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
                <button
                  className="context-strip"
                  onClick={() => setContextExpanded((value) => !value)}
                >
                  <span>Bridge context</span>
                  {contextUsed.length} cited context {contextUsed.length === 1 ? 'item' : 'items'}{' '}
                  supplied
                </button>
                {contextExpanded && (
                  <div className="context-details">
                    {contextUsed.map((item) => (
                      <button
                        key={item.contextId}
                        onClick={() => selectChat(item.sourceChatId, item.sourceMessageIds[0])}
                      >
                        <span>
                          {item.kind === 'memory' ? item.memoryType : 'transcript excerpt'}
                        </span>
                        <b>{item.statement}</b>
                        <small>↗ {item.sourceChatTitle} · exact source</small>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <Composer
              disabled={!state.vault.writable}
              busy={busy}
              onSend={send}
              onStop={() => selectedChatId && window.memoryBridge.stopGeneration(selectedChatId)}
            />
          </>
        ) : (
          <NoChat onNew={() => void createChat()} disabled={!state.vault.writable} />
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
        onSettings={(settings) =>
          setState((current) => (current ? { ...current, settings } : current))
        }
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
          {activeProcessingScopeId && (
            <button
              onClick={() => void window.memoryBridge.cancelReprocessing(activeProcessingScopeId)}
            >
              Stop processing
            </button>
          )}
          <button onClick={() => setNotice(null)} aria-label="Dismiss">
            ×
          </button>
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
              <button
                type="button"
                className="secondary"
                onClick={() => setProjectDialogOpen(false)}
              >
                Cancel
              </button>
              <button
                data-testid="create-project"
                className="primary"
                type="submit"
                disabled={!newProjectName.trim()}
              >
                Create project
              </button>
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
        <h1>
          Conversations that
          <br />
          remember where they came from.
        </h1>
        <p className="lede">
          Choose a folder you control. MemoryBridge keeps the original conversation, extracts
          durable decisions, and brings back only what matters, with exact sources.
        </p>
        <div className="welcome-actions">
          <button
            className="primary"
            data-testid="create-vault"
            onClick={() => void run(window.memoryBridge.chooseAndCreateVault)}
          >
            Create a new vault
          </button>
          <button
            className="secondary"
            onClick={() => void run(window.memoryBridge.chooseAndOpenVault)}
          >
            Open an existing vault
          </button>
        </div>
        <p className="privacy-note">
          No MemoryBridge cloud account or telemetry. Imports and keyword search work without an API
          key. If you configure a provider, selected bounded text can be sent to that endpoint.
        </p>
        {notice && <p className="inline-error">{notice}</p>}
      </div>
      <div className="bridge-visual" aria-hidden="true">
        <span className="shore shore-a" />
        <span className="shore shore-b" />
        <span className="bridge-line one" />
        <span className="bridge-line two" />
        <span className="bridge-line three" />
        <div className="memory-chip chip-a">
          Decision <b>cited</b>
        </div>
        <div className="memory-chip chip-b">
          Preference <b>active</b>
        </div>
        <div className="memory-chip chip-c">
          Milestone <b>complete</b>
        </div>
      </div>
    </div>
  )
}

function LockedVaultScreen({
  vault,
  onReconnect,
  notice,
  onError
}: {
  vault: VaultStatus
  onReconnect: () => Promise<void>
  notice: string | null
  onError: (message: string) => void
}): React.JSX.Element {
  return (
    <div className="locked-vault-screen">
      <BrandMark large />
      <p className="eyebrow">VAULT LOCKED</p>
      <h1>Another MemoryBridge instance owns this vault.</h1>
      <p>
        Browsing and changes are disabled because a readable repository was not opened. Close the
        other instance, then retry. MemoryBridge will not save anything to a fallback location.
      </p>
      <p className="path-copy">{vault.path}</p>
      <button
        className="primary"
        onClick={() => void onReconnect().catch((error: unknown) => onError(errorMessage(error)))}
      >
        Retry or reconnect
      </button>
      {notice && (
        <p className="onboarding-notice" role="status">
          {notice}
        </p>
      )}
    </div>
  )
}

function FirstRunOnboarding({
  state,
  onState,
  onError,
  notice
}: {
  state: BootstrapState
  onState: (state: BootstrapState) => void
  onError: (message: string) => void
  notice: string | null
}): React.JSX.Element {
  const [step, setStep] = useState<2 | 3 | 4 | 5>(2)
  const [storage, setStorage] = useState<VaultStorageStats | null>(null)
  const [preview, setPreview] = useState<ImportPreviewResult | null>(null)
  const [result, setResult] = useState<ImportRecord | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<ImportProgressView | null>(null)
  useEffect(() => {
    const offProgress = window.memoryBridge.onImportProgress(setProgress)
    void window.memoryBridge
      .getVaultStorage()
      .then(setStorage)
      .catch((error: unknown) => onError(errorMessage(error)))
    return offProgress
  }, [onError])
  const chooseMode = async (mode: AppSettings['processingMode']): Promise<void> => {
    const saved = await window.memoryBridge.updateSettings({
      processingMode: mode,
      mockMode: mode !== 'ai',
      provider: mode === 'ai' ? 'openai-compatible' : 'mock',
      memoryExtractionEnabled: mode !== 'offline',
      semanticIndexingEnabled: false
    })
    onState({ ...state, settings: saved })
    setStep(4)
  }
  const finish = async (): Promise<void> => {
    const settings = await window.memoryBridge.updateSettings({ onboardingCompleted: true })
    onState({ ...(await window.memoryBridge.bootstrap()), settings })
  }
  const importChosen = async (): Promise<void> => {
    setBusy(true)
    try {
      const nextPreview = await window.memoryBridge.chooseImport()
      setPreview(nextPreview)
      if (!nextPreview) return
    } catch (error) {
      onError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  const executeChosen = async (): Promise<void> => {
    if (!preview) return
    setBusy(true)
    try {
      const imported = await window.memoryBridge.executeImport({ token: preview.token })
      setResult(await window.memoryBridge.validateImport(imported.import_id))
      setStep(5)
    } catch (error) {
      onError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  const loadDemo = async (): Promise<void> => {
    setBusy(true)
    try {
      const loaded = await window.memoryBridge.loadDemoArchive()
      setResult(loaded.importRecord)
      setStep(5)
    } catch (error) {
      onError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  const scanInbox = async (): Promise<void> => {
    setBusy(true)
    try {
      const records = await window.memoryBridge.scanImportInbox()
      if (!records.length) {
        onError('The import inbox contains no supported files.')
        return
      }
      setResult(await window.memoryBridge.validateImport(records[0]!.import_id))
      setStep(5)
    } catch (error) {
      onError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="onboarding-shell">
      <header>
        <BrandMark />
        <span>Setup {step} of 5</span>
      </header>
      {step === 2 && (
        <section>
          <p className="eyebrow">STORAGE SELECTED</p>
          <h1>Your vault is ready.</h1>
          <p>
            Conversations, indexes, memory, and evidence will stay in this selected vault. No
            conversation is redirected to application storage.
          </p>
          <div className="onboarding-summary">
            <b>{state.vault.manifest?.vault_id}</b>
            <span>{state.vault.path}</span>
            <span>{state.vault.writable ? 'Writable' : 'Unavailable'}</span>
            <span>
              {storage
                ? `${formatHumanBytes(storage.freeDeviceBytes)} free`
                : 'Calculating capacity'}
            </span>
          </div>
          <button className="primary" onClick={() => setStep(3)}>
            Continue
          </button>
        </section>
      )}
      {step === 3 && (
        <section>
          <p className="eyebrow">PROCESSING MODE</p>
          <h1>Choose how MemoryBridge should process chats.</h1>
          <div className="mode-options">
            <button onClick={() => void chooseMode('offline')}>
              <b>Offline storage and search</b>
              <span>Import, browse, and keyword search. No API key required.</span>
            </button>
            <button onClick={() => void chooseMode('ai')}>
              <b>AI memory intelligence</b>
              <span>
                Structured extraction and optional embeddings through your API key or local
                compatible endpoint.
              </span>
            </button>
            <button data-testid="demo-mode" onClick={() => void chooseMode('demo')}>
              <b>Demo mode</b>
              <span>Deterministic synthetic extraction for product testing only.</span>
            </button>
          </div>
          <small>
            ChatGPT subscriptions and API billing are separate. Import and keyword indexing work
            without an API key.
          </small>
        </section>
      )}
      {step === 4 && (
        <section>
          <p className="eyebrow">FIRST CONVERSATION</p>
          <h1>Import an archive or start locally.</h1>
          <div className="onboarding-actions">
            <button disabled={busy} onClick={() => void importChosen()}>
              Import ChatGPT ZIP or JSON
            </button>
            <button disabled={busy} onClick={() => void importChosen()}>
              Import Markdown or text
            </button>
            <button disabled={busy} onClick={() => void scanInbox()}>
              Scan Import Inbox
            </button>
            <button data-testid="load-demo" disabled={busy} onClick={() => void loadDemo()}>
              Load bundled synthetic demo
            </button>
            <button
              data-testid="start-native"
              disabled={busy}
              onClick={() => {
                setResult(null)
                setStep(5)
              }}
            >
              Start a native conversation
            </button>
          </div>
          {busy && progress && (
            <div className="import-progress" role="status">
              <b>{humanize(progress.phase)}</b>
              <span>
                {progress.totalBytes
                  ? `${Math.min(
                      100,
                      Math.round((progress.processedBytes / progress.totalBytes) * 100)
                    )}%`
                  : `${progress.completedConversations} of ${
                      progress.totalConversations || '?'
                    } conversations`}
              </span>
            </div>
          )}
          {preview && (
            <article className="onboarding-summary">
              <b>{preview.fileName}</b>
              <span>
                {preview.conversations} conversations, {preview.messages} messages
              </span>
              {preview.warnings.map((warning) => (
                <small key={warning}>{warning}</small>
              ))}
              <button className="primary" disabled={busy} onClick={() => void executeChosen()}>
                Import archive
              </button>
            </article>
          )}
        </section>
      )}
      {step === 5 && (
        <section>
          <p className="eyebrow">READY TO REVIEW</p>
          <h1>
            {result ? 'Your first import is ready.' : 'Your vault is ready for a conversation.'}
          </h1>
          {result ? (
            <div className="onboarding-summary">
              <span>{result.imported_count} conversations added</span>
              <span>{result.message_count} messages discovered</span>
              <span>{result.changed_count} conversations updated</span>
              <span>{result.skipped_count} unchanged</span>
              <span>{result.review_count} items requiring review</span>
              <span>Validation: {result.validation_status}</span>
            </div>
          ) : (
            <p>Create a native chat from the sidebar after setup closes.</p>
          )}
          <button data-testid="finish-setup" className="primary" onClick={() => void finish()}>
            Open MemoryBridge
          </button>
        </section>
      )}
      {notice && <p className="inline-error">{notice}</p>}
    </div>
  )
}

function BrandMark({ large = false }: { large?: boolean }): React.JSX.Element {
  return (
    <div className={`brand ${large ? 'large' : ''}`}>
      <span className="brand-icon">
        <i />
        <i />
        <i />
      </span>
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
      <button
        className="new-chat"
        data-testid="new-chat"
        onClick={props.onNewChat}
        disabled={!props.vault.writable}
      >
        ＋ New conversation
      </button>
      <nav className="project-nav">
        <div className="nav-label">
          <span>Workspaces</span>
          <button onClick={props.onNewProject}>＋</button>
        </div>
        <button
          className={props.selectedProjectId === 'all' ? 'active' : ''}
          onClick={() => props.onProject('all')}
        >
          <span>◫</span> All conversations
        </button>
        <button
          className={props.selectedProjectId === null ? 'active' : ''}
          onClick={() => props.onProject(null)}
        >
          <span>◇</span> Unassigned
        </button>
        {props.projects.map((project) => (
          <button
            key={project.project_id}
            className={props.selectedProjectId === project.project_id ? 'active' : ''}
            onClick={() => props.onProject(project.project_id)}
          >
            <span className="project-dot" /> {project.name}
          </button>
        ))}
      </nav>
      <div className="nav-label chat-label">
        <span>Recent</span>
        {props.selectedChatId && (
          <button className="clear-chat" onClick={props.onClear}>
            Clear
          </button>
        )}
      </div>
      <div className="chat-list">
        {props.chats.map((chat) => (
          <button
            key={chat.chat_id}
            className={props.selectedChatId === chat.chat_id ? 'active' : ''}
            onClick={() => props.onChat(chat.chat_id)}
          >
            <span className="chat-title">{chat.title}</span>
            <time>{relativeDate(chat.updated_at)}</time>
          </button>
        ))}
        {props.chats.length === 0 && <p className="empty-list">No conversations here yet.</p>}
      </div>
      <div className="sidebar-foot">
        <button onClick={() => props.onPanel('memory')}>Memory ledger</button>
        <button onClick={() => props.onPanel('search')}>⌕ Search archive</button>
        <button onClick={() => props.onPanel('providers')}>Providers</button>
        <button onClick={() => props.onPanel('topics')}>Topics</button>
        <button onClick={() => props.onPanel('imports')}>Imports & sync</button>
        <button onClick={() => props.onPanel('storage')}>Vault storage</button>
        <button onClick={() => props.onPanel('mcp')}>MCP & integrations</button>
        <button onClick={() => props.onPanel('settings')}>Vault settings</button>
        <div
          className={`vault-pill ${
            props.vault.writable
              ? 'connected'
              : props.vault.connected
                ? 'read-only'
                : 'disconnected'
          }`}
        >
          <span />
          <div>
            <b>
              {props.vault.writable
                ? 'Vault connected'
                : props.vault.connected
                  ? props.vault.reason === 'locked'
                    ? 'Vault locked'
                    : 'Vault read-only'
                  : 'Vault offline'}
            </b>
            <small>{formatBytes(props.vault.freeBytes)} free</small>
          </div>
        </div>
      </div>
    </aside>
  )
}

function ChatHeader({
  chat,
  projects,
  onUpdated
}: {
  chat: Chat
  projects: Project[]
  onUpdated: (chat: Chat) => void
}): React.JSX.Element {
  const [title, setTitle] = useState(chat.title)
  const saveTitle = async (): Promise<void> => {
    if (title.trim() && title.trim() !== chat.title)
      onUpdated(await window.memoryBridge.updateChat({ chatId: chat.chat_id, title: title.trim() }))
  }
  return (
    <header className="chat-header">
      <div>
        <input
          aria-label="Chat title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => void saveTitle()}
          onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
        />
        <p>
          {chat.source_provider} · {chat.sync_state} · {chat.processing_state}
          {chat.model_ids.length ? ` · ${chat.model_ids.join(', ')}` : ''}
          {chat.workspace ? ` · ${chat.workspace}` : ''}
        </p>
      </div>
      <select
        aria-label="Assign project"
        value={chat.project_id ?? ''}
        onChange={async (event) =>
          onUpdated(
            await window.memoryBridge.updateChat({
              chatId: chat.chat_id,
              projectId: event.target.value || null
            })
          )
        }
      >
        <option value="">Unassigned</option>
        {projects.map((project) => (
          <option key={project.project_id} value={project.project_id}>
            {project.name}
          </option>
        ))}
      </select>
    </header>
  )
}

function MessageCard({
  message,
  retrievedCount,
  highlighted,
  onOpenMemory,
  onRetry
}: {
  message: Message
  retrievedCount: number
  highlighted: boolean
  onOpenMemory: () => void
  onRetry?: () => void
}): React.JSX.Element {
  return (
    <article
      id={`message-${message.message_id}`}
      className={`message ${message.role} ${highlighted ? 'source-highlight' : ''}`}
      data-status={message.status}
    >
      <div className="avatar">{message.role === 'user' ? 'You' : 'MB'}</div>
      <div className="bubble">
        <div className="message-meta">
          <b>{message.role === 'user' ? 'You' : 'MemoryBridge'}</b>
          <time>{formatTime(message.created_at)}</time>
        </div>
        <p>{message.content || (message.status === 'pending' ? 'Preparing a response…' : '…')}</p>
        {message.role === 'assistant' && message.status === 'streaming' && (
          <span className="stream-cursor" />
        )}
        {retrievedCount > 0 && (
          <button className="citation-button" onClick={onOpenMemory}>
            ↗ Used {retrievedCount} cited context {retrievedCount === 1 ? 'item' : 'items'}
          </button>
        )}
        {!['complete', 'streaming', 'pending'].includes(message.status) && (
          <div className="message-state">
            <span>{message.status}</span>
            {message.content && ' · partial response preserved'}
            {onRetry && <button onClick={onRetry}>Retry</button>}
          </div>
        )}
      </div>
    </article>
  )
}

function Composer({
  disabled,
  busy,
  onSend,
  onStop
}: {
  disabled: boolean
  busy: boolean
  onSend: (content: string) => Promise<void>
  onStop: () => void
}): React.JSX.Element {
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
      <textarea
        data-testid="composer"
        value={content}
        onChange={(event) => setContent(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            event.currentTarget.form?.requestSubmit()
          }
        }}
        placeholder={disabled ? 'Reconnect your vault to continue' : 'Continue the conversation…'}
        disabled={disabled}
      />
      {busy ? (
        <button type="button" className="stop" onClick={onStop}>
          ■ Stop
        </button>
      ) : (
        <button
          data-testid="send"
          className="send"
          type="submit"
          disabled={disabled || !content.trim()}
        >
          ↑
        </button>
      )}
      <small>Messages are saved to your vault before they are sent.</small>
    </form>
  )
}

function Inspector({
  panel,
  setPanel,
  state,
  memories,
  selectedChatId,
  selectedProjectId,
  onMemories,
  onSelectChat,
  onSettings,
  onProjectUpdated,
  onBootstrap,
  onNotice
}: {
  panel: Panel
  setPanel: (panel: Panel) => void
  state: BootstrapState
  memories: Memory[]
  selectedChatId: string | null
  selectedProjectId: string | null | 'all'
  onMemories: (memories: Memory[]) => void
  onSelectChat: (id: string, messageId?: string) => void
  onSettings: (settings: AppSettings) => void
  onProjectUpdated: (project: Project) => void
  onBootstrap: (state: BootstrapState) => void
  onNotice: (message: string) => void
}): React.JSX.Element {
  return (
    <aside className="inspector">
      <div className="inspector-tabs">
        <button className={panel === 'memory' ? 'active' : ''} onClick={() => setPanel('memory')}>
          Memory
        </button>
        <button className={panel === 'search' ? 'active' : ''} onClick={() => setPanel('search')}>
          Search
        </button>
        <button className={panel === 'imports' ? 'active' : ''} onClick={() => setPanel('imports')}>
          Imports
        </button>
        <button className={panel === 'storage' ? 'active' : ''} onClick={() => setPanel('storage')}>
          Storage
        </button>
        <button className={panel === 'mcp' ? 'active' : ''} onClick={() => setPanel('mcp')}>
          MCP
        </button>
        <button
          className={panel === 'settings' ? 'active' : ''}
          onClick={() => setPanel('settings')}
        >
          Settings
        </button>
      </div>
      {panel === 'memory' && (
        <MemoryPanel
          memories={memories}
          selectedChatId={selectedChatId}
          selectedProjectId={selectedProjectId}
          projects={state.projects}
          chats={state.chats}
          onMemories={onMemories}
          onSelectChat={onSelectChat}
        />
      )}
      {panel === 'search' && (
        <SearchPanel projects={state.projects} chats={state.chats} onSelectChat={onSelectChat} />
      )}
      {panel === 'providers' && (
        <ProvidersPanel projects={state.projects} chats={state.chats} onNotice={onNotice} />
      )}
      {panel === 'topics' && <TopicsPanel selectedChatId={selectedChatId} onNotice={onNotice} />}
      {panel === 'imports' && (
        <ImportPanel
          onImported={async () => {
            onBootstrap(await window.memoryBridge.bootstrap())
            onMemories(await window.memoryBridge.listMemories())
          }}
          onNotice={onNotice}
        />
      )}
      {panel === 'storage' && <StoragePanel vault={state.vault} onNotice={onNotice} />}
      {panel === 'mcp' && <McpPanel />}
      {panel === 'settings' && (
        <SettingsPanel
          state={state}
          selectedChatId={selectedChatId}
          onSettings={onSettings}
          onMemories={onMemories}
          onProjectUpdated={onProjectUpdated}
          onBootstrap={onBootstrap}
          onNotice={onNotice}
        />
      )}
    </aside>
  )
}

function MemoryPanel({
  memories,
  selectedChatId,
  selectedProjectId,
  projects,
  chats,
  onMemories,
  onSelectChat
}: {
  memories: Memory[]
  selectedChatId: string | null
  selectedProjectId: string | null | 'all'
  projects: Project[]
  chats: Chat[]
  onMemories: (items: Memory[]) => void
  onSelectChat: (id: string, messageId?: string) => void
}): React.JSX.Element {
  const [scope, setScope] = useState<'chat' | 'project' | 'all'>('chat')
  const visible = memories
    .filter((memory) => {
      if (scope === 'all') return true
      if (scope === 'project')
        return selectedProjectId === 'all' ? true : memory.project_id === selectedProjectId
      return memory.chat_id === selectedChatId
    })
    .filter((memory) => memory.state !== 'deleted')
  const act = async (
    input: Parameters<typeof window.memoryBridge.memoryAction>[0]
  ): Promise<void> => onMemories(await window.memoryBridge.memoryAction(input))
  return (
    <div className="panel-content">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">EVIDENCE-BACKED</p>
          <h2>Memory ledger</h2>
        </div>
        <span>{visible.length}</span>
      </div>
      <div className="segmented three">
        <button className={scope === 'chat' ? 'active' : ''} onClick={() => setScope('chat')}>
          This chat
        </button>
        <button className={scope === 'project' ? 'active' : ''} onClick={() => setScope('project')}>
          Project
        </button>
        <button className={scope === 'all' ? 'active' : ''} onClick={() => setScope('all')}>
          All
        </button>
      </div>
      <div className="memory-list">
        {visible.map((memory) => {
          const chat = chats.find((item) => item.chat_id === memory.chat_id)
          const project = projects.find((item) => item.project_id === memory.project_id)
          return (
            <MemoryCard
              key={memory.memory_id}
              memory={memory}
              allMemories={memories}
              project={project}
              projects={projects}
              chat={chat}
              act={act}
              onSelectChat={onSelectChat}
            />
          )
        })}
        {visible.length === 0 && (
          <PanelEmpty
            icon="⌁"
            title="No durable memories yet"
            copy="Decisions, preferences, completed work, and open questions will appear here with their sources."
          />
        )}
      </div>
    </div>
  )
}

function MemoryCard({
  memory,
  allMemories,
  project,
  projects,
  chat,
  act,
  onSelectChat
}: {
  memory: Memory
  allMemories: Memory[]
  project?: Project
  projects: Project[]
  chat?: Chat
  act: (input: Parameters<typeof window.memoryBridge.memoryAction>[0]) => Promise<void>
  onSelectChat: (id: string, messageId?: string) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [statement, setStatement] = useState(memory.statement)
  const [relationship, setRelationship] = useState<'merge' | 'supersede' | null>(null)
  const [targetId, setTargetId] = useState('')
  const [sourceExcerpt, setSourceExcerpt] = useState('Loading source…')
  const [evidence, setEvidence] = useState<MemoryEvidence[]>([])
  useEffect(() => {
    void window.memoryBridge.listEvidence(memory.memory_id).then(async (records) => {
      setEvidence(records)
      if (records.length) {
        setSourceExcerpt(records.map((record) => record.exact_excerpt).join(' '))
        return
      }
      const messages = await window.memoryBridge.getMessages(memory.chat_id)
      setSourceExcerpt(
        messages
          .filter((message) => memory.source_message_ids.includes(message.message_id))
          .map((message) => message.content)
          .join(' ') || 'Source message unavailable'
      )
    })
  }, [memory.chat_id, memory.memory_id, memory.source_message_ids])
  const targets = allMemories.filter(
    (item) =>
      item.memory_id !== memory.memory_id &&
      item.state !== 'deleted' &&
      item.project_id === memory.project_id &&
      (memory.project_id !== null || item.chat_id === memory.chat_id)
  )
  const primaryEvidence = evidence[0]
  return (
    <article className="memory-card" data-state={memory.state}>
      <div className="memory-top">
        <span className={`type type-${memory.type}`}>{memory.type.replace('_', ' ')}</span>
        <span className="state">{memory.state}</span>
      </div>
      {editing ? (
        <div className="memory-editor">
          <textarea value={statement} onChange={(event) => setStatement(event.target.value)} />
          <div>
            <button
              onClick={() => {
                setStatement(memory.statement)
                setEditing(false)
              }}
            >
              Cancel
            </button>
            <button
              onClick={() => {
                if (statement.trim())
                  void act({
                    memoryId: memory.memory_id,
                    action: 'edit',
                    statement: statement.trim()
                  }).then(() => setEditing(false))
              }}
            >
              Save correction
            </button>
          </div>
        </div>
      ) : (
        <p>{memory.statement}</p>
      )}
      <div className="confidence">
        <i style={{ width: `${memory.confidence * 100}%` }} />
        <span>{Math.round(memory.confidence * 100)}%</span>
      </div>
      <blockquote>
        “{sourceExcerpt.length > 180 ? `${sourceExcerpt.slice(0, 179)}…` : sourceExcerpt}”
      </blockquote>
      <button
        className="source"
        disabled={primaryEvidence?.source_available === false}
        onClick={() =>
          onSelectChat(
            primaryEvidence?.chat_id ?? memory.chat_id,
            primaryEvidence?.message_id ?? memory.source_message_ids[0]
          )
        }
      >
        {primaryEvidence?.source_available === false ? 'Source unavailable' : 'Open exact source'} ·{' '}
        {primaryEvidence?.evidence_role ?? 'supports'} · {project?.name ?? 'Unassigned'} ·{' '}
        {chat?.title ?? 'Source chat'}
      </button>
      {evidence.slice(1).map((record) => (
        <button
          className="source"
          key={record.evidence_id}
          disabled={record.source_available === false}
          onClick={() => onSelectChat(record.chat_id, record.message_id)}
        >
          {record.source_available === false ? 'Source unavailable' : 'Open additional evidence'} ·{' '}
          {record.evidence_role} · {record.provider}
        </button>
      ))}
      <div className="memory-dates">
        <span>Scope: {memory.scope?.kind ?? (memory.project_id ? 'project' : 'conversation')}</span>
        <span>Confirmation: {memory.confirmation_source ?? 'none'}</span>
        <span>Evidence: {evidence.length || memory.source_message_ids.length}</span>
        <span>Updated {new Date(memory.updated_at).toLocaleDateString()}</span>
        {memory.superseded_by && <span>Superseded by {memory.superseded_by.slice(0, 16)}…</span>}
      </div>
      <div className="memory-actions">
        <select
          aria-label="Memory scope"
          value={
            memory.scope?.kind === 'global'
              ? 'global'
              : memory.scope?.kind === 'project' || (!memory.scope && memory.project_id)
                ? `project:${memory.scope?.kind === 'project' ? memory.scope.project_id : memory.project_id}`
                : `conversation:${memory.chat_id}`
          }
          onChange={(event) => {
            const [kind, id] = event.target.value.split(':')
            const scope =
              kind === 'global'
                ? ({ kind: 'global' } as const)
                : kind === 'project' && id
                  ? ({ kind: 'project', project_id: id } as const)
                  : ({ kind: 'conversation', chat_id: memory.chat_id } as const)
            void act({ memoryId: memory.memory_id, action: 'set_scope', scope })
          }}
        >
          <option value={`conversation:${memory.chat_id}`}>This conversation</option>
          {projects.map((item) => (
            <option key={item.project_id} value={`project:${item.project_id}`}>
              Project: {item.name}
            </option>
          ))}
          <option value="global">Confirmed global</option>
        </select>
        {!memory.user_confirmed && (
          <button onClick={() => void act({ memoryId: memory.memory_id, action: 'confirm' })}>
            Confirm
          </button>
        )}
        <button onClick={() => setEditing(true)}>Edit</button>
        <button
          onClick={() =>
            void act({ memoryId: memory.memory_id, action: memory.pinned ? 'unpin' : 'pin' })
          }
        >
          {memory.pinned ? 'Unpin' : 'Pin'}
        </button>
        <button onClick={() => void act({ memoryId: memory.memory_id, action: 'reject' })}>
          Reject
        </button>
        <button onClick={() => void act({ memoryId: memory.memory_id, action: 'delete' })}>
          Delete
        </button>
        {(memory.state === 'disputed' || memory.type === 'unresolved_conflict') && (
          <>
            <button
              onClick={() =>
                void act({
                  memoryId: memory.memory_id,
                  action: 'resolve_conflict',
                  resolution: 'confirm'
                })
              }
            >
              Resolve as current
            </button>
            <button
              onClick={() =>
                void act({
                  memoryId: memory.memory_id,
                  action: 'resolve_conflict',
                  resolution: 'reject'
                })
              }
            >
              Resolve as rejected
            </button>
          </>
        )}
        {targets.length > 0 && (
          <button onClick={() => setRelationship(relationship ? null : 'merge')}>Relate</button>
        )}
      </div>
      {relationship && (
        <div className="relationship-editor">
          <select
            value={relationship}
            onChange={(event) => setRelationship(event.target.value as 'merge' | 'supersede')}
          >
            <option value="merge">Merge into</option>
            <option value="supersede">Mark superseded by</option>
          </select>
          <select value={targetId} onChange={(event) => setTargetId(event.target.value)}>
            <option value="">Choose memory…</option>
            {targets.map((target) => (
              <option key={target.memory_id} value={target.memory_id}>
                {target.statement.slice(0, 70)}
              </option>
            ))}
          </select>
          <button
            disabled={!targetId}
            onClick={() => {
              if (!targetId) return
              void act(
                relationship === 'merge'
                  ? { memoryId: memory.memory_id, action: 'merge', targetId }
                  : { memoryId: memory.memory_id, action: 'supersede', replacementId: targetId }
              ).then(() => setRelationship(null))
            }}
          >
            Apply
          </button>
        </div>
      )}
    </article>
  )
}

function ProvidersPanel({
  projects,
  chats,
  onNotice
}: {
  projects: Project[]
  chats: Chat[]
  onNotice: (message: string) => void
}): React.JSX.Element {
  const [connectors, setConnectors] = useState<ConnectorCapabilitiesView[]>([])
  const [providerMemories, setProviderMemories] = useState<ProviderMemory[]>([])
  useEffect(() => {
    void Promise.all([
      window.memoryBridge.listConnectors(),
      window.memoryBridge.listProviderMemories()
    ]).then(([nextConnectors, nextMemories]) => {
      setConnectors(nextConnectors)
      setProviderMemories(nextMemories)
    })
  }, [])
  const act = async (
    input: Parameters<typeof window.memoryBridge.providerMemoryAction>[0]
  ): Promise<void> => {
    try {
      setProviderMemories(await window.memoryBridge.providerMemoryAction(input))
      onNotice('Provider memory review saved.')
    } catch (error) {
      onNotice(errorMessage(error))
    }
  }
  return (
    <div className="panel-content">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">HONEST CAPABILITIES</p>
          <h2>Providers</h2>
        </div>
      </div>
      <div className="memory-list">
        {connectors.map((connector) => (
          <article className="memory-card" key={connector.id}>
            <div className="memory-top">
              <b>{connector.name}</b>
              <span className="state">{connector.id}</span>
            </div>
            <p>{connector.description}</p>
            <div className="memory-dates">
              {Object.entries(connector.capabilities).map(([name, supported]) => (
                <span key={name}>
                  {supported ? 'Available' : 'Unavailable'}: {humanize(name)}
                </span>
              ))}
            </div>
          </article>
        ))}
      </div>
      <h3>Provider memory records for review</h3>
      {providerMemories.map((memory) => (
        <ProviderMemoryCard
          key={memory.provider_memory_id}
          memory={memory}
          allMemories={providerMemories}
          projects={projects}
          chats={chats}
          act={act}
        />
      ))}
      {providerMemories.length === 0 && (
        <PanelEmpty
          icon="◇"
          title="No provider memories imported"
          copy="Provider memories remain separate and reviewable; they are never silently promoted into confirmed MemoryBridge memory."
        />
      )}
    </div>
  )
}

function ProviderMemoryCard({
  memory,
  allMemories,
  projects,
  chats,
  act
}: {
  memory: ProviderMemory
  allMemories: ProviderMemory[]
  projects: Project[]
  chats: Chat[]
  act: (input: Parameters<typeof window.memoryBridge.providerMemoryAction>[0]) => Promise<void>
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [statement, setStatement] = useState(memory.statement)
  const [replacementId, setReplacementId] = useState('')
  const targets = allMemories.filter(
    (item) =>
      item.provider_memory_id !== memory.provider_memory_id &&
      item.state !== 'deleted' &&
      JSON.stringify(item.scope) === JSON.stringify(memory.scope)
  )
  return (
    <article className="memory-card">
      <div className="memory-top">
        <b>{memory.provider}</b>
        <span className="state">{memory.state}</span>
      </div>
      {editing ? (
        <div className="memory-editor">
          <textarea value={statement} onChange={(event) => setStatement(event.target.value)} />
          <div>
            <button onClick={() => setEditing(false)}>Cancel</button>
            <button
              onClick={() =>
                void act({
                  providerMemoryId: memory.provider_memory_id,
                  action: 'edit',
                  statement
                }).then(() => setEditing(false))
              }
            >
              Save reviewed text
            </button>
          </div>
        </div>
      ) : (
        <p>{memory.statement}</p>
      )}
      <div className="memory-dates">
        <span>Source: {memory.source_label}</span>
        <span>Type: {memory.source_type.replaceAll('_', ' ')}</span>
        <span>
          Scope: {memory.scope.kind}
          {memory.scope.kind === 'provider' ? ` (${memory.scope.level})` : ''}
        </span>
        <span>User confirmed: {memory.user_confirmed ? 'yes' : 'no'}</span>
        {memory.raw_source_reference && <span>Reference: {memory.raw_source_reference}</span>}
      </div>
      <div className="memory-actions">
        <select
          aria-label="Provider memory scope"
          value={
            memory.scope.kind === 'global'
              ? 'global'
              : memory.scope.kind === 'project'
                ? `project:${memory.scope.project_id}`
                : memory.scope.kind === 'conversation'
                  ? `conversation:${memory.scope.chat_id}`
                  : ''
          }
          onChange={(event) => {
            const [kind, id] = event.target.value.split(':')
            if (!kind) return
            const scope =
              kind === 'global'
                ? ({ kind: 'global' } as const)
                : kind === 'project' && id
                  ? ({ kind: 'project', project_id: id } as const)
                  : id
                    ? ({ kind: 'conversation', chat_id: id } as const)
                    : null
            if (scope)
              void act({
                providerMemoryId: memory.provider_memory_id,
                action: 'change_scope',
                scope
              })
          }}
        >
          <option value="">Choose MemoryBridge scope</option>
          <option value="global">Global</option>
          {projects.map((project) => (
            <option key={project.project_id} value={`project:${project.project_id}`}>
              Project: {project.name}
            </option>
          ))}
          {chats.map((chat) => (
            <option key={chat.chat_id} value={`conversation:${chat.chat_id}`}>
              Conversation: {chat.title}
            </option>
          ))}
        </select>
        {!memory.user_confirmed && memory.state !== 'deleted' && (
          <button
            disabled={memory.scope.kind === 'provider'}
            onClick={() =>
              void act({ providerMemoryId: memory.provider_memory_id, action: 'confirm' })
            }
          >
            Confirm
          </button>
        )}
        <button onClick={() => setEditing(true)}>Edit</button>
        <button
          onClick={() =>
            void act({ providerMemoryId: memory.provider_memory_id, action: 'reject' })
          }
        >
          Reject
        </button>
        <button
          onClick={() =>
            void act({ providerMemoryId: memory.provider_memory_id, action: 'delete' })
          }
        >
          Delete
        </button>
      </div>
      {targets.length > 0 && (
        <div className="relationship-editor">
          <select value={replacementId} onChange={(event) => setReplacementId(event.target.value)}>
            <option value="">Choose superseding provider memory</option>
            {targets.map((target) => (
              <option key={target.provider_memory_id} value={target.provider_memory_id}>
                {target.statement.slice(0, 70)}
              </option>
            ))}
          </select>
          <button
            disabled={!replacementId}
            onClick={() =>
              replacementId &&
              void act({
                providerMemoryId: memory.provider_memory_id,
                action: 'supersede',
                replacementId
              })
            }
          >
            Mark superseded
          </button>
        </div>
      )}
    </article>
  )
}

function TopicsPanel({
  selectedChatId,
  onNotice
}: {
  selectedChatId: string | null
  onNotice: (message: string) => void
}): React.JSX.Element {
  const [topics, setTopics] = useState<TopicSegment[]>([])
  useEffect(() => {
    void window.memoryBridge.listTopics(selectedChatId ?? undefined).then(setTopics)
  }, [selectedChatId])
  return (
    <div className="panel-content">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">DETERMINISTIC SEGMENTS</p>
          <h2>Topics</h2>
        </div>
        <span>{topics.length}</span>
      </div>
      {topics.map((topic) => (
        <article className="memory-card" key={topic.topic_id}>
          <div className="memory-top">
            <b>{topic.label}</b>
            <span className="state">#{topic.ordinal + 1}</span>
          </div>
          <p>
            {topic.message_ids.length} messages · {topic.character_count.toLocaleString()}{' '}
            characters
          </p>
          <small>
            {new Date(topic.started_at).toLocaleString()} →{' '}
            {new Date(topic.ended_at).toLocaleString()}
          </small>
          <div className="memory-dates">
            <span>
              Project classification:{' '}
              {topic.project_id
                ? `${topic.project_id.slice(0, 16)}… (${Math.round((topic.project_confidence ?? 0) * 100)}%)`
                : 'unassigned'}
            </span>
            {topic.project_reason && <span>{topic.project_reason}</span>}
          </div>
          <div className="memory-actions">
            <button
              onClick={async () => {
                const result = await window.memoryBridge.reprocessSegment(topic.topic_id)
                setTopics(await window.memoryBridge.listTopics(selectedChatId ?? undefined))
                onNotice(
                  `Segment processing complete: ${result.processedSegments} changed, ${result.failedSegments} failed.`
                )
              }}
            >
              Reprocess this segment
            </button>
          </div>
        </article>
      ))}
      {topics.length === 0 && (
        <PanelEmpty
          icon="◫"
          title="No topic segments yet"
          copy="Run full-chat processing from Vault settings. Only complete messages become authoritative segments."
        />
      )}
    </div>
  )
}

function ImportPanel({
  onImported,
  onNotice
}: {
  onImported: () => Promise<void>
  onNotice: (message: string) => void
}): React.JSX.Element {
  const [preview, setPreview] = useState<ImportPreviewResult | null>(null)
  const [records, setRecords] = useState<ImportRecord[]>([])
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<ImportProgressView | null>(null)
  const [activeToken, setActiveToken] = useState<string | null>(null)
  useEffect(() => {
    void window.memoryBridge.listImportRecords().then(setRecords)
    return window.memoryBridge.onImportProgress(setProgress)
  }, [])
  const choose = async (): Promise<void> => {
    try {
      setPreview(await window.memoryBridge.chooseImport())
    } catch (error) {
      onNotice(errorMessage(error))
    }
  }
  const execute = async (): Promise<void> => {
    if (!preview) return
    setBusy(true)
    setActiveToken(preview.token)
    try {
      const record = await window.memoryBridge.executeImport({ token: preview.token })
      setRecords((current) => [record, ...current])
      setPreview(null)
      await onImported()
      onNotice(
        `Import ${record.status}: ${record.imported_count} added, ${record.changed_count} changed, ${record.skipped_count} unchanged.`
      )
    } catch (error) {
      onNotice(errorMessage(error))
    } finally {
      setBusy(false)
      setActiveToken(null)
    }
  }
  const scan = async (): Promise<void> => {
    setBusy(true)
    try {
      const next = await window.memoryBridge.scanImportInbox()
      setRecords((current) => [...next, ...current])
      await onImported()
      onNotice(`Inbox scan processed ${next.length} file${next.length === 1 ? '' : 's'}.`)
    } catch (error) {
      onNotice(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="panel-content">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">LOCAL INGESTION</p>
          <h2>Imports & sync</h2>
        </div>
      </div>
      <p>
        Import a ChatGPT export ZIP or generic JSON, JSONL, Markdown, or text file. This is archive
        import, not live provider synchronization. Files stay local.
      </p>
      <div className="memory-actions">
        <button disabled={busy} onClick={() => void choose()}>
          Choose file
        </button>
        <button disabled={busy} onClick={() => void scan()}>
          Scan vault inbox
        </button>
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              const loaded = await window.memoryBridge.loadDemoArchive()
              setRecords((current) => [loaded.importRecord, ...current])
              await onImported()
              onNotice(
                `Synthetic demo loaded: ${loaded.importRecord.imported_count} conversations, ${loaded.processing.memories.length} extracted memories.`
              )
            } catch (error) {
              onNotice(errorMessage(error))
            } finally {
              setBusy(false)
            }
          }}
        >
          Load synthetic demo
        </button>
      </div>
      {busy && progress && (
        <div className="import-progress" role="status">
          <b>{humanize(progress.phase)}</b>
          <span>
            {progress.totalBytes
              ? `${Math.min(100, Math.round((progress.processedBytes / progress.totalBytes) * 100))}%`
              : `${progress.completedConversations} of ${progress.totalConversations || '?'} conversations`}
          </span>
          {activeToken && (
            <button onClick={() => void window.memoryBridge.cancelImport(activeToken)}>
              Cancel import
            </button>
          )}
        </div>
      )}
      {preview && (
        <article className="memory-card">
          <div className="memory-top">
            <b>{preview.fileName}</b>
            <span className="state">preview</span>
          </div>
          <p>
            {preview.conversations} conversations · {preview.messages} messages ·{' '}
            {preview.providerMemories} provider memories
          </p>
          {preview.warnings.map((warning) => (
            <small key={warning}>{warning}</small>
          ))}
          <div className="memory-actions">
            <button disabled={busy} onClick={() => void execute()}>
              Import now
            </button>
            <button onClick={() => setPreview(null)}>Cancel</button>
          </div>
        </article>
      )}
      {records.map((record) => (
        <article className="memory-card" key={record.import_id}>
          <div className="memory-top">
            <b>{record.connector_id}</b>
            <span className="state">{record.status}</span>
          </div>
          <p>
            {record.imported_count} added · {record.changed_count} changed · {record.skipped_count}{' '}
            unchanged · {record.review_count} requiring review · {record.error_count} errors
          </p>
          <div className="memory-dates">
            <span>Connector: {record.connector_version}</span>
            <span>Archive hash: {record.archive_hash.slice(0, 16)}…</span>
            <span>Discovered: {record.discovered_count}</span>
            <span>Branches handled: {record.branches_handled}</span>
            <span>Malformed: {record.malformed_count}</span>
            <span>Validation: {record.validation_status.replaceAll('_', ' ')}</span>
          </div>
          <button
            onClick={async () => {
              try {
                const validated = await window.memoryBridge.validateImport(record.import_id)
                setRecords((current) =>
                  current.map((item) => (item.import_id === validated.import_id ? validated : item))
                )
                onNotice(
                  validated.validation_status === 'passed'
                    ? 'Import verification passed.'
                    : `Import verification found ${validated.validation_issues.length} warning(s).`
                )
              } catch (error) {
                onNotice(errorMessage(error))
              }
            }}
          >
            Verify imported archive
          </button>
          {record.validation_issues.map((issue) => (
            <small className="inline-error" key={issue}>
              {issue}
            </small>
          ))}
          {record.error_messages.map((message) => (
            <small className="inline-error" key={message}>
              {message}
            </small>
          ))}
        </article>
      ))}
    </div>
  )
}

function StoragePanel({
  vault,
  onNotice
}: {
  vault: VaultStatus
  onNotice: (message: string) => void
}): React.JSX.Element {
  const [stats, setStats] = useState<VaultStorageStats | null>(null)
  const [progress, setProgress] = useState<StorageProgress | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(
    async (refresh = false): Promise<void> => {
      setBusy(true)
      try {
        setStats(await window.memoryBridge.getVaultStorage(refresh))
      } catch (error) {
        onNotice(errorMessage(error))
      } finally {
        setBusy(false)
      }
    },
    [onNotice]
  )
  useEffect(() => {
    void load()
    return window.memoryBridge.onStorageProgress(setProgress)
  }, [load])
  const rows: Array<[string, number | null]> = stats
    ? [
        ['Total vault', stats.totalVaultBytes],
        ['Raw transcripts', stats.transcriptBytes],
        ['Index and database', stats.indexBytes],
        ['Structured memory', stats.structuredMemoryBytes],
        ['Evidence', stats.evidenceBytes],
        ['Embedding payload', stats.embeddingBytes],
        ['Attachments', stats.attachmentBytes],
        ['Retained import archives', stats.importArchiveBytes]
      ]
    : []
  return (
    <div className="panel-content storage-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">SELECTED VAULT</p>
          <h2>Vault storage</h2>
        </div>
      </div>
      {!stats ? (
        <PanelEmpty
          icon="◫"
          title={busy ? 'Calculating storage' : 'Storage is unavailable'}
          copy={
            progress
              ? `${progress.scannedFiles} files inspected (${formatHumanBytes(progress.scannedBytes)}).`
              : 'Refresh to calculate capacity without reading file contents.'
          }
        />
      ) : (
        <>
          <section className="storage-identity">
            <h3>{stats.vaultName || 'MemoryBridge vault'}</h3>
            <p className="path-copy">{stats.path}</p>
            <div className="memory-dates">
              <span>Vault ID: {stats.vaultId}</span>
              <span>Connection: {stats.connectionStatus}</span>
              <span>Write status: {stats.writeStatus}</span>
              <span>Storage type: {stats.storageType}</span>
              <span>Volume: {stats.volumeName ?? 'Unavailable'}</span>
              <span>Filesystem ID: {stats.filesystem ?? 'Unavailable'}</span>
            </div>
          </section>
          <section>
            <h3>Device capacity</h3>
            <div className="storage-metrics">
              <span>
                <b>{formatHumanBytes(stats.totalDeviceBytes)}</b>
                Total
              </span>
              <span>
                <b>{formatHumanBytes(stats.freeDeviceBytes)}</b>
                Free
              </span>
              <span>
                <b>{formatHumanBytes(stats.usedDeviceBytes)}</b>
                Used
              </span>
            </div>
          </section>
          <section>
            <h3>MemoryBridge data</h3>
            <dl className="storage-breakdown">
              {rows.map(([label, bytes]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{formatHumanBytes(bytes)}</dd>
                </div>
              ))}
            </dl>
          </section>
          <section>
            <h3>Vault records</h3>
            <div className="storage-metrics">
              <span>
                <b>{stats.projects.toLocaleString()}</b>
                Projects
              </span>
              <span>
                <b>{stats.chats.toLocaleString()}</b>
                Chats
              </span>
              <span>
                <b>{stats.messages.toLocaleString()}</b>
                Messages
              </span>
              <span>
                <b>{stats.memories.toLocaleString()}</b>
                Memories
              </span>
            </div>
            <small>Last calculated {new Date(stats.calculatedAt).toLocaleString()}</small>
          </section>
          {stats.warnings.map((warning) => (
            <p className="inline-error" key={warning}>
              {warning}
            </p>
          ))}
        </>
      )}
      <div className="row-actions">
        <button disabled={busy || !vault.writable} onClick={() => void load(true)}>
          Refresh capacity
        </button>
        {busy && (
          <button onClick={() => void window.memoryBridge.cancelVaultStorage()}>
            Cancel calculation
          </button>
        )}
        <button
          disabled={!vault.writable}
          onClick={async () => {
            try {
              const result = await window.memoryBridge.verifyVaultLocation()
              onNotice(
                `Vault location verified at ${new Date(result.checkedAt).toLocaleTimeString()}.`
              )
            } catch (error) {
              onNotice(errorMessage(error))
            }
          }}
        >
          Verify vault location
        </button>
      </div>
    </div>
  )
}

function McpPanel(): React.JSX.Element {
  const [configuration, setConfiguration] = useState<McpConfiguration | null>(null)
  useEffect(() => {
    void window.memoryBridge.getMcpConfiguration().then(setConfiguration)
  }, [])
  const text = configuration
    ? JSON.stringify(
        { command: configuration.command, args: configuration.args, env: configuration.env },
        null,
        2
      )
    : ''
  return (
    <div className="panel-content">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">LOCAL STDIO</p>
          <h2>MCP & integrations</h2>
        </div>
      </div>
      <p>
        Connect another AI client to bounded, cited retrieval tools. The server has no
        filesystem-browsing tool and never returns a full-vault dump.
      </p>
      <pre className="mcp-config">{text || 'Preparing configuration…'}</pre>
      <button disabled={!text} onClick={() => void navigator.clipboard.writeText(text)}>
        Copy MCP configuration
      </button>
      <small>
        Available tools: search_memory, project state, decisions, open questions, completed items,
        related conversations, excerpts, evidence, projects, and provider memories.
      </small>
    </div>
  )
}

function SearchPanel({
  projects,
  chats,
  onSelectChat
}: {
  projects: Project[]
  chats: Chat[]
  onSelectChat: (id: string, messageId?: string) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [projectId, setProjectId] = useState<string>('')
  const [chatId, setChatId] = useState('')
  const [memoryType, setMemoryType] = useState<Memory['type'] | ''>('')
  const [memoryState, setMemoryState] = useState<Memory['state'] | ''>('')
  const [provider, setProvider] = useState('')
  const [sourceType, setSourceType] = useState<'' | 'conversation' | 'memory' | 'provider_memory'>(
    ''
  )
  const [topicId, setTopicId] = useState('')
  const [topics, setTopics] = useState<TopicSegment[]>([])
  const [confirmedOnly, setConfirmedOnly] = useState(false)
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [includeHistory, setIncludeHistory] = useState(false)
  const [results, setResults] = useState<SearchResult[]>([])
  useEffect(() => {
    void window.memoryBridge.listTopics(chatId || undefined).then(setTopics)
  }, [chatId])
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
        provider: provider || undefined,
        sourceType: sourceType || undefined,
        topicId: topicId || undefined,
        confirmedOnly,
        fromDate: fromDate || undefined,
        toDate: toDate || undefined,
        includeHistory,
        allProjects: !projectId && !chatId,
        limit: 40
      })
    )
  }
  return (
    <div className="panel-content">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">LOCAL FTS5</p>
          <h2>Search archive</h2>
        </div>
      </div>
      <form className="search-form" onSubmit={(event) => void search(event)}>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search messages and memories"
        />
        <div className="search-filter-grid">
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            <option value="">All projects</option>
            {projects.map((project) => (
              <option key={project.project_id} value={project.project_id}>
                {project.name}
              </option>
            ))}
          </select>
          <select value={chatId} onChange={(event) => setChatId(event.target.value)}>
            <option value="">All chats</option>
            {chats
              .filter((chat) => !projectId || chat.project_id === projectId)
              .map((chat) => (
                <option key={chat.chat_id} value={chat.chat_id}>
                  {chat.title}
                </option>
              ))}
          </select>
          <select
            aria-label="Memory type"
            value={memoryType}
            onChange={(event) => setMemoryType(event.target.value as Memory['type'] | '')}
          >
            <option value="">All memory types</option>
            {[
              'decision',
              'agreement',
              'completed_item',
              'fact',
              'preference',
              'instruction',
              'commitment',
              'open_question',
              'project_state',
              'rejected_option',
              'correction',
              'constraint',
              'deadline',
              'person',
              'organization',
              'artifact',
              'unresolved_conflict'
            ].map((type) => (
              <option key={type} value={type}>
                {type.replace('_', ' ')}
              </option>
            ))}
          </select>
          <select value={provider} onChange={(event) => setProvider(event.target.value)}>
            <option value="">All providers</option>
            {[...new Set(chats.map((chat) => chat.source_provider))].map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
          <select
            aria-label="Source type"
            value={sourceType}
            onChange={(event) =>
              setSourceType(
                event.target.value as '' | 'conversation' | 'memory' | 'provider_memory'
              )
            }
          >
            <option value="">All source types</option>
            <option value="conversation">Conversations and messages</option>
            <option value="memory">MemoryBridge memories</option>
            <option value="provider_memory">Provider memory</option>
          </select>
          <select value={topicId} onChange={(event) => setTopicId(event.target.value)}>
            <option value="">All topics</option>
            {topics.map((topic) => (
              <option key={topic.topic_id} value={topic.topic_id}>
                {topic.label}
              </option>
            ))}
          </select>
          <select
            aria-label="Memory state"
            value={memoryState}
            onChange={(event) => setMemoryState(event.target.value as Memory['state'] | '')}
          >
            <option value="">All active states</option>
            {[
              'active',
              'confirmed',
              'completed',
              'needs_review',
              'superseded',
              'rejected',
              'disputed'
            ].map((state) => (
              <option key={state} value={state}>
                {state}
              </option>
            ))}
          </select>
          <label>
            From
            <input
              type="date"
              value={fromDate}
              onChange={(event) => setFromDate(event.target.value)}
            />
          </label>
          <label>
            Through
            <input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} />
          </label>
        </div>
        <div className="search-history-row">
          <label>
            <input
              type="checkbox"
              checked={includeHistory}
              onChange={(event) => setIncludeHistory(event.target.checked)}
            />{' '}
            Include rejected and superseded history
          </label>
          <label>
            <input
              type="checkbox"
              checked={confirmedOnly}
              onChange={(event) => setConfirmedOnly(event.target.checked)}
            />{' '}
            Confirmed only
          </label>
          <button type="submit">Search</button>
        </div>
      </form>
      <div className="search-results">
        {results.map((result) => (
          <button
            key={`${result.kind}-${result.id}`}
            disabled={!result.chatId}
            onClick={() => {
              if (result.chatId) onSelectChat(result.chatId, result.sourceMessageIds[0])
            }}
          >
            <span className="result-kind">{result.kind}</span>
            <b>{result.title}</b>
            <p>{result.excerpt}</p>
            {result.memoryType && (
              <small>
                {result.memoryType} · {result.state}
              </small>
            )}
          </button>
        ))}
        {results.length === 0 && (
          <PanelEmpty
            icon="⌕"
            title="Search stays on your device"
            copy="Keyword search works without an API key. Historical and rejected memories are hidden by default."
          />
        )}
      </div>
    </div>
  )
}

function SettingsPanel({
  state,
  selectedChatId,
  onSettings,
  onMemories,
  onProjectUpdated,
  onBootstrap,
  onNotice
}: {
  state: BootstrapState
  selectedChatId: string | null
  onSettings: (settings: AppSettings) => void
  onMemories: (memories: Memory[]) => void
  onProjectUpdated: (project: Project) => void
  onBootstrap: (state: BootstrapState) => void
  onNotice: (message: string) => void
}): React.JSX.Element {
  const [settings, setSettings] = useState(state.settings)
  const [apiKey, setApiKey] = useState('')
  const [processingProjectId, setProcessingProjectId] = useState(
    state.projects[0]?.project_id ?? ''
  )
  const [providerCapabilities, setProviderCapabilities] = useState<
    Awaited<ReturnType<typeof window.memoryBridge.testConnection>>['capabilities'] | null
  >(state.settings.providerCapabilities)
  const save = async (): Promise<void> => {
    const saved = await window.memoryBridge.updateSettings(settings)
    onSettings(saved)
    onNotice('Settings saved.')
  }
  return (
    <div className="panel-content settings">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">CONTROL & TRANSPARENCY</p>
          <h2>Settings</h2>
        </div>
      </div>
      <section>
        <h3>Provider</h3>
        <p className="path-copy">
          ChatGPT subscriptions and API access are billed and authenticated separately. Offline
          import, storage, indexing, browsing, and keyword search do not require an API key.
        </p>
        <label>
          Mode
          <select
            value={settings.mockMode ? 'mock' : 'openai-compatible'}
            onChange={(event) =>
              setSettings({
                ...settings,
                mockMode: event.target.value === 'mock',
                provider: event.target.value as AppSettings['provider']
              })
            }
          >
            <option value="mock">Mock (no key required)</option>
            <option value="openai-compatible">OpenAI-compatible</option>
          </select>
        </label>
        <label>
          API base URL
          <input
            value={settings.apiBaseUrl}
            onChange={(event) => setSettings({ ...settings, apiBaseUrl: event.target.value })}
          />
        </label>
        <label>
          Chat model
          <input
            value={settings.chatModel}
            onChange={(event) => setSettings({ ...settings, chatModel: event.target.value })}
          />
        </label>
        <label>
          Extraction model
          <input
            value={settings.extractionModel}
            onChange={(event) => setSettings({ ...settings, extractionModel: event.target.value })}
          />
        </label>
        <label>
          Embedding model
          <input
            value={settings.embeddingModel}
            onChange={(event) => setSettings({ ...settings, embeddingModel: event.target.value })}
          />
        </label>
        <label>
          API key
          <input
            type="password"
            autoComplete="off"
            value={apiKey}
            placeholder={
              state.hasStoredApiKey ? 'Stored securely. Enter to replace.' : 'Not stored'
            }
            onChange={(event) => setApiKey(event.target.value)}
          />
        </label>
        <div className="row-actions">
          <button
            onClick={async () => {
              if (apiKey) {
                await window.memoryBridge.saveApiKey(apiKey)
                setApiKey('')
                onBootstrap(await window.memoryBridge.bootstrap())
                onNotice('API key encrypted with Windows secure storage.')
              }
            }}
          >
            Save key
          </button>
          <button
            onClick={async () => {
              const result = await window.memoryBridge.testConnection()
              setProviderCapabilities(result.capabilities)
              onNotice(result.message)
            }}
          >
            Test authentication
          </button>
          <button
            onClick={async () => {
              await window.memoryBridge.clearApiKey()
              onBootstrap(await window.memoryBridge.bootstrap())
              onNotice('Stored API key removed.')
            }}
          >
            Clear key
          </button>
        </div>
        {providerCapabilities && (
          <div className="capability-grid">
            {(
              [
                'chat',
                'streaming',
                'structuredOutput',
                'embeddings',
                'modelListing',
                'cancellation'
              ] as const
            ).map((name) => (
              <button
                key={name}
                onClick={async () => {
                  const result = await window.memoryBridge.testProviderCapability(name)
                  setProviderCapabilities(result.capabilities)
                  onNotice(result.message)
                }}
              >
                <b>{humanize(name)}</b>
                <span>{providerCapabilities[name] ? 'available' : 'not detected'}</span>
              </button>
            ))}
            <small>
              Advanced extraction is available only when structured output passes its own test.
            </small>
          </div>
        )}
      </section>
      <section>
        <h3>Memory</h3>
        <Toggle
          label="Automatic extraction"
          checked={settings.memoryExtractionEnabled}
          onChange={(value) => setSettings({ ...settings, memoryExtractionEnabled: value })}
        />
        <Toggle
          label="Semantic indexing"
          checked={settings.semanticIndexingEnabled}
          onChange={(value) => setSettings({ ...settings, semanticIndexingEnabled: value })}
        />
        <Toggle
          label="Include current-conversation memory"
          checked={settings.includeConversationScope}
          onChange={(value) => setSettings({ ...settings, includeConversationScope: value })}
        />
        <label>
          Maximum retrieved memories
          <input
            type="number"
            min="0"
            max="50"
            value={settings.maximumRetrievedMemories}
            onChange={(event) =>
              setSettings({ ...settings, maximumRetrievedMemories: Number(event.target.value) })
            }
          />
        </label>
        <label>
          Context character budget
          <input
            type="number"
            min="0"
            max="50000"
            value={settings.retrievalCharacterBudget}
            onChange={(event) =>
              setSettings({ ...settings, retrievalCharacterBudget: Number(event.target.value) })
            }
          />
        </label>
        <label>
          Recent chat budget
          <input
            type="number"
            min="0"
            max="100000"
            value={settings.recentChatCharacterBudget}
            onChange={(event) =>
              setSettings({ ...settings, recentChatCharacterBudget: Number(event.target.value) })
            }
          />
        </label>
        <label>
          Transcript excerpt budget
          <input
            type="number"
            min="0"
            max="50000"
            value={settings.transcriptExcerptCharacterBudget}
            onChange={(event) =>
              setSettings({
                ...settings,
                transcriptExcerptCharacterBudget: Number(event.target.value)
              })
            }
          />
        </label>
        <label>
          Extraction budget
          <input
            type="number"
            min="1000"
            max="250000"
            value={settings.extractionCharacterBudget}
            onChange={(event) =>
              setSettings({ ...settings, extractionCharacterBudget: Number(event.target.value) })
            }
          />
        </label>
        <label>
          Segmentation budget
          <input
            type="number"
            min="1000"
            max="250000"
            value={settings.segmentationCharacterBudget}
            onChange={(event) =>
              setSettings({ ...settings, segmentationCharacterBudget: Number(event.target.value) })
            }
          />
        </label>
        <label>
          Embedding input budget
          <input
            type="number"
            min="100"
            max="50000"
            value={settings.embeddingCharacterBudget}
            onChange={(event) =>
              setSettings({ ...settings, embeddingCharacterBudget: Number(event.target.value) })
            }
          />
        </label>
        <label>
          Output token budget
          <input
            type="number"
            min="128"
            max="100000"
            value={settings.outputTokenBudget}
            onChange={(event) =>
              setSettings({ ...settings, outputTokenBudget: Number(event.target.value) })
            }
          />
        </label>
      </section>
      <ProjectEditor projects={state.projects} onUpdated={onProjectUpdated} />
      <section>
        <h3>Vault & maintenance</h3>
        <p className="path-copy">{state.vault.path}</p>
        <button
          onClick={async () => {
            onBootstrap(await window.memoryBridge.chooseAndOpenVault())
            onNotice('Vault location reconnected.')
          }}
        >
          Reconnect or locate vault
        </button>
        <button
          onClick={async () =>
            onNotice(`Rebuilt index: ${JSON.stringify(await window.memoryBridge.rebuildIndex())}`)
          }
        >
          Rebuild local index
        </button>
        {selectedChatId && (
          <button
            onClick={async () => {
              const result = await window.memoryBridge.reprocessChat(selectedChatId)
              onMemories(await window.memoryBridge.listMemories())
              onBootstrap(await window.memoryBridge.bootstrap())
              onNotice(
                `Full-chat processing complete: ${result.processedSegments} changed, ${result.skippedSegments} unchanged, ${result.memories.length} new memories.`
              )
            }}
          >
            Force reprocess selected chat
          </button>
        )}
        <label>
          Project processing scope
          <select
            value={processingProjectId}
            onChange={(event) => setProcessingProjectId(event.target.value)}
          >
            <option value="">Choose project</option>
            {state.projects.map((project) => (
              <option key={project.project_id} value={project.project_id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={!processingProjectId}
          onClick={async () => {
            if (!processingProjectId) return
            const result = await window.memoryBridge.reprocessProject(processingProjectId)
            onMemories(await window.memoryBridge.listMemories())
            onBootstrap(await window.memoryBridge.bootstrap())
            onNotice(
              `Project processing complete: ${result.chats} chats, ${result.processedSegments} changed, ${result.failedSegments} failed.`
            )
          }}
        >
          Reprocess every chat in project
        </button>
        <button
          onClick={async () => {
            const result = await window.memoryBridge.reprocessVault()
            onMemories(await window.memoryBridge.listMemories())
            onBootstrap(await window.memoryBridge.bootstrap())
            onNotice(
              `Resume complete: ${result.chats} chats checked, ${result.processedSegments} processed, ${result.skippedSegments} already complete, ${result.failedSegments} failed.`
            )
          }}
        >
          Resume new, changed, or failed processing
        </button>
        <button
          onClick={async () => {
            const result = await window.memoryBridge.rebuildVaultIntelligence()
            onMemories(await window.memoryBridge.listMemories())
            onBootstrap(await window.memoryBridge.bootstrap())
            onNotice(
              `Derived-intelligence rebuild complete: ${result.chats} chats, ${result.processedSegments} segments, ${result.failedSegments} failed. Manual and explicitly confirmed memories were preserved.`
            )
          }}
        >
          Rebuild vault-derived intelligence
        </button>
        <button
          onClick={async () =>
            onNotice(`Diagnostics saved to ${(await window.memoryBridge.exportDiagnostics()).path}`)
          }
        >
          Export content-free diagnostics
        </button>
        <button
          onClick={async () => {
            await navigator.clipboard.writeText(await window.memoryBridge.getDiagnosticReport())
            onNotice('Content-free diagnostic report copied.')
          }}
        >
          Copy diagnostic report
        </button>
      </section>
      <section className="transparency">
        <h3>MemoryBridge {state.applicationVersion}</h3>
        <h4>What leaves this device?</h4>
        <p>
          Chat text goes only to your configured provider when you send it. Extraction and
          embeddings may send selected text when enabled. The vault, indexes, and transcripts remain
          in your chosen folder. API keys are stored separately with Windows encryption. Disabling
          extraction never disables transcript saving.
        </p>
      </section>
      <button className="primary save-settings" onClick={() => void save()}>
        Save settings
      </button>
    </div>
  )
}

function ProjectEditor({
  projects,
  onUpdated
}: {
  projects: Project[]
  onUpdated: (project: Project) => void
}): React.JSX.Element {
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
      {projects.length === 0 ? (
        <p className="path-copy">Create a project from the sidebar to edit it here.</p>
      ) : (
        <>
          <label>
            Project
            <select value={projectId} onChange={(event) => choose(event.target.value)}>
              {projects.map((project) => (
                <option key={project.project_id} value={project.project_id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Name
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            Description
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <button
            onClick={async () => {
              if (!projectId || !name.trim()) return
              onUpdated(
                await window.memoryBridge.updateProject({
                  projectId,
                  name: name.trim(),
                  description
                })
              )
            }}
          >
            Save project details
          </button>
        </>
      )}
    </section>
  )
}

function Toggle({
  label,
  checked,
  onChange
}: {
  label: string
  checked: boolean
  onChange: (value: boolean) => void
}): React.JSX.Element {
  return (
    <label className="toggle">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <i />
    </label>
  )
}

function PanelEmpty({
  icon,
  title,
  copy
}: {
  icon: string
  title: string
  copy: string
}): React.JSX.Element {
  return (
    <div className="panel-empty">
      <span>{icon}</span>
      <h3>{title}</h3>
      <p>{copy}</p>
    </div>
  )
}

function EmptyChat(): React.JSX.Element {
  return (
    <div className="empty-chat">
      <span>⌁</span>
      <h2>A clean thread, backed by memory.</h2>
      <p>Write a message. It will be saved before a response begins.</p>
    </div>
  )
}

function NoChat({ onNew, disabled }: { onNew: () => void; disabled: boolean }): React.JSX.Element {
  return (
    <div className="no-chat">
      <BrandMark large />
      <h1>Where should we pick up?</h1>
      <p>Start a focused conversation or choose one from your archive.</p>
      <button className="primary" onClick={onNew} disabled={disabled}>
        New conversation
      </button>
    </div>
  )
}

function DisconnectedBanner({
  vault,
  onReconnect
}: {
  vault: VaultStatus
  onReconnect: () => Promise<void>
}): React.JSX.Element {
  return (
    <div className="disconnect-banner">
      <b>{vault.connected ? 'Vault opened read-only' : 'Vault disconnected'}</b>
      <span>
        {vault.connected
          ? 'Another live MemoryBridge process owns this vault.'
          : vault.path
            ? 'The selected drive or folder is unavailable.'
            : 'Locate your vault to continue.'}{' '}
        New messages are blocked and nothing is saved elsewhere.
      </span>
      <button onClick={() => void onReconnect()}>
        {vault.connected ? 'Try again' : 'Locate vault'}
      </button>
    </div>
  )
}

function upsertMessage(messages: Message[], message: Message): Message[] {
  const found = messages.some((item) => item.message_id === message.message_id)
  const next = found
    ? messages.map((item) => (item.message_id === message.message_id ? message : item))
    : [...messages, message]
  return next.sort((a, b) => a.sequence - b.sequence)
}
function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': /, '')
    : 'Something went wrong.'
}

function humanize(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
}
function formatBytes(bytes: number | null): string {
  return formatHumanBytes(bytes)
}
function formatHumanBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return 'Unavailable'
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / 1024 ** index
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`
}
function relativeDate(value: string): string {
  const days = Math.floor((Date.now() - Date.parse(value)) / 86_400_000)
  return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : `${days}d`
}
function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(
    new Date(value)
  )
}
function sortProjects(a: Project, b: Project): number {
  return a.name.localeCompare(b.name)
}
