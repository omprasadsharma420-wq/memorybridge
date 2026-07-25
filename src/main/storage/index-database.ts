import { DatabaseSync } from 'node:sqlite'
import { dirname } from 'node:path'
import type {
  Chat,
  ExtractionRun,
  Memory,
  MemoryState,
  MemoryType,
  MemoryEvidence,
  Message,
  Project,
  TopicSegment,
  ImportRecord,
  ProviderMemory
} from '../../shared/schemas'
import type { SearchInput, SearchResult } from '../../shared/contracts'
import { excerpt } from '../../shared/text'
import { ensureDirectory } from './file-utils'
import { filterMemoriesForScope } from '../memory/scope'

const SCHEMA_VERSION = 8

export class IndexDatabase {
  private database: DatabaseSync | null = null
  private contentRebuildRequired = false
  private deferSearchIndexWrites = false
  private readonly statementCache = new Map<string, ReturnType<DatabaseSync['prepare']>>()

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
    this.statementCache.clear()
    this.database?.close()
    this.database = null
  }

  getVaultId(): string | null {
    const row = this.db.prepare("SELECT value FROM vault_metadata WHERE key = 'vault_id'").get() as
      { value: string } | undefined
    return row?.value ?? null
  }

  setVaultId(vaultId: string): void {
    this.db
      .prepare("INSERT OR REPLACE INTO vault_metadata (key, value) VALUES ('vault_id', ?)")
      .run(vaultId)
  }

  requiresContentRebuild(): boolean {
    return this.contentRebuildRequired
  }

  async batch<T>(action: () => Promise<T>): Promise<T> {
    if (this.db.isTransaction) return action()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = await action()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  clearContent(): void {
    this.transaction(() => {
      this.db.exec(`
        DELETE FROM memory_relationships;
        DELETE FROM extraction_runs;
        DELETE FROM embeddings;
        DELETE FROM memory_evidence;
        DELETE FROM topics;
        DELETE FROM import_records;
        DELETE FROM connector_state;
        DELETE FROM provider_memories;
        DELETE FROM temporal_index;
        DELETE FROM memory_entities;
        DELETE FROM entity_relationships;
        DELETE FROM messages;
        DELETE FROM memories;
        DELETE FROM chats;
        DELETE FROM projects;
        DELETE FROM messages_fts;
        DELETE FROM memories_fts;
        DELETE FROM chats_fts;
        DELETE FROM provider_memories_fts;
      `)
    })
  }

  beginContentRebuild(): void {
    this.deferSearchIndexWrites = true
  }

  completeContentRebuild(): void {
    this.db.exec(`
      DELETE FROM messages_fts;
      DELETE FROM memories_fts;
      DELETE FROM chats_fts;
      DELETE FROM provider_memories_fts;
      INSERT INTO chats_fts (chat_id, title, project_id)
        SELECT chat_id, title, COALESCE(project_id, '') FROM chats;
      INSERT INTO messages_fts (message_id, content, chat_id, project_id)
        SELECT m.message_id, m.content, m.chat_id, COALESCE(c.project_id, '')
        FROM messages m JOIN chats c ON c.chat_id = m.chat_id;
      INSERT INTO memories_fts (memory_id, statement, type, state, project_id, chat_id)
        SELECT memory_id, statement, type, state, COALESCE(project_id, ''), chat_id
        FROM memories;
      INSERT INTO provider_memories_fts
        (provider_memory_id, statement, provider, source_type, state)
        SELECT provider_memory_id, statement, provider, source_type, state
        FROM provider_memories;
    `)
    this.deferSearchIndexWrites = false
  }

  cancelContentRebuild(): void {
    this.deferSearchIndexWrites = false
  }

  upsertProject(project: Project): void {
    this.prepared(
      `INSERT INTO projects (project_id, name, description, created_at, updated_at)
         VALUES (@project_id, @name, @description, @created_at, @updated_at)
         ON CONFLICT(project_id) DO UPDATE SET
           name=excluded.name, description=excluded.description, updated_at=excluded.updated_at`
    ).run({
      project_id: project.project_id,
      name: project.name,
      description: project.description,
      created_at: project.created_at,
      updated_at: project.updated_at
    })
  }

  upsertChat(chat: Chat): void {
    this.transaction(() => {
      this.prepared(
        `INSERT INTO chats (chat_id, project_id, title, created_at, updated_at,
             source_provider, source_conversation_id, original_title, workspace, model_ids,
             branch_count, attachment_count, citation_count, sync_state, processing_state,
             import_origin, content_hash, raw_metadata)
           VALUES (@chat_id, @project_id, @title, @created_at, @updated_at,
             @source_provider, @source_conversation_id, @original_title, @workspace, @model_ids,
             @branch_count, @attachment_count, @citation_count, @sync_state, @processing_state,
             @import_origin, @content_hash, @raw_metadata)
           ON CONFLICT(chat_id) DO UPDATE SET
             project_id=excluded.project_id, title=excluded.title, updated_at=excluded.updated_at,
             source_provider=excluded.source_provider,
             source_conversation_id=excluded.source_conversation_id,
             original_title=excluded.original_title, workspace=excluded.workspace,
             model_ids=excluded.model_ids, branch_count=excluded.branch_count,
             attachment_count=excluded.attachment_count, citation_count=excluded.citation_count,
             sync_state=excluded.sync_state, processing_state=excluded.processing_state,
             import_origin=excluded.import_origin, content_hash=excluded.content_hash,
             raw_metadata=excluded.raw_metadata`
      ).run({
        chat_id: chat.chat_id,
        project_id: chat.project_id,
        title: chat.title,
        created_at: chat.created_at,
        updated_at: chat.updated_at,
        source_provider: chat.source_provider,
        source_conversation_id: chat.source_conversation_id,
        original_title: chat.original_title,
        workspace: chat.workspace,
        model_ids: JSON.stringify(chat.model_ids),
        branch_count: chat.branch_count,
        attachment_count: chat.attachment_count,
        citation_count: chat.citation_count,
        sync_state: chat.sync_state,
        processing_state: chat.processing_state,
        import_origin: chat.import_origin,
        content_hash: chat.content_hash,
        raw_metadata: JSON.stringify(chat.raw_metadata)
      })
      if (!this.deferSearchIndexWrites) {
        this.prepared('DELETE FROM chats_fts WHERE chat_id = ?').run(chat.chat_id)
        this.prepared('INSERT INTO chats_fts (chat_id, title, project_id) VALUES (?, ?, ?)').run(
          chat.chat_id,
          chat.title,
          chat.project_id ?? ''
        )
      }
    })
  }

  upsertMessage(message: Message): void {
    this.transaction(() => {
      this.prepared(
        `INSERT INTO messages
             (message_id, chat_id, role, content, created_at, updated_at, provider, model, status,
              sequence, error_category, retrieved_memory_ids, retrieved_context_ids,
              provider_message_id, parent_message_id, branch_id, content_blocks, attachments,
              tool_events, citations, raw_metadata, content_hash)
           VALUES
             (@message_id, @chat_id, @role, @content, @created_at, @updated_at, @provider, @model,
              @status, @sequence, @error_category, @retrieved_memory_ids, @retrieved_context_ids,
              @provider_message_id, @parent_message_id, @branch_id, @content_blocks, @attachments,
              @tool_events, @citations, @raw_metadata, @content_hash)
           ON CONFLICT(message_id) DO UPDATE SET
             content=excluded.content, updated_at=excluded.updated_at, provider=excluded.provider,
             model=excluded.model, status=excluded.status, sequence=excluded.sequence,
             error_category=excluded.error_category, retrieved_memory_ids=excluded.retrieved_memory_ids,
             retrieved_context_ids=excluded.retrieved_context_ids,
             provider_message_id=excluded.provider_message_id, parent_message_id=excluded.parent_message_id,
             branch_id=excluded.branch_id, content_blocks=excluded.content_blocks,
             attachments=excluded.attachments, tool_events=excluded.tool_events,
             citations=excluded.citations, raw_metadata=excluded.raw_metadata,
             content_hash=excluded.content_hash`
      ).run({
        message_id: message.message_id,
        chat_id: message.chat_id,
        role: message.role,
        content: message.content,
        created_at: message.created_at,
        updated_at: message.updated_at,
        provider: message.provider,
        model: message.model,
        status: message.status,
        sequence: message.sequence,
        error_category: message.error_category ?? null,
        retrieved_memory_ids: JSON.stringify(message.retrieved_memory_ids),
        retrieved_context_ids: JSON.stringify(message.retrieved_context_ids),
        provider_message_id: message.provider_message_id ?? null,
        parent_message_id: message.parent_message_id ?? null,
        branch_id: message.branch_id ?? null,
        content_blocks: JSON.stringify(message.content_blocks ?? []),
        attachments: JSON.stringify(message.attachments ?? []),
        tool_events: JSON.stringify(message.tool_events ?? []),
        citations: JSON.stringify(message.citations ?? []),
        raw_metadata: JSON.stringify(message.raw_metadata ?? {}),
        content_hash: message.content_hash ?? null
      })
      if (!this.deferSearchIndexWrites) {
        this.prepared('DELETE FROM messages_fts WHERE message_id = ?').run(message.message_id)
        this.prepared(
          `INSERT INTO messages_fts (message_id, content, chat_id, project_id)
           SELECT ?, ?, c.chat_id, COALESCE(c.project_id, '') FROM chats c WHERE c.chat_id = ?`
        ).run(message.message_id, message.content, message.chat_id)
      }
    })
  }

  upsertMemory(memory: Memory): void {
    this.transaction(() => {
      this.prepared(
        `INSERT INTO memories
             (memory_id, type, statement, project_id, chat_id, source_message_ids, state, confidence,
              created_at, updated_at, effective_at, supersedes, superseded_by, entities, tags,
              user_confirmed, pinned, scope_kind, scope_id, confirmation_source, evidence_ids,
              source_chat_ids, valid_from, valid_until, temporal_precision, embedding_state,
              embedding_content_hash, source_provider, source_type)
           VALUES
             (@memory_id, @type, @statement, @project_id, @chat_id, @source_message_ids, @state, @confidence,
              @created_at, @updated_at, @effective_at, @supersedes, @superseded_by, @entities, @tags,
              @user_confirmed, @pinned, @scope_kind, @scope_id, @confirmation_source, @evidence_ids,
              @source_chat_ids, @valid_from, @valid_until, @temporal_precision, @embedding_state,
              @embedding_content_hash, @source_provider, @source_type)
           ON CONFLICT(memory_id) DO UPDATE SET
             type=excluded.type, statement=excluded.statement, project_id=excluded.project_id,
             source_message_ids=excluded.source_message_ids, state=excluded.state, confidence=excluded.confidence,
             updated_at=excluded.updated_at, effective_at=excluded.effective_at, supersedes=excluded.supersedes,
             superseded_by=excluded.superseded_by, entities=excluded.entities, tags=excluded.tags,
             user_confirmed=excluded.user_confirmed, pinned=excluded.pinned,
             chat_id=excluded.chat_id, scope_kind=excluded.scope_kind, scope_id=excluded.scope_id,
             confirmation_source=excluded.confirmation_source, evidence_ids=excluded.evidence_ids,
             source_chat_ids=excluded.source_chat_ids, valid_from=excluded.valid_from,
             valid_until=excluded.valid_until, temporal_precision=excluded.temporal_precision,
             embedding_state=excluded.embedding_state,
             embedding_content_hash=excluded.embedding_content_hash,
             source_provider=excluded.source_provider, source_type=excluded.source_type`
      ).run({
        memory_id: memory.memory_id,
        type: memory.type,
        statement: memory.statement,
        project_id: memory.project_id,
        chat_id: memory.chat_id,
        state: memory.state,
        confidence: memory.confidence,
        created_at: memory.created_at,
        updated_at: memory.updated_at,
        effective_at: memory.effective_at,
        superseded_by: memory.superseded_by,
        source_message_ids: JSON.stringify(memory.source_message_ids),
        supersedes: JSON.stringify(memory.supersedes),
        entities: JSON.stringify(memory.entities),
        tags: JSON.stringify(memory.tags),
        user_confirmed: memory.user_confirmed ? 1 : 0,
        pinned: memory.pinned ? 1 : 0,
        scope_kind: memory.scope?.kind ?? (memory.project_id ? 'project' : 'conversation'),
        scope_id:
          memory.scope?.kind === 'project'
            ? memory.scope.project_id
            : memory.scope?.kind === 'conversation'
              ? memory.scope.chat_id
              : memory.scope?.kind === 'global'
                ? null
                : (memory.project_id ?? memory.chat_id),
        confirmation_source: memory.confirmation_source ?? 'none',
        evidence_ids: JSON.stringify(memory.evidence_ids ?? []),
        source_chat_ids: JSON.stringify(memory.source_chat_ids ?? [memory.chat_id]),
        valid_from: memory.valid_from ?? null,
        valid_until: memory.valid_until ?? null,
        temporal_precision: memory.temporal_precision ?? 'unknown',
        embedding_state: memory.embedding_state ?? 'missing',
        embedding_content_hash: memory.embedding_content_hash ?? null,
        source_provider: memory.source_provider ?? 'native',
        source_type: memory.source_type ?? 'auto_extracted'
      })
      if (!this.deferSearchIndexWrites) {
        this.prepared('DELETE FROM memories_fts WHERE memory_id = ?').run(memory.memory_id)
        this.prepared(
          'INSERT INTO memories_fts (memory_id, statement, type, state, project_id, chat_id) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(
          memory.memory_id,
          memory.statement,
          memory.type,
          memory.state,
          memory.project_id ?? '',
          memory.chat_id
        )
      }
      this.prepared('DELETE FROM memory_relationships WHERE source_memory_id = ?').run(
        memory.memory_id
      )
      for (const target of memory.supersedes) {
        this.prepared(
          'INSERT OR REPLACE INTO memory_relationships (source_memory_id, target_memory_id, relationship) VALUES (?, ?, ?)'
        ).run(memory.memory_id, target, 'supersedes')
      }
      this.prepared('DELETE FROM memory_entities WHERE memory_id = ?').run(memory.memory_id)
      this.prepared('DELETE FROM entity_relationships WHERE memory_id = ?').run(memory.memory_id)
      for (const entity of memory.entities) {
        this.prepared(
          'INSERT OR REPLACE INTO memory_entities (memory_id, entity) VALUES (?, ?)'
        ).run(memory.memory_id, entity)
      }
      for (let left = 0; left < memory.entities.length; left += 1) {
        for (let right = left + 1; right < memory.entities.length; right += 1) {
          this.prepared(
            `INSERT OR REPLACE INTO entity_relationships
               (source_entity, target_entity, relationship, memory_id, scope_kind, scope_id, updated_at)
               VALUES (?, ?, 'co_occurs', ?, ?, ?, ?)`
          ).run(
            memory.entities[left]!,
            memory.entities[right]!,
            memory.memory_id,
            memory.scope?.kind ?? (memory.project_id ? 'project' : 'conversation'),
            memory.scope?.kind === 'project'
              ? memory.scope.project_id
              : memory.scope?.kind === 'conversation'
                ? memory.scope.chat_id
                : null,
            memory.updated_at
          )
        }
      }
      this.prepared(
        `INSERT OR REPLACE INTO temporal_index (memory_id, valid_from, valid_until, precision)
           VALUES (?, ?, ?, ?)`
      ).run(
        memory.memory_id,
        memory.valid_from ?? null,
        memory.valid_until ?? null,
        memory.temporal_precision ?? 'unknown'
      )
    })
  }

  removeMissingChatMemories(chatId: string, keepIds: string[]): void {
    const rows = this.db
      .prepare('SELECT memory_id FROM memories WHERE chat_id = ?')
      .all(chatId) as Array<{ memory_id: string }>
    const keep = new Set(keepIds)
    this.transaction(() => {
      for (const row of rows) {
        if (keep.has(row.memory_id)) continue
        this.db.prepare('DELETE FROM memories_fts WHERE memory_id = ?').run(row.memory_id)
        this.db
          .prepare(
            'DELETE FROM memory_relationships WHERE source_memory_id = ? OR target_memory_id = ?'
          )
          .run(row.memory_id, row.memory_id)
        this.db.prepare('DELETE FROM embeddings WHERE memory_id = ?').run(row.memory_id)
        this.db.prepare('DELETE FROM memory_evidence WHERE memory_id = ?').run(row.memory_id)
        this.db.prepare('DELETE FROM temporal_index WHERE memory_id = ?').run(row.memory_id)
        this.db.prepare('DELETE FROM memory_entities WHERE memory_id = ?').run(row.memory_id)
        this.db.prepare('DELETE FROM entity_relationships WHERE memory_id = ?').run(row.memory_id)
        this.db.prepare('DELETE FROM memories WHERE memory_id = ?').run(row.memory_id)
      }
    })
  }

  upsertExtractionRun(run: ExtractionRun): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO extraction_runs
          (extraction_id, chat_id, provider, model, status, created_at, source_message_ids,
           candidate_count, error_category, checkpoint, total_segments)
         VALUES (@extraction_id, @chat_id, @provider, @model, @status, @created_at,
                 @source_message_ids, @candidate_count, @error_category, @checkpoint, @total_segments)`
      )
      .run({
        extraction_id: run.extraction_id,
        chat_id: run.chat_id,
        provider: run.provider,
        model: run.model,
        status: run.status,
        created_at: run.created_at,
        candidate_count: run.candidate_count,
        source_message_ids: JSON.stringify(run.source_message_ids),
        error_category: run.error_category ?? null,
        checkpoint: run.checkpoint ?? 0,
        total_segments: run.total_segments ?? 1
      })
  }

  upsertEvidence(evidence: MemoryEvidence): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO memory_evidence
         (evidence_id, memory_id, chat_id, message_id, provider, exact_excerpt,
          start_offset, end_offset, segment_id, evidence_role, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        evidence.evidence_id,
        evidence.memory_id,
        evidence.chat_id,
        evidence.message_id,
        evidence.provider,
        evidence.exact_excerpt,
        evidence.start_offset,
        evidence.end_offset,
        evidence.segment_id ?? null,
        evidence.evidence_role ?? 'supports',
        evidence.created_at
      )
  }

  listEvidence(memoryId?: string): MemoryEvidence[] {
    const rows = (
      memoryId
        ? this.db
            .prepare(
              `SELECT e.*, EXISTS(
                 SELECT 1 FROM messages m WHERE m.message_id = e.message_id AND m.chat_id = e.chat_id
               ) AS source_available
               FROM memory_evidence e WHERE e.memory_id = ? ORDER BY e.created_at`
            )
            .all(memoryId)
        : this.db
            .prepare(
              `SELECT e.*, EXISTS(
                 SELECT 1 FROM messages m WHERE m.message_id = e.message_id AND m.chat_id = e.chat_id
               ) AS source_available
               FROM memory_evidence e ORDER BY e.created_at`
            )
            .all()
    ) as Array<Record<string, unknown>>
    return rows.map((row) => ({
      evidence_id: String(row.evidence_id),
      memory_id: String(row.memory_id),
      chat_id: String(row.chat_id),
      message_id: String(row.message_id),
      provider: String(row.provider),
      exact_excerpt: String(row.exact_excerpt),
      start_offset: row.start_offset === null ? null : Number(row.start_offset),
      end_offset: row.end_offset === null ? null : Number(row.end_offset),
      segment_id: row.segment_id ? String(row.segment_id) : null,
      evidence_role: String(row.evidence_role ?? 'supports') as MemoryEvidence['evidence_role'],
      created_at: String(row.created_at),
      source_available: Boolean(row.source_available)
    }))
  }

  upsertTopic(topic: TopicSegment): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO topics
       (topic_id, chat_id, project_id, ordinal, label, message_ids, started_at, ended_at,
        entities, character_count, content_hash, project_confidence, project_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        topic.topic_id,
        topic.chat_id,
        topic.project_id,
        topic.ordinal,
        topic.label,
        JSON.stringify(topic.message_ids),
        topic.started_at,
        topic.ended_at,
        JSON.stringify(topic.entities),
        topic.character_count,
        topic.content_hash,
        topic.project_confidence ?? null,
        topic.project_reason ?? null
      )
  }

  deleteTopicsForChat(chatId: string): void {
    this.db.prepare('DELETE FROM topics WHERE chat_id = ?').run(chatId)
  }

  listTopics(chatId?: string): TopicSegment[] {
    const rows = (
      chatId
        ? this.db.prepare('SELECT * FROM topics WHERE chat_id = ? ORDER BY ordinal').all(chatId)
        : this.db.prepare('SELECT * FROM topics ORDER BY started_at DESC').all()
    ) as Array<Record<string, unknown>>
    return rows.map((row) => ({
      topic_id: String(row.topic_id),
      chat_id: String(row.chat_id),
      project_id: row.project_id ? String(row.project_id) : null,
      ordinal: Number(row.ordinal),
      label: String(row.label),
      start_message_id: parseStringArray(row.message_ids)[0]!,
      end_message_id: parseStringArray(row.message_ids).at(-1)!,
      message_ids: parseStringArray(row.message_ids),
      started_at: String(row.started_at),
      ended_at: String(row.ended_at),
      entities: parseStringArray(row.entities),
      character_count: Number(row.character_count),
      content_hash: String(row.content_hash),
      project_confidence:
        row.project_confidence === null || row.project_confidence === undefined
          ? null
          : Number(row.project_confidence),
      project_reason: row.project_reason ? String(row.project_reason) : null
    }))
  }

  upsertImportRecord(record: ImportRecord): void {
    const counters = {
      conversation_count: record.conversation_count,
      message_count: record.message_count,
      imported_count: record.imported_count,
      changed_count: record.changed_count,
      skipped_count: record.skipped_count,
      error_count: record.error_count,
      review_count: record.review_count,
      discovered_count: record.discovered_count,
      branches_handled: record.branches_handled,
      malformed_count: record.malformed_count,
      skipped_entry_count: record.skipped_entry_count
    }
    const metadata = {
      connector_version: record.connector_version,
      validation_status: record.validation_status,
      validation_issues: record.validation_issues
    }
    this.db
      .prepare(
        `INSERT OR REPLACE INTO import_records
       (import_id, connector_id, source_path, archive_hash, status, started_at, completed_at,
        counters, checkpoint, error_category, error_messages, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.import_id,
        record.connector_id,
        record.source_path,
        record.archive_hash,
        record.status,
        record.started_at,
        record.completed_at,
        JSON.stringify(counters),
        JSON.stringify(record.checkpoint),
        record.error_category,
        JSON.stringify(record.error_messages),
        JSON.stringify(metadata)
      )
  }

  findImportByHash(hash: string): ImportRecord | null {
    const row = this.db
      .prepare(
        'SELECT * FROM import_records WHERE archive_hash = ? ORDER BY started_at DESC LIMIT 1'
      )
      .get(hash) as Record<string, unknown> | undefined
    if (!row) return null
    const counters = JSON.parse(String(row.counters)) as Record<string, number>
    const metadata = parseJsonRecord(row.metadata)
    return {
      import_id: String(row.import_id),
      connector_id: String(row.connector_id),
      connector_version: String(metadata.connector_version ?? 'unknown'),
      source_path: String(row.source_path),
      archive_hash: String(row.archive_hash),
      status: String(row.status) as ImportRecord['status'],
      started_at: String(row.started_at),
      completed_at: row.completed_at ? String(row.completed_at) : null,
      conversation_count: counters.conversation_count ?? 0,
      message_count: counters.message_count ?? 0,
      imported_count: counters.imported_count ?? 0,
      changed_count: counters.changed_count ?? 0,
      skipped_count: counters.skipped_count ?? 0,
      error_count: counters.error_count ?? 0,
      review_count: counters.review_count ?? 0,
      discovered_count: counters.discovered_count ?? 0,
      branches_handled: counters.branches_handled ?? 0,
      malformed_count: counters.malformed_count ?? 0,
      skipped_entry_count: counters.skipped_entry_count ?? 0,
      validation_status: String(
        metadata.validation_status ?? 'not_run'
      ) as ImportRecord['validation_status'],
      validation_issues: Array.isArray(metadata.validation_issues)
        ? metadata.validation_issues.filter((value): value is string => typeof value === 'string')
        : [],
      checkpoint: JSON.parse(String(row.checkpoint)) as Record<string, unknown>,
      error_category: row.error_category ? String(row.error_category) : null,
      error_messages: parseStringArray(row.error_messages)
    }
  }

  upsertProviderMemory(memory: ProviderMemory): void {
    const scopeId =
      memory.scope.kind === 'project'
        ? memory.scope.project_id
        : memory.scope.kind === 'conversation'
          ? memory.scope.chat_id
          : memory.scope.kind === 'provider'
            ? memory.scope.reference
            : null
    this.prepared(
      `INSERT OR REPLACE INTO provider_memories
       (provider_memory_id, provider, provider_record_id, statement, source_label,
        source_type, scope_kind, scope_id, state, user_confirmed, imported_at,
        provider_updated_at, raw_source_reference, superseded_by, content_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      memory.provider_memory_id,
      memory.provider,
      memory.provider_record_id,
      memory.statement,
      memory.source_label,
      memory.source_type,
      memory.scope.kind,
      scopeId,
      memory.state,
      memory.user_confirmed ? 1 : 0,
      memory.imported_at,
      memory.provider_updated_at,
      memory.raw_source_reference,
      memory.superseded_by,
      memory.content_hash
    )
    if (!this.deferSearchIndexWrites) {
      this.prepared('DELETE FROM provider_memories_fts WHERE provider_memory_id = ?').run(
        memory.provider_memory_id
      )
      this.prepared(
        `INSERT INTO provider_memories_fts
         (provider_memory_id, statement, provider, source_type, state) VALUES (?, ?, ?, ?, ?)`
      ).run(
        memory.provider_memory_id,
        memory.statement,
        memory.provider,
        memory.source_type,
        memory.state
      )
    }
  }

  listProviderMemories(): ProviderMemory[] {
    return (
      this.db.prepare('SELECT * FROM provider_memories ORDER BY imported_at DESC').all() as Array<
        Record<string, unknown>
      >
    ).map((row) => ({
      provider_memory_id: String(row.provider_memory_id),
      provider: String(row.provider),
      provider_record_id: row.provider_record_id ? String(row.provider_record_id) : null,
      source_type: String(
        row.source_type ?? 'provider_saved_memory'
      ) as ProviderMemory['source_type'],
      statement: String(row.statement),
      source_label: String(row.source_label),
      scope:
        String(row.scope_kind) === 'global'
          ? { kind: 'global' }
          : String(row.scope_kind) === 'project'
            ? { kind: 'project', project_id: String(row.scope_id) }
            : String(row.scope_kind) === 'conversation'
              ? { kind: 'conversation', chat_id: String(row.scope_id) }
              : {
                  kind: 'provider',
                  level: providerLevelFromSourceType(String(row.source_type)),
                  reference: row.scope_id ? String(row.scope_id) : null
                },
      state: String(row.state) as ProviderMemory['state'],
      user_confirmed: Boolean(row.user_confirmed),
      imported_at: String(row.imported_at),
      provider_updated_at: row.provider_updated_at ? String(row.provider_updated_at) : null,
      raw_source_reference: row.raw_source_reference ? String(row.raw_source_reference) : null,
      superseded_by: row.superseded_by ? String(row.superseded_by) : null,
      content_hash: String(row.content_hash)
    }))
  }

  invalidateEmbedding(memoryId: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM embeddings WHERE memory_id = ?').run(memoryId)
      this.db
        .prepare(
          "UPDATE memories SET embedding_state = 'stale', embedding_content_hash = NULL WHERE memory_id = ?"
        )
        .run(memoryId)
    })
  }

  storeEmbedding(memoryId: string, model: string, vector: number[], contentHash: string): void {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO embeddings (memory_id, model, vector, dimensions, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(memory_id, model) DO UPDATE SET vector=excluded.vector, dimensions=excluded.dimensions, updated_at=excluded.updated_at`
        )
        .run(memoryId, model, JSON.stringify(vector), vector.length, new Date().toISOString())
      this.db
        .prepare(
          "UPDATE memories SET embedding_state = 'current', embedding_content_hash = ? WHERE memory_id = ?"
        )
        .run(contentHash, memoryId)
    })
  }

  getEmbeddings(model: string): Array<{ memoryId: string; vector: number[] }> {
    const rows = this.db
      .prepare('SELECT memory_id, vector FROM embeddings WHERE model = ?')
      .all(model) as Array<{ memory_id: string; vector: string }>
    return rows.map((row) => ({
      memoryId: row.memory_id,
      vector: JSON.parse(row.vector) as number[]
    }))
  }

  listNonterminalMessages(): Message[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM messages WHERE role = 'assistant' AND status IN ('pending', 'streaming')"
      )
      .all() as Array<Record<string, unknown>>
    return rows.map(rowToMessage)
  }

  listMessageRange(chatId: string, afterSequence: number, limit: number): Message[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM messages WHERE chat_id = ? AND sequence > ? ORDER BY sequence LIMIT ?'
      )
      .all(chatId, afterSequence, Math.max(1, Math.min(limit, 1000))) as Array<
      Record<string, unknown>
    >
    return rows.map(rowToMessage)
  }

  countMessages(chatId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM messages WHERE chat_id = ?')
      .get(chatId) as { count: number }
    return Number(row.count)
  }

  vaultCounts(): { projects: number; chats: number; messages: number; memories: number } {
    const row = this.db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM projects) AS projects,
          (SELECT COUNT(*) FROM chats) AS chats,
          (SELECT COUNT(*) FROM messages) AS messages,
          (SELECT COUNT(*) FROM memories) AS memories`
      )
      .get() as { projects: number; chats: number; messages: number; memories: number }
    return {
      projects: Number(row.projects),
      chats: Number(row.chats),
      messages: Number(row.messages),
      memories: Number(row.memories)
    }
  }

  embeddingPayloadBytes(): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(length(vector)), 0) AS bytes FROM embeddings')
      .get() as { bytes: number }
    return Number(row.bytes)
  }

  search(input: SearchInput): SearchResult[] {
    const terms = toFtsQuery(input.query)
    if (!terms) return []
    const results: SearchResult[] = []
    const memoryFilters = buildFilters(input, 'm')
    const memoryRows =
      input.sourceType && input.sourceType !== 'memory'
        ? []
        : (this.db
            .prepare(
              `SELECT m.memory_id, m.chat_id, m.project_id, c.title, m.statement, m.type, m.state,
                      m.source_message_ids, m.created_at, bm25(memories_fts) AS rank
               FROM memories_fts
               JOIN memories m ON m.memory_id = memories_fts.memory_id
               JOIN chats c ON c.chat_id = m.chat_id
               WHERE memories_fts MATCH ? ${memoryFilters.sql}
               ORDER BY rank LIMIT ?`
            )
            .all(terms, ...memoryFilters.values, input.limit) as Array<Record<string, unknown>>)
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

    if ((!input.sourceType || input.sourceType === 'provider_memory') && !input.memoryType) {
      const providerClauses = ['provider_memories_fts MATCH ?']
      const providerValues: Array<string | number> = [terms]
      if (!input.includeHistory)
        providerClauses.push("p.state NOT IN ('superseded','rejected','deleted')")
      if (input.provider) {
        providerClauses.push('p.provider = ?')
        providerValues.push(input.provider)
      }
      if (input.projectId) {
        providerClauses.push(
          "(p.scope_kind = 'global' OR (p.scope_kind = 'project' AND p.scope_id = ?))"
        )
        providerValues.push(input.projectId)
      } else if (input.chatId) {
        providerClauses.push(
          "(p.scope_kind = 'global' OR (p.scope_kind = 'conversation' AND p.scope_id = ?))"
        )
        providerValues.push(input.chatId)
      } else if (!input.allProjects) providerClauses.push("p.scope_kind = 'global'")
      if (input.fromDate) {
        providerClauses.push('p.imported_at >= ?')
        providerValues.push(`${input.fromDate}T00:00:00.000Z`)
      }
      if (input.toDate) {
        providerClauses.push('p.imported_at < ?')
        providerValues.push(`${nextDate(input.toDate)}T00:00:00.000Z`)
      }
      providerValues.push(input.limit)
      const providerRows = this.db
        .prepare(
          `SELECT p.*, bm25(provider_memories_fts) AS rank
           FROM provider_memories_fts
           JOIN provider_memories p
             ON p.provider_memory_id = provider_memories_fts.provider_memory_id
           WHERE ${providerClauses.join(' AND ')} ORDER BY rank LIMIT ?`
        )
        .all(...providerValues) as Array<Record<string, unknown>>
      for (const row of providerRows) {
        results.push({
          kind: 'provider_memory',
          id: String(row.provider_memory_id),
          chatId: String(row.scope_kind) === 'conversation' ? String(row.scope_id) : null,
          projectId: String(row.scope_kind) === 'project' ? String(row.scope_id) : null,
          title: `${String(row.provider)} provider memory`,
          excerpt: excerpt(String(row.statement)),
          memoryType: null,
          state: String(row.state),
          sourceMessageIds: [],
          score: 9 - Number(row.rank),
          createdAt: String(row.imported_at)
        })
      }
    }

    if (
      input.memoryType ||
      input.state ||
      input.sourceType === 'memory' ||
      input.sourceType === 'provider_memory'
    ) {
      return results.sort((a, b) => b.score - a.score).slice(0, input.limit)
    }

    if (!input.allProjects && !input.projectId && !input.chatId) {
      return results.sort((a, b) => b.score - a.score).slice(0, input.limit)
    }
    if (input.sourceType && input.sourceType !== 'conversation')
      return results.sort((a, b) => b.score - a.score).slice(0, input.limit)
    const projectClause = input.projectId ? ' AND c.project_id = ?' : ''
    const chatClause = input.chatId ? ' AND m.chat_id = ?' : ''
    const messageProviderClause = input.provider ? ' AND m.provider = ?' : ''
    const messageTopicClause = input.topicId
      ? ' AND EXISTS (SELECT 1 FROM topics t, json_each(t.message_ids) tm WHERE t.topic_id = ? AND tm.value = m.message_id)'
      : ''
    const fromClause = input.fromDate ? ' AND m.created_at >= ?' : ''
    const toClause = input.toDate ? ' AND m.created_at < ?' : ''
    const messageValues = [
      terms,
      ...(input.projectId ? [input.projectId] : []),
      ...(input.chatId ? [input.chatId] : []),
      ...(input.provider ? [input.provider] : []),
      ...(input.topicId ? [input.topicId] : []),
      ...(input.fromDate ? [`${input.fromDate}T00:00:00.000Z`] : []),
      ...(input.toDate ? [`${nextDate(input.toDate)}T00:00:00.000Z`] : []),
      input.limit
    ]
    const messageRows = this.db
      .prepare(
        `SELECT m.message_id, m.chat_id, c.project_id, c.title, m.content, m.created_at,
                bm25(messages_fts) AS rank
         FROM messages_fts
         JOIN messages m ON m.message_id = messages_fts.message_id
         JOIN chats c ON c.chat_id = m.chat_id
         WHERE messages_fts MATCH ? AND m.status = 'complete' ${projectClause} ${chatClause} ${messageProviderClause} ${messageTopicClause} ${fromClause} ${toClause}
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
    const chatIdClause = input.chatId ? ' AND c.chat_id = ?' : ''
    const chatProviderClause = input.provider ? ' AND c.source_provider = ?' : ''
    const chatTopicClause = input.topicId
      ? ' AND EXISTS (SELECT 1 FROM topics t WHERE t.topic_id = ? AND t.chat_id = c.chat_id)'
      : ''
    const chatFromClause = input.fromDate ? ' AND c.created_at >= ?' : ''
    const chatToClause = input.toDate ? ' AND c.created_at < ?' : ''
    const chatRows = this.db
      .prepare(
        `SELECT c.chat_id, c.project_id, c.title, c.created_at, bm25(chats_fts) AS rank
         FROM chats_fts JOIN chats c ON c.chat_id = chats_fts.chat_id
         WHERE chats_fts MATCH ? ${chatProjectClause} ${chatIdClause} ${chatProviderClause} ${chatTopicClause} ${chatFromClause} ${chatToClause}
         ORDER BY rank LIMIT ?`
      )
      .all(
        terms,
        ...(input.projectId ? [input.projectId] : []),
        ...(input.chatId ? [input.chatId] : []),
        ...(input.provider ? [input.provider] : []),
        ...(input.topicId ? [input.topicId] : []),
        ...(input.fromDate ? [`${input.fromDate}T00:00:00.000Z`] : []),
        ...(input.toDate ? [`${nextDate(input.toDate)}T00:00:00.000Z`] : []),
        input.limit
      ) as Array<Record<string, unknown>>
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

  listActiveMemories(
    projectId: string | null,
    chatId?: string | null,
    includeConversation = true
  ): Memory[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memories
         WHERE state IN ('active', 'confirmed', 'completed', 'needs_review')
         ORDER BY pinned DESC, user_confirmed DESC, updated_at DESC`
      )
      .all() as Array<Record<string, unknown>>
    return filterMemoriesForScope(rows.map(rowToMemory), {
      projectId,
      chatId,
      includeConversation
    })
  }

  listProjectMemoryIds(projectId: string): string[] {
    return (
      this.db
        .prepare("SELECT memory_id FROM memories WHERE project_id = ? AND state != 'deleted'")
        .all(projectId) as Array<{ memory_id: string }>
    ).map((row) => row.memory_id)
  }

  private get db(): DatabaseSync {
    if (!this.database) throw new Error('Index database is not open.')
    return this.database
  }

  private prepared(sql: string): ReturnType<DatabaseSync['prepare']> {
    const existing = this.statementCache.get(sql)
    if (existing) return existing
    const statement = this.db.prepare(sql)
    this.statementCache.set(sql, statement)
    return statement
  }

  private transaction(action: () => void): void {
    if (this.db.isTransaction) {
      action()
      return
    }
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
        title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        source_provider TEXT NOT NULL DEFAULT 'native', source_conversation_id TEXT,
        original_title TEXT, workspace TEXT, model_ids TEXT NOT NULL DEFAULT '[]',
        branch_count INTEGER NOT NULL DEFAULT 1, attachment_count INTEGER NOT NULL DEFAULT 0,
        citation_count INTEGER NOT NULL DEFAULT 0, sync_state TEXT NOT NULL DEFAULT 'local',
        processing_state TEXT NOT NULL DEFAULT 'unprocessed', import_origin TEXT,
        content_hash TEXT, raw_metadata TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS messages (
        message_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(chat_id) ON DELETE CASCADE,
        role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        provider TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, sequence INTEGER NOT NULL,
        error_category TEXT, retrieved_memory_ids TEXT NOT NULL DEFAULT '[]',
        retrieved_context_ids TEXT NOT NULL DEFAULT '[]', provider_message_id TEXT,
        parent_message_id TEXT, branch_id TEXT, content_blocks TEXT NOT NULL DEFAULT '[]',
        attachments TEXT NOT NULL DEFAULT '[]', tool_events TEXT NOT NULL DEFAULT '[]',
        citations TEXT NOT NULL DEFAULT '[]', raw_metadata TEXT NOT NULL DEFAULT '{}', content_hash TEXT
      );
      CREATE TABLE IF NOT EXISTS memories (
        memory_id TEXT PRIMARY KEY, type TEXT NOT NULL, statement TEXT NOT NULL, project_id TEXT,
        chat_id TEXT NOT NULL REFERENCES chats(chat_id) ON DELETE CASCADE,
        source_message_ids TEXT NOT NULL, state TEXT NOT NULL, confidence REAL NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, effective_at TEXT NOT NULL,
        supersedes TEXT NOT NULL, superseded_by TEXT, entities TEXT NOT NULL, tags TEXT NOT NULL,
        user_confirmed INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
        scope_kind TEXT NOT NULL DEFAULT 'conversation', scope_id TEXT,
        confirmation_source TEXT NOT NULL DEFAULT 'none', evidence_ids TEXT NOT NULL DEFAULT '[]',
        source_chat_ids TEXT NOT NULL DEFAULT '[]', valid_from TEXT, valid_until TEXT,
        temporal_precision TEXT NOT NULL DEFAULT 'unknown', embedding_state TEXT NOT NULL DEFAULT 'missing',
        embedding_content_hash TEXT, source_provider TEXT NOT NULL DEFAULT 'native',
        source_type TEXT NOT NULL DEFAULT 'auto_extracted'
      );
      CREATE TABLE IF NOT EXISTS memory_relationships (
        source_memory_id TEXT NOT NULL, target_memory_id TEXT NOT NULL, relationship TEXT NOT NULL,
        PRIMARY KEY (source_memory_id, target_memory_id, relationship)
      );
      CREATE TABLE IF NOT EXISTS extraction_runs (
        extraction_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL, source_message_ids TEXT NOT NULL,
        candidate_count INTEGER NOT NULL, error_category TEXT,
        checkpoint INTEGER NOT NULL DEFAULT 0, total_segments INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS embeddings (
        memory_id TEXT NOT NULL, model TEXT NOT NULL, vector TEXT NOT NULL, dimensions INTEGER NOT NULL,
        updated_at TEXT NOT NULL, PRIMARY KEY (memory_id, model)
      );
      CREATE TABLE IF NOT EXISTS index_versions (name TEXT PRIMARY KEY, version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_evidence (
        evidence_id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL, provider TEXT NOT NULL, exact_excerpt TEXT NOT NULL,
        start_offset INTEGER, end_offset INTEGER, segment_id TEXT,
        evidence_role TEXT NOT NULL DEFAULT 'supports', created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS topics (
        topic_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, project_id TEXT, ordinal INTEGER NOT NULL,
        label TEXT NOT NULL, message_ids TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT NOT NULL,
        entities TEXT NOT NULL, character_count INTEGER NOT NULL, content_hash TEXT NOT NULL,
        project_confidence REAL, project_reason TEXT
      );
      CREATE TABLE IF NOT EXISTS import_records (
        import_id TEXT PRIMARY KEY, connector_id TEXT NOT NULL, source_path TEXT NOT NULL,
        archive_hash TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL,
        completed_at TEXT, counters TEXT NOT NULL, checkpoint TEXT NOT NULL, error_category TEXT,
        error_messages TEXT NOT NULL DEFAULT '[]', metadata TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS connector_state (
        connector_id TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_memories (
        provider_memory_id TEXT PRIMARY KEY, provider TEXT NOT NULL, provider_record_id TEXT,
        statement TEXT NOT NULL, source_label TEXT NOT NULL,
        source_type TEXT NOT NULL DEFAULT 'provider_saved_memory', scope_kind TEXT NOT NULL,
        scope_id TEXT, state TEXT NOT NULL, user_confirmed INTEGER NOT NULL DEFAULT 0,
        imported_at TEXT NOT NULL, provider_updated_at TEXT, raw_source_reference TEXT,
        superseded_by TEXT, content_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS temporal_index (
        memory_id TEXT PRIMARY KEY, valid_from TEXT, valid_until TEXT, precision TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_entities (
        memory_id TEXT NOT NULL, entity TEXT NOT NULL,
        PRIMARY KEY (memory_id, entity)
      );
      CREATE INDEX IF NOT EXISTS memory_entities_entity ON memory_entities(entity);
      CREATE TABLE IF NOT EXISTS entity_relationships (
        source_entity TEXT NOT NULL, target_entity TEXT NOT NULL, relationship TEXT NOT NULL,
        memory_id TEXT NOT NULL, scope_kind TEXT NOT NULL, scope_id TEXT, updated_at TEXT NOT NULL,
        PRIMARY KEY (source_entity, target_entity, relationship, memory_id)
      );
      CREATE INDEX IF NOT EXISTS entity_relationships_source ON entity_relationships(source_entity);
      CREATE INDEX IF NOT EXISTS entity_relationships_target ON entity_relationships(target_entity);
      CREATE VIRTUAL TABLE IF NOT EXISTS chats_fts USING fts5(chat_id UNINDEXED, title, project_id UNINDEXED, tokenize='unicode61 remove_diacritics 2');
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(message_id UNINDEXED, content, chat_id UNINDEXED, project_id UNINDEXED, tokenize='unicode61 remove_diacritics 2');
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(memory_id UNINDEXED, statement, type, state, project_id UNINDEXED, chat_id UNINDEXED, tokenize='unicode61 remove_diacritics 2');
      CREATE VIRTUAL TABLE IF NOT EXISTS provider_memories_fts USING fts5(provider_memory_id UNINDEXED, statement, provider, source_type, state, tokenize='unicode61 remove_diacritics 2');
    `)
    const priorVersion = this.db
      .prepare("SELECT version FROM index_versions WHERE name = 'main'")
      .get() as { version: number } | undefined
    this.contentRebuildRequired = !priorVersion || priorVersion.version < SCHEMA_VERSION
    ensureColumns(this.db, 'messages', [
      ['retrieved_context_ids', "TEXT NOT NULL DEFAULT '[]'"],
      ['provider_message_id', 'TEXT'],
      ['parent_message_id', 'TEXT'],
      ['branch_id', 'TEXT'],
      ['content_blocks', "TEXT NOT NULL DEFAULT '[]'"],
      ['attachments', "TEXT NOT NULL DEFAULT '[]'"],
      ['tool_events', "TEXT NOT NULL DEFAULT '[]'"],
      ['citations', "TEXT NOT NULL DEFAULT '[]'"],
      ['raw_metadata', "TEXT NOT NULL DEFAULT '{}'"],
      ['content_hash', 'TEXT']
    ])
    ensureColumns(this.db, 'chats', [
      ['source_provider', "TEXT NOT NULL DEFAULT 'native'"],
      ['source_conversation_id', 'TEXT'],
      ['original_title', 'TEXT'],
      ['workspace', 'TEXT'],
      ['model_ids', "TEXT NOT NULL DEFAULT '[]'"],
      ['branch_count', 'INTEGER NOT NULL DEFAULT 1'],
      ['attachment_count', 'INTEGER NOT NULL DEFAULT 0'],
      ['citation_count', 'INTEGER NOT NULL DEFAULT 0'],
      ['sync_state', "TEXT NOT NULL DEFAULT 'local'"],
      ['processing_state', "TEXT NOT NULL DEFAULT 'unprocessed'"],
      ['import_origin', 'TEXT'],
      ['content_hash', 'TEXT'],
      ['raw_metadata', "TEXT NOT NULL DEFAULT '{}'"]
    ])
    ensureColumns(this.db, 'memories', [
      ['scope_kind', "TEXT NOT NULL DEFAULT 'conversation'"],
      ['scope_id', 'TEXT'],
      ['confirmation_source', "TEXT NOT NULL DEFAULT 'none'"],
      ['evidence_ids', "TEXT NOT NULL DEFAULT '[]'"],
      ['source_chat_ids', "TEXT NOT NULL DEFAULT '[]'"],
      ['valid_from', 'TEXT'],
      ['valid_until', 'TEXT'],
      ['temporal_precision', "TEXT NOT NULL DEFAULT 'unknown'"],
      ['embedding_state', "TEXT NOT NULL DEFAULT 'missing'"],
      ['embedding_content_hash', 'TEXT'],
      ['source_provider', "TEXT NOT NULL DEFAULT 'native'"],
      ['source_type', "TEXT NOT NULL DEFAULT 'auto_extracted'"]
    ])
    ensureColumns(this.db, 'memory_evidence', [
      ['segment_id', 'TEXT'],
      ['evidence_role', "TEXT NOT NULL DEFAULT 'supports'"]
    ])
    ensureColumns(this.db, 'topics', [
      ['project_confidence', 'REAL'],
      ['project_reason', 'TEXT']
    ])
    ensureColumns(this.db, 'import_records', [
      ['error_messages', "TEXT NOT NULL DEFAULT '[]'"],
      ['metadata', "TEXT NOT NULL DEFAULT '{}'"]
    ])
    ensureColumns(this.db, 'provider_memories', [
      ['source_type', "TEXT NOT NULL DEFAULT 'provider_saved_memory'"],
      ['user_confirmed', 'INTEGER NOT NULL DEFAULT 0'],
      ['provider_updated_at', 'TEXT'],
      ['raw_source_reference', 'TEXT'],
      ['superseded_by', 'TEXT']
    ])
    ensureColumns(this.db, 'extraction_runs', [
      ['checkpoint', 'INTEGER NOT NULL DEFAULT 0'],
      ['total_segments', 'INTEGER NOT NULL DEFAULT 1']
    ])
    this.db
      .prepare("UPDATE provider_memories SET state = 'needs_review' WHERE state = 'imported'")
      .run()
    this.db.prepare("UPDATE provider_memories SET state = 'active' WHERE state = 'reviewed'").run()
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
    .join(' OR ')
}

