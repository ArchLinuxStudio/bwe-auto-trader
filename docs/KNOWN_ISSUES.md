# Known Issues and Limitations

Only current limitations, reproducible environment problems, and active workarounds belong here. Resolved bugs are retained only in [`DECISIONS.md`](DECISIONS.md) when their lesson constrains future work.

## Telegram low-latency and automatic reconnect need real-environment re-verification

Symptoms: In a 2026-08-25 user test of the published `v0.1.7` Windows build, a target-channel post appeared in the signal timeline only after approximately two minutes.

Impact: A fresh announcement can exceed both the desired roughly ten-second receive/analyze window and the trading freshness deadline before the application sees it.

Cause: The tagged implementation checked connection state and generic Telegram authorization every five seconds, but did not compare the target channel's remote message cursor with the locally delivered cursor. This is a confirmed detection gap. The exact private-network or proxy condition that delayed the live push has not been reproduced by automated tests and must not be guessed from local source alone.

Current mitigation in `v0.1.8`: The application performs a four-second-bounded target-channel cursor probe every five seconds. A missed post becomes an immediate no-token recovery preview, then enters the existing complete atomic catch-up and AI path as permanently non-trading. Target-channel, catch-up, authorization, forced-disconnect, and reconnect timeouts fail closed before diagnostics and cannot permanently occupy the health/recovery single-flight; obsolete stopped-client failures are isolated from a later monitor generation. Injected tests show preview and AI start inside the ten-second acceptance window, but do not prove real Telegram or ChatGPT latency.

Additional mitigation in `v0.1.9`: A confirmed recoverable network outage keeps the existing manual arm only as suspended same-monitor intent. Failed reconnects are retried on later health cycles; readiness stays closed, old message tokens are invalidated, and catch-up messages remain permanently non-trading. The final `connected` event is emitted only after readiness is actually open, at which point later new live messages can use the retained arm. The final authorization check calls `updates.getState` directly so network/timeout failures remain recoverable; only an explicit teleproto `UnauthorizedError`/`AuthKeyError` is fatal, stops retry, and revokes the arm. Status/error/message callbacks are monitor-identity guarded so a stopped instance cannot lock or resume its replacement, and the saved-config connect action retires an errored/stopped instance before replacement. Injected tests cover two failed connects followed by success, both authorization-probe error classes, errored-monitor replacement, and controller token behavior, but no private Telegram/proxy interruption has been exercised.

Next direction: After installing the reviewed `v0.1.10` package or a later reviewed build, repeat a user-supervised Telegram/ChatGPT-only test. Measure channel publication, timeline `received`, and AI `analyzing` times, then temporarily interrupt and restore the network while live ordering remains prohibited. Retain only aggregate timing/state behavior; never record credentials, session data, message contents, or personal network details. Keep the issue open until both low-latency receipt and repeated automatic reconnect are verified in the real environment.

## Dynamic ChatGPT quota refresh needs authenticated verification

Symptoms: `v0.1.8` applies rolling quota notifications and performs a complete bounded read every 60 seconds while authenticated. Injected tests prove timer updates, single-flight behavior, timeout preservation/retry, login/logout lifecycle, exhaustion recovery, and late-close isolation, but no real ChatGPT account was accessed for this change.

Impact: Until a user-authorized real-account check is performed, the live Codex app-server's notification timing and rate-limit snapshot behavior cannot be claimed as integration-verified even though the local scheduling and UI propagation paths pass.

Current workaround: The UI labels the value as updated every minute and retains the last trusted snapshot on a read failure. Treat it as usage guidance rather than a billing or authorization guarantee; the separate fail-closed exhausted state remains the trading authority.

Next direction: Follow the dedicated P1 item in `TODO.md`, observe at least two poll cycles without relogin, and record only non-sensitive results.

## Cross-client unknown may remain locked indefinitely

Symptoms: If the client that originated an ambiguous mutation is gone—including after process restart—the durable record remains locked when a replacement client sees no matching order. A position effect without an exact matching terminal order is recorded as evidence but also does not release the recovered record. While any recovered record remains unresolved, an automatic or manual full connection attempt fails before creating the private WebSocket, so the application does not continuously observe that order's later terminal state.

Impact: Automation can remain safely unavailable until a human establishes the exchange outcome.

