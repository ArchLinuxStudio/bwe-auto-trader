# Architecture

This document contains stable system structure and safety boundaries. Current release state, test counts, and unfinished work belong in the other documents linked from [`INDEX.md`](INDEX.md).

## Product boundary

BWE Auto Trader is a local-first Electron desktop application that:

1. Uses the user's personal Telegram MTProto account to monitor `@BWEnews` while the application is open. Monitoring starts automatically only when startup restores all three configured services successfully; otherwise it remains a manual action.
2. Uses the user's ChatGPT Plus/Codex login to classify each accepted text message as one coin and `LONG`, `SHORT`, or `SKIP` under a strict deadline.
3. Can open a small OKX USDT perpetual-swap position only after the user explicitly arms live trading and every main-process safety gate still passes.
4. Displays every SWAP position in the dedicated OKX sub-account and provides an explicitly confirmed, whole-position `reduceOnly` market close.

It is an unofficial tool, not investment advice, and is designed for a dedicated sub-account with minimal funds and active human supervision. It has no automatic stop loss, take profit, or time-based exit.

## Technology and process model

Exact versions are authoritative in `package.json`.

- Electron main process, sandboxed preload, and React renderer.
- TypeScript, electron-vite, electron-builder, and Vitest.
- `teleproto` for personal-account Telegram MTProto.
- `@openai/codex` app-server for ChatGPT Plus authentication and structured analysis.
- OKX V5 REST and private WebSocket APIs.
- Zod for IPC/config validation, `ws` for WebSocket transport, and `socks`/HTTP CONNECT support for proxies.
- Electron `safeStorage`, JSON files, and JSONL audit logs; there is no database.

The authority boundary is:

```text
React renderer
  -> frozen contextBridge DesktopApi
  -> trusted-sender check + Zod-validated IPC
  -> AppController (runtime orchestration and safety authority)
  -> Telegram / ChatGPT / OKX / local stores
  -> AppSnapshot and events
  -> renderer display
```

The renderer has no Node integration or direct network authority. UI disabled states improve usability but are never the trading interlock.

## Directory and module responsibilities

| Path | Responsibility |
|---|---|
| `src/main/index.ts` | Electron lifecycle, single-instance/tray behavior, native system-notification delivery, window hardening, CSP, trusted external URLs, IPC installation, and orderly shutdown |
| `src/main/window-tray.ts` | Pure hide/reveal helpers, stable tray-menu actions, and the asynchronous shutdown coordinator |
| `src/main/ipc.ts` | Trusted renderer validation, IPC argument schemas, public error compression, and the controller facade |
| `src/main/app-controller.ts` | Global connection/safety state machine, lifecycle mutex, credentials boundary, live capability, positions, manual close, reconciliation, notifications, and snapshots |
| `src/main/services/telegram.ts` | teleproto login, Clash transport, channel resolution, startup baseline, cursor recovery, buffering, connection health, and message-time authorization capture |
| `src/main/services/telegram-message.ts` | Fail-closed normalization of channel identity, text/caption, timestamps, links, deduplication key, and `recovered` metadata |
| `src/main/services/chatgpt.ts` | Codex app-server JSON-RPC, ChatGPT Plus login, model selection, process-local ephemeral thread warm-up/reuse, serialized analysis, schema parsing, and absolute timeout handling |
| `src/main/services/signal-coordinator.ts` | Signal history, deduplication, freshness, AI decision gates, authorization matching, cooldown, single-order interlock, and order-update state transitions |
| `src/main/services/okx.ts` | OKX signing, direct/proxy transport, account checks, order sizing, one-use live capabilities, REST/WS state, unknown-order reconciliation, and `reduceOnly` close |
| `src/main/services/mutation-journal.ts` | Strict, bounded, fsync-backed atomic journal for unresolved open/close mutations and restart recovery evidence |
| `src/main/services/settings-store.ts` | Public settings read/write with atomic replacement |
| `src/main/services/secret-store.ts` | Encrypted credentials and Telegram session through Electron `safeStorage` |
| `src/main/services/audit-log.ts` | Recursively redacted JSONL safety/audit events |
| `src/main/services/network-diagnostics.ts` | Informational direct/proxy probes; not a credential or connection gate |
| `src/shared/` | IPC/snapshot types, validated defaults, confirmation phrases, deadlines, and schemas |
| `src/preload/` | Minimal frozen desktop API exposed through `contextBridge` |
| `src/renderer/` | State rendering and user interactions; temporarily holds form input but owns no persisted secrets or trade capability |
| `scripts/` | Production dependency, compiled-output, and packaged-output compliance gates |
| `licenses/` | Reviewed production policy, machine-readable third-party manifest, and evidence files |
| `tests/` | Mock/injected boundary tests; tests must never use real credentials or private services |