function buildFilters(
  input: SearchInput,
  alias: string
): { sql: string; values: Array<string | number | null> } {
  const clauses: string[] = []
  const values: Array<string | number | null> = []
  if (!input.includeHistory && !input.state)
    clauses.push(`${alias}.state NOT IN ('superseded','rejected','deleted')`)
  if (!input.allProjects) {
    const global = `(${alias}.scope_kind = 'global' AND ${alias}.state = 'confirmed' AND ${alias}.user_confirmed = 1 AND ${alias}.confirmation_source != 'none')`
    if (input.projectId) {
      clauses.push(`(${global} OR (${alias}.scope_kind = 'project' AND ${alias}.scope_id = ?))`)
      values.push(input.projectId)
    } else if (input.chatId) {
      clauses.push(
        `(${global} OR (${alias}.scope_kind = 'conversation' AND ${alias}.scope_id = ?))`
      )
      values.push(input.chatId)
    } else clauses.push(global)
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
  if (input.provider) {
    clauses.push(`${alias}.source_provider = ?`)
    values.push(input.provider)
  }
  if (input.topicId) {
    clauses.push(
      `EXISTS (SELECT 1 FROM topics t, json_each(t.message_ids) tm, json_each(${alias}.source_message_ids) sm WHERE t.topic_id = ? AND tm.value = sm.value)`
    )
    values.push(input.topicId)
  }
  if (input.confirmedOnly) clauses.push(`${alias}.user_confirmed = 1`)
  if (input.fromDate) {
    clauses.push(`${alias}.created_at >= ?`)
    values.push(`${input.fromDate}T00:00:00.000Z`)
  }
  if (input.toDate) {
    clauses.push(`${alias}.created_at < ?`)
    values.push(`${nextDate(input.toDate)}T00:00:00.000Z`)
  }
  return { sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', values }
}

function nextDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString().slice(0, 10)
}

function rowToMemory(row: Record<string, unknown>): Memory {
  const scopeKind = String(row.scope_kind ?? (row.project_id ? 'project' : 'conversation'))
  const scopeId = row.scope_id ? String(row.scope_id) : null
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
    pinned: Boolean(row.pinned),
    scope:
      scopeKind === 'global'
        ? { kind: 'global' }
        : scopeKind === 'project' && scopeId
          ? { kind: 'project', project_id: scopeId }
          : { kind: 'conversation', chat_id: scopeId ?? String(row.chat_id) },
    confirmation_source: String(row.confirmation_source ?? 'none') as Memory['confirmation_source'],
    evidence_ids: parseStringArray(row.evidence_ids),
    source_chat_ids: parseStringArray(row.source_chat_ids, [String(row.chat_id)]),
    valid_from: row.valid_from ? String(row.valid_from) : null,
    valid_until: row.valid_until ? String(row.valid_until) : null,
    temporal_precision: String(row.temporal_precision ?? 'unknown') as Memory['temporal_precision'],
    embedding_state: String(row.embedding_state ?? 'missing') as Memory['embedding_state'],
    embedding_content_hash: row.embedding_content_hash ? String(row.embedding_content_hash) : null,
    source_provider: String(row.source_provider ?? 'native'),
    source_type: String(row.source_type ?? 'auto_extracted') as Memory['source_type']
  }
}