Cause: The existing bounded absence rule depends on evidence from the same originating client. The accepted cross-client model requires complete order/pending/history/fill evidence, durable client/account/journal revisions, and two consistency barriers. The reviewed OKX API contract does not publish a finite maximum visibility delay or a shared cross-endpoint snapshot revision, so the automatic absence gate intentionally has no enabled value.

Already excluded: One not-found response, a short timer, or credential replacement is not sufficient proof. Those approaches can miss delayed exchange visibility or a late fill.

Current workaround: Do not retry, switch credentials to clear state, edit the journal, or assume absence. Re-run explicit GET-only recovery only with the matching sub-account, verify the outcome in the official OKX client, and remain locked if evidence is absent or conflicts.

Next direction: Implement the collection-only, recovery-stream portion of the accepted model in `TODO.md`. Negative evidence must remain diagnostic and locked unless `DECISIONS.md` is later updated with an authoritative consistency bound and a durable certificate/tombstone implementation.

## No real private-service end-to-end verification

Symptoms: All automated tests use mocks/injected transports. Windows build/cold-start verification proves packaging and process startup, not Telegram delivery, ChatGPT account behavior, OKX private connectivity, saved-configuration restoration against real services, or an OKX real order lifecycle.

Impact: The first real approximately 10 USDT order and close may expose integration behavior not represented by mocks.

Current workaround: Only perform a user-authorized, dedicated-sub-account, minimal-fund, actively supervised test while the official OKX client is open. Never use a real private call as an unattended smoke test.

Next direction: Follow the corresponding private-service P1 item in `TODO.md` and record only non-sensitive results.

## Not suitable for unattended operation

Symptoms: There is no automatic stop loss, take profit, maximum holding time, time-based close, operating-system login autostart, headless supervision, or exit-time close. Opening the application can restore valid saved connections and start monitoring after all three services connect, but this does not create live authorization or add unattended-operation safeguards. Emergency stop and application exit do not close an existing position. Hiding the window to the tray keeps the existing process and live state running.

Impact: Exposure can remain after the application stops or the signal pipeline becomes unavailable.

Cause: This is the user-confirmed initial scope, not an unfinished hidden feature.

Current workaround: Use minimal funds, active human supervision, and the official OKX client. Use the independent manual `reduceOnly` close path when appropriate.

Next direction: Only design automated exit risk if the user explicitly expands scope.

## macOS and Linux are not release-verified

Symptoms: Package scripts exist, but native packages, secure storage, proxy behavior, Codex platform binaries, UI, tray lifecycle/fallback, signing, and cold start have not been verified. The reviewed Electron runtime manifest currently has a Windows x64 profile only.

Impact: A non-Windows dependency check/package may fail closed because no unique reviewed runtime profile exists, and the application must not be advertised as having verified three-platform binaries.

Current workaround: Treat macOS/Linux as source/build intent only.

Next direction: Build each target on a native runner and complete the target-specific compliance profile described in `TODO.md`.

## OKX disconnect UI can understate retained exposure uncertainty

Symptoms: After disconnect, the visible current position list can be empty while the controller retains old-account exposure facts and blocks unsafe credential changes.

Impact: The safety behavior is correct, but the user may interpret “0 positions” as a fresh exchange fact.

Current workaround: Use the connection state and official OKX client as the source of current exposure after disconnect. Do not weaken the retained internal block.

Next direction: Add an explicit “old account exposure not freshly verified” state instead of clearing safety facts.

## Saving identical OKX credentials can revoke live authorization without a clear explanation

Symptoms: A repeated save of the same account does not switch accounts or clear order state, but lifecycle reservation revokes the live-open capability.

Impact: The user may think the application locked itself unexpectedly.

Cause: Safety revocation happens at the start of an account lifecycle operation; UI messaging does not distinguish an identical save.

Current workaround: Re-arm manually only after all connections and safety blockers are healthy.

Next direction: Improve the notification without removing lifecycle revocation.

## Windows artifacts are unsigned

Symptoms: Windows reports the application and installer as `NotSigned`; SmartScreen may warn. The bundled OpenAI Codex executable may have a valid upstream signature, but that does not sign this application.

Current state: `v0.1.9` and the reviewed `v0.1.10` Windows artifacts use the custom BWE application icon. The `v0.1.10` application EXE and NSIS installer remain `NotSigned`. The historical `v0.1.8` assets remain immutable and retain the default Electron icon.

