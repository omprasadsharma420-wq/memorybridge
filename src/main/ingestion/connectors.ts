export interface ConnectorCapabilities {
  nativeCapture: boolean
  liveApiSync: boolean
  incrementalSync: boolean
  exportImport: boolean
  watchedFolderImport: boolean
  providerMemoryImport: boolean
  attachmentImport: boolean
  conversationBranchImport: boolean
}

export interface ConnectorDefinition {
  id: string
  name: string
  description: string
  capabilities: ConnectorCapabilities
}

const none: ConnectorCapabilities = {
  nativeCapture: false,
  liveApiSync: false,
  incrementalSync: false,
  exportImport: false,
  watchedFolderImport: false,
  providerMemoryImport: false,
  attachmentImport: false,
  conversationBranchImport: false
}

export const CONNECTORS: ConnectorDefinition[] = [
  {
    id: 'native',
    name: 'MemoryBridge chat',
    description: 'Conversations created directly in MemoryBridge.',
    capabilities: { ...none, nativeCapture: true, incrementalSync: true }
  },
  {
    id: 'chatgpt-export',
    name: 'ChatGPT data export',
    description:
      'User-supplied ChatGPT ZIP exports; no account scraping or undocumented API access.',
    capabilities: {
      ...none,
      incrementalSync: true,
      exportImport: true,
      watchedFolderImport: true,
      providerMemoryImport: true,
      attachmentImport: true,
      conversationBranchImport: true
    }
  },
  {
    id: 'generic-file',
    name: 'Generic files',
    description: 'User-supplied JSON, JSONL, Markdown, and plain-text transcripts.',
    capabilities: {
      ...none,
      incrementalSync: true,
      exportImport: true,
      watchedFolderImport: true
    }
  }
]

export function getConnector(id: string): ConnectorDefinition | undefined {
  return CONNECTORS.find((connector) => connector.id === id)
}
