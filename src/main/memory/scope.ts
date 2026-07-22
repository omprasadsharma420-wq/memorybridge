import type { Memory, MemoryScope } from '../../shared/schemas'

export interface ScopeContext {
  projectId: string | null
  chatId?: string | null
  includeConversation?: boolean
  allowAllProjects?: boolean
}

export function effectiveScope(memory: Memory): MemoryScope {
  return (
    memory.scope ??
    (memory.project_id
      ? { kind: 'project', project_id: memory.project_id }
      : { kind: 'conversation', chat_id: memory.chat_id })
  )
}

export function isConfirmedGlobal(memory: Memory): boolean {
  return (
    effectiveScope(memory).kind === 'global' &&
    memory.state === 'confirmed' &&
    memory.user_confirmed &&
    memory.confirmation_source !== 'none'
  )
}

export function isMemoryVisible(memory: Memory, context: ScopeContext): boolean {
  if (context.allowAllProjects) return true
  const scope = effectiveScope(memory)
  if (scope.kind === 'global') return isConfirmedGlobal(memory)
  if (scope.kind === 'conversation' && context.includeConversation !== false && context.chatId) {
    return scope.chat_id === context.chatId
  }
  if (scope.kind === 'project') {
    return Boolean(context.projectId && scope.project_id === context.projectId)
  }
  return false
}

export function filterMemoriesForScope(memories: Memory[], context: ScopeContext): Memory[] {
  return memories.filter((memory) => isMemoryVisible(memory, context))
}

export function canRelateMemories(left: Memory, right: Memory): boolean {
  const leftScope = effectiveScope(left)
  const rightScope = effectiveScope(right)
  if (leftScope.kind === 'global' || rightScope.kind === 'global') {
    return leftScope.kind === 'global' && rightScope.kind === 'global'
  }
  if (leftScope.kind === 'project' || rightScope.kind === 'project') {
    return (
      leftScope.kind === 'project' &&
      rightScope.kind === 'project' &&
      leftScope.project_id === rightScope.project_id
    )
  }
  return leftScope.chat_id === rightScope.chat_id
}

export function scopeForConversation(projectId: string | null, chatId: string): MemoryScope {
  return projectId
    ? { kind: 'project', project_id: projectId }
    : { kind: 'conversation', chat_id: chatId }
}