Impact: The custom icon improves application identity, but the package still has lower installation trust until publisher signing is configured.

Current workaround: Verify the release SHA-256 values in `CURRENT_STATE.md`/`SHA256SUMS.txt` and communicate the warning accurately.

Next direction: Add project publisher signing before treating distribution as polished.

## Selected system notifications need packaged Windows verification

Symptoms: Injected tests verify selection, reconnect-episode deduplication, notification-setting suppression, privacy-safe text, and delivery-failure isolation. This task has not yet observed the resulting native Windows toast or click-to-restore behavior from either the installed NSIS package or the Portable ZIP. Operating-system notification permissions and focus modes may suppress display even when Electron reports notification support.

Impact: The in-application signal timeline and notification history remain authoritative. A hidden-window user must not treat receipt of—or failure to receive—a system notification as proof of Telegram continuity, AI execution, OKX submission, or order state.

Current workaround: Keep desktop notifications enabled when desired, but verify all trading state in the application and OKX. The four system notification bodies intentionally omit channel and trade details.

Next direction: Test the reviewed `v0.1.10` NSIS and Portable packages separately while hidden to tray, including click restoration, one-per-outage reconnect behavior, disabled-notification suppression, and an injected order-start event that makes no private-service call.

## Telegram and content support is intentionally narrow

Symptoms:

- Only text and caption-like message content is analyzed; images, OCR, linked pages, and attachments are not fetched.
- Standard phone number, code, and 2FA password prompts are implemented. Rare email-code or CAPTCHA flows are not.
- Monitoring exists only while the application process is open. When all three valid saved configurations restore successfully at startup it begins automatically; otherwise the user must complete the connections and start it manually. A window hidden to the tray still counts as open.

Impact: Some posts or unusual login flows are safely skipped or fail instead of being analyzed/bypassed.

Current workaround: Do not infer content that was not extracted and do not bypass Telegram security. Handle unsupported login requirements through the official Telegram flow.

Next direction: Expand only after a concrete user requirement and safe reproduction.

## Positions cannot be attributed exclusively to this application

Symptoms: OKX returns the dedicated sub-account's complete SWAP position set, including positions that might come from the official client or another tool.

Impact: Calling these “positions created by this application” would be false and can hide external activity.

Current workaround: Keep UI and docs wording as “all SWAP positions in the dedicated sub-account.”

Next direction: Persist order provenance and reconcile external orders if attribution becomes a requirement.

## Packaging and license boundaries require artifact-level verification

Symptoms:

- Historical or intermediate build artifacts can carry a different dependency closure; a filename or local directory name is not provenance evidence.
- Electron/Chromium runtime notices include LGPL components even though the application npm/ASAR production closure no longer contains the retired GramJS GPL chain.

Impact: Renaming or uploading a historical/intermediate artifact could publish the wrong dependency set. Claiming the complete Electron bundle is free of every GPL-family/weak-copyleft component would be inaccurate.

Current workaround: Use the exact current release identity and hashes in `CURRENT_STATE.md`, and use the accepted license boundary in `DECISIONS.md`. Preserve project/third-party/Electron/Chromium license files. Never glob-upload a local release directory.

Already tried: Putting the same NOTICE sources in both ASAR `files` and `extraFiles` failed because electron-builder excludes duplicate extra-file sources from ASAR; afterPack correctly reported `app.asar does not contain THIRD_PARTY_NOTICES.txt`.

Current solution: Keep visible compliance files at the application/ZIP root via `extraFiles` and validate them there in `scripts/after-pack-license-check.cjs`.

## Windows build access can fail because of local network/cache behavior

Symptoms and reproducibility:

- International downloads may fail with `unable to verify the first certificate` on this machine.
- Electron cache relocation has intermittently failed with `rename EPERM`.

Already tried: Repeating the same network/cache operation without changing the process environment was not reliable. Global proxy changes are unnecessary and undesirable.

Current workarounds:

```powershell
$env:NODE_USE_SYSTEM_CA='1'
$env:HTTP_PROXY='http://127.0.0.1:7890'
$env:HTTPS_PROXY='http://127.0.0.1:7890'
```

If the pinned local Electron distribution is already installed and verified:

```powershell
.\node_modules\.bin\electron-builder.cmd --win nsis zip --x64 --config.electronDist=node_modules/electron/dist
```

Next direction: Keep workarounds process-local. Do not turn them into application routing logic or global machine settings.
