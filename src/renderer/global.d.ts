import type { MemoryBridgeApi } from '../shared/contracts'

declare global {
  interface Window {
    memoryBridge: MemoryBridgeApi
  }
}

export {}