## Startup and connection lifecycle

- Application initialization loads public settings and the mutation journal before starting external-service restoration. A `prepared` journal entry can be removed because the transport protocol requires a later durable `transmitting` commit before fetch; every later state remains locked until read-only evidence is conclusive.
- After the main window, IPC, and tray lifecycle are ready, the main process independently attempts Telegram, ChatGPT, and OKX connection for each service whose saved configuration marker exists. Failure of one attempt does not cancel or roll back the other attempts, and errors expose only non-sensitive retry guidance.
- Telegram connect is main-process single-flight across startup and renderer callers. Disconnect, shutdown, or a newer lifecycle revision cancels ownership of the in-flight attempt; a late monitor cannot replace current state or trading authorization.
- Telegram and OKX configuration markers are only entry conditions for reading their encrypted records through the owning store. Missing, malformed, or undecryptable data fails that service closed. The persisted ChatGPT marker is weaker still: it is only a startup-attempt hint; current Codex app-server account/authentication state, model warm-up, and bounded reads remain authoritative, and an invalid saved session clears the hint instead of being treated as connected.
- Startup opens monitoring only when all three configuration markers were present at the beginning of restoration and Telegram, ChatGPT, and OKX all finish in `connected`. A user settings, connect/disconnect, monitoring, emergency-stop, or shutdown action cancels that one-time automatic-monitoring intent. Partial success leaves successfully restored services connected but monitoring stopped.
- Restart never restores, persists, or creates live authorization. Startup connection and monitoring therefore remain display/analysis-only until the user enters the exact live confirmation phrase in that process. Startup Telegram catch-up remains `recovered` and permanently non-trading.
- An automatic or manual OKX connection uses the same account-bound, fail-closed path: it first matches the journal's hashed account UID, then performs GET-only recovery. A recovered new client never applies the originating client's timed absence rule, never replays a mutation, and never treats negative evidence as permission to arm.
- `AppController` serializes OKX credential, account, and trading lifecycle operations with a FIFO mutex. Safety actions can revoke capability synchronously before awaited audit or UI work.
- Snapshots are emitted from the main process and contain only public state.
- Once startup is complete and a usable native tray exists, a title-bar close hides the existing main window instead of destroying it. Tray activation, the show menu item, a second instance, and macOS activation all restore or recreate the same main window path.
- Hiding is not a service-lifecycle event: the controller, current monitoring, connections, and any current live authorization continue unchanged. Only explicit application quit starts IPC removal and controller disposal; repeated quit requests remain blocked until that asynchronous cleanup finishes.
- If a usable tray cannot be created, Windows/Linux retain normal close-to-exit behavior so the application cannot become unreachable. Native tray behavior is a platform-specific integration and does not transfer release verification between operating systems.
- Program-internal notices and system notifications are separate main-process channels. Only channel receipt, confirmed Telegram reconnect entry, AI-analysis start, and order-submission start use the system channel. Their bodies intentionally omit channel content and trade details, delivery is best-effort, and an OS notification can never grant authorization, prove execution, or alter signal/order state. Clicking a delivered notification requests the same guarded window-restoration path used by the tray and second-instance events.

## Signal-to-order data flow

1. The application either restores all configured services and starts monitoring under the startup rules above, or the user completes those actions manually. In both cases the user must enter the exact live confirmation phrase in the current process before any message can gain open-order authority.
2. The raw teleproto `NewMessage` handler synchronously captures the current process-local authorization token before FIFO or asynchronous dispatch.
3. Telegram validates channel/message data, deduplicates it, and queues it. A bounded five-second target-channel cursor probe independently detects a post that the live update stream did not deliver. Startup/reconnect/cursor-gap catch-up messages carry `recovered=true` permanently.
4. If a raw live update or cursor-probe result is held behind startup/recovery verification, Telegram emits a separate no-token, `recovered=true` observation after it is successfully buffered. `SignalCoordinator` may publish only a `received` record for immediate renderer visibility; this path neither starts AI nor consumes canonical message state.
5. After the normal FIFO handoff, `SignalCoordinator` creates or reuses the record and asks `ChatGptService` for a strictly structured classification. A long-lived process-local Codex thread, created with `ephemeral=true`, is reused to serialize analyses during that service lifetime.
6. After each asynchronous boundary, the coordinator rechecks message age, monitoring, recovery state, live authorization generations, OKX connectivity, close/pending interlocks, cooldown, and positions.
7. `AppController` asks `OkxV5Client` to prepare an order, then mints a one-use open capability only after read-only checks.
8. A synchronous `transmissionGuard` revalidates the original message authorization through leverage setup and immediately before the real `/trade/order` POST.
9. A successful REST acknowledgement becomes pending confirmation, not a fill. Private order updates or read-only reconciliation determine fill, cancellation, rejection, or unknown state.
10. `AppController` emits a new `AppSnapshot`; the renderer only displays it.

