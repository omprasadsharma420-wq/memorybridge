import { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { vaultManifestSchema } from '../../shared/schemas'
import { resolveInside } from '../storage/file-utils'
import { AppError } from '../errors'

export interface McpScope {
  projectId?: string
  chatId?: string
  allProjects?: boolean
  includeNeedsReview?: boolean
  includeDisputed?: boolean
  includeHistorical?: boolean
}

export class McpQueryService {
  private constructor(private readonly database: DatabaseSync) {}

  static async open(vaultPath: string): Promise<McpQueryService> {
    const root = resolve(vaultPath)
    try {
      vaultManifestSchema.parse(
        JSON.parse(await readFile(resolveInside(root, 'memorybridge.vault.json'), 'utf8'))
      )
    } catch {
      throw new AppError(
        'MCP_VAULT_INVALID',
        'The configured MemoryBridge vault is unavailable or invalid.'
      )
    }
    const indexPath = resolveInside(root, 'indexes', 'memorybridge.sqlite')
    try {
      const database = new DatabaseSync(indexPath, { readOnly: true })
      database.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;')
      return new McpQueryService(database)
    } catch {
      throw new AppError(
        'MCP_INDEX_UNAVAILABLE',
        'The MemoryBridge index is unavailable. Open the vault in MemoryBridge first.'
      )
    }
  }

  close(): void {
    this.database.close()
  }

  searchMemory(query: string, scope: McpScope = {}, limit = 10): unknown[] {
    const terms = toFtsQuery(query)
    if (!terms) return []
    const visible = scopeSql('m', scope)
    const lifecycle = lifecycleSql('m', scope)
    return (
      this.database
        .prepare(
          `SELECT m.*, c.title, bm25(memories_fts) AS rank
           FROM memories_fts JOIN memories m ON m.memory_id = memories_fts.memory_id
           JOIN chats c ON c.chat_id = m.chat_id
           WHERE memories_fts MATCH ? AND ${lifecycle.sql}
             ${visible.sql}
           ORDER BY m.pinned DESC, m.user_confirmed DESC, rank LIMIT ?`
        )
        .all(terms, ...visible.values, boundedLimit(limit)) as Array<Record<string, unknown>>
    ).map((row) => this.citedMemory(row, scope))
  }

  getMemoriesByType(types: string[], scope: McpScope = {}, limit = 20): unknown[] {
    const visible = scopeSql('m', scope)
    const lifecycle = lifecycleSql('m', scope)
    const placeholders = types.map(() => '?').join(',')
    return (
      this.database
        .prepare(
          `SELECT m.*, c.title FROM memories m JOIN chats c ON c.chat_id = m.chat_id
           WHERE m.type IN (${placeholders}) AND ${lifecycle.sql}
           ${visible.sql} ORDER BY m.pinned DESC, m.user_confirmed DESC, m.updated_at DESC LIMIT ?`
        )
        .all(...types, ...visible.values, boundedLimit(limit)) as Array<Record<string, unknown>>
    ).map((row) => this.citedMemory(row, scope))
  }

  findRelatedConversations(query: string, scope: McpScope = {}, limit = 10): unknown[] {
    const terms = toFtsQuery(query)
    if (!terms) return []
    const clauses: string[] = []
    const values: Array<string | number> = [terms]
    if (!scope.allProjects) {
      if (scope.chatId) {
        clauses.push('c.chat_id = ?')
        values.push(scope.chatId)
      } else if (scope.projectId) {
        clauses.push('c.project_id = ?')
        values.push(scope.projectId)
      } else return []
    }
    values.push(boundedLimit(limit))
    return (
      this.database
        .prepare(
          `SELECT c.chat_id, c.title, c.project_id, c.source_provider, c.updated_at,
                  bm25(chats_fts) AS rank
           FROM chats_fts JOIN chats c ON c.chat_id = chats_fts.chat_id
           WHERE chats_fts MATCH ? ${clauses.length ? `AND ${clauses.join(' AND ')}` : ''}
           ORDER BY rank LIMIT ?`
        )
        .all(...values) as Array<Record<string, unknown>>
    ).map((row) => ({
      chatId: String(row.chat_id),
      title: String(row.title),
      projectId: row.project_id ? String(row.project_id) : null,
      provider: String(row.source_provider ?? 'native'),
      updatedAt: String(row.updated_at)
    }))
  }

  getChatExcerpt(chatId: string, scope: McpScope, afterSequence = -1, limit = 20): unknown[] {
    if (!this.canAccessChat(chatId, scope)) return []
    return (
      this.database
        .prepare(
          `SELECT message_id, role, content, created_at, sequence FROM messages
           WHERE chat_id = ? AND status = 'complete' AND sequence > ?
           ORDER BY sequence LIMIT ?`
        )
        .all(chatId, Math.max(-1, afterSequence), boundedLimit(limit)) as Array<
        Record<string, unknown>
      >
    ).map((row) => ({
      messageId: String(row.message_id),
      role: String(row.role),
      excerpt: String(row.content).slice(0, 1000),
      createdAt: String(row.created_at),
      sequence: Number(row.sequence),
      citation: `memorybridge://chat/${chatId}/message/${String(row.message_id)}`
    }))
  }

  getMemoryEvidence(memoryId: string, scope: McpScope, limit = 20): unknown[] {
    const visible = scopeSql('m', scope)
    const lifecycle = lifecycleSql('m', scope)
    return (
      this.database
        .prepare(
          `SELECT e.evidence_id, e.chat_id, e.message_id, e.provider, e.exact_excerpt,
                  e.segment_id, e.evidence_role, e.created_at,
                  EXISTS(SELECT 1 FROM messages m WHERE m.message_id = e.message_id
                         AND m.chat_id = e.chat_id) AS source_available
           FROM memory_evidence e JOIN memories m ON m.memory_id = e.memory_id
           WHERE e.memory_id = ? AND ${lifecycle.sql} ${visible.sql}
           ORDER BY e.created_at LIMIT ?`
        )
        .all(memoryId, ...visible.values, boundedLimit(limit)) as Array<Record<string, unknown>>
    ).map((row) => ({
      evidenceId: String(row.evidence_id),
      chatId: String(row.chat_id),
      messageId: String(row.message_id),
      provider: String(row.provider),
      excerpt: String(row.exact_excerpt).slice(0, 1000),
      segmentId: row.segment_id ? String(row.segment_id) : null,
      evidenceRole: String(row.evidence_role ?? 'supports'),
      sourceAvailable: Boolean(row.source_available),
      createdAt: String(row.created_at),
      citation: `memorybridge://chat/${String(row.chat_id)}/message/${String(row.message_id)}`
    }))
  }

  listProjects(limit = 50): unknown[] {
    return this.database
      .prepare(
        `SELECT p.project_id, p.name, p.description, p.updated_at,
                COUNT(DISTINCT c.chat_id) AS conversation_count
         FROM projects p LEFT JOIN chats c ON c.project_id = p.project_id
         GROUP BY p.project_id ORDER BY p.updated_at DESC LIMIT ?`
      )
      .all(boundedLimit(limit))
  }

  listProviderMemories(scope: McpScope = {}, limit = 20): unknown[] {
    const clauses = ["state NOT IN ('superseded','rejected','deleted')"]
    const values: Array<string | number> = []
    if (!scope.allProjects) {
      if (scope.projectId) {
        clauses.push("(scope_kind = 'global' OR (scope_kind = 'project' AND scope_id = ?))")
        values.push(scope.projectId)
      } else if (scope.chatId) {
        clauses.push("(scope_kind = 'global' OR (scope_kind = 'conversation' AND scope_id = ?))")
        values.push(scope.chatId)
      } else clauses.push("scope_kind = 'global'")
    }
    values.push(boundedLimit(limit))
    return this.database
      .prepare(
        `SELECT provider_memory_id, provider, provider_record_id, source_type, statement,
                source_label, scope_kind, scope_id, state, user_confirmed, imported_at,
                provider_updated_at, raw_source_reference, superseded_by FROM provider_memories
         WHERE ${clauses.join(' AND ')} ORDER BY imported_at DESC LIMIT ?`
      )
      .all(...values)
  }

  private citedMemory(row: Record<string, unknown>, scope: McpScope): Record<string, unknown> {
    const memoryId = String(row.memory_id)
    const scopeKind = String(row.scope_kind ?? (row.project_id ? 'project' : 'conversation'))
    return {
      memoryId,
      type: String(row.type),
      statement: String(row.statement).slice(0, 1000),
      state: String(row.state),
      scope:
        scopeKind === 'global'
          ? { kind: 'global' }
          : scopeKind === 'project'
            ? { kind: 'project', projectId: String(row.scope_id ?? row.project_id) }
            : { kind: 'conversation', chatId: String(row.scope_id ?? row.chat_id) },
      projectId: row.project_id ? String(row.project_id) : null,
      sourceProvider: String(row.source_provider ?? 'native'),
      chatId: String(row.chat_id),
      chatTitle: String(row.title),
      updatedAt: String(row.updated_at),
      supersedes: parseArray(row.supersedes),
      supersededBy: row.superseded_by ? String(row.superseded_by) : null,
      evidence: this.getMemoryEvidence(memoryId, scope, 5),
      citation: `memorybridge://chat/${String(row.chat_id)}/memory/${memoryId}`
    }
  }

  private canAccessChat(chatId: string, scope: McpScope): boolean {
    if (scope.allProjects) return true
    if (scope.chatId && scope.chatId !== chatId) return false
    if (scope.chatId && !scope.projectId) return true
    if (!scope.projectId) return false
    const row = this.database
      .prepare('SELECT 1 AS allowed FROM chats WHERE chat_id = ? AND project_id = ?')
      .get(chatId, scope.projectId) as { allowed?: number } | undefined
    return Boolean(row?.allowed)
  }
}

function scopeSql(alias: string, scope: McpScope): { sql: string; values: string[] } {
  if (scope.allProjects) return { sql: '', values: [] }
  const global = `(${alias}.scope_kind = 'global' AND ${alias}.state = 'confirmed' AND ${alias}.user_confirmed = 1 AND ${alias}.confirmation_source != 'none')`
  if (scope.projectId && scope.chatId) {
    return {
      sql: `AND (${global}
        OR (${alias}.scope_kind = 'project' AND ${alias}.scope_id = ?)
        OR (${alias}.scope_kind = 'conversation' AND ${alias}.scope_id = ?
            AND EXISTS (
              SELECT 1 FROM chats scope_chat
              WHERE scope_chat.chat_id = ? AND scope_chat.project_id = ?
            )))`,
      values: [scope.projectId, scope.chatId, scope.chatId, scope.projectId]
    }
  }
  if (scope.projectId)
    return {
      sql: `AND (${global} OR (${alias}.scope_kind = 'project' AND ${alias}.scope_id = ?))`,
      values: [scope.projectId]
    }
  if (scope.chatId)
    return {
      sql: `AND (${global} OR (${alias}.scope_kind = 'conversation' AND ${alias}.scope_id = ?))`,
      values: [scope.chatId]
    }
  return { sql: `AND ${global}`, values: [] }
}

function lifecycleSql(alias: string, scope: McpScope): { sql: string } {
  const accepted = ['active', 'confirmed', 'completed']
  if (scope.includeNeedsReview) accepted.push('needs_review', 'candidate')
  if (scope.includeDisputed) accepted.push('disputed')
  if (scope.includeHistorical) accepted.push('superseded', 'rejected')
  return {
    sql: `${alias}.state IN (${accepted.map((state) => `'${state}'`).join(',')})`
  }
}

function boundedLimit(value: number): number {
  return Math.max(1, Math.min(Math.trunc(value), 50))
}
function parseArray(value: unknown): string[] {
  try {
    return JSON.parse(String(value ?? '[]')) as string[]
  } catch {
    return []
  }
}
function toFtsQuery(query: string): string {
  return query
    .replace(/["'*()^:-]/g, ' ')
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 20)
    .map((term) => `"${term}"*`)
    .join(' OR ')
}
