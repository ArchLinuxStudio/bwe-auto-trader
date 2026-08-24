# Current State

Checkpoint date: 2026-08-24, Asia/Shanghai.

## Current Objective

The Windows x64 `v0.1.7` release is complete. It publishes the durable mutation journal together with the Telegram immediate-visibility, network-diagnostics, and ChatGPT quota fixes. The tagged source, `main`, checksums, installer, portable archive, licenses, and GitHub Release are the current public checkpoint.

Implementation, packaging, artifact QA, commit, tag, push, and GitHub Release publication are complete. The first real dedicated-sub-account test remains pending and still requires explicit authorization in the current Thread before any private connection or order.

## Current Status

- Version: `0.1.7` in `package.json` and `package-lock.json`.
- Branch: `main`.
- HEAD, `origin/main`, and tag `v0.1.7`: the release commit containing this checkpoint.
- Published release: [`v0.1.7`](https://github.com/ArchLinuxStudio/bwe-auto-trader/releases/tag/v0.1.7).
- Previous published baseline: [`v0.1.6`](https://github.com/ArchLinuxStudio/bwe-auto-trader/releases/tag/v0.1.6) at `2a06b70252ed98209d13bf8bc5e9038714c38f4d`.
- The durable-journal, Telegram early-visibility, network-diagnostics, and ChatGPT quota implementations are present in the tagged source and `v0.1.7` binaries.
- The Windows x64 `v0.1.7` NSIS/ZIP artifacts completed build, afterPack, archive inspection, hashing, and portable isolated cold-start QA. macOS/Linux still have source/package configuration only and are not release-verified.
- No real Telegram, ChatGPT, or OKX private call and no real order was executed by Codex.

## Completed

Release baseline already present at HEAD:

- teleproto transport with application-owned atomic catch-up and recovered-message trading isolation.
- Message-time authorization through the final OKX POST guard.
- REST ACK/private-stream order state machine, same-origin unknown no-retry reconciliation, credential lifecycle safety, and independent `reduceOnly` manual close.
- Direct-first OKX routing with fixed fallback and no post-mutation route retry.
- Windows x64 `v0.1.6` NSIS/portable release and reviewed dependency/runtime-license gates.

Post-release changes in this working tree:

- Added `mutation-journal.v1.json`, owned by the Electron main process, with a 128 KiB/16-record bound, strict lifecycle-dependent schema, serialized copy-on-write, file sync, atomic rename, and fail-closed corruption/oversize behavior.
- Added awaited `prepared` and `transmitting` commits after unique `clOrdId` generation. `transmitting` records the exact exchange `expTime`; the synchronous authorization guard runs again after that commit and immediately before fetch.
- Added monotonic lifecycle/reconciliation updates for ACK, private order evidence, unknown results, pending/partial state, terminal state, and same-origin resolution. A still-running request may clear `transmitting` only when its final guard proves fetch never began; startup cannot infer that evidence.
- Made account fingerprint, `instId`, `clOrdId`, and any known `ordId` immutable evidence. Conflicting or incomplete exchange identity fails closed instead of rebinding or deleting a record.
- Serialized controller journal transitions so terminal evidence and a concurrent late ACK cannot race. A pre-ACK terminal update with `clOrdId` is first persisted with its `ordId`; an update containing only `ordId` is buffered until ACK provides the binding. Conflicting late ACK/order evidence fails closed.
- Added startup journal loading without auto-connect or auto-arm. Only a semantically valid `prepared` record is locally removable; every phase at or after `transmitting` remains locked.
- Added explicit-connect GET-only recovery bound to a SHA-256 fingerprint of the OKX account `uid`. Exact terminal evidence may clear; pending/partial, account or order identity mismatch, malformed/query failure, position-only evidence, and any number of replacement-client not-found results remain locked.
- Added early blockers for arm, credential replacement, open, and close while the journal is unresolved or unhealthy.
- Added targeted mock tests for the durable boundary, restart phases, corruption/semantic contradictions, immutable identity, first-read/write serialization, concurrent terminal/late-ACK ordering, pre-ACK terminal replay, and cross-client fail-closed behavior.
- Added a no-token, display-only callback for raw Telegram messages successfully reserved in startup/recovery buffers. The timeline now receives one immediate `received + recovered` record while canonical catch-up/FIFO ordering remains unchanged.
- Reused that record at canonical handoff before starting AI, kept `recovered` sticky, and retained the permanent no-order rule. Healthy live messages continue to publish `received -> analyzing` immediately without waiting for AI completion.
- Terminally skip and atomically consume pending observations when stop/emergency/startup rollback/shutdown abandons their flow. Cleanup continues across per-record listener errors, preventing an indefinite “waiting for verification” card, a late callback revival, or an asynchronous multi-record cleanup race.
- Added monitor/coordinator/controller-wiring tests for early startup/recovery visibility, immediate snapshots, canonical de-duplication, AI ordering, no-order isolation, bounded shutdown, and abandoned-observation cleanup. Updated the renderer copy to distinguish AI analysis from Telegram continuity verification.
- Added a renderer-owned diagnostics presentation model keyed by `checkedAt`, so never-run, completed-success, and completed-negative probes are distinct. A missing direct IP after a run now says it was checked but not obtained; Clash/protocol/OKX failures show “检测未通过” or “未识别” instead of “未验证”.
- Added checked time and the direct/proxy address outcome to the settings summary. The button now reports a warning with the specific incomplete probe names when the diagnostic flow completed with negative results, rather than unconditionally presenting success.
- Added pure tri-state presentation tests, including `checkedAt=0`, and tightened the service test contract that an optional OKX failure still returns a completed timestamp.
- Added a dedicated ChatGPT quota state that recognizes structured `usageLimitExceeded`, all nested percentage windows including `secondary`, `spendControlReached`, and existing text fallbacks. Sparse rate-limit notifications preserve unavailable `null` fields, update the matching `rateLimitsByLimitId` bucket, and trigger a revisioned authoritative refresh while exhausted. All full-read entry points now share the same evidence revision, so pending, failed, or superseded responses cannot clear newer exhaustion evidence. Quota skips also start a non-blocking, single-flight, 60-second-throttled full read, allowing later messages to detect natural recovery even if a rolling recovery notification was missed.
- Quota exhaustion now revokes the main-process live capability, blocks re-arming and the final message authorization path, emits one explicit warning, and keeps the authenticated ChatGPT transport represented separately from Telegram monitoring. Monitoring remains running and can be restarted while quota is unavailable; recovery never restores live authorization automatically.
- Each channel message received during quota exhaustion remains in the signal timeline, ends as a clearly worded non-trading `SKIP`, and never reaches the OKX order boundary. The ChatGPT settings card shows a persistent exhausted state and explains that Telegram reception continues.
- Added service, coordinator, and controller regressions for secondary quota, spend control, sparse updates, structured failures, de-duplicated warning, multi-message visibility, monitoring restart, maximum quota percentage, no-order behavior, recovery without automatic re-arm, pending/failed refreshes, stale initialization/public reads, an older turn completing after newer exhaustion evidence, and throttled recovery without a rolling notification.
- Updated README, architecture, decisions, TODO, known issues, and this checkpoint to match the code.

## In Progress

No implementation, packaging, or publication step is partially underway. The Windows x64 `v0.1.7` release and QA records are complete.

## Relevant Files

| Path | Current responsibility |
|---|---|
| `AGENTS.md` | Persistent Agent entry point, safety rules, reading order, and standard commands |
| `docs/INDEX.md` | Documentation map and authority table |
| `docs/ARCHITECTURE.md` | Stable process/module/data-flow and fail-closed invariants |
| `docs/DECISIONS.md` | Accepted constraints and rejected approaches |
| `docs/TODO.md` | Only unfinished executable work |
| `docs/KNOWN_ISSUES.md` | Current limitations and active workarounds |
| `src/main/services/mutation-journal.ts` | Strict durable mutation schema, atomic store, identity binding, and resolution operations |
| `src/main/services/okx.ts` | Final request boundary and awaited mutation lifecycle events |
| `src/main/app-controller.ts` | Journal authority, evidence serialization, service lifecycle, Telegram observation wiring, account binding, and mutation blockers |
| `src/main/services/telegram.ts` | Atomic Telegram recovery plus no-token early observation of successfully buffered raw messages |
| `src/main/services/chatgpt.ts` | Codex protocol, classifier lifecycle, structured quota detection, and sparse rate-limit state |
| `src/main/services/signal-coordinator.ts` | Immediate display records, canonical AI/order gates, quota-specific non-trading results, and runtime pending-order interlocks |
| `src/shared/types.ts` | Public snapshot contract, including the dedicated ChatGPT quota flag |
| `src/renderer/src/App.tsx` | Distinct pending UI for Telegram continuity verification versus AI analysis, plus persistent quota guidance |
| `src/renderer/src/network-diagnostics-view.ts` | Tri-state mapping for never-run, successful, and completed-negative network probes |
| `src/renderer/src/styles.css` | Diagnostic success/information/warning indicators |
| `tests/telegram-monitor.test.ts` | Startup/recovery observation ordering, de-duplication, and bounded-stop tests |
| `tests/unit/app-controller-telegram-visibility.test.ts` | Main-process callback-to-snapshot wiring and emergency cleanup tests |
| `tests/unit/network-diagnostics-view.test.ts` | Renderer diagnostics state and wording tests |
| `tests/unit/network-diagnostics.test.ts` | Injected public/proxy probe behavior and completed-result contract |
| `tests/unit/chatgpt.test.ts` | Structured/text quota classification, rate windows, sparse updates, and recovery |
| `tests/unit/signal-coordinator.test.ts` | Immediate stages, canonical reuse, non-trading recovery, and abandonment tests |
| `tests/unit/mutation-journal.test.ts` | Store lifecycle, integrity, identity, serialization, and redaction tests |
| `tests/unit/okx.test.ts` | Durable precommit/final-guard/ACK/unknown/rejection boundary tests |
| `tests/unit/app-controller-okx-route.test.ts` | Restart recovery, controller races, identity mismatch, and blocker tests |

## Current Implementation

The renderer invokes a frozen preload API. Trusted IPC handlers call `AppController`, which remains the only authority for credentials, live capabilities, service lifecycles, positions, close operations, and durable order evidence.

On a healthy Telegram path, canonical delivery publishes `received` and `analyzing` before awaiting ChatGPT. If startup/recovery ordering holds a raw update, Telegram first emits a separate no-token observation only after buffer reservation; the coordinator publishes one `received + recovered` record immediately. Canonical FIFO handoff later reuses that record and begins AI, but sticky `recovered` metadata prevents any order. If that flow is abandoned first, the record becomes terminal `skipped` and cannot be revived by a late callback.

Network diagnostics remain optional and informational. The main process returns `checkedAt` even when an individual probe times out, returns an invalid response, or cannot obtain an IP. The renderer now uses that completion marker as the tri-state authority and does not treat a negative boolean or missing IP as “never checked”.

ChatGPT quota exhaustion is carried as a dedicated service/controller state rather than a generic sticky connection error. A transition to exhausted synchronously invalidates live authorization and emits one warning, while the ChatGPT authenticated transport and Telegram monitoring remain connected. Later messages continue through the coordinator, are retained on the timeline with quota-specific wording, and return before any exchange operation. New classifier turns are blocked while exhaustion is known, and an older in-flight turn is reduced to the same quota `SKIP` if newer exhaustion evidence arrives. A quota skip may initiate a throttled background full read; only a latest-revision full read can clear analysis unavailability, and recovery never re-arms live trading.

For an order mutation, `OkxV5Client` completes read-only prerequisites and generates a unique `clOrdId`. It then awaits a `prepared` journal commit. Immediately before the order fetch it awaits `transmitting` with the exact exchange expiry, re-runs the existing synchronous live/message generation guard, and only then permits fetch. The journal contains no replay API or persisted authorization capability.

ACK, private-stream updates, read-only recovery, and same-origin evidence enter one controller FIFO. Composite order identity cannot change after it becomes known. Terminal evidence is durably committed; when ACK identity is still pending it remains staged until matching ACK/unknown evidence permits removal. Process-local bidirectional finalized identity tombstones and bounded early-order evidence reject conflicting late updates and prevent pre-ACK evidence from being stranded.

Startup reads the journal before IPC use but does not connect, monitor, or arm. A `prepared` record can be removed only because the transport boundary makes fetch unreachable until the later `transmitting` commit completes; startup never clears `transmitting` from timing or local inference. On an explicit OKX connection, the controller hashes the verified account `uid`, requires an exact fingerprint match, and uses only GET evidence. It never reuses the originating client's 30-second absence rule on a replacement client.

The existing runtime coordinator and manual-close maps remain active defense layers. The journal is the restart-spanning authority and independently blocks every new open/close mutation, live arm, and credential replacement until its state is conclusively resolved.

## Current Problems

There is no known P0 blocker for the current approximately 10 USDT, actively supervised, dedicated-sub-account scope. Important remaining limitations are:

- No real dedicated-sub-account end-to-end validation has been authorized or performed.
- The Telegram latency change is verified with deterministic injected monitor/coordinator tests, not a real Telegram account; visibility still necessarily begins only after the raw MTProto update reaches this process.
- The diagnostics presentation fix is verified with injected/pure tests and a renderer build; no real public-IP, Clash, or OKX endpoint probe was run in this task.
- The ChatGPT quota fix is verified with injected Codex protocol/status results; no real account was deliberately exhausted or accessed in this task.
- Cross-client unknown absence has no accepted safe automatic release rule. A replacement client that cannot find the order remains locked, even after repeated attempts or a position effect.
- While recovered evidence remains nonterminal or absent, connection fails before the private WebSocket is established; the application cannot continuously observe the later terminal event in that recovery session.
- The deterministic injected end-to-end crash harness in `TODO.md` is not yet built; current coverage is layered unit/integration-style mock coverage rather than filesystem-failure injection across every write primitive.
- macOS/Linux native builds and runtime-license profiles are incomplete.
- Windows application artifacts are not publisher-signed and use the default Electron icon.

Details and workarounds are authoritative in [`KNOWN_ISSUES.md`](KNOWN_ISSUES.md); executable work is in [`TODO.md`](TODO.md).

## Verification State

The standard commands were rerun on 2026-08-24 on Windows/PowerShell:

| Verification | Result |
|---|---|
| `npm.cmd run check:dependencies` | Passed: 16 installed production packages satisfy the reviewed policy |
| `npm.cmd run typecheck` | Passed: node and renderer `tsc --noEmit` projects |
| `npm.cmd test` | Passed: 12 files, 217 tests |
| `npm.cmd run build` | Passed: dependency gate, typecheck, all three electron-vite outputs, and compiled-output provenance gate |
| Lint | Not configured; `package.json` has no lint script |
| `npm audit --omit=dev` | Passed: 0 known vulnerabilities |
| `npm.cmd run package:win` | Passed: Windows x64 NSIS and portable ZIP generated; afterPack verified 16 packaged dependencies and runtime notices |
| Windows artifact QA | Passed: ZIP fully extracted (103 files), ASAR version/entries and Codex binary verified, portable isolated cold start retained main/renderer and logged only `application_started` |
| Windows signatures | Expected limitation confirmed: Setup and application are `NotSigned` |
| Real Telegram/ChatGPT/OKX private integration | Not verified |
| Real order open/close | Not verified |
| macOS/Linux package and cold start | Not verified |

Published `v0.1.7` artifact facts:

| Asset | Size | SHA-256 |
|---|---:|---|
| `BWE.Auto.Trader-Setup-0.1.7-x64.exe` | 184,949,793 bytes | `0EF064BAC29EA536945931F4EE31C97522C363B8EB41CFCFDC1AB7A2B0C7FD8D` |
| `BWE.Auto.Trader-Portable-0.1.7-x64.zip` | 263,889,413 bytes | `406D3B154FA957F81C931E8E5D2480BFF15A6C3930EA9C938724BA9652E635B8` |

The public asset names and hashes are recorded in the Release `SHA256SUMS.txt`. The package was not installed automatically because the QA machine already had a `v0.1.6` installation record; avoiding that overwrite preserved the existing installed state. The extracted portable package was cold-started instead.

Published `v0.1.6` artifact facts retained from the prior release checkpoint:

| Asset | Size | SHA-256 |
|---|---:|---|
| `BWE.Auto.Trader-Setup-0.1.6-x64.exe` | 185,013,251 bytes | `645B2A04979A22680BD9B64BDD36D473CD653828A30ADABE54E019A4A02825A3` |
| `BWE.Auto.Trader-Portable-0.1.6-x64.zip` | 263,945,002 bytes | `9DA118C0A4F8BF62951706EE430174472BCB77E885417C0FA05210613A17F7E7` |

The second table describes the superseded `v0.1.6` release only.

## Git Workspace State

At release completion, `main`, `origin/main`, and tag `v0.1.7` identify the same reviewed release commit. The tracked working tree is clean and there are no staged or untracked source changes.

`release-v0.1.7/` remains intentionally ignored and contains the exact local build outputs, release notes, checksums, builder metadata, and unpacked package used for publication. Historical artifacts, logs, existing local user-data folders, and `CODEX_CONTEXT.md` were not modified or deleted.

## Next Recommended Action

For the next Thread:

1. Read `AGENTS.md`, `docs/INDEX.md`, and this file; run `git status --short --branch` and confirm the `v0.1.7` checkpoint before changing code.
2. Let the user test the public `v0.1.7` Setup/Portable assets, using `SHA256SUMS.txt` to verify them; collect concrete failures against the tagged release.
3. After test feedback, either fix the reported issue or resume the P1 cross-client unknown-absence evidence model in [`TODO.md`](TODO.md). Do not replace the journal, replay a mutation, clear on one not-found result, or copy the same-origin 30-second rule to a replacement client.
4. If the user authorizes the first real test, follow the dedicated-sub-account checklist in `TODO.md`; obtain explicit current-task authorization before any private connection or order.
5. Do not edit the journal by hand, access private services, place orders, or publish another release without explicit authorization.

## New Thread Bootstrap

1. Read `AGENTS.md`, `docs/INDEX.md`, and `docs/CURRENT_STATE.md`.
2. Treat tagged and published `v0.1.7` as the current Windows x64 baseline; it includes the durable journal plus the Telegram visibility, diagnostics, and ChatGPT quota fixes.
3. Run `git status --short --branch` and verify any drift against the tagged source, tests, and GitHub Release artifacts.
4. Continue with the cross-client evidence design or a separately authorized real test; do not redo the completed journal, Telegram visibility, diagnostics, or ChatGPT quota implementations.
