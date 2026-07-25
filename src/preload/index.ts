import { contextBridge, ipcRenderer } from 'electron'
import type { MemoryBridgeApi } from '../shared/contracts'
import type { Message } from '../shared/schemas'
import type { VaultStatus } from '../shared/contracts'
import type { ProcessingProgress } from '../shared/contracts'
import type { ImportProgressView } from '../shared/contracts'
import type { StorageProgress } from '../shared/contracts'

const api: MemoryBridgeApi = {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  chooseAndCreateVault: () => ipcRenderer.invoke('vault:create'),
  chooseAndOpenVault: () => ipcRenderer.invoke('vault:open'),
  createProject: (input) => ipcRenderer.invoke('project:create', input),
  updateProject: (input) => ipcRenderer.invoke('project:update', input),
  createChat: (input) => ipcRenderer.invoke('chat:create', input),
  updateChat: (input) => ipcRenderer.invoke('chat:update', input),
  listChats: () => ipcRenderer.invoke('chat:list'),
  getMessages: (chatId) => ipcRenderer.invoke('chat:messages', { chatId }),
  getMessageRange: (chatId, afterSequence = -1, limit = 200) =>
    ipcRenderer.invoke('chat:message-range', { chatId, afterSequence, limit }),
  sendMessage: (input) => ipcRenderer.invoke('chat:send', input),
  retryMessage: (input) => ipcRenderer.invoke('chat:retry', input),
  stopGeneration: (chatId) => ipcRenderer.invoke('chat:stop', { chatId }),
  listMemories: (chatId) => ipcRenderer.invoke('memory:list', chatId ? { chatId } : {}),
  memoryAction: (input) => ipcRenderer.invoke('memory:action', input),
  search: (input) => ipcRenderer.invoke('search:run', input),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  saveApiKey: (apiKey) => ipcRenderer.invoke('credentials:save', { apiKey }),
  clearApiKey: () => ipcRenderer.invoke('credentials:clear'),
  testConnection: () => ipcRenderer.invoke('provider:test'),
  testProviderCapability: (capability) =>
    ipcRenderer.invoke('provider:test-capability', { capability }),
  rebuildIndex: () => ipcRenderer.invoke('index:rebuild'),
  getVaultStorage: (refresh = false) => ipcRenderer.invoke('storage:stats', { refresh }),
  cancelVaultStorage: () => ipcRenderer.invoke('storage:cancel'),
  verifyVaultLocation: () => ipcRenderer.invoke('storage:verify'),
  rerunExtraction: (chatId) => ipcRenderer.invoke('extraction:rerun', { chatId }),
  reprocessSegment: (topicId) => ipcRenderer.invoke('processing:segment', { topicId }),
  reprocessChat: (chatId) => ipcRenderer.invoke('processing:chat', { chatId }),
  reprocessProject: (projectId) => ipcRenderer.invoke('processing:project', { projectId }),
  reprocessVault: () => ipcRenderer.invoke('processing:vault'),
  rebuildVaultIntelligence: () => ipcRenderer.invoke('processing:rebuild-vault'),
  cancelReprocessing: (scopeId) => ipcRenderer.invoke('processing:cancel', { scopeId }),
  listConnectors: () => ipcRenderer.invoke('connector:list'),
  chooseImport: () => ipcRenderer.invoke('import:choose'),
  executeImport: (input) => ipcRenderer.invoke('import:execute', input),
  cancelImport: (token) => ipcRenderer.invoke('import:cancel', { token }),
  scanImportInbox: () => ipcRenderer.invoke('import:scan-inbox'),
  listImportRecords: () => ipcRenderer.invoke('import:list'),
  validateImport: (importId) => ipcRenderer.invoke('import:validate', { importId }),
  loadDemoArchive: () => ipcRenderer.invoke('import:demo'),
  listTopics: (chatId) => ipcRenderer.invoke('topic:list', chatId ? { chatId } : {}),
  listEvidence: (memoryId) => ipcRenderer.invoke('evidence:list', memoryId ? { memoryId } : {}),
  listProviderMemories: () => ipcRenderer.invoke('provider-memory:list'),
  providerMemoryAction: (input) => ipcRenderer.invoke('provider-memory:action', input),
  getMcpConfiguration: () => ipcRenderer.invoke('mcp:configuration'),
  exportDiagnostics: () => ipcRenderer.invoke('diagnostics:export'),
  getDiagnosticReport: () => ipcRenderer.invoke('diagnostics:report'),
  onStream: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, message: Message): void =>
      callback(message)
    ipcRenderer.on('chat:stream', listener)
    return () => ipcRenderer.removeListener('chat:stream', listener)
  },
  onVaultStatus: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, status: VaultStatus): void =>
      callback(status)
    ipcRenderer.on('vault:status', listener)
    return () => ipcRenderer.removeListener('vault:status', listener)
  },
  onProcessingProgress: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: ProcessingProgress): void =>
      callback(progress)
    ipcRenderer.on('processing:progress', listener)
    return () => ipcRenderer.removeListener('processing:progress', listener)
  },
  onImportProgress: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: ImportProgressView): void =>
      callback(progress)
    ipcRenderer.on('import:progress', listener)
    return () => ipcRenderer.removeListener('import:progress', listener)
  },
  onStorageProgress: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: StorageProgress): void =>
      callback(progress)
    ipcRenderer.on('storage:progress', listener)
    return () => ipcRenderer.removeListener('storage:progress', listener)
  }
}

contextBridge.exposeInMainWorld('memoryBridge', Object.freeze(api))
