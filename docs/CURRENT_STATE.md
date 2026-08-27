# Current State

Checkpoint date: 2026-08-27, Asia/Shanghai.

## Current Objective

Package, commit, tag, and publish the accumulated custom application icon and fail-closed Telegram automatic-reconnect work as the Windows x64 `v0.1.9` release. The user explicitly authorized the code/documentation commit and Release in this task. Published `v0.1.8` assets remain immutable, and release verification must not access private Telegram, ChatGPT, or OKX services or place an order.

## Current Status

- Version: `0.1.9`.
- Branch: `main`.
- Release target: `v0.1.9`; the reviewed local release candidate is complete and Git publication is the remaining step at this checkpoint.
- Source baseline: published [`v0.1.8`](https://github.com/ArchLinuxStudio/bwe-auto-trader/releases/tag/v0.1.8), commit `bf1449b5a4f55aeb27aa1dab4f4561408dc373da`. Local and remote `main` were aligned there before the authorized release work began.
- The `v0.1.9` candidate adds `build/icon.svg` as the electron-builder application icon. The final application EXE, Portable ZIP application, and NSIS installer embed the same reviewed custom icon.
- The candidate retains an existing manual arm only as suspended same-monitor intent across a recoverable Telegram network outage. It keeps retrying, restores readiness only after bounded connection/catch-up/authorization verification, and resumes authorization solely for later new live messages. Startup/recovery messages remain non-trading and pre-recovery tokens remain invalid.
- Telegram status/error/message callbacks are bound to their owning monitor identity. A stopped monitor cannot overwrite, lock, or resume a replacement generation, and a successful recovery publishes `connected` only after `liveTradingReadiness.ready` is true. Recovery uses direct `updates.getState` error classification, so only explicit auth-key/session loss is fatal while auth-probe network failures continue retrying. Errored/stopped monitors are retired before saved-config reconnect.
- Explicit `UnauthorizedError`/`AuthKeyError` is normalized to fatal authorization loss from any recovery stage, including connect and catch-up before the final authorization probe.
- The renderer displays `实盘重连中` while the retained arm is suspended instead of claiming that signals can currently submit orders.
- The final Windows package, artifact inspection, checksums, and isolated cold start pass. Commit, annotated tag, atomic push, GitHub asset upload, and remote verification remain pending.
- Codex made no real Telegram, ChatGPT, or OKX private call and placed no real order during this release work.

## Completed

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

## In Progress

The requested implementation and final local release candidate are complete. These release actions remain in progress:

1. Stage and review only the intended source, tests, icon, license metadata, and documentation; commit as `Release v0.1.9`.
2. Create the annotated `v0.1.9` tag, atomically push `main` and the tag, create a draft GitHub Release with exactly five named assets, verify remote hashes/sizes/tag identity, and publish it.
3. Record the final release/tag/asset state in this file and push the post-release documentation checkpoint.
4. Real authenticated Telegram/ChatGPT and any OKX test remain separately gated by explicit private-service/order authorization.

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
| `src/main/index.ts` | Electron startup, tray ownership, window restoration, and shutdown wiring |
| `src/main/window-tray.ts` | Close/reveal/menu helpers and repeated-quit-safe shutdown coordination |
| `src/main/services/telegram.ts` | Live delivery, target cursor probes, bounded atomic recovery, and no-token recovered previews |
| `src/main/services/chatgpt.ts` | Codex protocol, classifier lifecycle, quota notifications, and periodic complete reads |
| `src/main/services/mutation-journal.ts` | Strict durable mutation state and identity/evidence persistence |
| `src/main/services/okx.ts` | OKX request validation and final mutation-transmission boundary |
| `src/main/app-controller.ts` | Main-process authority for services, journal recovery, credentials, and trading gates |
| `src/main/services/signal-coordinator.ts` | Signal timeline, AI/order gates, recovery isolation, and pending-order interlocks |
| `src/renderer/src/App.tsx` | Timeline/status UI, reconnect-suspension presentation, and dynamic remaining-quota presentation |
| `src/renderer/src/styles.css` | Renderer visual states, including the amber suspended-live indicator |
| `tests/telegram-monitor.test.ts` | Telegram latency-recovery, ordering, timeout, and generation-isolation coverage |
| `tests/unit/app-controller-okx-route.test.ts` | Controller capability, service-lifecycle, stale-monitor, and final-authorization coverage |
| `tests/unit/chatgpt.test.ts` | Quota parsing, cadence, timeout, single-flight, logout, and close coverage |
| `tests/unit/window-tray.test.ts` | Close-to-hide, fallback, restore/menu, and shutdown-gate coverage |
| `tests/unit/okx.test.ts` | Transmission boundary and strict exchange-evidence validation coverage |
| `tests/unit/mutation-journal.test.ts` | Durable lifecycle, identity, expiry, serialization, and redaction coverage |

## Current Implementation

- The Electron renderer uses the frozen preload API; `AppController` in the main process remains the authority for credentials, service lifecycles, live capabilities, positions, close operations, and durable mutation evidence. Renderer state is never a trading security boundary.
- Telegram live callbacks publish immediately. Independently, a five-second target-channel cursor probe has a four-second RPC deadline. A newer cursor closes readiness and exposes a sticky recovered/no-token preview before complete atomic catch-up; recovered messages can run AI but can never order. Confirmed network loss publishes `reconnecting` and repeats bounded recovery on later health cycles. The same in-memory arm remains suspended, not recreated; recovery emits readiness-backed `connected` after full verification, and only later fresh live ingress can regain authorization.
- While ChatGPT is authenticated, rolling quota notifications update immediately and one recursive timer performs a complete rate-limit read every 60 seconds. All triggers share one 10-second-bounded request. Failure preserves the latest trusted value; logout/close cancel future scheduling and isolate late results; recovery never re-arms live trading.
- With a usable native tray, title-bar close hides the existing window. Tray activation/show, second-instance activation, and platform activation share one guarded restore-or-create path. Explicit quit disables restoration, removes IPC/tray state, waits for startup, disposes the controller once, and then permits final Electron quit. Without a usable tray, Windows/Linux retain normal close-to-exit behavior.
- Electron-builder uses `build/icon.svg` as the explicit application icon and converts it to each target's native format. The Windows application and installer resources were verified with the generated multi-size ICO; installer-created shortcuts are configured to inherit the application icon. The existing runtime tray image and lifecycle code are unchanged.
- Every OKX mutation crosses the durable `prepared` then immutable `transmitting` journal boundary before the final guarded POST. ACK, private-stream, and read-only evidence are serialized by the controller. Unknown results are never retried, and replacement-client absence evidence cannot clear an unresolved mutation.

## Current Problems

There is no known P0 blocker for the accepted approximately 10 USDT, actively supervised, dedicated-sub-account scope.

- The real Telegram/proxy/ChatGPT path has not been retested after the `v0.1.9` automatic-resume changes. Low-latency receipt and repeated reconnect/resume are proven only with injected transports.
- Two synthetic concurrent `connectTelegram()` IPC calls can still cross the initial empty-monitor check before credential read completes and create redundant monitor work. The renderer serializes its action and monitor identity prevents a trading-authority bypass; a main-process single-flight remains tracked in `docs/TODO.md`.
- Dynamic quota refresh is proven with an injected Codex app-server transport only; no authenticated account was observed across multiple live cycles.
- No real dedicated-sub-account end-to-end order/close test has been authorized or performed.
- A cross-client unknown can remain locked indefinitely. Automatic absence release remains intentionally disabled; repeated not-found or position-effect evidence is not sufficient.
- The `v0.1.9` Windows candidate has the custom icon but remains unsigned, so SmartScreen may warn. macOS/Linux package/runtime-license profiles, cold starts, native icon conversion, and tray lifecycle/fallback behavior are not release-verified.

See `docs/KNOWN_ISSUES.md` for symptoms, exclusions, workarounds, and investigation directions. See `docs/TODO.md` for executable completion criteria.

## Verification State

This task reran the Windows gates and built a clean final `v0.1.9` candidate after the last authorization-classification source change. No check made a private-service call. The Explorer tray/menu/quit result is retained as an explicitly identified `v0.1.8` lifecycle result because this release did not change tray behavior beyond a comment.

| Verification | State |
|---|---|
| `npm.cmd run check:dependencies` | Passed: 16 installed production packages satisfy the reviewed policy |
| `npm.cmd run typecheck` | Passed: node and renderer TypeScript projects |
| `npm.cmd test` | Passed: 13 files, 260 tests |
| `npm.cmd run build` | Passed: dependency, typecheck, electron-vite, and provenance gates |
| Lint | Not configured; there is no lint script |
| `npm audit --omit=dev` | Passed with process-local system CA: 0 known production vulnerabilities |
| `npm.cmd run package:win` | Passed from a clean final output directory with process-local system CA: Windows x64 NSIS and ZIP; afterPack verified 16 packaged dependencies and runtime notices |
| Windows artifact inspection | Passed: generated ICO has seven 32-bit sizes from 16 through 256 px; icons extracted from the unpacked application, NSIS installer, and ZIP application are byte-identical; ZIP contains 103 files; package version is `0.1.9`; unpacked and ZIP ASAR hashes match |
| Isolated packaged cold start | Passed with fresh repository-local ignored user data: audit recorded only `application_started`, version `0.1.9`, live unarmed, zero unresolved mutations, and a healthy journal. No private service started; the exact QA process group was terminated after inspection and no process remained |
| `npm.cmd test -- tests/telegram-monitor.test.ts tests/unit/app-controller-okx-route.test.ts` | Passed: 2 files, 67 tests; includes repeated failed reconnect then success, direct auth-RPC network/fatal classification, catch-up-stage fatal authorization loss, readiness-backed connected status, errored-monitor replacement, retained-arm suspension/resume, stale-monitor isolation, and old/new recovery-token behavior |
| Focused Telegram/coordinator checks | Passed: missed-push preview at the first five-second tick, AI start inside the injected ten-second window, permanent non-trading recovery, bounded timeouts, FIFO, and generation isolation |
| Focused tray lifecycle checks | Passed: 9/9 tests rerun in this Thread, plus the prior packaged close/hide, process-retention, second-launch, and minimized-restore checks |
| Focused ChatGPT quota checks | Passed: 25 total tests, including cadence, timeout/retry, single-flight, logout, close isolation, and recovery without auto-arm |
| Windows signatures | Confirmed limitation on the final `v0.1.9` candidate: Setup/application `NotSigned`; prior inspection found the bundled OpenAI Codex executable has a valid OpenAI signature |
| Explorer tray menu/explicit quit cleanup | Previously passed via Windows UI Automation on build 26200 against the exact published `v0.1.8` Portable extraction; tray behavior is unchanged in `v0.1.9`, but this native UIA check was not rerun against the new package |
| Real Telegram/ChatGPT/OKX private integration | Not verified |
| Real order open/close | Not verified |
| macOS/Linux package, cold start, and native tray lifecycle/fallback | Not verified |

Final `v0.1.9` release-candidate asset facts:

| Asset | Size | SHA-256 |
|---|---:|---|
| `BWE.Auto.Trader-Setup-0.1.9-x64.exe` | 185,011,384 bytes | `DFEC0C0EF612C3F493FA6D3A9B0BEB4827AED627B30979CA4AF3E675F5556F8B` |
| `BWE.Auto.Trader-Portable-0.1.9-x64.zip` | 263,912,285 bytes | `2276A4D6BE2710902C0C0C87D61BD289C3BE28FC4F9FDBB4142C086C998EC750` |
| `LICENSE` | 3,911 bytes | `E35451072886B5799DAC567F5764AEEC6BBD66D75068EA52169E3931263E886A` |
| `SHA256SUMS.txt` | 207 bytes | `6CBC801A7E3A9CDB49CA724F5E92F5CD9619A0FEA0198C3AA1BE9A2B8F4B1C3E` |
| `THIRD_PARTY_NOTICES.txt` | 8,098 bytes | `CB5853F3BBD8CFFF83266F9AE08582455DC92348C6825ABE09F2B8A2C9B8C0FE` |

## Git Workspace State

- `main`, `origin/main`, and the peeled `v0.1.8` tag were aligned at `bf1449b5a4f55aeb27aa1dab4f4561408dc373da` when release work began.
- The current release candidate remains unstaged while the final diff is reviewed. It includes the icon, version/license metadata, reconnect/controller/renderer changes, tests, and authoritative documentation. `build/icon.svg` is the only untracked source asset and must be explicitly included.
- Ignored final package and QA directories remain outside Git. The first pre-fix package was moved to the explicitly named ignored `release-v0.1.9-pre-fix-qa`; only the later clean `release-v0.1.9` assets may be uploaded. All QA application processes exited.
- No unrelated tracked user change was altered, no `v0.1.8` tag or asset was changed, and the locally excluded historical `CODEX_CONTEXT.md` was not treated as authoritative context.

## Next Recommended Action

1. Complete the authorized staged-diff review, commit `Release v0.1.9`, create an annotated tag, and atomically push `main` plus the tag without changing `v0.1.8`.
2. Create a draft GitHub Release using exactly the five candidate assets above, verify tag identity, remote size/digest, checksums, and release notes, then publish it.
3. Update this checkpoint with the final release commit/tag object/URL and remote verification, commit that documentation-only checkpoint, and push `main`.
4. Only with separate explicit private-service authorization, perform the no-order Telegram/ChatGPT real-environment checks in `docs/TODO.md`; any real OKX order remains separately gated.

## New Thread Bootstrap

1. Read `AGENTS.md`, then `docs/INDEX.md`, then `docs/CURRENT_STATE.md`.
2. Run `git status --short --branch`, inspect any staged/unstaged state, and continue only from the explicit `v0.1.9` release step recorded above.
3. The final local candidate is Windows x64 only and has exactly five intended public assets. Never glob-upload either release directory; the `pre-fix-qa` package is rejected.
4. The current injected baseline is 13 files/260 tests; focused reconnect/controller coverage is 67 tests. Dependency, typecheck, build, package, audit, artifact, icon, and isolated cold-start gates pass. Real Telegram reconnect remains unverified.
5. The user explicitly authorized this `v0.1.9` code/documentation commit and Release. That does not authorize private-service access, real orders, unrelated changes, history rewriting, or modification of `v0.1.8`.
