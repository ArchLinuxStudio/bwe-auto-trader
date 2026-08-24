# Engineering Decisions

This file records durable choices and rejected alternatives that a future Agent might otherwise reintroduce. Implementation details remain authoritative in the linked source and tests.

## Decision: Small, supervised real-sub-account scope

Status: Accepted

Context: The user wants real testing rather than OKX demo, but only with minimal funds and active supervision.

Decision: Trade USDT perpetual swaps in `net` mode, isolated margin, 1x leverage, approximately 10 USDT per order, at most one concurrent position, with a 60-minute same-coin cooldown. Use a dedicated real sub-account. Tests remain mock-only.

Reason: This satisfies the requested initial product while bounding exposure.

Rejected alternatives: OKX demo mode; unattended operation; silently increasing order size to satisfy an exchange minimum.

Implications: No automatic stop loss, take profit, maximum holding time, or exit-on-application-close exists. That is current scope, not a missing implementation, but the product must not be described as unattended-safe.

## Decision: Startup and live trading fail closed

Status: Accepted

Context: A stale connection or authorization must never survive a lifecycle boundary.

Decision: Restart does not auto-connect services, start monitoring, or restore live authorization. Live open requires the exact phrase `确认实盘`; manual close requires `确认平仓`. Confirmed connection/data-stream failures, mutation ambiguity, stop, emergency stop, account/client changes, and relevant lifecycle revisions revoke open capability. Recovery never auto-arms.

Reason: A false negative loses an opportunity; a false positive can create an unwanted real position.

Rejected alternatives: Persisting the armed state; treating renderer button state as the interlock; automatically re-arming after reconnect.

Implications: The main-process capability and revisions are authoritative. UI state is informational and must not replace controller checks.

## Decision: Personal Telegram MTProto through pinned teleproto

Status: Accepted

Context: The product must monitor `@BWEnews` with the user's own Telegram account, and the earlier GramJS distribution introduced an unwanted GPL dependency chain.

Decision: Use exactly `teleproto@1.228.5`, retain existing GramJS StringSession compatibility, and prohibit `telegram` and `@cryptography/aes` in manifest, lock, compiled output, and final ASAR.

Reason: teleproto preserves the required MTProto/login behavior under the reviewed MIT package license and avoids the retired transitive chain.

Rejected alternatives: Telegram Bot API; continued GramJS binary distribution; npm aliases that hide a forbidden package.

Implications: Dependency policy and migration tests must be updated deliberately for any future version change. Do not replace the Telegram client casually.

## Decision: Application-owned atomic Telegram recovery

Status: Accepted

Context: Library-level reconnect can race channel cursor recovery, while treating one transient health failure as a confirmed reconnect caused unnecessary live locks.

Decision: Set teleproto `autoReconnect=false`. The application owns cursor, full-page catch-up, live buffering, revision, single-flight recovery, and atomic FIFO handoff. A suspected failure closes readiness immediately. Recovery inside one health interval may retain the user's existing arm only after full verification; a sustained/repeated failure publishes reconnecting and revokes it. Once a raw target-channel update has been successfully reserved in the startup/recovery buffer, a separate no-token callback may immediately publish a display-only `received` observation with sticky `recovered=true`. That observation does not consume canonical deduplication, start AI, advance the cursor, or enter any order path; canonical dispatch and AI still wait for the verified FIFO handoff.

Reason: This prevents analysis or trade-capable updates from escaping before catch-up, while keeping transport verification latency from hiding a message that is already present in the local process.

Rejected alternatives: Concurrent library and application reconnect; locking on any generic recoverable library error; keeping readiness true until disconnect is confirmed; sending a buffered update through the normal `onMessage`/AI path before catch-up order is known.

Implications: `tests/telegram-monitor.test.ts` is required reading before changing recovery. Recovered deliveries are permanently non-trading. Renderer visibility is allowed ahead of recovery verification, but authorization, canonical `seen` state, AI ordering, and trading are not. If monitoring or the owning connection is abandoned before canonical handoff, the observation becomes terminal `skipped` and its message key is consumed so a late callback cannot revive it.

