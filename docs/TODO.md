# TODO

This file contains only unfinished, executable work. Current limitations are explained in [`KNOWN_ISSUES.md`](KNOWN_ISSUES.md); stable constraints are in [`DECISIONS.md`](DECISIONS.md).

## P0 — Blocking

No known P0 for the current approximately 10 USDT, actively supervised, dedicated-sub-account scope.

## P1 — Next safety work

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

- [ ] Define a safe cross-client unknown-absence rule.
  - Dependency: The durable journal and fail-closed restart recovery are complete. Do not substitute another timer or weaken the persisted interlock.
  - Context: The current 30-second bounded absence logic is valid only on the originating client. A recovered new client records missing-order/position evidence but remains locked indefinitely without a matching terminal order.
  - Done when:
    - A written evidence model covers persistent identity, `expTime`, exchange consistency delay, order history, pending orders, position effects, and account/client revisions.
    - Release conditions do not rely on one not-found response or an arbitrary short timer.
    - Tests cover disconnect, origin-client loss, credential-save attempts, delayed exchange visibility, late fill, and malformed responses.
    - The accepted model is added to `docs/DECISIONS.md` before implementation is declared complete.

- [ ] Add native runtime-license profiles and validate macOS/Linux packages.
  - Targets:
    - macOS x64/arm64 DMG.
    - Linux x64 and arm64 AppImage/deb as currently configured.
  - Done when for each claimed target:
    - `licenses/third-party-manifest.json` has an exact reviewed Electron/runtime profile and evidence hashes.
    - Dependency gate, build, native afterPack, archive/install, secure storage, proxy, Codex binary, UI, and isolated cold start pass on a native runner.
    - Platform signing/notarization status is stated accurately.
    - `README.md` and `docs/CURRENT_STATE.md` are updated without extrapolating Windows results.

## P2 — Product and operational improvements

- [ ] Display unresolved-operation provenance from the durable mutation journal.
  - Dependency: Read the existing `mutation-journal.v1.json` through the main-process store; do not create a second provenance store or expose the hashed account identity.
  - Done when the UI reads journal state to expose `clOrdId`, operation type, last verified state, and a safe read-only reconciliation action without exposing credentials.

- [ ] Clarify retained OKX exposure after disconnect.
  - Relevant code: `src/main/app-controller.ts`, `src/shared/types.ts`, `src/renderer/src/App.tsx`.
  - Done when the UI distinguishes “currently fetched zero positions” from “old account exposure not freshly verified” and still blocks unsafe credential changes.

- [ ] Explain live-lock revocation when saving identical OKX credentials.
  - Done when the user receives a clear reason that lifecycle reservation revoked authorization even though the account identity did not change.

- [ ] Configure application identity and signing.
  - Done when a non-default application icon is packaged, Windows installer/application publisher signatures verify, and the documented macOS targets have Developer ID signing/notarization when published.

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
- [ ] If the user requests background/autostart operation, redesign lifecycle, secure login availability, recovery, and user-visible risk controls first.
- [ ] If the user requires attribution between application and externally created positions, persist order provenance and reconcile external orders; do not infer ownership from the OKX position list.
