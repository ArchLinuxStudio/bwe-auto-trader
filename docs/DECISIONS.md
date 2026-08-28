# Engineering Decisions

This file records durable choices and rejected alternatives that a future Agent might otherwise reintroduce. Implementation details remain authoritative in the linked source and tests.

## Decision: Small, supervised real-sub-account scope

Status: Accepted

Context: The user wants real testing rather than OKX demo, but only with minimal funds and active supervision.

Decision: Trade USDT perpetual swaps in `net` mode, isolated margin, 1x leverage, approximately 10 USDT per order, at most one concurrent position, with a 60-minute same-coin cooldown. Use a dedicated real sub-account. Tests remain mock-only.

Reason: This satisfies the requested initial product while bounding exposure.

Rejected alternatives: OKX demo mode; unattended operation; silently increasing order size to satisfy an exchange minimum.

Implications: No automatic stop loss, take profit, maximum holding time, or exit-on-application-close exists. That is current scope, not a missing implementation, but the product must not be described as unattended-safe.

## Decision: Startup may restore configured services; live trading still fails closed

Status: Accepted

Context: The user wants the application, once opened, to reuse valid saved service configuration without repeating three manual connection actions. A saved marker or stale session must still never be mistaken for current authentication, monitoring readiness, or live-order authority.

Decision: After application initialization has loaded settings and the mutation journal, independently attempt Telegram, ChatGPT, and OKX connection for each service with a saved configuration marker. One failed attempt does not cancel the others. Automatically start monitoring only when all three markers existed for that startup attempt and all three services finish fully connected; partial restoration remains connected where successful but does not start monitoring. The ChatGPT marker is only a hint to attempt restoration: current Codex app-server account/authentication state, warm-up, and bounded read results are authoritative, and an invalid saved session must fail closed rather than being called connected. Restart never persists, reconstructs, or creates live authorization, so live open still requires the exact phrase `确认实盘` in the current process and manual close still requires `确认平仓`. Mutation ambiguity, OKX data-stream failure, stop, emergency stop, account/client changes, Telegram authentication or fatal failure, monitor replacement, and relevant lifecycle changes revoke open capability. A recoverable Telegram network outage in the same running monitor may retain an already-created in-memory arm only as suspended intent: readiness closes immediately, every pre-recovery message token is invalidated, and no startup/recovery/catch-up message can trade. Only after full atomic catch-up, authorization, monitor-identity, and readiness verification may later new live messages use that same capability again. Recovery never creates, persists, or restores a capability after it was revoked.

Reason: A false negative loses an opportunity; a false positive can create an unwanted real position.

Rejected alternatives: Persisting the armed state; treating a saved configuration flag or renderer button state as proof of authentication; starting monitoring after only a subset of services connect; cancelling successful independent connection attempts because another service failed; minting or reconstructing an arm after restart, manual disconnect, monitor replacement, fatal/authentication failure, stop, or another revoking lifecycle boundary; keeping readiness open during Telegram recovery; describing application-open restoration as operating-system autostart, a headless service, or unattended-safe operation.

Implications: The main-process service state, capability, and revisions are authoritative. Startup and renderer connection callers share the same lifecycle guards, including a single-flight Telegram connect. The mutation journal is loaded before any automatic OKX connection, and automatic OKX restoration uses the same account-bound GET-only recovery and unknown-order interlocks as a manual connection. UI and persisted hint state are informational and must not replace controller checks.

## Decision: Personal Telegram MTProto through pinned teleproto

Status: Accepted

Context: The product must monitor `@BWEnews` with the user's own Telegram account, and the earlier GramJS distribution introduced an unwanted GPL dependency chain.

Decision: Use exactly `teleproto@1.228.5`, retain existing GramJS StringSession compatibility, and prohibit `telegram` and `@cryptography/aes` in manifest, lock, compiled output, and final ASAR.

Reason: teleproto preserves the required MTProto/login behavior under the reviewed MIT package license and avoids the retired transitive chain.

Rejected alternatives: Telegram Bot API; continued GramJS binary distribution; npm aliases that hide a forbidden package.

Implications: Dependency policy and migration tests must be updated deliberately for any future version change. Do not replace the Telegram client casually.

## Decision: Application-owned atomic Telegram recovery

Status: Accepted