## Decision: Authorization is captured at message ingress and cannot be retroactive

Status: Accepted

Context: A message received while locked could otherwise begin processing after a later arm and be incorrectly authorized.

Decision: Capture an opaque authorization token in the raw `NewMessage` handler's first synchronous turn. It binds arm, monitoring, Telegram lifecycle, recovery revision, and monitor identity. Carry it privately through the coordinator/controller and revalidate it through the final OKX transmission boundary.

Reason: Every `await`, FIFO, and `setImmediate` is a race boundary. Current state cannot safely substitute for message-time state.

Rejected alternatives: Checking only before AI; looking up the current arm when processing starts; serializing capability into IPC/shared message payload; removing the final `transmissionGuard` as redundant.

Implications: A message received while unarmed, or spanning lock/stop/recovery/re-arm, must remain display-only forever. Tests must cover guard invalidation immediately before POST.

## Decision: ChatGPT Plus/Codex is a strict, deadline-bound classifier

Status: Accepted

Context: The user wants to use an existing ChatGPT Plus login and prioritizes speed, not a separately billed OpenAI API key.

Decision: Use the bundled Codex app-server login, select a fast model, warm one process-local thread created with `ephemeral=true`, and reuse it to serialize analyses for the service lifetime. The absolute trade deadline is ten seconds from local Telegram ingress and includes queueing, AI, preflight, and time synchronization. Output must match the strict schema; ambiguity or failure becomes `SKIP`.

Reason: Serialization preserves the reused thread's protocol safety, while process-local ephemeral lifetime avoids treating it as durable application state. An absolute deadline prevents chasing old news.

Rejected alternatives: OpenAI API-key integration; resetting a ten-second timeout at each stage; guessing a coin/direction from malformed, conflicting, multi-coin, unauthenticated, or timed-out output.

Implications: The classifier has no tools, browsing, filesystem, code, or order capability. Do not document AI analysis as concurrent unless the implementation changes and is reverified. ChatGPT quota exhaustion is represented separately from transport authentication: it produces an explicit de-duplicated warning, revokes and blocks live authorization, and turns each affected message into a visible non-trading `SKIP`, while Telegram monitoring remains running and may be restarted. Once known, exhaustion is sticky across sparse updates, failed/superseded full reads, and older successful turns; quota skips use a non-blocking, single-flight, 60-second-throttled full read so a missed recovery notification does not require a restart. Only a successful full rate-limit read whose request began after the latest quota evidence may clear analysis unavailability. Quota recovery never re-arms live trading automatically.

## Decision: OKX routes are selected before private work and fixed

Status: Accepted

Context: Direct OKX domains can be blocked in China even when credentials are correct, but route changes after a mutation can duplicate an order.

Decision: Telegram and AI use Clash. OKX REST performs a credential-free public-time probe and selects direct or Clash before any authenticated REST request; that route is immutable for the client lifetime. The private WebSocket separately prefers a direct socket and may fall back to Clash only when the socket fails before `open`. Once it has opened, later login, subscription, or disconnect failure cannot trigger a cross-route retry. Diagnostics are optional information.

Reason: This preserves low latency when direct works and connectivity when it does not, without retrying an ambiguous private request on another path.

Rejected alternatives: Requiring direct diagnostics to pass; treating network failure as bad credentials; switching routes and resending after authentication/order timeout.

Implications: System VPN/TUN may alter the physical route, so UI text can only report the application choice. Withdraw permission and API IP whitelist remain warnings, not connection blockers; the application has no withdrawal endpoint.

## Decision: OKX exposure queries are complete and fail closed

Status: Accepted

Context: An unseen ordinary or strategy order can create exposure later. A failed, malformed, or incomplete exchange response is not evidence that the account is clear.

Decision: Connection validation, credential-boundary checks, and order preflight must query ordinary pending SWAP orders plus all supported strategy types: `conditional`, `oco`, `trigger`, `move_order_stop`, `chase`, `iceberg`, `twap`, and `smart_iceberg`. Any endpoint failure, malformed entry, or full 100-item strategy page fails closed. Opening also rereads account-wide SWAP positions, ordinary orders, and strategy orders and requires all three sets to be clear. Closing queries the target instrument and may ignore unrelated instruments returned by OKX, but it must refuse a same-instrument ordinary or strategy order.

