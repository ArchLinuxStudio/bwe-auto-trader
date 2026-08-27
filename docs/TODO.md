# TODO

This file contains only unfinished, executable work. Current limitations are explained in [`KNOWN_ISSUES.md`](KNOWN_ISSUES.md); stable constraints are in [`DECISIONS.md`](DECISIONS.md).

## P0 — Blocking

No known P0 for the current approximately 10 USDT, actively supervised, dedicated-sub-account scope.

## P1 — Next safety work

- [ ] Re-verify dynamic ChatGPT/Codex remaining-quota updates with a real authenticated account.
  - Dependency: Requires explicit authorization in the current Thread before Codex accesses a private ChatGPT login. Do not record account identifiers, tokens, request payloads, or other session data.
  - Scope:
    - Observe the initial remaining value and at least two 60-second refresh cycles without logging in again.
    - Confirm a real usage change or reset is reflected by notification or the next full poll, and a temporary failed read does not replace the last trusted value with a false reset.
    - Confirm logout stops polling and quota recovery does not automatically re-arm live trading.
  - Done when the authenticated UI changes without reconnecting and only non-sensitive timing/value behavior is recorded in `docs/CURRENT_STATE.md`.

- [ ] Re-verify Telegram target-channel receipt and AI-start latency in the user's real environment.
  - Dependency: Use the reviewed `v0.1.9` Windows package or a later build. Codex must not access a private Telegram session or ChatGPT login without explicit authorization in that current Thread.
  - Scope:
    - Test several new channel posts after an idle period while the application remains visibly connected.
    - Compare the channel publication time with the first timeline `received` state and the first `analyzing` state; retain only non-sensitive aggregate timing.
    - Confirm that a cursor-probe recovery is marked recovered and never submits an order, even if the post is recent and live trading was armed.
    - While no real order is permitted, simulate a temporary network interruption and confirm the application remains in automatic `reconnecting`, retries without restarting monitoring, and returns to `connected` after the network recovers.
    - Confirm recovery/catch-up messages remain non-trading and a later new live message is delivered normally after recovery. Retained-arm trading eligibility is covered by the injected no-order harness; do not claim it as real-environment verified without a separately authorized three-service safety test.
  - Done when repeated healthy-path or cursor-recovery posts begin AI in roughly ten seconds or less, no message waits near the previously observed two minutes, network recovery resumes listening without manual restart, and the verified environment/result is recorded without secrets.

- [ ] Perform the first user-supervised dedicated-sub-account end-to-end test.
  - Scope:
    - Requires explicit authorization in the current Thread before any private service connection or order.
    - Use an otherwise empty dedicated OKX sub-account with minimal expendable funds and the official OKX client visible throughout.
    - Verify at least one controlled LONG or SHORT signal path, REST pending state, private WS fill/terminal state, position refresh, explicitly confirmed `reduceOnly` close, disconnect locking, and redacted audit output. Exercise both directions only if the user accepts the additional real exposure.
  - Done when:
    - Every exchange state is cross-checked in the official OKX client by `instId`, `clOrdId`, and `ordId` where available.
    - No credential, session, verification code, token, or personal network data is captured in source, docs, issue text, or logs.
    - Any unknown result remains locked and is not retried.
    - The verified and unverified scenarios are recorded in `docs/CURRENT_STATE.md` without embedding private data.

- [ ] Implement the accepted cross-client recovery evidence model without enabling automatic absence release.
  - Dependency: The durable journal and fail-closed restart recovery are complete. The evidence model is accepted in `docs/DECISIONS.md`; its visibility-bound gate currently has no authoritative value, so negative evidence must remain locked.
  - Scope:
    - Add strict, complete ordinary order-history and fill-history query primitives with bounded pagination and exchange-time coverage.
    - Define and atomically migrate the strict journal schema before adding evidence fields. Preserve old v1 unresolved records as locked; an interrupted migration, unknown version, or record without a provable exchange-clock transmission lower bound must fail closed and cannot become absence-eligible.
    - Persist account/client/lifecycle/journal revisions, the exchange-clock interval and uncertainty, and multi-epoch endpoint coverage without storing secrets or a replayable request.
    - Keep a matching-account replacement client connected in an explicitly recovery-only state so private order updates and later GET evidence can converge. Enforce read-only behavior through a narrow service facade and the final main-process transmission guard while arm, credential replacement, open, and close remain blocked.
    - Establish the private-order subscription and bounded event buffer before the first GET snapshot. A subscription failure, handoff race, overflow, unclassified exposure event, disconnect, or reconnect invalidates the epoch and requires a new complete snapshot.
    - Do not add an absence resolution enum or delete a record from negative evidence until the consistency gate in `DECISIONS.md` is satisfied and reviewed.
  - Done when:
    - Exact order, ordinary pending, history, fills, positions, time, pagination, and retention gaps all fail closed on malformed or incomplete evidence.
    - Tests cover duplicate/reused `clOrdId`, missing/ambiguous exchange times, local clock jumps, full intermediate history pages, pagination caps/cursor loops, disconnect, origin-client loss, credential-save attempts, delayed visibility, GET/WS handoff, subscription failure, late fill, concurrent terminal evidence, revision changes, journal migration interruption, and restart during evidence collection.
    - The recovery-only client cannot call any POST, mutate, arm, or silently become a full trading connection. Exact terminal resolution after recovery-only mode disconnects/notifies and still requires the explicit full connection and arm flows.
    - The existing repeated cross-client not-found and position-effect-only tests remain locked.