ChatGPT quota exhaustion is an analysis-capacity state, not a Telegram transport failure. While the main-process service is initialized and ChatGPT-authenticated, rolling app-server notifications update quota state immediately and a recursive 60-second timer performs a complete rate-limit read with a 10-second request deadline. Periodic, explicit, notification-recovery, and quota-`SKIP` refresh triggers share one single-flight request. A timeout or latest-revision read failure preserves the last trusted value and retries on a later cycle; logout pauses polling before its RPC, and service close cancels future scheduling and rejects late state commits. The main process revokes the live-trading capability and blocks re-arming, emits one explicit exhaustion-transition notification, and keeps Telegram monitoring available. Each later channel message remains visible and terminates as `SKIP` without crossing the OKX order boundary. Known exhaustion blocks new classifier turns; if newer exhaustion evidence arrives during an older turn, that result is also reduced to a quota `SKIP`. Sparse updates, failed reads, superseded reads, and older successful turns cannot clear exhaustion. Only a successful full rate-limit read begun for the latest account/evidence revision may restore analysis readiness, and it never restores live authorization; the user must explicitly arm again.

## Telegram recovery model

The application, not teleproto, owns reconnect sequencing. Library auto-reconnect is disabled.

- A suspected connection failure immediately closes internal readiness, so no message can gain trade authority during validation.
- While connected, a target-channel `getMessages(limit=1)` probe runs every five seconds with a four-second deadline. A generic authorization probe is not sufficient because it can succeed while a channel push is delayed. If the remote cursor is newer than the local cursor, the returned candidate is immediately buffered/observed without a token and the normal atomic recovery starts from the frozen local cursor.
- A recoverable failure retains only the already-created, process-local arm capability for the same monitor lifecycle. Readiness remains closed throughout recovery, so the retained arm is suspended and cannot authorize a message during the outage.
- A sustained or repeated failure publishes `reconnecting` and continues one bounded, single-flight recovery attempt on each later health cycle until it succeeds or the user stops/disconnects. It does not mint or reconstruct an arm.
- Recovery publishes `connected` only after the single-flight promise is cleared and authorization, complete catch-up, residual-buffer FIFO reservation, and monitor identity have all been verified. Only new live messages received after that point can use the retained arm. A fatal/authentication failure, explicit disconnect, stop, emergency stop, monitor replacement, settings lifecycle change, or application shutdown still revokes it and requires manual confirmation.
- The final authorization probe calls the typed `updates.getState` RPC directly because teleproto's boolean `checkAuthorization()` intentionally collapses every RPC failure to `false`. Only an explicit `UnauthorizedError`/`AuthKeyError` is fatal; network, timeout, and unclassified RPC failures remain suspended and retry. An errored/stopped monitor is retired before a saved-config reconnect can install its replacement.
- A timed-out target-channel, catch-up, authorization, disconnect, or connect operation cannot hold the single-flight health/recovery loop indefinitely. Readiness closes synchronously before asynchronous diagnostics. The next recovery tears down the sender even if its public `connected` flag is already false, so a late dial or pending request cannot accumulate behind a ghost connection.
- A raw live message or bounded cursor-probe candidate already reserved in a recovery buffer can appear immediately as a display-only `received` record. The callback carries no authorization token, and AI waits until the atomic catch-up order is known.
- Stopping monitoring, emergency stop, a fatal/rolled-back startup, or application shutdown terminally marks any still-pending display-only observation as `skipped`; a late canonical callback cannot restart it.
- Stop uses a bounded drain, detaches any obsolete health single-flight, and identity-checks late recovery failures. A late operation from the stopped client cannot publish `reconnecting` or mutate a later monitor generation.
- Catch-up messages remain `recovered` even if they are recent or processed after a later re-arm. They may be analyzed for visibility but can never trade.
- Cursor, recovery revision, single-flight recovery, bounded live buffer, and FIFO reservation prevent partial batches or interleaving.

## Order state and reconciliation