Context: Library-level reconnect can race channel cursor recovery, while treating one transient health failure as a confirmed reconnect caused unnecessary live locks. A 2026-08-25 user test of `v0.1.7` also observed a target-channel post only after approximately two minutes even though the application still appeared connected. Code inspection showed that the periodic health check proved generic authorization but did not compare the target channel's remote cursor with the application's delivered cursor.

Decision: Set teleproto `autoReconnect=false`. The application owns cursor, full-page catch-up, live buffering, revision, single-flight recovery, and atomic FIFO handoff. In addition to transport state, run a bounded target-channel cursor probe every five seconds; its RPC deadline is four seconds. A newer remote cursor closes readiness, freezes the local cursor, buffers the returned candidate as no-token recovery evidence, and immediately enters the existing atomic catch-up. Target-channel, catch-up, authorization, forced-disconnect, and reconnect operations are bounded; timeout closes readiness before asynchronous error reporting and causes the next health cycle to rebuild the sender instead of continuing on a ghost connection. Failed network reconnect attempts remain gated and are retried on later health cycles. The recovery authorization probe uses the typed `updates.getState` RPC directly: teleproto's convenience `checkAuthorization()` cannot be used for classification because it turns every network/RPC error into boolean `false`. Explicit `UnauthorizedError`/`AuthKeyError` is fatal and revokes the arm; network, deadline, and unclassified RPC errors remain recoverable. Bounded stop detaches obsolete health work, and status/error/message callbacks plus late recovery failures may mutate controller state only while their original monitor identity is still current. A confirmed same-monitor network outage publishes `reconnecting` and retains an existing manual arm only as suspended intent; it cannot authorize anything until recovery clears the single-flight and publishes readiness-backed `connected`. Once a raw target-channel update or bounded cursor-probe candidate has been successfully reserved in the startup/recovery buffer, a separate no-token callback may immediately publish a display-only `received` observation with sticky `recovered=true`. That observation does not consume canonical deduplication, start AI, advance the cursor, or enter any order path; canonical dispatch and AI still wait for the verified FIFO handoff.

Reason: Generic authorization and `connected` state do not prove that the target channel's push stream is current. The bounded remote-cursor comparison detects the reported class of silent delay within one normal health cycle while preserving ordered recovery and the non-trading boundary.

Rejected alternatives: Concurrent library and application reconnect; locking on any generic recoverable library error; treating `checkAuthorization() === false` as proof of revoked authorization; keeping readiness true during recovery; revoking the same in-memory arm on every recoverable same-monitor network outage; creating a new arm after a revoking lifecycle boundary; relying only on generic authorization/transport pings; treating a polled post as live or trade-authorized; sending a buffered update through the normal `onMessage`/AI path before catch-up order is known.

Implications: `tests/telegram-monitor.test.ts` is required reading before changing recovery. Recovered deliveries are permanently non-trading, and a pre-recovery token remains invalid even after the same arm resumes for later messages. Renderer visibility is allowed ahead of recovery verification, but authorization, canonical `seen` state, AI ordering, and trading are not. If monitoring or the owning connection is abandoned before canonical handoff, the observation becomes terminal `skipped` and its message key is consumed so a late callback cannot revive it. The five-second injected timing and repeated-reconnect tests prove application scheduling only; real proxy/Telegram/ChatGPT latency and reconnect behavior must be measured separately and must not be reported as verified until that test occurs.

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

Implications: The classifier has no tools, browsing, filesystem, code, or order capability. Do not document AI analysis as concurrent unless the implementation changes and is reverified. A persisted ChatGPT configured flag can request one startup restoration attempt but cannot prove a valid account, authentication, warm-up, quota, or read result; the live app-server state remains authoritative. ChatGPT quota exhaustion is represented separately from transport authentication: it produces an explicit de-duplicated warning, revokes and blocks live authorization, and turns each affected message into a visible non-trading `SKIP`, while Telegram monitoring remains running and may be restarted. Authenticated quota display must not depend on a one-time login read: rolling notifications apply immediately and the main process also requests a complete snapshot every 60 seconds with a 10-second bound. Periodic, explicit, notification-recovery, and quota-skip triggers share one request; failure retains the last trusted value instead of publishing an invented reset. Once known, exhaustion is sticky across sparse updates, failed/superseded full reads, and older successful turns. Only a successful full rate-limit read whose request began after the latest account and quota evidence may clear analysis unavailability. Logout and service close stop scheduling, and quota recovery never re-arms live trading automatically.

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

