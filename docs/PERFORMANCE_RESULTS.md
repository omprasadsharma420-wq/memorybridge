# Performance results

Measured 2026-07-25. These are one-machine internal-test observations, not universal performance
promises.

## Environment

| Item        | Value                                                |
| ----------- | ---------------------------------------------------- |
| OS          | Windows 11 Home Single Language 64-bit, 10.0.26200   |
| CPU         | Intel Core i7-9750H, 6 cores / 12 logical processors |
| Memory      | 16,611,600 KB visible (approximately 15.8 GiB)       |
| Test volume | Fixed NTFS volume                                    |
| Runtime     | Node v24.18.0, win32 x64                             |
| Command     | `npm run benchmark:large`                            |

## Synthetic dataset

The generator creates no real user data. It wrote:

- 1,000 main conversations and two incremental-import conversations;
- 50 messages per main conversation, 50,004 messages total;
- five projects;
- 1,300 structured memories, including active and superseded decisions, completed items, and
  unresolved commitments;
- repeated entities/identifiers;
- English, Nepali Devanagari, and mixed English-Nepali messages.

## Measured run

| Measurement                                       |                                                   Result |
| ------------------------------------------------- | -------------------------------------------------------: |
| Raw 1,000-conversation chat files                 |                                         32,218,221 bytes |
| Final vault size reported by capacity scan        |                             65,402,666 bytes (62.37 MiB) |
| Dataset generation                                |                                                 4,375 ms |
| Initial authoritative-file/SQLite/FTS index build |                                                 9,615 ms |
| Healthy-vault restart                             |                                                 1,290 ms |
| Representative mixed-language keyword search      |                                                423.47 ms |
| Complete capacity scan                            |                                                   875 ms |
| Peak observed process RSS                         |                           151,740,416 bytes (144.71 MiB) |
| Observed RSS growth during run                    |                             63,766,528 bytes (60.81 MiB) |
| Raw storage growth ratio, 1,000 chats versus 500  |                                                    2.001 |
| Incremental import                                | two initially imported; one later changed; one unchanged |
| Total benchmark duration                          |                                                22,812 ms |

## Assertions exercised

- Dataset generation completed at the required scale.
- Doubling from 500 to 1,000 raw conversations produced a 2.001 storage ratio.
- A representative transcript contained exactly 50 complete records, with no cumulative
  full-response copies.
- A healthy restart returned zero rebuilt projects/chats/messages/memories.
- Mixed-language keyword search remained within the test's 10-second usability ceiling.
- A project-private marker returned no result in a different project.
- Capacity size matched a separate metadata-only recursive scan within the documented tolerance:
  the larger of 16 KiB or 1% (to allow live SQLite metadata changes).
- A later archive processed only one changed conversation and skipped one unchanged conversation.
- Observed RSS growth remained far below the 768 MiB guard and did not scale as a retained
  in-memory copy of all raw files.
- An already-cancelled capacity scan failed safely; an immediate recovery scan completed.

## Optimization discovered during testing

The first full run exceeded the original five-minute ceiling because a full rebuild maintained FTS
row-by-row. MemoryBridge now writes authoritative index rows transactionally and bulk-populates FTS
once during a full rebuild, while ordinary edits remain incremental. After that repair, the same
final full benchmark completed in 22.81 seconds.

## Limitations of this measurement

- RSS is sampled at phase boundaries, so it is an observed peak, not profiler-grade peak memory.
- The benchmark uses synthetic text and local NTFS; export complexity, antivirus, external-drive
  speed, very long messages, and provider latency vary.
- It validates bounded behavior at 50,000 messages, not an unlimited vault size.
- Initial indexing is intentionally different from normal startup. A healthy normal restart does
  not rebuild the index.
