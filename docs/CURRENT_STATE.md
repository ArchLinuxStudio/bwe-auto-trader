# Current State

Checkpoint date: 2026-08-28, Asia/Shanghai.

## Current Objective

Package, commit, tag, push, and publish the completed selective-system-notification and saved-configuration startup-restoration work as Windows x64 `v0.1.10`. The user explicitly authorized this code/documentation commit, push, and Release. Preserve the published `v0.1.8`/`v0.1.9` identities, every fail-closed trading invariant, and the rule that release verification must not access private Telegram, ChatGPT, or OKX services or place an order.

## Current Status

- Version: `0.1.10` release candidate.
- Branch: `main`.
- The working tree contains the completed selective system notifications, saved-config startup restoration, release-identity bump, tests, and documentation for `v0.1.10`. All local release gates, Windows packaging, artifact review, and isolated no-config cold start pass; commit/tag/push and GitHub publication remain.
- Published baseline: [`v0.1.9`](https://github.com/ArchLinuxStudio/bwe-auto-trader/releases/tag/v0.1.9), published 2026-08-27 12:02:28 Asia/Shanghai.
- Published `v0.1.9` baseline release commit: `36bdbbece160255cdb82537d173f8739afb8c37a`.
- Published `v0.1.9` annotated tag object: `765f0eb375f190b17de33e10cdb8f5beb86a0e93`; its peeled commit is the baseline release commit above.
- At `v0.1.9` publication, local `main`, remote-tracking `origin/main`, remote `refs/heads/main`, and the peeled tag were aligned at that release commit. Its post-release documentation checkpoint is intentionally one commit after the tag.
- Published GitHub Release `377556649` is the immutable `v0.1.9` baseline and contains exactly five remotely verified assets. Its historical hashes are retained by Git/GitHub rather than duplicated in the current `v0.1.10` candidate table below.
- Published `v0.1.9` introduced `build/icon.svg` as the electron-builder application icon. Read-only extraction from the `v0.1.10` unpacked application, final Portable ZIP application, and NSIS installer confirms all three still expose the same custom icon.
- The release retains an existing manual arm only as suspended same-monitor intent across a recoverable Telegram network outage. It keeps retrying, restores readiness only after bounded connection/catch-up/authorization verification, and resumes authorization solely for later new live messages. Startup/recovery messages remain non-trading and pre-recovery tokens remain invalid.
- Telegram status/error/message callbacks are bound to their owning monitor identity. A stopped monitor cannot overwrite, lock, or resume a replacement generation, and a successful recovery publishes `connected` only after `liveTradingReadiness.ready` is true. Recovery uses direct `updates.getState` error classification, so only explicit auth-key/session loss is fatal while auth-probe network failures continue retrying. Errored/stopped monitors are retired before saved-config reconnect.
- Explicit `UnauthorizedError`/`AuthKeyError` is normalized to fatal authorization loss from any recovery stage, including connect and catch-up before the final authorization probe.
- The renderer displays `实盘重连中` while the retained arm is suspended instead of claiming that signals can currently submit orders.
- The published `v0.1.9` Windows package, artifact inspection, checksums, isolated cold start, release commit, annotated tag, atomic push, five-asset upload, remote digest verification, and public publication passed.
- Codex made no real Telegram, ChatGPT, or OKX private call and placed no real order during this release work.
- Ordinary `NotificationItem` history/toasts are now separated from native OS notifications. Only the four explicitly requested transitions use the system channel, and clicking a delivered notification requests the existing guarded window-restoration path.
- Channel receipt is notified once when a unique message record first becomes visible; recovered observation and later canonical processing share that record. AI and order notifications occur only after `analyzing` and `submitting` are successfully published. Confirmed Telegram `reconnecting` is notified once per outage episode regardless of whether live trading was armed.
- System-notification bodies are neutral and expose no channel text, channel name, message ID, symbol, direction, notional, client/order ID, credential, or session data. Synchronous throws and asynchronous rejections from the notification backend are isolated from monitoring, AI, authorization, and order flow.
- The startup path runs only after normal application initialization, attempts each saved service independently, and reserves automatic monitoring for the case where all three configuration markers and all three connected states are present. It never restores `liveArmed`.
- Telegram startup and renderer calls share a main-process connection single-flight with lifecycle ownership. The saved ChatGPT flag is persisted only as a restoration hint; authenticated account/read state and model readiness from the live Codex app-server remain authoritative. A manual connect/login, credentials or settings change, disconnect, monitoring action, emergency stop, or shutdown cancels the one-time automatic-monitoring intent, and a replaced ChatGPT startup service cannot overwrite the manual successor.

## Completed

- Completed the post-version-bump `v0.1.10` release gates and Windows x64 packaging. The final NSIS/Portable artifacts passed dependency, typecheck, focused/full test, build, audit, afterPack, content/version/signature, checksum, ASAR parity, and fresh-user-data cold-start checks without accessing a private service or placing an order.
- Implemented and locally verified saved-configuration startup restoration. Telegram, ChatGPT, and OKX attempts are isolated; monitoring starts only after all three initially configured services complete connection; startup and recovered messages remain non-trading; no path restores `liveArmed`; and user/shutdown lifecycle actions prevent late automatic monitoring.
- Added main-process Telegram connection single-flight and late-owner cleanup across startup, renderer connect, disconnect, and shutdown. Added startup-specific ChatGPT account/warm-up validation without opening a login URL, manual-login takeover isolation, and unchanged fail-closed OKX connection/journal recovery reuse.
- Implemented and locally verified selective system notifications for unique channel receipt, AI-analysis start, one-per-outage Telegram reconnect entry, and order-submission start. Ordinary notices remain in-app, OS-visible text is neutral, click requests guarded window restoration, and delivery failure is non-authoritative.
- Published exactly five reviewed `v0.1.8` GitHub Release assets: the Windows x64 Setup and Portable packages, `LICENSE`, `SHA256SUMS.txt`, and `THIRD_PARTY_NOTICES.txt`.
- Added a five-second, four-second-bounded target-channel Telegram cursor probe. A missed-push recovery is immediately visible, enters canonical FIFO processing, and is permanently non-trading.
- Added main-process tray ownership, close-to-hide, single-instance restore, minimized-window restore, explicit orderly quit, and a close-to-exit fallback when no usable tray exists.
- Added authenticated ChatGPT rate-limit polling every 60 seconds with immediate rolling-notification updates, a shared 10-second-bounded single-flight read, last-trusted-value preservation, logout/close isolation, and remaining-percentage UI semantics.
- Hardened the mutation journal and OKX read evidence: immutable committed expiry, non-regressing lifecycle, strict order/pending/position validation, scoped identity checks, exact decimal non-zero handling, and fail-closed malformed/incomplete evidence.
- Accepted the cross-client evidence-certificate design while deliberately leaving automatic negative-evidence release disabled because no authoritative OKX visibility bound is known.
- Completed source checks, Windows packaging, artifact inspection, isolated cold start, packaged close/hide/restore smoke checks, checksums, commit, annotated tag, atomic source/tag push, asset verification, and public release publication from the same `0.1.8` source state.
- Completed a fresh-user-data Explorer UI Automation check against the exact 103-file extraction of the published Portable ZIP on Windows 11 build 26200. Explorer exposed an on-screen BWE notification-area control; its invoke action and the native “显示主窗口” menu item restored the same PID and HWND. Within 546 ms after invoking native “退出 BWE Auto Trader”, all four observed packaged Electron processes no longer existed, and a fresh UI Automation query found no BWE notification-area control. The isolated audit contained only `application_started`/`application_stopped`, with live trading unarmed and zero unresolved mutations. No separate human visual/screenshot confirmation was performed.
- Replaced the packaging fallback icon with an original dark/emerald signal-bolt asset that remains legible at 16, 32, 64, and 1024 px and matches the existing tray motif. The generated Windows ICO contains 16, 24, 32, 48, 64, 128, and 256 px 32-bit entries; the application and installer extracted-icon PNGs were byte-identical.
- Implemented same-monitor Telegram network recovery continuity without weakening the trading boundary: repeated reconnect failures remain in the health-cycle retry loop; readiness and message authorization stay closed during recovery; the old recovery revision permanently invalidates in-flight tokens; recovered messages never trade; and only post-verification new live ingress can use the retained process-local arm.
- Added monitor-identity guards for Telegram callbacks and late connect/disconnect completion, saved-config replacement of errored/stopped monitors, plus an explicit suspended/resumed audit and notification path.
- Added injected regressions for two failed reconnect attempts followed by success, a direct authorization-RPC network failure followed by retry, explicit `UnauthorizedError` becoming fatal without retry, readiness-backed `connected`, errored-monitor replacement, stale-monitor callback isolation, recovery-time authorization suspension, old-token rejection, and new post-recovery authorization.
- Added a release-blocking regression for explicit authorization loss during catch-up, ensuring every recovery phase enters fatal state rather than retrying a revoked session indefinitely.
- Bumped all application/runtime/NOTICE/manifest version identities to `0.1.9`, generated a clean Windows x64 NSIS and Portable package from the final source, and verified the exact five intended public assets.
- Committed `36bdbbece160255cdb82537d173f8739afb8c37a` as `Release v0.1.9`, created annotated tag object `765f0eb375f190b17de33e10cdb8f5beb86a0e93`, atomically pushed source and tag, verified the draft's five remote assets, and published the final GitHub Release.

## In Progress

The source implementation and local release-candidate verification are complete. The authorized `v0.1.10` publication workflow is now in progress:

1. Commit the reviewed source and documentation as `Release v0.1.10`, create the annotated tag, and atomically push `main` plus the tag.
2. Create a draft GitHub Release with exactly the five reviewed assets below, verify every remote byte size and SHA-256 digest, and only then publish it.
3. Record final remote identities and release facts in this checkpoint and push a documentation-only checkpoint after the release tag.
4. Real authenticated startup restoration, native toast/click observation, and any real order remain separately gated; none is part of this release task.

## Relevant Files

| Path | Current responsibility |
|---|---|
| `AGENTS.md` | Persistent Agent entry point, safety rules, reading order, and standard commands |
| `docs/INDEX.md` | Documentation map and authority table |
| `docs/ARCHITECTURE.md` | Stable process, module, data-flow, and fail-closed boundaries |
| `docs/DECISIONS.md` | Accepted constraints and rejected alternatives |
| `docs/TODO.md` | Unfinished executable work and completion criteria |
| `docs/KNOWN_ISSUES.md` | Current limitations, prior failed approaches, and workarounds |
| `build/icon.svg` | Reviewable application-icon master used for platform package conversion |
| `package.json` | Electron-builder identity, icon, target, and artifact configuration |
| `src/main/index.ts` | Electron startup, tray ownership, native notification delivery/click restoration, window restoration, and shutdown wiring |
| `src/main/window-tray.ts` | Close/reveal/menu helpers and repeated-quit-safe shutdown coordination |
| `src/main/services/telegram.ts` | Live delivery, target cursor probes, bounded atomic recovery, and no-token recovered previews |
| `src/main/services/chatgpt.ts` | Codex protocol, classifier lifecycle, quota notifications, and periodic complete reads |
| `src/main/services/settings-store.ts` | Public settings persistence, including the non-authoritative ChatGPT startup-attempt hint |
| `src/main/services/mutation-journal.ts` | Strict durable mutation state and identity/evidence persistence |
| `src/main/services/okx.ts` | OKX request validation and final mutation-transmission boundary |
| `src/main/app-controller.ts` | Main-process authority for services, journal recovery, credentials, notification routing, and trading gates |
| `src/main/services/signal-coordinator.ts` | Signal timeline, selected system-notification transitions, AI/order gates, recovery isolation, and pending-order interlocks |
| `src/renderer/src/App.tsx` | Timeline/status UI, reconnect-suspension presentation, and dynamic remaining-quota presentation |
| `src/renderer/src/styles.css` | Renderer visual states, including the amber suspended-live indicator |
| `tests/telegram-monitor.test.ts` | Telegram latency-recovery, ordering, timeout, and generation-isolation coverage |
| `tests/unit/app-controller-okx-route.test.ts` | Controller capability, service-lifecycle, stale-monitor, and final-authorization coverage |
| `tests/unit/chatgpt.test.ts` | Quota parsing, cadence, timeout, single-flight, logout, and close coverage |
| `tests/unit/window-tray.test.ts` | Close-to-hide, fallback, restore/menu, and shutdown-gate coverage |
| `tests/unit/app-controller-notifications.test.ts` | Program/system notification separation, setting suppression, reconnect deduplication, and delivery-failure isolation |
| `tests/unit/app-controller-startup.test.ts` | Saved-config selection, three-service monitoring gate, service-failure isolation, stale ChatGPT hint, manual takeover, Telegram single-flight/cancellation, shutdown, and permanent startup lock coverage |
| `tests/unit/okx.test.ts` | Transmission boundary and strict exchange-evidence validation coverage |
| `tests/unit/mutation-journal.test.ts` | Durable lifecycle, identity, expiry, serialization, and redaction coverage |

## Current Implementation

- The Electron renderer uses the frozen preload API; `AppController` in the main process remains the authority for credentials, service lifecycles, live capabilities, positions, close operations, and durable mutation evidence. Renderer state is never a trading security boundary.
- The current working tree adds a one-time startup restoration task after Electron window/IPC/tray initialization. Telegram, ChatGPT, and OKX attempts are selected from saved configuration markers and run independently. Automatic monitoring is allowed only when all three markers existed and all three services end connected; a user lifecycle action or shutdown cancels the one-time monitoring intent. Focused controller/Telegram/ChatGPT regressions and all standard repository gates pass with injected transports.
- Telegram connect is owned by one main-process task across startup and renderer callers; disconnect/shutdown or a newer lifecycle revision prevents a late monitor from becoming current. The ChatGPT persisted marker only requests restoration, while app-server authentication, account/read state, and warm-up decide the actual connection. Startup failures produce non-sensitive guidance without cancelling other service attempts.
- Telegram live callbacks publish immediately. Independently, a five-second target-channel cursor probe has a four-second RPC deadline. A newer cursor closes readiness and exposes a sticky recovered/no-token preview before complete atomic catch-up; recovered messages can run AI but can never order. Confirmed network loss publishes `reconnecting` and repeats bounded recovery on later health cycles. The same in-memory arm remains suspended, not recreated; recovery emits readiness-backed `connected` after full verification, and only later fresh live ingress can regain authorization.
- While ChatGPT is authenticated, rolling quota notifications update immediately and one recursive timer performs a complete rate-limit read every 60 seconds. All triggers share one 10-second-bounded request. Failure preserves the latest trusted value; logout/close cancel future scheduling and isolate late results; recovery never re-arms live trading.
- With a usable native tray, title-bar close hides the existing window. Tray activation/show, second-instance activation, and platform activation share one guarded restore-or-create path. Explicit quit disables restoration, removes IPC/tray state, waits for startup, disposes the controller once, and then permits final Electron quit. Without a usable tray, Windows/Linux retain normal close-to-exit behavior.
- `AppController` keeps ordinary notices in the renderer/history and sends only the four selected lifecycle transitions to Electron's main-process `Notification` API. Duplicate/recovered message handling reuses the signal key, reconnect notifications use an outage-episode latch, the desktop-notification setting gates delivery, and a notification click uses the same restore-or-create path as the tray.
- Electron-builder uses `build/icon.svg` as the explicit application icon and converts it to each target's native format. The icon source is unchanged from `v0.1.9`; read-only 32 px associated-icon extraction from the `v0.1.10` unpacked application, final Portable ZIP application, and NSIS installer produced the same SHA-256. Installer-created shortcuts inherit the application icon, while the existing runtime tray image and lifecycle code are unchanged.
- Every OKX mutation crosses the durable `prepared` then immutable `transmitting` journal boundary before the final guarded POST. ACK, private-stream, and read-only evidence are serialized by the controller. Unknown results are never retried, and replacement-client absence evidence cannot clear an unresolved mutation.

## Current Problems

There is no known P0 blocker for the accepted approximately 10 USDT, actively supervised, dedicated-sub-account scope.

- The real Telegram/proxy/ChatGPT path has not been retested for the `v0.1.9` automatic-resume or `v0.1.10` startup-restoration/notification changes. Low-latency receipt and repeated reconnect/resume are proven only with injected transports.
- Startup orchestration, ChatGPT hint persistence, Telegram connection single-flight, manual ChatGPT takeover, service-failure isolation, and shutdown cancellation are verified with injected transports only; installed-package and authenticated private-service behavior remain unverified.
- Dynamic quota refresh is proven with an injected Codex app-server transport only; no authenticated account was observed across multiple live cycles.
- No real dedicated-sub-account end-to-end order/close test has been authorized or performed.
- A cross-client unknown can remain locked indefinitely. Automatic absence release remains intentionally disabled; repeated not-found or position-effect evidence is not sufficient.
- The `v0.1.10` Windows release candidate has the custom icon but remains unsigned, so SmartScreen may warn. macOS/Linux package/runtime-license profiles, cold starts, native icon conversion, and tray lifecycle/fallback behavior are not release-verified.
- Selective system notification routing is verified with injected callbacks only. Native visibility and click-to-restore behavior have not been observed in an installed NSIS build or the Portable ZIP; Windows notification settings or focus modes may suppress them.

See `docs/KNOWN_ISSUES.md` for symptoms, exclusions, workarounds, and investigation directions. See `docs/TODO.md` for executable completion criteria.

## Verification State

The combined selective-notification and startup-restoration behavior passed the complete repository gates after the `0.1.10` identity bump. The reviewed Windows x64 release candidate also passed packaging, artifact inspection, and a no-config isolated cold start. All service tests use mocks or injected transports; no check accessed a private service or placed an order. Published `v0.1.9` package and release facts remain immutable.

| Verification | State |
|---|---|
| Startup restoration focused tests | Passed: `tests/unit/app-controller-startup.test.ts`, 15/15 tests; covers no/partial/all configuration, full Telegram/OKX completion gates, OKX verification failure, stale ChatGPT hint, error redaction, user takeover, Telegram single-flight/bounded cancellation, queued OKX and late ChatGPT shutdown isolation, monitoring, and permanent `liveArmed=false` |
| Combined focused controller/Telegram/ChatGPT regression | Passed: 6 files, 114 tests |
| `npm.cmd run check:dependencies` | Passed: 16 installed production packages satisfy the reviewed policy |
| `npm.cmd run typecheck` | Passed for node and renderer TypeScript projects |
| `npm.cmd test` | Passed: 15 files, 281 tests |
| `npm.cmd run build` | Passed: dependency policy, typecheck, electron-vite, and compiled-output provenance checks |
| Lint | Not configured; there is no lint script |
| `npm audit --omit=dev` | Passed with process-local system CA: 0 known production vulnerabilities |
| `npm.cmd run package:win` | Passed for Windows x64 after the initial Electron download timed out and was retried with process-local system CA and `127.0.0.1:7890` proxy variables; afterPack verified 16 packaged dependencies and runtime notices |
| Notification artifact inspection | Passed: packaged `app.asar` contains all four selected notification titles and excludes the tested message/trade detail samples; delivery/click behavior was not invoked |
| Windows artifact inspection | Passed: Portable ZIP contains exactly 103 files; package version is `0.1.10`; unpacked and ZIP `app.asar` hashes match at `1AFCDC408A999AD37D0A0D1257D93AF1A105D6C50E97C2E7462B02A1B9D9592A`; packaged project license and NOTICE match source; associated icons extracted from unpacked/ZIP applications and NSIS installer match at `C1C9E1C37E313CD027AFBC3071E591AFB2B9A1FB6919447CE0EC00762DC3103B` |
| Isolated packaged cold start | Passed against the exact extraction of the final Portable ZIP with fresh repository-local ignored user data: `application_started` reported version `0.1.10`, live unarmed, zero unresolved mutations, and a healthy journal; `startup_connections_completed` reported zero configured/connected services, monitoring not started, and live unarmed. All four exact Portable processes were removed after the check |
| `npm.cmd test -- tests/telegram-monitor.test.ts tests/unit/app-controller-okx-route.test.ts` | Passed: 2 files, 67 tests; includes repeated failed reconnect then success, direct auth-RPC network/fatal classification, catch-up-stage fatal authorization loss, readiness-backed connected status, errored-monitor replacement, retained-arm suspension/resume, stale-monitor isolation, and old/new recovery-token behavior |
| Focused Telegram/coordinator checks | Passed: missed-push preview at the first five-second tick, AI start inside the injected ten-second window, permanent non-trading recovery, bounded timeouts, FIFO, and generation isolation |
| Focused tray lifecycle checks | Passed: 9/9 tests rerun in this Thread, plus the prior packaged close/hide, process-retention, second-launch, and minimized-restore checks |
| Focused ChatGPT quota checks | Passed: 25 total tests, including cadence, timeout/retry, single-flight, logout, close isolation, and recovery without auto-arm |
| Focused system-notification checks | Passed: 4 files, 63 tests; covers received/analyzing/submitting selection, recovered receipt deduplication, neutral text, reconnect episode deduplication, setting suppression, ordinary-notice isolation, obsolete-monitor isolation, and sync/async delivery-failure isolation |
| Native Windows toast/click smoke | Not verified: the candidate was cold-started, but no synthetic lifecycle event was injected and no toast visibility or notification click was observed |
| Windows signatures | Confirmed limitation on candidate `v0.1.10`: Setup/application `NotSigned`; the bundled OpenAI Codex executable has a valid upstream signature |
| Explorer tray menu/explicit quit cleanup | Previously passed via Windows UI Automation on build 26200 against the exact published `v0.1.8` Portable extraction; tray behavior is unchanged, but this native UIA check was not rerun against the `v0.1.10` candidate |
| Real Telegram/ChatGPT/OKX private integration | Not verified |
| Real order open/close | Not verified |
| macOS/Linux package, cold start, and native tray lifecycle/fallback | Not verified |

Final local `v0.1.10` release-candidate asset facts; remote digests and sizes still require draft-Release verification:

| Asset | Size | SHA-256 |
|---|---:|---|
| `BWE.Auto.Trader-Setup-0.1.10-x64.exe` | 185,016,404 bytes | `09B6D136E42539BD2FFF746E1DC3C91F0B1BD04F44AB32D1E47435F096CBFBFE` |
| `BWE.Auto.Trader-Portable-0.1.10-x64.zip` | 263,917,829 bytes | `3EA07D51912368764C5BBF7C46AEB414FCDB93C78EB158A24E4813F66820B6BE` |
| `LICENSE` | 3,911 bytes | `E35451072886B5799DAC567F5764AEEC6BBD66D75068EA52169E3931263E886A` |
| `SHA256SUMS.txt` | 209 bytes | `F604C9C077ED2DA7DB3C2A6B3FF51DF01985F6EAA21CC944DFAFD6CA965E7744` |
| `THIRD_PARTY_NOTICES.txt` | 8,100 bytes | `57924BD11D9AE84FF9F52FB6E9FA939D7B54317B11D52945897705CB1785C53F` |

## Git Workspace State

- Published release commit `36bdbbece160255cdb82537d173f8739afb8c37a` and annotated `v0.1.9` remain unchanged. Git remains authoritative for their identities.
- `main` is aligned with `origin/main` at `83d8897` before the new release commit. The working tree intentionally contains the notification, startup-restoration, `0.1.10` identity, test, and documentation changes plus the two new controller test files. Nothing is staged yet; the user explicitly authorized the `v0.1.10` commit, push, tag, and Release.
- Ignored `release-v0.1.10` contains the reviewed final candidate. The empty/incomplete first network-failed packaging directory and isolated inspection/cold-start directories remain ignored and will not be uploaded. All package QA processes exited.
- No unrelated tracked user change was altered, no `v0.1.8` or `v0.1.9` tag/asset was changed, and the locally excluded historical `CODEX_CONTEXT.md` was not treated as authoritative context.

## Next Recommended Action

1. Commit `Release v0.1.10`, create an annotated tag, and atomically push `main` plus the tag.
2. Upload exactly the reviewed five assets to a draft Release, verify all remote digests and sizes, then publish.
3. Record the final release identities and remote asset facts in this checkpoint and push the documentation-only checkpoint.
4. Preserve recovered-message isolation, unknown-order non-retry, durable journal identity, and the final OKX transmission guard. Startup connection and monitoring must never reconstruct live authorization.

## New Thread Bootstrap

1. Read `AGENTS.md`, then `docs/INDEX.md`, then `docs/CURRENT_STATE.md`.
2. Run `git status --short --branch`; inspect staged/unstaged state and continue from the current `v0.1.10` release step above.
3. Treat published Windows x64 `v0.1.9` and its exactly five public assets as immutable. Never overwrite or append assets to that release.
4. The post-version-bump `v0.1.10` candidate passed dependency, typecheck, 6-file/114-test focused, 15-file/281-test full, build, audit, packaging, artifact, and isolated cold-start checks. Continue from the commit/tag step; do not rerun private-service checks.
5. The user explicitly authorized the `v0.1.10` code/documentation commit, push, annotated tag, and GitHub Release. This does not authorize private-service access, real orders, unrelated changes, history rewriting, or modification of older releases.