Implications: Process-bound same-origin reconciliation is the only current automated absence path. Its exact order must use a documented normal state, every scoped pending/position result must match the target instrument, and a mathematically non-zero decimal position remains an effect even when conversion to a JavaScript `Number` would underflow. Cross-client recovery follows the evidence-certificate decision below; its collection implementation and consistency gate are still incomplete.

## Decision: Unresolved mutations use a durable, non-replayable journal

Status: Accepted

Context: The in-memory coordinator, close map, and originating-client unknown record disappear on crash or restart. Writing only after REST returns leaves uncovered windows after transmission and ACK.

Decision: The Electron main process owns a strict `mutation-journal.v1.json`. After generating `clOrdId` and before `/trade/order` can fetch, OKX first persists `prepared`, then atomically commits `transmitting` with the exact `expTime`; only after that await does the existing synchronous generation/message guard run again. If that final guard blocks fetch, the still-running request may explicitly resolve its `transmitting` marker as `not_transmitted`; restart recovery may never infer the same fact. The journal stores operation, a SHA-256 fingerprint of the account `uid`, `instId`, `clOrdId`, optional `ordId`, lifecycle/reconciliation state, and timestamps. It never stores live authorization, credentials, signed headers, or an order body, and it has no replay API.

Reason: A durable precommit makes every possible exchange mutation recoverable by stable identity without creating an outbox that could duplicate orders. The two commits distinguish a process that provably stopped before the transport marker from any state where bytes might later have been sent; the latter remains conservative even though a crash can also occur between the marker and fetch.

Recovery: Startup loads the journal before any configured-service connection attempt and never arms. `prepared` can be removed locally because fetch is unreachable until `transmitting` has committed. Every later phase blocks arm, credential replacement, open, and close. Whether OKX connection begins from startup restoration or a user action, the controller requires the same hashed account UID and uses only GET evidence. A matching terminal order may clear the record. Matching live/partial state updates it. A new client never clears from elapsed time, a position effect alone, or one or many not-found results; any future absence path must satisfy the evidence-certificate decision below.

Failure policy: Writes use a bounded strict schema with lifecycle-dependent evidence invariants, file sync, atomic rename, and serialized copy-on-write. The account fingerprint, `instId`, `clOrdId`, exact `exchangeExpiresAt`, and any known `ordId` form immutable identity; conflicting evidence cannot rebind a record. Controller journal transitions are serialized across ACK, private-stream, reconciliation, and position evidence. A private-stream terminal state that races ahead of ACK is first committed with its `ordId`; matching ACK/unknown evidence may then remove it, while a conflicting ACK remains durably locked. Corruption, oversize data, missing stable account identity, malformed/conflicting exchange evidence, or persistence uncertainty fails closed. Process-local finalized identity tombstones and early-order-evidence replay prevent late ACK/order evidence from reviving, rebinding, or stranding a record.

Rejected alternatives: Audit-log reconstruction; persisting armed capabilities; API-key-derived identity; clearing on restart; replaying a journal entry; reusing the originating client's 30-second absence rule on a new client; treating a position effect alone as cross-client terminal evidence.

## Decision: Cross-client absence requires a durable evidence certificate

Status: Accepted; automatic absence release is disabled until both visibility and cross-endpoint consistency gates below are satisfied.

Context: A replacement client has the durable mutation identity and exchange expiry, but it does not have the originating client's error object, transport instance, or timed reconciliation history. OKX documents that `expTime` prevents processing after the exchange deadline, pending-order queries return current live/partial orders, and order/fill history has bounded retention. It does not document a maximum visibility delay or an atomic revision shared by order details, pending orders, history, fills, and positions. It also permits a `clOrdId` to be reused after terminal state and returns only the latest match from order details. Therefore elapsed time plus repeated successful negative reads is not, by itself, a proof that the original mutation never existed.

Decision: Cross-client absence is a separate evidence state, not another value passed to the current delete-oriented `resolve()` method.

