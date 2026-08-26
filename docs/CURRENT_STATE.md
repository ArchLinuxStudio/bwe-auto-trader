# Current State

Checkpoint date: 2026-08-26, Asia/Shanghai.

## Current Objective

The Windows x64 `v0.1.8` release is complete. It packages the accumulated OKX fail-closed hardening, Telegram cursor-latency recovery, Windows tray lifecycle, and dynamic ChatGPT/Codex quota work; the annotated source tag and five explicit GitHub Release assets are the public checkpoint.

Code review found no P0/P1 release blocker. Version/runtime identity, standard gates, Windows packaging, afterPack, archive inspection, isolated cold start, native window/tray wiring checks, checksums, commit, annotated tag, atomic push, draft-asset verification, and final publication all use the same `0.1.8` source state.

Real Telegram/ChatGPT latency, real-account quota behavior, interactive Explorer tray-menu cleanup, and the first dedicated-sub-account end-to-end test remain pending. They require the corresponding user environment or explicit private-service authorization; none was inferred from the packaging/release request.

## Current Status

- Version: `0.1.8` in `package.json`, `package-lock.json`, the production manifest/notices, renderer fallback, and Codex app-server client metadata.
- Branch: `main`.
- Current published source/release: annotated tag [`v0.1.8`](https://github.com/ArchLinuxStudio/bwe-auto-trader/releases/tag/v0.1.8); Git is the authority for its release commit and tag-object identities.
- Previous published baseline: [`v0.1.7`](https://github.com/ArchLinuxStudio/bwe-auto-trader/releases/tag/v0.1.7) at release commit `50153e19c91c019dfe103f4f27253e5c169fa204`; its annotated tag object is `7e6da16119159dda926ee7360e33a1ad26a417c1` and must not be moved or rewritten.
- The durable journal, immediate Telegram visibility, network diagnostics, explicit quota exhaustion, and all `v0.1.8` hardening/features are present in the tagged source and Windows binaries.
- A 2026-08-25 user test of the tagged Windows build observed approximately two minutes between target-channel publication and timeline receipt. The exact private network/proxy trigger is not locally reproduced, but the tagged health loop's inability to compare the target-channel cursor is confirmed in source.
- The Windows x64 `v0.1.8` NSIS/ZIP artifacts completed build, afterPack, archive inspection, hashing, isolated cold start, and automated packaged close/hide/second-instance/minimized-restore QA. macOS/Linux still have source/package configuration only and are not release-verified.
- No real Telegram, ChatGPT, or OKX private call and no real order was executed by Codex.
- `v0.1.8` strictly validates exact order details, documented normal-order states, ordinary pending-order entries/completeness, and position entries before any opening-preflight or reconciliation safety decision. Exact same-origin reconciliation also rejects a valid-looking scoped response for another instrument, and decimal position-effect checks do not collapse a mathematically non-zero value through JavaScript number underflow. Repeated mutation lifecycle events can no longer change the committed exchange `expTime` or regress a later lifecycle to `transmitting`.
- The accepted cross-client design requires revision-bound, complete order/pending/history/fill evidence and a durable absence certificate/tombstone. Its automatic release gate is intentionally disabled until an authoritative OKX visibility bound exists.
- The `v0.1.8` Telegram monitor probes the target channel every five seconds with a four-second RPC deadline. A newer remote cursor is immediately shown as a no-token recovered preview, then goes through the existing atomic catch-up before AI; it can never trade. A timed-out channel/catch-up RPC fails closed and makes the next recovery rebuild the sender.
- The `v0.1.8` Electron main process owns a strong native tray reference. With a usable tray, title-bar close hides the existing window; tray activation/menu, platform activation, and a second instance use one guarded restore-or-create path. Explicit quit uses a three-phase shutdown gate so repeated quit requests cannot bypass IPC removal and `AppController.dispose()`. If tray creation fails, Windows/Linux retain normal close-to-exit behavior.
- The `v0.1.8` ChatGPT service applies official rolling quota notifications immediately and performs a complete rate-limit read every 60 seconds for the authenticated service lifetime. All complete-read triggers share a single-flight request with a 10-second deadline; failures preserve the last trusted value, and logout/close stop future scheduling and isolate late results.
- The `v0.1.8` settings UI displays current-cycle remaining percentage rather than used percentage, with a matching remaining-capacity bar and explicit one-minute cadence.

## Completed

Baseline inherited from `v0.1.6`:

- Pinned teleproto transport with application-owned atomic catch-up, ingress-time authorization, recovered-message trading isolation, the final OKX POST guard, fixed private routing, no-retry unknown handling, and independent `reduceOnly` manual close.

Changes delivered in `v0.1.7` relative to `v0.1.6`:

- Added the strict, bounded, fsync-backed, non-replayable `mutation-journal.v1.json` and fail-closed restart recovery. Durable `prepared`/`transmitting` boundaries, immutable exchange identity, serialized evidence updates, and journal health now block unsafe arm, credential replacement, open, and close operations.
- Made Telegram messages visible immediately after local receipt or successful startup/recovery buffer reservation. Recovery observations remain no-token, sticky `recovered`, canonical-FIFO ordered, terminally cleaned up when abandoned, and permanently unable to trade.
- Added `checkedAt`-based tri-state network-diagnostics presentation so completed negative/incomplete probes no longer appear as “尚未检测/未验证”.
- Added explicit ChatGPT quota exhaustion state, structured and fallback evidence parsing, stale-read protection, throttled recovery checks, persistent user guidance, live-capability revocation, and per-message non-trading `SKIP` results while Telegram monitoring continues.
- Added targeted mock/injected regressions for all four areas, updated the authoritative docs and user-facing README, built and inspected Windows x64 artifacts, cold-started the isolated portable package, committed/tagged/pushed the source, and published the five-asset GitHub Release.

Changes delivered in `v0.1.8` relative to `v0.1.7`:

- Made `exchangeExpiresAt` immutable after the durable `transmitting` commit and rejected a repeated transmitting event after lifecycle advancement.
- Added strict runtime validation for exact order-details results, documented normal-order states, ordinary pending SWAP order entries, full 100-item pending pages, and positions used by opening preflight or same-origin unknown reconciliation. Same-origin scoped responses must contain only the requested instrument; the existing risk-reducing close path still intentionally filters unrelated valid instruments as required by the accepted decision. Malformed, incomplete, or conflicting evidence now blocks submission or keeps the unknown interlock instead of becoming absence/position proof.
- Replaced floating-point position zero detection with a validated decimal-significand check, so values such as `1e-999` remain non-zero safety evidence. Reduce-only close now derives direction from the lexical sign and sends a trimmed unsigned size, avoiding both underflow misdirection and whitespace-corrupted quantities.
- Added focused regressions for conflicting expiry evidence, malformed exact/pending/position responses, external orders with empty `clOrdId`, undocumented `rejected`/`failed` normal-order states, scoped identity conflicts, decimal underflow, normalized close direction/size, ordinary pending-page completeness, and malformed opening-position snapshots.
- Accepted the evidence-gated cross-client certificate model in `docs/DECISIONS.md`; negative replacement-client evidence remains diagnostic and locked.
- Replaced the generic authorization-only Telegram health probe with a bounded target-channel cursor probe. A proven cursor gap now freezes recovery state in the same synchronous turn, immediately exposes the probe result as a sticky recovered/no-token preview, and starts complete catch-up without waiting for teleproto's much later generic stale recovery.
- Bounded channel probes, catch-up pages, final recovery authorization, forced disconnect, and reconnect at four seconds. A timeout closes readiness before asynchronous diagnostics; the next recovery cancels the old sender/dial before retrying. Bounded stop detaches obsolete health work, and late old-client recovery failure cannot mutate a restarted monitor.
- Added injected regressions proving that a missed push is visible at the first default five-second tick, starts the real coordinator AI callback inside the ten-second acceptance window, carries no authorization even while the rest of the system is armed, and remains permanently non-trading. Tests also cover multi-message gap/residual-live FIFO, duplicate suppression, stale newer-cursor isolation, default/probe/catch-up/authorization/disconnect/connect deadlines, ghost rebuilding, and stop/restart generation isolation.
- Added native main-process tray ownership with a compact bundled glyph, stable show/quit menu actions, title-bar close-to-hide, minimized/hidden restoration, second-instance/platform activation reuse, destroyed-window recreation, and a tray-unavailable close fallback. The tray is published only after the initially hidden renderer has loaded, and concurrent restore requests share one window-creation promise.
- Replaced the old boolean shutdown gate with `idle -> disposing -> ready-to-quit` coordination. Repeated quit requests remain prevented until the one cleanup operation completes, then the final Electron quit is allowed; an early quit first settles the startup task so its failure handler cannot force-exit during controller disposal.
- Added nine pure mock lifecycle regressions for close/hide, tray fallback, restore/focus, stable menu actions, repeated asynchronous quit, startup-before-dispose ordering, and cleanup failure. The full local suite and production build pass without starting Electron or accessing private services.
- Replaced the login-only ChatGPT rate-limit snapshot with authenticated 60-second recursive polling while retaining immediate rolling-notification updates. Periodic, explicit, quota-skip, and notification-recovery reads share one bounded single-flight operation; stale account/evidence revisions and post-close completions cannot write state.
- Paused quota polling before the logout RPC, preserved the last trusted value across timeout/failure, retried on a later cycle, and kept the existing invariant that quota recovery never restores live authorization automatically.
- Added seven focused regressions for the one-minute cadence, the default 10-second read deadline, cross-trigger single-flight, logout pause, close isolation, no-message exhaustion recovery, and post-login polling. The focused quota suite, standard full suite, and production build pass without private-service access.
- Synchronized the app, lockfile, runtime manifest/notices, renderer fallback, and Codex client metadata to `0.1.8`; built and inspected the Windows x64 package, generated explicit public checksums/notes, committed/tagged/pushed the source, and published only the five reviewed Release assets.

## In Progress

The `v0.1.8` source and Windows assets are published. The next user-visible work is installation testing for the remaining Explorer tray-menu/cleanup behavior, followed—only with explicit authorization—by real Telegram/ChatGPT timing and quota observation. Collection-only cross-client recovery remains queued with automatic negative-evidence release disabled. No private-service connection or real order was performed during release work.

## Relevant Files

| Path | Current responsibility |
|---|---|
| `AGENTS.md` | Persistent Agent entry point, safety rules, reading order, and standard commands |
| `docs/INDEX.md` | Documentation map and authority table |
| `docs/ARCHITECTURE.md` | Stable process/module/data-flow and fail-closed invariants |
| `docs/DECISIONS.md` | Accepted constraints and rejected approaches |
| `docs/TODO.md` | Only unfinished executable work |
| `docs/KNOWN_ISSUES.md` | Current limitations and active workarounds |
| `src/main/index.ts` | Electron startup, native tray ownership, unified window restore, and orderly shutdown wiring |
| `src/main/window-tray.ts` | Pure close/reveal/menu helpers and the repeated-quit-safe asynchronous shutdown coordinator |
| `src/main/services/mutation-journal.ts` | Strict durable mutation schema, atomic store, identity binding, and resolution operations |
| `src/main/services/okx.ts` | Final request boundary and awaited mutation lifecycle events |
| `src/main/app-controller.ts` | Journal authority, evidence serialization, service lifecycle, Telegram observation wiring, account binding, and mutation blockers |
| `src/main/services/telegram.ts` | Live Telegram delivery, bounded target-channel cursor probes, atomic recovery, no-token early observation, and ghost-connection rebuilding |
| `src/main/services/chatgpt.ts` | Codex protocol, classifier lifecycle, structured quota detection, immediate notifications, and bounded 60-second authenticated rate-limit polling |
| `src/main/services/signal-coordinator.ts` | Immediate display records, canonical AI/order gates, quota-specific non-trading results, and runtime pending-order interlocks |
| `src/main/services/network-diagnostics.ts` | Informational direct/proxy/OKX probes and the authoritative completed-run `checkedAt` marker |
| `src/shared/types.ts` | Public snapshot contract, including ChatGPT quota state and network-diagnostics completion data |
| `src/renderer/src/App.tsx` | Distinct pending UI for Telegram continuity verification versus AI analysis, plus dynamic remaining-quota presentation |
| `src/renderer/src/network-diagnostics-view.ts` | Tri-state mapping for never-run, successful, and completed-negative network probes |
| `src/renderer/src/styles.css` | Diagnostic success/information/warning indicators |
| `tests/telegram-monitor.test.ts` | Five-second missed-push detection/AI start, probe timeout/reconnect, startup/recovery ordering, de-duplication, and bounded-stop tests |
| `tests/unit/app-controller-telegram-visibility.test.ts` | Main-process callback-to-snapshot wiring and emergency cleanup tests |
| `tests/unit/network-diagnostics-view.test.ts` | Renderer diagnostics state and wording tests |
| `tests/unit/network-diagnostics.test.ts` | Injected public/proxy probe behavior and completed-result contract |
| `tests/unit/chatgpt.test.ts` | Structured/text quota classification, rate windows, sparse updates, polling lifecycle, timeout/single-flight behavior, and recovery |
| `tests/unit/signal-coordinator.test.ts` | Immediate stages, canonical reuse, non-trading recovery, and abandonment tests |
| `tests/unit/mutation-journal.test.ts` | Store lifecycle, integrity, identity, immutable expiry, serialization, and redaction tests |
| `tests/unit/okx.test.ts` | Durable precommit/final-guard/ACK/unknown/rejection boundaries, strict response validation, and malformed preflight/reconciliation evidence tests |
| `tests/unit/app-controller-okx-route.test.ts` | Restart recovery, controller races, identity mismatch, mutation blockers, and ChatGPT quota lifecycle/warning tests |
| `tests/unit/window-tray.test.ts` | Close-to-hide, tray fallback, restore/menu behavior, and asynchronous shutdown-gate tests |

## Current Implementation

The renderer invokes a frozen preload API. Trusted IPC handlers call `AppController`, which remains the only authority for credentials, live capabilities, service lifecycles, positions, close operations, and durable order evidence.

After controller/IPC initialization, the main process loads the initially hidden renderer, attaches controller events, creates one native tray, marks startup complete, and only then reveals the window. A usable tray changes title-bar close into `preventDefault()` plus `hide()`; it does not dispose or mutate the controller. Tray activation, its show action, a second-instance event, and platform activation share one initialized/not-shutting-down restore-or-create path. Concurrent restore requests await the same window-creation promise, then restore a minimized window before showing and focusing it. Explicit tray quit calls the normal Electron quit path. The shutdown coordinator prevents both the first and repeated `before-quit` events; the first request synchronously disables restoration, destroys the tray, and removes IPC, then waits for any in-flight startup before disposing the controller and permitting the final quit. With no usable tray, close interception is disabled so Windows/Linux cannot leave an unreachable background process.

On a healthy Telegram path, the raw `NewMessage` callback still delivers immediately and canonical processing publishes `received` and `analyzing` before awaiting ChatGPT. Independently, every five seconds a four-second-bounded `getMessages(limit=1)` request compares the target channel's newest message ID with the local delivered cursor. A newer remote cursor synchronously closes readiness, freezes the cursor, reserves the returned message as a no-token recovered preview, and starts the existing full-page atomic catch-up. Canonical FIFO handoff later reuses that record and begins AI, but sticky `recovered` metadata prevents any order. Target-channel/catch-up/authorization and forced disconnect/connect operations all have deadlines; readiness closes before non-blocking diagnostics, and the next recovery tears down the sender even if it only appears disconnected. Bounded stop detaches old health work and client-identity checks late failures so a restarted monitor is not polluted. If a preview flow is abandoned first, the record becomes terminal `skipped` and cannot be revived by a late callback.

Network diagnostics remain optional and informational. The main process returns `checkedAt` even when an individual probe times out, returns an invalid response, or cannot obtain an IP. The renderer now uses that completion marker as the tri-state authority and does not treat a negative boolean or missing IP as “never checked”.

ChatGPT quota exhaustion is carried as a dedicated service/controller state rather than a generic sticky connection error. While initialized and authenticated, rolling app-server notifications update the value immediately and a recursive timer requests a complete snapshot every 60 seconds. The request is bounded to 10 seconds and shared across periodic, explicit, notification-recovery, and quota-skip triggers, so calls never overlap. A failed or timed-out latest read leaves the previous trusted value intact and the next cycle retries. Account/quota evidence revisions prevent stale completion, logout pauses polling before its RPC, and close clears scheduling and rejects late commits. The renderer derives and displays the current-cycle remaining percentage from this live main-process state. A transition to exhausted synchronously invalidates live authorization and emits one warning, while the ChatGPT authenticated transport and Telegram monitoring remain connected. Later messages continue through the coordinator, are retained on the timeline with quota-specific wording, and return before any exchange operation. New classifier turns are blocked while exhaustion is known, and an older in-flight turn is reduced to the same quota `SKIP` if newer exhaustion evidence arrives. Only a latest-revision full read can clear analysis unavailability, and recovery never re-arms live trading.

For an order mutation, `OkxV5Client` completes read-only prerequisites and generates a unique `clOrdId`. It then awaits a `prepared` journal commit. Immediately before the order fetch it awaits `transmitting` with the exact exchange expiry, re-runs the existing synchronous live/message generation guard, and only then permits fetch. The journal contains no replay API or persisted authorization capability.

The committed exchange expiry is immutable: an idempotent repeated `transmitting` event must carry the same value, and a later lifecycle cannot regress to transmission. Exact order details must now return at most one strictly matching SWAP order in a documented normal state; the controller applies the same state allowlist before durable private-stream evidence can resolve a record. Ordinary pending-order entries are validated, requests explicitly use the 100-item maximum, and a full page is rejected as incomplete. Every returned SWAP position is structurally validated, and same-origin reconciliation additionally requires all scoped position/pending results to match the requested instrument. Position zero/non-zero classification and reduce-only close direction use the exact decimal significand/sign rather than a potentially underflowed JavaScript `Number`; the submitted close size is trimmed and unsigned. These checks are local fail-closed hardening; they do not enable cross-client absence release.

ACK, private-stream updates, read-only recovery, and same-origin evidence enter one controller FIFO. Composite order identity cannot change after it becomes known. Terminal evidence is durably committed; when ACK identity is still pending it remains staged until matching ACK/unknown evidence permits removal. Process-local bidirectional finalized identity tombstones and bounded early-order evidence reject conflicting late updates and prevent pre-ACK evidence from being stranded.

Startup reads the journal before IPC use but does not connect, monitor, or arm. A `prepared` record can be removed only because the transport boundary makes fetch unreachable until the later `transmitting` commit completes; startup never clears `transmitting` from timing or local inference. On an explicit OKX connection, the controller hashes the verified account `uid`, requires an exact fingerprint match, and uses only GET evidence. It never reuses the originating client's 30-second absence rule on a replacement client.

The existing runtime coordinator and manual-close maps remain active defense layers. The journal is the restart-spanning authority and independently blocks every new open/close mutation, live arm, and credential replacement until its state is conclusively resolved.

## Current Problems

There is no known P0 blocker for the current approximately 10 USDT, actively supervised, dedicated-sub-account scope.

- The new Telegram cursor probe is verified only with injected transports. The user's real proxy/Telegram/ChatGPT path has not yet been retested, so roughly ten-second receipt/AI start is a target, not a confirmed private-service result.
- The packaged Windows build passed native title-bar close/hide, process-retention, second-launch restoration, and minimized restoration checks. Explorer tray icon activation/menu, explicit orderly quit, and stale-icon cleanup still require the user's interactive installation test; macOS/Linux remain release-unverified.
- Dynamic ChatGPT remaining-quota refresh is verified with an injected app-server transport only. A real authenticated account has not been observed across multiple cycles, so live Codex notification/snapshot timing remains integration-unverified.
- No real dedicated-sub-account end-to-end validation has been authorized or performed. Telegram delivery, public/proxy diagnostics, deliberate ChatGPT exhaustion, and real OKX order behavior remain unverified against private services.
- Cross-client unknown absence has an accepted evidence model but no enabled automatic release gate. A replacement client that sees no matching order remains locked even after repeated not-found results or a position effect, and the failed connection attempt does not keep a private WebSocket open for later terminal evidence. The reviewed OKX API contract has no finite maximum visibility delay or shared cross-endpoint snapshot revision.
- Windows artifacts are unsigned/default-icon builds. macOS/Linux native packaging, runtime-license profiles, and cold starts remain unverified.

All current limitations, failed approaches, and workarounds are authoritative in [`KNOWN_ISSUES.md`](KNOWN_ISSUES.md); executable completion criteria are in [`TODO.md`](TODO.md).

## Verification State

The standard local commands were rerun on 2026-08-26 on Windows/PowerShell after synchronizing the final `0.1.8` release identity. They use mocks/injected transports and made no private-service call:

| Verification | Result |
|---|---|
| `npm.cmd run check:dependencies` | Passed: 16 installed production packages satisfy the reviewed policy |
| `npm.cmd run typecheck` | Passed: node and renderer `tsc --noEmit` projects |
| `npm.cmd test` | Passed: 13 files, 255 tests |
| `npm.cmd run build` | Passed: dependency gate, typecheck, all three electron-vite outputs, and compiled-output provenance gate |
| Lint | Not configured; `package.json` has no lint script |
| `npm audit --omit=dev` | Passed for the `v0.1.8` release candidate: 0 known vulnerabilities; required process-local system-CA/proxy variables after the first certificate-chain failure |
| `npm.cmd run package:win` | Passed: Windows x64 NSIS installer and portable ZIP generated from final `0.1.8` source; afterPack verified 16 packaged dependencies and runtime notices |
| Windows artifact QA | Passed: portable ZIP fully extracted to 103 files; ASAR package version/main and main/preload/renderer entries verified; Codex x64 binary and project/third-party/Electron/Chromium licenses present; isolated cold start logged only `application_started` |
| Windows signatures | Expected limitation confirmed: Setup and application are `NotSigned`; bundled OpenAI Codex executable has a valid OpenAI signature |
| Focused Telegram/coordinator verification | Passed: 3 files, 56 tests; missed-push preview at the first five-second tick, AI starts within the injected ten-second acceptance window, recovered message cannot order, stale/multi-message FIFO cases stay isolated, every new timeout is bounded, and stalled/old-generation work cannot strand or pollute the connection |
| Focused tray lifecycle verification | Passed: 1 file, 9 tests; close-to-hide, no-tray fallback, minimized restore/focus, stable show/quit actions, repeated-quit blocking, startup-before-dispose ordering, and failed-cleanup finalization |
| Focused ChatGPT quota verification | Passed: 1 file, 25 tests total; new coverage proves the one-minute cadence, bounded timeout/retry, last-trusted-value preservation, cross-trigger single-flight, logout pause, close isolation, exhaustion recovery without a message/notification, and polling after login |
| Packaged Windows tray smoke test | Partially passed: isolated native run proved title-bar close hides while retaining the process, second launch restores the existing window, and a minimized window restores visibly; interactive Explorer tray icon/menu, explicit quit, and stale-icon cleanup remain for user testing |
| Real Telegram/ChatGPT/OKX private integration | Not verified; the reported Telegram latency still needs user-environment re-test |
| Real order open/close | Not verified |
| macOS/Linux package and cold start | Not verified |

Published `v0.1.8` asset facts (only these five files are public):

| Asset | Size | SHA-256 |
|---|---:|---|
| `BWE.Auto.Trader-Setup-0.1.8-x64.exe` | 184,956,835 bytes | `1FDCC75692B59550C3579D51C505C0BD5FA052B7E214D32CBACB72A74BA0F170` |
| `BWE.Auto.Trader-Portable-0.1.8-x64.zip` | 263,898,691 bytes | `58D1D45E72A4C8FAC6AF77EF05AF2AD384B551737E7DEA90270CC980504C78BF` |
| `LICENSE` | 3,911 bytes | `E35451072886B5799DAC567F5764AEEC6BBD66D75068EA52169E3931263E886A` |
| `SHA256SUMS.txt` | 207 bytes | `7DECDD0C2D73224777DB189142D2F09F483326C915BDF4559D096F37D41A5E90` |
| `THIRD_PARTY_NOTICES.txt` | 8,098 bytes | `255884390691E7D3C3CCE170C561AB6114E414016520A4F651A6A95EE7966868` |

`SHA256SUMS.txt` records the two executable archive hashes. `RELEASE_NOTES.md` is the GitHub Release body and was not uploaded as a duplicate asset. The package was not installed automatically because the QA machine already had a `v0.1.6` installation record; avoiding that overwrite preserved the existing installed state. The extracted portable package was cold-started instead.

## Git Workspace State

At the published checkpoint, local `main`, `origin/main`, and annotated tag `v0.1.8` point to the release commit and the tracked worktree is clean; use Git itself for the exact commit/tag object identities. The release commit includes all twenty-two previously modified tracked files plus the two formerly untracked tray source/test files. No private connection or real order occurred.

`release-v0.1.8/` remains intentionally ignored. It contains the unpacked app, original space-named builder outputs, dotted publication copies, builder metadata, release notes, checksums, and copied licenses. Only the dotted Setup/Portable binaries plus `LICENSE`, `SHA256SUMS.txt`, and `THIRD_PARTY_NOTICES.txt` were uploaded explicitly. Never glob-upload this directory; `builder-debug.yml`, `latest.yml`, `.blockmap`, `win-unpacked/`, and `RELEASE_NOTES.md` are not public assets. Historical artifacts, existing local user-data folders, and `CODEX_CONTEXT.md` were not modified or deleted.

## Next Recommended Action

For the next Thread:

1. Install or open the published Windows `v0.1.8` asset and verify tray icon activation, “显示主窗口”, explicit tray quit, process exit, and stale-icon cleanup. Confirm that hiding alone preserves monitoring/connections and does not imply emergency stop.
2. With explicit ChatGPT authorization, observe the remaining-quota value across at least two one-minute cycles without relogin; confirm a real change propagates and logout stops updates without recording account/session data.
3. Re-test several real target-channel posts after an idle interval only with explicit Telegram/ChatGPT authorization. The acceptance target is timeline visibility and AI start in roughly ten seconds or less; cursor-probe deliveries must remain visibly recovered and must never order.
4. If those checks pass, record only non-sensitive results and continue the collection-only cross-client recovery task in [`TODO.md`](TODO.md). Preserve the journal and every fail-closed rule; do not replay a mutation, clear on replacement-client negative evidence, access private services, place orders, edit the journal by hand, commit, push, package, or publish without the corresponding authorization.

## New Thread Bootstrap

1. Read `AGENTS.md`, then `docs/INDEX.md`, then this file.
2. Read `docs/DECISIONS.md`, `docs/TODO.md`, and `docs/KNOWN_ISSUES.md` only for the task selected above.
3. Treat published Windows x64 `v0.1.8` as the baseline and verify its exact Git/Release identities live before making new claims.
4. Run `git status --short --branch`, preserve any later user work, and continue from `Next Recommended Action`.