function rowToMessage(row: Record<string, unknown>): Message {
  return {
    message_id: String(row.message_id),
    chat_id: String(row.chat_id),
    role: String(row.role) as Message['role'],
    content: String(row.content),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    provider: String(row.provider),
    model: String(row.model),
    status: String(row.status) as Message['status'],
    sequence: Number(row.sequence),
    error_category: row.error_category ? String(row.error_category) : undefined,
    retrieved_memory_ids: parseStringArray(row.retrieved_memory_ids),
    retrieved_context_ids: parseStringArray(row.retrieved_context_ids),
    provider_message_id: row.provider_message_id ? String(row.provider_message_id) : null,
    parent_message_id: row.parent_message_id ? String(row.parent_message_id) : null,
    branch_id: row.branch_id ? String(row.branch_id) : null,
    content_blocks: parseJsonRecords(row.content_blocks),
    attachments: parseJsonRecords(row.attachments),
    tool_events: parseJsonRecords(row.tool_events),
    citations: parseJsonRecords(row.citations),
    raw_metadata: parseJsonRecord(row.raw_metadata),
    content_hash: row.content_hash ? String(row.content_hash) : null
  }
}

function parseStringArray(value: unknown, fallback: string[] = []): string[] {
  try {
    return value ? (JSON.parse(String(value)) as string[]) : fallback
  } catch {
    return fallback
  }
}

function parseJsonRecords(value: unknown): Array<Record<string, unknown>> {
  try {
    return value ? (JSON.parse(String(value)) as Array<Record<string, unknown>>) : []
  } catch {
    return []
  }
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  try {
    return value ? (JSON.parse(String(value)) as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function providerLevelFromSourceType(
  sourceType: string
): 'project' | 'workspace' | 'conversation' | 'unknown' {
  if (sourceType === 'project_instruction') return 'project'
  if (sourceType === 'workspace_instruction') return 'workspace'
  if (sourceType === 'provider_summary') return 'conversation'
  return 'unknown'
}

function ensureColumns(
  database: DatabaseSync,
  table: string,
  columns: Array<[name: string, declaration: string]>
): void {
  const existing = new Set(
    (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )
  for (const [name, declaration] of columns) {
    if (!existing.has(name)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`)
  }
}