- Eligibility is restricted to `transmitting` or `unknown` records that have never bound an `ordId`, never observed a matching/live/partial/terminal order, and never observed an operation-compatible position effect. Accepted, known-`ordId`, live, partial, or position-effect records require positive matching terminal-order evidence and can never use absence release.
- Every recovery epoch must use the same exact account fingerprint, immutable operation/`instId`/`clOrdId`/`exchangeExpiresAt`, fixed route, replacement-client generation, controller lifecycle revision, and journal record revision. The journal must also contain an immutable exchange-clock lower bound for possible transmission, or a persisted server-offset interval and uncertainty from which that bound can be proved. Existing records without such evidence are never eligible for absence certification. A credential-save attempt, disconnect, reconnect, route/client replacement, concurrent evidence update, or relevant account activity invalidates the epoch.
- An epoch begins only after exchange time is beyond `exchangeExpiresAt` plus a reviewed visibility bound and clock uncertainty. It must obtain strictly validated negative order-details evidence, a provably complete ordinary pending-order snapshot, complete paginated terminal order history and fill history covering the entire exchange-clock transmission interval, and a validated position snapshot. For an eligible record, any duplicate matching `clOrdId`, missing/invalid creation time, or order whose creation time cannot be uniquely placed inside or outside that interval is ambiguous and keeps the record locked. A known `ordId` belongs only to the positive terminal-evidence path, never to absence certification.
- Position state is a veto, not attribution. An open-position effect for an unknown open, or a closed-position effect for an unknown close, blocks absence certification because another client or manual action can produce the same account state. No position effect cannot replace order/history evidence.
- A recovery-only client must be enforced read-only by an API facade and the final main-process transmission guard, not by renderer state. Its private order subscription must be acknowledged and buffering active before the first GET epoch. The GET/WS handoff is one revisioned observation interval; subscription failure, buffer overflow, unclassified private activity, disconnect, or reconnect invalidates the epoch and requires a new complete snapshot.
- Two complete epochs are required. They must remain in one continuously observed replacement-client generation and be separated by the reviewed maximum visibility bound. Relevant activity means any ordinary/algo order, fill, target-instrument position, account identity/configuration change, or unclassifiable private event that could affect exposure. Any malformed item, endpoint error, timeout, rate limit, ordinary pending page at its maximum, history/fill pagination cap or cursor contradiction, retention gap, inconsistent identity/state, late WebSocket update, or intervening revision cancels the candidate and keeps the journal locked. Full intermediate history/fill pages are normal only when cursor pagination continues monotonically to a proved final page covering the interval.
- Finalization must compare-and-swap the client, lifecycle, account, and journal revisions under the existing controller/journal FIFOs. Before removing the blocker it must atomically persist a redacted absence certificate and cross-restart tombstone in the existing mutation journal. A protected tombstone is never evicted; capacity exhaustion fails closed. Its minimum protection interval must cover the accepted visibility bound, the longest relied-on history/fill retention window, and clock uncertainty. Matching late evidence synchronously revokes authorization, increments and persists the evidence revision, and reinstates the blocker before any later mutation. Resolution never restores live authorization.
- If exact terminal evidence is found during the original synchronous explicit connection attempt, the current complete re-verification may continue that connection. Once a client has entered recovery-only mode, later terminal resolution must leave or return it to a non-trading disconnected state, notify the user, and require a new explicit full connection plus complete exposure verification; a background recovery session never silently upgrades itself.

Current consistency gate: No official finite maximum visibility delay or cross-endpoint snapshot revision was found in the reviewed OKX API contract. Consequently the visibility-bound parameter has no accepted value, and there is no accepted proof that separately timed endpoint reads form one consistent account view. Automatic cross-client absence release remains disabled until both facts are supplied by an authoritative contract or this decision separately accepts and justifies a continuous-WS/two-epoch substitute. The application may add strict history/fill collection, durable evidence revisions, and a recovery-only private stream, but negative evidence remains diagnostic. A matching terminal order remains the only current automatic cross-client resolution.

Reason: This preserves the useful positive evidence and restart safety already present without disguising repeated cacheable negative reads as exchange finality. A durable certificate/tombstone is required because a process-local decision cannot safely reject late evidence after another restart.

Rejected alternatives: One or many point-query not-found results; a fixed local timer chosen by experience; position state alone; trusting response gateway time as data freshness; treating a successful but unpaginated history call as complete; using a new client or credential save as a revision boundary; clearing first and writing audit evidence later; evicting a still-protected tombstone; process-local absence tombstones; renderer-only recovery controls; silently upgrading a background recovery client; automatically re-arming after recovery.

## Decision: Manual close is an independent risk-reduction path

Status: Accepted

Context: A user must be able to reduce exposure when Telegram, AI, monitoring, or open authorization is unavailable.

