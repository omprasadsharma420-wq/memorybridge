import { DatabaseSync } from 'node:sqlite'
import { dirname } from 'node:path'
import type {
  Chat,
  ExtractionRun,
  Memory,
  MemoryState,
  MemoryType,
  Message,
  Project
} from '../../shared/schemas'
import type { SearchInput, SearchResult } from '../../shared/contracts'
import { excerpt } from '../../shared/text'
import { ensureDirectory } from './file-utils'

const SCHEMA_VERSION = 1

export class IndexDatabase {
  private database: DatabaseSync | null = null

  constructor(private readonly path: string) {}

  async open(): Promise<void> {
    await ensureDirectory(dirname(this.path))
    this.database = new DatabaseSync(this.path)
    this.db.exec('PRAGMA journal_mode = DELETE')
    this.db.exec('PRAGMA synchronous = FULL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.migrate()
  }

  close(): void {
    this.database?.close()
    this.database = null
  }

  clearContent(): void {
    this.transaction(() => {
      this.db.exec(`
        DELETE FROM memory_relationships;
        DELETE FROM extraction_runs;
        DELETE FROM embeddings;
        DELETE FROM messages;
        DELETE FROM memories;
        DELETE FROM chats;
        DELETE FROM projects;
        DELETE FROM messages_fts;
        DELETE FROM memories_fts;
        DELETE FROM chats_fts;
      `)
    })
  }

  upsertProject(project: Project): void {
    this.db
      .prepare(
        `INSERT INTO projects (project_id, name, description, created_at, updated_at)
         VALUES (@project_id, @name, @description, @created_at, @updated_at)
         ON CONFLICT(project_id) DO UPDATE SET
           name=excluded.name, description=excluded.description, updated_at=excluded.updated_at`
      )
      .run({
        project_id: project.project_id,
        name: project.name,
        description: project.description,
        created_at: project.created_at,
        updated_at: project.updated_at
      })
  }

  upsertChat(chat: Chat): void {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO chats (chat_id, project_id, title, created_at, updated_at)
           VALUES (@chat_id, @project_id, @title, @created_at, @updated_at)
           ON CONFLICT(chat_id) DO UPDATE SET
             project_id=excluded.project_id, title=excluded.title, updated_at=excluded.updated_at`
        )
        .run({
          chat_id: chat.chat_id,
          project_id: chat.project_id,
          title: chat.title,
          created_at: chat.created_at,
          updated_at: chat.updated_at
        })
      this.db.prepare('DELETE FROM chats_fts WHERE chat_id = ?').run(chat.chat_id)
      this.db
        .prepare('INSERT INTO chats_fts (chat_id, title, project_id) VALUES (?, ?, ?)')
        .run(chat.chat_id, chat.title, chat.project_id ?? '')
    })
  }

  upsertMessage(message: Message): void {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO messages
             (message_id, chat_id, role, content, created_at, updated_at, provider, model, status, sequence, error_category, retrieved_memory_ids)
           VALUES
             (@message_id, @chat_id, @role, @content, @created_at, @updated_at, @provider, @model, @status, @sequence, @error_category, @retrieved_memory_ids)
           ON CONFLICT(message_id) DO UPDATE SET
             content=excluded.content, updated_at=excluded.updated_at, provider=excluded.provider,
             model=excluded.model, status=excluded.status, sequence=excluded.sequence,
             error_category=excluded.error_category, retrieved_memory_ids=excluded.retrieved_memory_ids`
        )
        .run({
          ...message,
          error_category: message.error_category ?? null,
          retrieved_memory_ids: JSON.stringify(message.retrieved_memory_ids)
        })
      this.db.prepare('DELETE FROM messages_fts WHERE message_id = ?').run(message.message_id)
      this.db
        .prepare(
          `INSERT INTO messages_fts (message_id, content, chat_id, project_id)
           SELECT ?, ?, c.chat_id, COALESCE(c.project_id, '') FROM chats c WHERE c.chat_id = ?`
        )
        .run(message.message_id, message.content, message.chat_id)
    })
  }

  upsertMemory(memory: Memory): void {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO memories
             (memory_id, type, statement, project_id, chat_id, source_message_ids, state, confidence,
              created_at, updated_at, effective_at, supersedes, superseded_by, entities, tags, user_confirmed, pinned)
           VALUES
             (@memory_id, @type, @statement, @project_id, @chat_id, @source_message_ids, @state, @confidence,
              @created_at, @updated_at, @effective_at, @supersedes, @superseded_by, @entities, @tags, @user_confirmed, @pinned)
           ON CONFLICT(memory_id) DO UPDATE SET
             type=excluded.type, statement=excluded.statement, project_id=excluded.project_id,
             source_message_ids=excluded.source_message_ids, state=excluded.state, confidence=excluded.confidence,
             updated_at=excluded.updated_at, effective_at=excluded.effective_at, supersedes=excluded.supersedes,
             superseded_by=excluded.superseded_by, entities=excluded.entities, tags=excluded.tags,
             user_confirmed=excluded.user_confirmed, pinned=excluded.pinned`
        )
        .run({
          ...memory,
          source_message_ids: JSON.stringify(memory.source_message_ids),
          supersedes: JSON.stringify(memory.supersedes),
          entities: JSON.stringify(memory.entities),
          tags: JSON.stringify(memory.tags),
          user_confirmed: memory.user_confirmed ? 1 : 0,
          pinned: memory.pinned ? 1 : 0
        })
      this.db.prepare('DELETE FROM memories_fts WHERE memory_id = ?').run(memory.memory_id)
      this.db
        .prepare(
          'INSERT INTO memories_fts (memory_id, statement, type, state, project_id, chat_id) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .run(
          memory.memory_id,
          memory.statement,
          memory.type,
          memory.state,
          memory.project_id ?? '',
          memory.chat_id
        )
      this.db.prepare('DELETE FROM memory_relationships WHERE source_memory_id = ?').run(memory.memory_id)
      for (const target of memory.supersedes) {
        this.db
          .prepare(
            'INSERT OR REPLACE INTO memory_relationships (source_memory_id, target_memory_id, relationship) VALUES (?, ?, ?)'
          )
          .run(memory.memory_id, target, 'supersedes')
      }
    })
  }

  upsertExtractionRun(run: ExtractionRun): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO extraction_runs
          (extraction_id, chat_id, provider, model, status, created_at, source_message_ids, candidate_count, error_category)
         VALUES (@extraction_id, @chat_id, @provider, @model, @status, @created_at, @source_message_ids, @candidate_count, @error_category)`
      )
      .run({
        ...run,
        source_message_ids: JSON.stringify(run.source_message_ids),
        error_category: run.error_category ?? null
      })
  }

  storeEmbedding(memoryId: string, model: string, vector: number[]): void {
    this.db
      .prepare(
        `INSERT INTO embeddings (memory_id, model, vector, dimensions, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(memory_id, model) DO UPDATE SET vector=excluded.vector, dimensions=excluded.dimensions, updated_at=excluded.updated_at`
      )
      .run(memoryId, model, JSON.stringify(vector), vector.length, new Date().toISOString())
  }

  getEmbeddings(model: string): Array<{ memoryId: string; vector: number[] }> {
    const rows = this.db
      .prepare('SELECT memory_id, vector FROM embeddings WHERE model = ?')
      .all(model) as Array<{ memory_id: string; vector: string }>
    return rows.map((row) => ({ memoryId: row.memory_id, vector: JSON.parse(row.vector) as number[] }))
  }

  search(input: SearchInput): SearchResult[] {
    const terms = toFtsQuery(input.query)
    if (!terms) return []
    const results: SearchResult[] = []
    const memoryFilters = buildFilters(input, 'm')
    const memoryRows = this.db
      .prepare(
        `SELECT m.memory_id, m.chat_id, m.project_id, c.title, m.statement, m.type, m.state,
                m.source_message_ids, m.created_at, bm25(memories_fts) AS rank
         FROM memories_fts
         JOIN memories m ON m.memory_id = memories_fts.memory_id
         JOIN chats c ON c.chat_id = m.chat_id
         WHERE memories_fts MATCH ? ${memoryFilters.sql}
         ORDER BY rank LIMIT ?`
      )
      .all(terms, ...memoryFilters.values, input.limit) as Array<Record<string, unknown>>
    for (const row of memoryRows) {
      results.push({
        kind: 'memory',
        id: String(row.memory_id),
        chatId: String(row.chat_id),
        projectId: row.project_id ? String(row.project_id) : null,
        title: String(row.title),
        excerpt: excerpt(String(row.statement)),
        memoryType: String(row.type),
        state: String(row.state),
        sourceMessageIds: JSON.parse(String(row.source_message_ids)) as string[],
        score: 10 - Number(row.rank),
        createdAt: String(row.created_at)
      })
    }

    const projectClause = input.projectId ? ' AND c.project_id = ?' : ''
    const chatClause = input.chatId ? ' AND m.chat_id = ?' : ''
    const messageValues = [terms, ...(input.projectId ? [input.projectId] : []), ...(input.chatId ? [input.chatId] : []), input.limit]
    const messageRows = this.db
      .prepare(
        `SELECT m.message_id, m.chat_id, c.project_id, c.title, m.content, m.created_at,
                bm25(messages_fts) AS rank
         FROM messages_fts
         JOIN messages m ON m.message_id = messages_fts.message_id
         JOIN chats c ON c.chat_id = m.chat_id
         WHERE messages_fts MATCH ? ${projectClause} ${chatClause}
         ORDER BY rank LIMIT ?`
      )
      .all(...messageValues) as Array<Record<string, unknown>>
    for (const row of messageRows) {
      results.push({
        kind: 'message',
        id: String(row.message_id),
        chatId: String(row.chat_id),
        projectId: row.project_id ? String(row.project_id) : null,
        title: String(row.title),
        excerpt: excerpt(String(row.content)),
        memoryType: null,
        state: null,
        sourceMessageIds: [String(row.message_id)],
        score: 6 - Number(row.rank),
        createdAt: String(row.created_at)
      })
    }

    const chatProjectClause = input.projectId ? ' AND c.project_id = ?' : ''
    const chatRows = this.db
      .prepare(
        `SELECT c.chat_id, c.project_id, c.title, c.created_at, bm25(chats_fts) AS rank
         FROM chats_fts JOIN chats c ON c.chat_id = chats_fts.chat_id
         WHERE chats_fts MATCH ? ${chatProjectClause}
         ORDER BY rank LIMIT ?`
      )
      .all(terms, ...(input.projectId ? [input.projectId] : []), input.limit) as Array<Record<string, unknown>>
    for (const row of chatRows) {
      results.push({
        kind: 'chat',
        id: String(row.chat_id),
        chatId: String(row.chat_id),
        projectId: row.project_id ? String(row.project_id) : null,
        title: String(row.title),
        excerpt: String(row.title),
        memoryType: null,
        state: null,
        sourceMessageIds: [],
        score: 8 - Number(row.rank),
        createdAt: String(row.created_at)
      })
    }
    return results.sort((a, b) => b.score - a.score).slice(0, input.limit)
  }

  listActiveMemories(projectId?: string | null): Memory[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memories
         WHERE state IN ('active', 'confirmed', 'completed')
           AND (? IS NULL OR project_id = ? OR project_id IS NULL)
         ORDER BY pinned DESC, user_confirmed DESC, updated_at DESC`
      )
      .all(projectId ?? null, projectId ?? null) as Array<Record<string, unknown>>
    return rows.map(rowToMemory)
  }

  private get db(): DatabaseSync {
    if (!this.database) throw new Error('Index database is not open.')
    return this.database
  }

  private transaction(action: () => void): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      action()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS migration_state (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS vault_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chats (
        chat_id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(project_id) ON DELETE SET NULL,
        title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        message_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(chat_id) ON DELETE CASCADE,
        role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        provider TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, sequence INTEGER NOT NULL,
        error_category TEXT, retrieved_memory_ids TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS memories (
        memory_id TEXT PRIMARY KEY, type TEXT NOT NULL, statement TEXT NOT NULL, project_id TEXT,
        chat_id TEXT NOT NULL REFERENCES chats(chat_id) ON DELETE CASCADE,
        source_message_ids TEXT NOT NULL, state TEXT NOT NULL, confidence REAL NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, effective_at TEXT NOT NULL,
        supersedes TEXT NOT NULL, superseded_by TEXT, entities TEXT NOT NULL, tags TEXT NOT NULL,
        user_confirmed INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS memory_relationships (
        source_memory_id TEXT NOT NULL, target_memory_id TEXT NOT NULL, relationship TEXT NOT NULL,
        PRIMARY KEY (source_memory_id, target_memory_id, relationship)
      );
      CREATE TABLE IF NOT EXISTS extraction_runs (
        extraction_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL, source_message_ids TEXT NOT NULL,
        candidate_count INTEGER NOT NULL, error_category TEXT
      );
      CREATE TABLE IF NOT EXISTS embeddings (
        memory_id TEXT NOT NULL, model TEXT NOT NULL, vector TEXT NOT NULL, dimensions INTEGER NOT NULL,
        updated_at TEXT NOT NULL, PRIMARY KEY (memory_id, model)
      );
      CREATE TABLE IF NOT EXISTS index_versions (name TEXT PRIMARY KEY, version INTEGER NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS chats_fts USING fts5(chat_id UNINDEXED, title, project_id UNINDEXED);
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(message_id UNINDEXED, content, chat_id UNINDEXED, project_id UNINDEXED);
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(memory_id UNINDEXED, statement, type, state, project_id UNINDEXED, chat_id UNINDEXED);
    `)
    this.db
      .prepare('INSERT OR IGNORE INTO migration_state (version, applied_at) VALUES (?, ?)')
      .run(SCHEMA_VERSION, new Date().toISOString())
    this.db
      .prepare('INSERT OR REPLACE INTO index_versions (name, version) VALUES (?, ?)')
      .run('main', SCHEMA_VERSION)
  }
}

