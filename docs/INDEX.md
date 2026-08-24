# Development Documentation Index

Start here when a new Thread has no chat history. Read only the documents relevant to the task.

## Reading routes

| Need | Read |
|---|---|
| Restore the exact checkpoint and choose the next step | [`CURRENT_STATE.md`](CURRENT_STATE.md) |
| Understand processes, modules, data flow, and safety boundaries | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| Understand why a constraint exists or which alternative is forbidden | [`DECISIONS.md`](DECISIONS.md) |
| Select unfinished work with a concrete completion definition | [`TODO.md`](TODO.md) |
| Diagnose a known limitation or reuse an environment workaround | [`KNOWN_ISSUES.md`](KNOWN_ISSUES.md) |
| Install, configure, run, or understand end-user risk | [`../README.md`](../README.md) |
| Learn the required Agent workflow | [`../AGENTS.md`](../AGENTS.md) |

## Stability classes

- Stable knowledge: `ARCHITECTURE.md` and `DECISIONS.md`. Update them only when architecture or an accepted decision changes.
- Current state: `CURRENT_STATE.md`. Refresh it at meaningful checkpoints; verify Git facts rather than assuming the snapshot is still current.
- Work tracking: `TODO.md` and `KNOWN_ISSUES.md`. Remove completed or disproven entries instead of retaining history.
- User-facing contract: `README.md`, `LICENSE`, and `THIRD_PARTY_NOTICES.txt`.

## Authoritative sources

Use one source for each class of fact:

| Information | Authority |
|---|---|
| Current branch, commit, dirty state, tags | Git itself; `CURRENT_STATE.md` is only a dated snapshot |
| Version, dependencies, build/package scripts | `package.json` and `package-lock.json` |
| Defaults, confirmation phrases, deadlines | `src/shared/defaults.ts` |
| IPC and snapshot contracts | `src/shared/types.ts`, `src/shared/ipc-channels.ts`, `src/shared/validation.ts`, `src/main/ipc.ts` |
| Runtime behavior | The relevant file under `src/`, backed by tests |
| Stable architecture and module ownership | `ARCHITECTURE.md` |
| Rationale and rejected approaches | `DECISIONS.md` |
| Current objective and verification | `CURRENT_STATE.md` |
| Remaining work | `TODO.md` |
| Active limitations and workarounds | `KNOWN_ISSUES.md` |
| Project license | `LICENSE` |
| Production dependency/license admission policy | `licenses/production-policy.json` |
| Third-party license inventory and evidence | `THIRD_PARTY_NOTICES.txt`, `licenses/third-party-manifest.json`, and `licenses/third-party/` |
| Public release assets | GitHub Release plus its `SHA256SUMS.txt`; local build folders are not authoritative by name alone |

## Documentation rules

- Do not copy large source sections into docs; link to the owning file and record intent or invariants.
- Keep transient failures out of `ARCHITECTURE.md`.
- Keep completed work out of `TODO.md`.
- Keep resolved bugs out of `KNOWN_ISSUES.md` unless they establish a decision that prevents recurrence.
- Do not duplicate test counts, hashes, or branch state outside `CURRENT_STATE.md`.
- A local `CODEX_CONTEXT.md` may exist from an older workflow. It is excluded from Git and is not an authority after this checkpoint.