Reason: Complete exposure evidence is required before increasing risk, while unrelated instruments must not prevent an explicitly confirmed risk-reducing close.

Rejected alternatives: Checking only ordinary or common strategy orders; continuing after a query error; treating a full page as complete; checking only the target instrument before opening; blocking a close because an unrelated instrument has an order.

Implications: Do not remove these requests or order categories as a latency optimization. If OKX adds an exposure-producing strategy type or changes pagination, update the coverage, failure rules, and tests before relying on a clear result.

## Decision: REST acknowledgement, fill, and unknown are separate states

Status: Accepted

Context: OKX can accept a request before it is filled, and transport failure can occur after the exchange received it.

Decision: Use a unique `clOrdId`. `sCode=0` creates a pending confirmation only. Private order updates or read-only reconciliation establish fill/terminal state. Any uncertain mutation boundary creates an unknown interlock, locks live trading, and is never automatically resent. A single not-found response cannot clear it.

Reason: Retrying an accepted but unacknowledged order is more dangerous than remaining locked.

Rejected alternatives: Marking REST ACK as filled; starting cooldown on ACK; clearing unknown after one not-found; blindly retrying or replacing an order.

Implications: Same-origin repeated bounded absence is the only current automated absence evidence. Cross-client recovery needs a written consistency/absence evidence model built on the existing durable journal, not another persistence mechanism or a shorter timeout.

## Decision: Unresolved mutations use a durable, non-replayable journal

Status: Accepted

Context: The in-memory coordinator, close map, and originating-client unknown record disappear on crash or restart. Writing only after REST returns leaves uncovered windows after transmission and ACK.

Decision: The Electron main process owns a strict `mutation-journal.v1.json`. After generating `clOrdId` and before `/trade/order` can fetch, OKX first persists `prepared`, then atomically commits `transmitting` with the exact `expTime`; only after that await does the existing synchronous generation/message guard run again. If that final guard blocks fetch, the still-running request may explicitly resolve its `transmitting` marker as `not_transmitted`; restart recovery may never infer the same fact. The journal stores operation, a SHA-256 fingerprint of the account `uid`, `instId`, `clOrdId`, optional `ordId`, lifecycle/reconciliation state, and timestamps. It never stores live authorization, credentials, signed headers, or an order body, and it has no replay API.

Reason: A durable precommit makes every possible exchange mutation recoverable by stable identity without creating an outbox that could duplicate orders. The two commits distinguish a process that provably stopped before the transport marker from any state where bytes might later have been sent; the latter remains conservative even though a crash can also occur between the marker and fetch.

Recovery: Startup loads the journal but does not connect or arm. `prepared` can be removed locally because fetch is unreachable until `transmitting` has committed. Every later phase blocks arm, credential replacement, open, and close. After the user explicitly connects, the controller requires the same hashed account UID and uses only GET evidence. A matching terminal order may clear the record. Matching live/partial state updates it. A new client never clears from elapsed time, a position effect alone, or one or many not-found results; that remains the separate cross-client evidence task.

Failure policy: Writes use a bounded strict schema with lifecycle-dependent evidence invariants, file sync, atomic rename, and serialized copy-on-write. The account fingerprint, `instId`, `clOrdId`, and any known `ordId` form immutable identity; conflicting evidence cannot rebind a record. Controller journal transitions are serialized across ACK, private-stream, reconciliation, and position evidence. A private-stream terminal state that races ahead of ACK is first committed with its `ordId`; matching ACK/unknown evidence may then remove it, while a conflicting ACK remains durably locked. Corruption, oversize data, missing stable account identity, malformed/conflicting exchange evidence, or persistence uncertainty fails closed. Process-local finalized identity tombstones and early-order-evidence replay prevent late ACK/order evidence from reviving, rebinding, or stranding a record.