Decision: Allow explicitly confirmed whole-position close whenever the OKX private connection and close-specific safety checks are healthy. Submit a reverse `reduceOnly` market order with a unique `clOrdId`, and interlock until final state. Derive the reverse side from the validated decimal's lexical sign and submit a trimmed unsigned magnitude; floating-point conversion cannot decide whether or how to close the position.

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

## Decision: Title-bar close hides to tray; explicit quit owns shutdown

Status: Accepted

Context: The user requires the application to remain available in the system tray instead of exiting when the main window's title-bar close button is clicked. Because this process can continue monitoring and can retain a manually armed live capability, hiding and quitting must have unambiguous safety semantics.

Decision: After successful startup, create one main-process-owned native tray with show and explicit quit actions. When that tray is usable, intercept the main window `close` event and hide the window without changing controller state. Tray activation, the show action, platform activation, and a second-instance event share one guarded restore-or-create path. Explicit quit enters a three-phase main-process shutdown gate (`idle -> disposing -> ready-to-quit`), destroys the tray, removes IPC handlers, and awaits `AppController.dispose()` before the final quit is allowed. If no usable tray exists, do not intercept the window close.

Reason: The Electron main process owns both desktop lifecycle and trading authority. A strong tray reference and one restore path prevent an unreachable or duplicate window, while the three-phase gate prevents a repeated quit request from bypassing asynchronous safety cleanup.

Rejected alternatives: Renderer-owned close handling; treating window hide as disconnect, emergency stop, or live-lock revocation; unconditionally preventing close when no tray is available; setting the final-quit state before controller cleanup; adding an autostart or headless service as part of this request.

Implications: Hiding to tray is not exit: monitoring, connections, and an already armed live capability continue. Users must use emergency stop to block new opens and the tray quit action to end the process. Neither hide nor exit closes an existing OKX position. Tray behavior and icon visibility require native packaged verification on each claimed platform.

## Decision: Only selected lifecycle events use system notifications

Status: Accepted

Context: The user needs important progress to remain visible while the main window is hidden, without turning every program-internal notice into an operating-system toast or exposing channel/trade details on a lock screen.

Decision: Keep ordinary notices in the application. Send a separate main-process-owned system notification only when a unique channel message first becomes visible, when its record successfully enters `analyzing`, when a confirmed Telegram outage first enters `reconnecting`, and when an authorized signal successfully enters `submitting`. Deduplicate receipt by the existing channel/message record and reconnect by outage episode. Use neutral notification bodies without message text, message IDs, channel names, AI results, symbols, directions, sizes, or order identifiers. Respect the existing desktop-notification setting, isolate synchronous and asynchronous delivery failures, and route notification clicks through the guarded window restore path.

Reason: These four transitions provide useful off-window progress while preserving privacy and avoiding notification storms. Main-process delivery works while the renderer is hidden and cannot be mistaken for a renderer-owned safety control.

Rejected alternatives: Mirroring every in-app warning/error globally; using renderer Web Notifications; including message or order details in OS-visible text; notifying on every reconnect retry; emitting “order submitted” before OKX acknowledgement; letting notification failure delay or change signal processing.

Implications: “Starting an order operation” means only that the local signal record entered `submitting`; it is not an exchange acknowledgement or fill. Operating-system permissions, focus modes, or unpackaged-app identity may suppress a notification, so notification visibility is never audit or trading evidence and must be verified separately for each packaged platform.

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

## Decision: Application packages use one SVG icon master; the tray glyph remains embedded

Status: Accepted

Context: The default Electron package icon obscures application identity. Package formats require different native icon representations, while tray creation must remain reliable before or independently of packaged-resource lookup.

Decision: Keep the original application-icon source at `build/icon.svg` and configure electron-builder to convert that one reviewable asset for each package target. Preserve the compact transparent tray PNG in the main process; its visual motif matches the application icon, but tray availability does not depend on locating a build resource at runtime.

Reason: A single vector master avoids hand-maintained platform variants and keeps small-size output reproducible. The embedded tray glyph preserves the already-verified early-startup and fallback behavior.

Rejected alternatives: Continue using Electron's default icon; maintain unrelated platform icon designs; load the tray image from an unpacked build-resource path; replace the verified tray lifecycle merely to share a file path.

Implications: Windows packages must verify the icon embedded in both the application executable and installer, including small ICO sizes. Successful Windows conversion does not verify macOS or Linux output, and custom branding does not imply publisher signing.