function toFtsQuery(query: string): string {
  return query
    .replace(/["'*()^:-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term}"*`)
    .join(' AND ')
}

function buildFilters(
  input: SearchInput,
  alias: string
): { sql: string; values: Array<string | number | null> } {
  const clauses: string[] = []
  const values: Array<string | number | null> = []
  if (!input.includeHistory && !input.state) clauses.push(`${alias}.state NOT IN ('superseded','rejected','deleted')`)
  if (input.projectId) {
    clauses.push(`${alias}.project_id = ?`)
    values.push(input.projectId)
  }
  if (input.chatId) {
    clauses.push(`${alias}.chat_id = ?`)
    values.push(input.chatId)
  }
  if (input.memoryType) {
    clauses.push(`${alias}.type = ?`)
    values.push(input.memoryType)
  }
  if (input.state) {
    clauses.push(`${alias}.state = ?`)
    values.push(input.state)
  }
  return { sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', values }
}

function rowToMemory(row: Record<string, unknown>): Memory {
  return {
    memory_id: String(row.memory_id),
    type: String(row.type) as MemoryType,
    statement: String(row.statement),
    project_id: row.project_id ? String(row.project_id) : null,
    chat_id: String(row.chat_id),
    source_message_ids: JSON.parse(String(row.source_message_ids)) as string[],
    state: String(row.state) as MemoryState,
    confidence: Number(row.confidence),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    effective_at: String(row.effective_at),
    supersedes: JSON.parse(String(row.supersedes)) as string[],
    superseded_by: row.superseded_by ? String(row.superseded_by) : null,
    entities: JSON.parse(String(row.entities)) as string[],
    tags: JSON.parse(String(row.tags)) as string[],
    user_confirmed: Boolean(row.user_confirmed),
    pinned: Boolean(row.pinned)
  }
}