- Every mutation has a unique `clOrdId`.
- Before `/trade/order` can start, the main process atomically persists operation, hashed account identity, `instId`, `clOrdId`, lifecycle timestamps, intent expiry, and the exact exchange `expTime`. The final synchronous authorization guard runs again after this await.
- `sCode=0` means the request was accepted; it does not prove a fill or start cooldown.
- Private WebSocket order data is preferred for state transitions. Read-only REST reconciliation is used when needed.
- If it is unclear whether a mutation crossed the exchange boundary, the operation becomes unknown, live trading is locked, and no automatic retry is allowed.
- ACK, private order updates, and reconciliation update the journal through one controller FIFO. Account fingerprint, `instId`, `clOrdId`, and any known `ordId` are immutable identity. A pre-ACK terminal update is committed with its identity before later matching ACK/unknown evidence removes it; conflicting evidence remains locked. Finalized identity tombstones reject conflicting late ACK/order updates, so concurrency cannot recreate or silently rebind a finalized mutation.
- A single not-found response is not absence evidence. The bounded absence path is restricted to the same originating client and its process-bound error identity; controller retry snapshots do not transfer authority to a replacement client. Its scoped order/position results must all match the target instrument, and position effect uses the validated decimal value without floating-point underflow to zero.
- After restart, account mismatch, malformed evidence, query failure, pending/partial state, a visible position effect without a matching order, and any number of not-found results all retain the durable interlock.
- Normal pending orders and all eight supported pending strategy-order types are checked before connection, open, close, and credential changes. These exposure queries fail closed on request failure, malformed data, or an unproven complete result.

## Manual close data flow

Manual close is a separate risk-reduction path:

```text
exact close confirmation
  -> controller lifecycle mutex
  -> healthy OKX private connection and exposure checks
  -> close-scoped one-use capability
  -> reverse whole-size reduceOnly market order with unique clOrdId
  -> private stream or read-only final confirmation
```

It remains available when Telegram, AI, monitoring, live-open authorization, or emergency-stop state prevents new positions. A close remains interlocked until final state; duplicate close and new open attempts are blocked.

## External services and routing

- Telegram and the Codex child process use Clash Party, normally at `127.0.0.1:7890`, with SOCKS5/HTTP CONNECT detection.
- OKX REST and private WebSocket routes are selected separately. REST uses a credential-free public-time probe to select direct or Clash before authenticated requests.
- The private WebSocket prefers a direct socket and may fall back to Clash only if the socket fails before `open`. After `open`, login, subscription, or disconnect failure never triggers a cross-route retry.
- A selected REST or WebSocket route is fixed for that connection. A private request or order is never resent on another route after a transport ambiguity.
- Network diagnostics are informational. A failed direct probe must not invalidate correct credentials or block a proxy-backed connection.
- VPN, TUN, or system proxy configuration can change the physical path, so the UI describes only the route chosen by the application.

## Persistent data boundary

Files live under Electron's application user-data directory:

- `settings.v1.json`: public settings, written atomically.
- `secrets.v1.json`: credentials and session material encrypted with `safeStorage`; insecure Linux `basic_text` storage is rejected.
- `audit/events.jsonl`: recursively redacted safety events.
- `mutation-journal.v1.json`: atomic, bounded unresolved-mutation state. It contains a one-way account UID fingerprint and whitelisted order/recovery metadata, never credentials, authorization capabilities, request headers, signatures, or order bodies.

The renderer may briefly hold credentials or verification codes as form input before sending them through IPC and clearing them. It owns no persisted secrets or trading capability. Secrets and session material are persisted only by the main process through `safeStorage`; they must not enter `AppSnapshot`, public settings, documentation, or logs.

## Stable safety invariants

- AI returns analysis only and cannot construct exchange capability.
- Live authorization is a process-local capability; it is neither persisted nor sent through IPC.
- A message received while locked can never be authorized retroactively.
- Lock, stop, every recovery revision, re-arm, monitor replacement, or lifecycle revision invalidates the old message token. A same-monitor network recovery may retain the arm capability, but never the token of a pre-recovery message.
- Recovered messages never trade.
- Recovery-time early observations carry no authorization and cannot start AI or consume canonical message state.
- Abandoned recovery observations are consumed and terminally skipped rather than remaining pending or being revived later.
- The ten-second trade deadline starts at local message ingress and includes queueing, AI, preflight, and time synchronization.
- Mutation ambiguity fails closed and never triggers an automatic replacement order.
- Restart cannot erase an unresolved mutation. Journal corruption or write uncertainty disables all new mutations; the journal is not a replayable outbox.
- The main-process mutex, revisions, and capabilities are authoritative; the UI is not.
- Manual close uses a `reduceOnly` order. The OKX close-position endpoint is intentionally not used because it lacks a safely attributable client order ID.
- Displayed positions are all SWAP positions in the dedicated sub-account and must not be labeled as exclusively created by this application.
- Application exit and emergency stop do not automatically close positions.

## Packaging and license boundary

Build gates verify the production lock closure, compiled imports, final ASAR/unpacked dependencies, reviewed evidence hashes, and visible runtime license files. Project and third-party notices are placed at the application/ZIP root through `extraFiles`; NSIS displays the project license.

The application production dependency closure excludes the retired GramJS GPL chain. Electron/Chromium still contains independently licensed LGPL components, including FFmpeg-related runtime material. PolyForm Strict applies only to ArchLinuxStudio's original code and cannot reduce third-party rights.
