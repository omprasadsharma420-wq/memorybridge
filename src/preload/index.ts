import { contextBridge, ipcRenderer } from 'electron'
import type { MemoryBridgeApi } from '../shared/contracts'
import type { Message } from '../shared/schemas'
import type { VaultStatus } from '../shared/contracts'

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
  rebuildIndex: () => ipcRenderer.invoke('index:rebuild'),
  rerunExtraction: (chatId) => ipcRenderer.invoke('extraction:rerun', { chatId }),
  exportDiagnostics: () => ipcRenderer.invoke('diagnostics:export'),
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
  }
}

contextBridge.exposeInMainWorld('memoryBridge', Object.freeze(api))