- [ ] Add native runtime-license profiles and validate macOS/Linux packages.
  - Targets:
    - macOS x64/arm64 DMG.
    - Linux x64 and arm64 AppImage/deb as currently configured.
  - Done when for each claimed target:
    - `licenses/third-party-manifest.json` has an exact reviewed Electron/runtime profile and evidence hashes.
    - Dependency gate, build, native afterPack, archive/install, secure storage, proxy, Codex binary, UI, isolated cold start, native tray lifecycle, and tray-unavailable close-to-exit fallback pass on a native runner.
    - Platform signing/notarization status is stated accurately.
    - `README.md` and `docs/CURRENT_STATE.md` are updated without extrapolating Windows results.

## P2 — Product and operational improvements

- [ ] Serialize Telegram connect attempts in the main process.
  - Relevant code: `src/main/app-controller.ts`.
  - Done when a lifecycle reservation or single-flight prevents two concurrent `connectTelegram()` calls from constructing competing monitors, disconnect can cancel an in-flight connect, and a late loser is bounded-stopped without changing connection state or trading authorization.

- [ ] Display unresolved-operation provenance from the durable mutation journal.
  - Dependency: Read the existing `mutation-journal.v1.json` through the main-process store; do not create a second provenance store or expose the hashed account identity.
  - Done when the UI reads journal state to expose `clOrdId`, operation type, last verified state, and a safe read-only reconciliation action without exposing credentials.

- [ ] Clarify retained OKX exposure after disconnect.
  - Relevant code: `src/main/app-controller.ts`, `src/shared/types.ts`, `src/renderer/src/App.tsx`.
  - Done when the UI distinguishes “currently fetched zero positions” from “old account exposure not freshly verified” and still blocks unsafe credential changes.

- [ ] Explain live-lock revocation when saving identical OKX credentials.
  - Done when the user receives a clear reason that lifecycle reservation revoked authorization even though the account identity did not change.

- [ ] Configure application publisher signing.
  - Done when Windows installer/application publisher signatures verify and the documented macOS targets have Developer ID signing/notarization when published.

- [ ] Add an explicit, redacted log export and reconciliation report.
  - Done when exported diagnostics exclude all configured secret/session/token fields and give the user enough `clOrdId`/route/lifecycle context to investigate an unknown order.

- [ ] Expand Telegram login prompts only when a real account requires them.
  - Scope: Email-code or CAPTCHA flows are not currently supported.
  - Done when the flow is reproduced safely, implemented without bypassing Telegram security, and covered by injected tests.

- [ ] Build a deterministic end-to-end harness around injected Telegram, AI, OKX REST, and private WS transports.
  - Done when crash/reconnect/late-fill/malformed-ACK timelines can be replayed without real services and assert zero duplicate mutations.

## Scope-dependent — Do not start without a new user requirement

- [ ] If the user requests unattended operation or materially larger funds, design stop loss, take profit, maximum holding time, and exit-risk behavior as a separate safety project.
- [ ] If the user requests images, links, web pages, or attachments, design provenance and content extraction before adding them to the classifier.
- [ ] If the user requests autostart, a headless background service, or unattended operation beyond the accepted hide-to-tray behavior, redesign lifecycle, secure login availability, recovery, and user-visible risk controls first.
- [ ] If the user requires attribution between application and externally created positions, persist order provenance and reconcile external orders; do not infer ownership from the OKX position list.
