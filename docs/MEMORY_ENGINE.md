# Memory engine

## Eligibility and segmentation

Only complete messages are authoritative by default; failed, cancelled, interrupted, pending, and streaming content is retained but excluded. Turn extraction is bounded by an extraction character budget. Full-chat processing segments complete history deterministically by character budget, six-hour gaps, and topic shift, with bounded overlap. Stable topic hashes preserve topic IDs. Per-chat checkpoint files record complete, failed, running, and cancelled segments plus attempts and safe error categories. Complete hashes are skipped, failed hashes retry, and forced segment runs remain available. Progress and cancellation are exposed for segment, chat, project, and vault scopes.

An assigned chat inherits its project. An unassigned segment is classified only when exact project naming or distinctive overlap clears confidence and separation thresholds; ambiguous segments remain conversation-scoped. Reprocessing preserves explicit user-confirmed memories and surfaces new conflicts instead of silently deleting them.

## Candidate validation

The extractor prompt asks for durable, cited claims, but its output is untrusted. MemoryBridge independently checks:

1. Every source ID belongs to the eligible supplied messages.
2. Duplicate/conflict/supersession targets exist, are lifecycle-eligible, and share the intended exact scope.
3. A completion hint has explicit user completion language.
4. Negated decisions are not promoted and uncertain claims become `needs_review`.
5. A model response cannot set confirmed state or user confirmation. Only an explicit user action or deterministic user-language rule can do so.
6. Cross-project relationships and merges are rejected.

The deterministic extractor covers decisions, agreements, completion, facts, preferences, instructions, commitments, open questions, state, rejection, correction, constraint, deadline, artifact, and uncertainty. Provider extraction failures never block transcript persistence.

## Reconciliation

Exact normalization and conservative keyword/entity comparison control duplicates. Numeric changes are not collapsed as duplicates. Supersession preserves both records and evidence. Confirmed memory is not silently replaced by unconfirmed candidates. Completion can close a related active commitment only inside the same scope.

Every accepted source becomes a `MemoryEvidence` record with its segment and semantic role. Duplicate evidence can come from the same or another conversation. Merges copy evidence to the surviving record. Edits and merges invalidate prior embeddings immediately; regenerated embeddings store the statement hash.

## Scope policy

- Project context: exact project memories, confirmed global memories, and optionally the current conversation.
- Unassigned context: confirmed global plus the same conversation; never every project or every unassigned chat.
- All-project context: only when explicitly requested.

This policy is shared by extraction context, duplicate/conflict/supersession/completion logic, manual relationships, hybrid retrieval, search, MCP, and UI scope changes.

## Ranking and budgets

Hybrid score uses lexical, optional semantic, exact phrase, scope, entity, lifecycle, confirmation, pin, recency, type, confidence, and evidence quality signals. Default results exclude superseded, rejected, deleted, disputed, and incomplete sources.

Separate settings bound recent chat, structured memories, transcript excerpts, extraction, segmentation, embeddings, and provider output. Current user text, system constraints, exact project state, confirmed active decisions, direct evidence, and recent context outrank broad history.
