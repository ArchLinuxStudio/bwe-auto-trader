# Agent Development Entry Point

This repository must be maintainable without chat history. Repository files and Git are the persistent development context.

## Before substantial changes

1. Read `docs/INDEX.md`.
2. Read `docs/CURRENT_STATE.md`.
3. Read only the architecture, decisions, TODO, or known-issues sections relevant to the task.
4. Run `git status --short --branch` before modifying files and preserve unrelated user changes.
5. Verify claims against code, tests, and Git when they may have changed since the checkpoint.

The locally excluded `CODEX_CONTEXT.md`, if present, is historical input only. It is not an authoritative project document.

## Non-negotiable safety rules

- This application can place real OKX perpetual-swap orders. Do not access private APIs, stored credentials, Telegram sessions, ChatGPT tokens, or place orders unless the user explicitly authorizes that action in the current task.
- Automated tests must use mocks or injected transports. Never make a private-service call as a test shortcut.
- Never log, document, commit, or expose API keys, secrets, passphrases, verification codes, sessions, tokens, audit data, or personal machine paths.
- The Electron main process is the trading authority. Renderer state and disabled buttons are not security controls.
- Preserve the fail-closed invariants documented in `docs/ARCHITECTURE.md` and `docs/DECISIONS.md`, especially message-time authorization, recovered-message isolation, unknown-order non-retry, and the final OKX transmission guard.
- Do not infer permission for a materially different action. In particular, a request to review or document does not authorize implementation, real trading, commits, pushes, releases, or deletion.
- Do not commit or push unless the user has authorized it. Do not rewrite history or use destructive Git commands to remove user work.

## Standard verification

Use the existing scripts rather than inventing substitutes:

```powershell
npm.cmd run check:dependencies
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

There is currently no lint script. Report lint as `Not configured`; do not claim it passed.

Packaging commands:

```powershell
npm.cmd run package:win
npm.cmd run package:mac
npm.cmd run package:linux
npm.cmd run package:linux:arm64
```

Build macOS/Linux artifacts on native runners and add a reviewed runtime-license profile before claiming platform support. See `docs/TODO.md` and `docs/KNOWN_ISSUES.md`.

If international package/build access fails in the current PowerShell, use process-local proxy variables only:

```powershell
$env:NODE_USE_SYSTEM_CA='1'
$env:HTTP_PROXY='http://127.0.0.1:7890'
$env:HTTPS_PROXY='http://127.0.0.1:7890'
```

Do not turn that workaround into a global system configuration.

## Documentation ownership

- `docs/ARCHITECTURE.md`: stable structure and safety boundaries.
- `docs/DECISIONS.md`: accepted decisions and rejected alternatives.
- `docs/CURRENT_STATE.md`: checkpoint snapshot, verification, Git state, and the next action.
- `docs/TODO.md`: only unfinished, executable work.
- `docs/KNOWN_ISSUES.md`: current limitations and active workarounds.
- `README.md`: user-facing setup, risk, scope, and license summary.

When behavior changes, update the smallest authoritative document in the same task. Do not duplicate current-state facts across several files.