Rejected alternatives: Audit-log reconstruction; persisting armed capabilities; API-key-derived identity; clearing on restart; replaying a journal entry; reusing the originating client's 30-second absence rule on a new client; treating a position effect alone as cross-client terminal evidence.

## Decision: Manual close is an independent risk-reduction path

Status: Accepted

Context: A user must be able to reduce exposure when Telegram, AI, monitoring, or open authorization is unavailable.

Decision: Allow explicitly confirmed whole-position close whenever the OKX private connection and close-specific safety checks are healthy. Submit a reverse `reduceOnly` market order with a unique `clOrdId`, and interlock until final state.

Reason: Risk reduction should not depend on the signal-generation path.

Rejected alternatives: Requiring Telegram/AI/live-open arm for close; OKX close-position endpoint, whose ambiguous result lacks a safe client order ID; repeated close clicks while pending.

Implications: Emergency stop blocks new opens but does not intentionally remove the close path. A close in progress blocks new opens.

## Decision: Credential changes are account-boundary operations

Status: Accepted

Context: Disconnecting or saving another key must not hide an old account's position or unresolved order.

Decision: Serialize save/connect/disconnect/arm/close in the controller lifecycle mutex. Before changing OKX credentials, require the old client to remain connected, pass the complete fail-closed exposure verification defined above, and have no local pending/unknown interlock. Recheck client/revision across awaits.

Reason: The account identity is part of every safety fact.

Rejected alternatives: Disconnect first and then replace credentials; treating identical credential save as state reset; using a new client to erase an originating client's unknown operation.

Implications: UI positions are honestly labeled as all positions in the dedicated sub-account, not as positions exclusively created by this application.

## Decision: Electron main/preload boundary remains hardened and preload remains CJS

Status: Accepted

Context: The renderer displays untrusted channel text, and an earlier ESM preload/package path failed in production.

Decision: Keep `contextIsolation=true`, `nodeIntegration=false`, `sandbox=true`, strict CSP, trusted-frame IPC validation, a minimal frozen preload API, and CJS preload output at `index.cjs`.

Reason: Persisted secrets and trading capability must not be exposed back to renderer content; the CJS path is the verified packaged configuration. Credential and verification-code form fields may exist briefly in renderer memory before IPC submission and clearing.

Rejected alternatives: Direct renderer service access; broader Electron permissions; reverting to the failed ESM preload without packaged cold-start evidence.

Implications: Any preload/module-format change requires production build, ASAR inspection, and isolated cold-start verification.

## Decision: Project and third-party license boundaries remain explicit

Status: Accepted

Context: The user selected a noncommercial, no-modification/no-distribution license for original project code, while the Electron bundle contains separately licensed software.

Decision: `LICENSE` (PolyForm Strict) covers only ArchLinuxStudio's original work. Preserve `THIRD_PARTY_NOTICES.txt`, the machine manifest/evidence, Electron license, and Chromium credits. Place project/third-party files visibly at the application/ZIP root and validate them after pack.

Reason: The project license cannot remove rights granted by MIT, Apache, BSD, LGPL, or other third-party terms.

Rejected alternatives: Claiming the entire Electron installer has no GPL-family/weak-copyleft component; applying project restrictions to third-party components; assuming the same source file can be simultaneously included through ASAR `files` and `extraFiles`.

Implications: It is accurate to say the old GramJS GPL npm chain was removed. It is not accurate to say the full Electron runtime contains no LGPL component. Each new platform/runtime needs its own reviewed profile.

## Decision: Platform validation does not transfer across operating systems

Status: Accepted

Context: Electron, secure storage, proxy behavior, Codex binaries, signing, and runtime notices differ by platform and architecture.

Decision: Build and validate macOS/Linux on native runners, with target-specific runtime provenance, license profile, afterPack, secure-storage, proxy, UI, signing, and cold-start checks.

Reason: A successful Windows package cannot prove a native package works or complies elsewhere.

Rejected alternatives: Cross-building and declaring support from Windows alone; reusing the Windows runtime manifest for another target.

Implications: Cross-platform package scripts express intent only until the corresponding native verification in `TODO.md` is complete.
