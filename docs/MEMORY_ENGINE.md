# Memory engine

## Taxonomy and significance

MemoryBridge extracts decisions, agreements, completed items, durable facts, preferences, instructions, commitments, open questions, project state, and rejected options. A statement is significant when it changes future answers or project state, records a choice/completion/durable preference, avoids repeated investigation, creates/resolves an important question, supersedes prior information, or is explicitly requested for memory.

Greetings, filler, rhetorical text, repeated unchanged facts, unsupported implications, AI suggestions not accepted by the user, and proposals phrased as possibilities are excluded. “Could use Electron” is not a decision; “decided to use Electron” is.

## Extraction strategy

After a completed assistant turn, the engine selects at most 12 recent validated message snapshots and related existing memories. Mock mode uses deterministic English rules for demonstrations and test fixtures. A real provider receives a compact system instruction plus messages labeled with immutable source IDs and must return strict JSON-schema output.

Candidates include type, statement, source IDs, confidence, entities/tags, duplicate/conflict/supersession hints, explicit confirmation, completion, and unresolved flags. Zod rejects malformed output. Candidates citing any ID outside the supplied window are dropped and the extraction run records the invalid reference. The entire historical transcript is never sent by default.

## Reconciliation

1. Exact normalized statement/type/project matches merge provenance and confidence.
2. High keyword/entity overlap controls likely duplicates.
3. Explicit or strongly inferred updated quantities/“no longer” language links the new memory to the old one and marks the old record superseded.
4. A related completed item resolves an active commitment while preserving both records and evidence.
5. Rejected options enter `rejected` state and default retrieval excludes them.
6. An unresolved conflict preserves both sides as disputed.
7. A non-confirmed candidate cannot silently supersede a user-confirmed memory; it becomes disputed instead.

The review panel can confirm, edit, reject, pin/unpin, merge, delete, or explicitly supersede records. Corrections become user-confirmed.

## Hybrid retrieval ranking

Default retrieval first excludes `superseded`, `rejected`, `disputed`, and `deleted`. For remaining memories, the score is:

```text
confidence × (
  0.36 keyword coverage +
  0.24 cosine similarity +
  0.14 project affinity +
  0.08 exact phrase +
  0.06 user confirmation +
  0.05 pinned +
  0.04 recency +
  0.03 memory-type boost
)
```

Global memories receive partial affinity; a selected project receives full affinity. Results must clear a minimum score, are capped by the maximum-memory setting, then fit the character budget. Every injected item includes type/state, project, source chat title, source IDs, excerpt, timestamp, and score. The assistant message records which memory IDs were supplied.

## Known limitations

- Deterministic mock extraction is conservative and English-oriented; it exists for reliable offline validation, not full language understanding.
- Keyword-based conflict inference is intentionally cautious and may send ambiguous changes to review.
- Semantic quality depends on the configured embedding model and is optional.
- Cross-chat entity resolution is lexical in the MVP; no hosted knowledge graph is used.
