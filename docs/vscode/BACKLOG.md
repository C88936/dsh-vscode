# Backlog

Current readiness, implementation status, blockers, and verification evidence
live in [READINESS_HANDOFF.md](READINESS_HANDOFF.md). The checklist below
predates the current implementation and is not a status source.

Status: `todo` / `doing` / `blocked` / `done`.

## P0 — Make the fork real

| ID | Task | Status | Acceptance |
| --- | --- | --- | --- |
| V0.1 | Install DSH workspace dependencies | todo | `pnpm install` succeeds |
| V0.2 | Build the DSH packages needed by an app | todo | typecheck/build succeeds |
| V0.3 | Run an existing non-web DSH app entry | todo | host boots without HTTP |
| V0.4 | Record Node/pnpm/DSH versions | todo | versions in `docs/vscode/ENVIRONMENT.md` |

## P1 — VS Code host

| ID | Task | Status | Acceptance |
| --- | --- | --- | --- |
| V1.1 | Add `apps/vscode` extension manifest | todo | VS Code recognizes the extension |
| V1.2 | Add in-process DSH host bootstrap | todo | DSH services live in extension host |
| V1.3 | Add lifecycle/disposal | todo | deactivate drains the host |
| V1.4 | Prove no sidecar/web server | todo | process list has no `dsh web`/SDK child |
| V1.5 | Add environment/secret configuration | todo | no secrets in webview state |

## P2 — Webview shell

| ID | Task | Status | Acceptance |
| --- | --- | --- | --- |
| V2.1 | Add webview container and CSP | todo | DSH shell loads once |
| V2.2 | Bundle DSH client packages | todo | no missing module at runtime |
| V2.3 | Bridge VS Code theme tokens | todo | light/dark render correctly |
| V2.4 | Reload lifecycle | todo | reload recreates one host |

## P3 — Agent/session

| ID | Task | Status | Acceptance |
| --- | --- | --- | --- |
| V3.1 | Composer → DSH session | todo | prompt reaches DSH |
| V3.2 | First tool execution | todo | tool result rendered |
| V3.3 | DSH session persistence | todo | reload restores transcript |
| V3.4 | Approval mapping | todo | single-use, execution-time decision |
| V3.5 | Cancellation/stop | todo | no late publish after stop |

## P4 — VS Code adapters

| ID | Task | Status | Acceptance |
| --- | --- | --- | --- |
| V4.1 | Workspace/file provider | todo | read/write real workspace |
| V4.2 | Terminal/process provider | todo | VS Code terminal backend |
| V4.3 | Editor/diagnostics provider | todo | open file/location |
| V4.4 | Settings/secret provider | todo | SecretStorage only |
| V4.5 | File checkpoints | todo | restore is per-file and explicit |

## P5 — Plugins

| ID | Task | Status | Acceptance |
| --- | --- | --- | --- |
| V5.1 | Official DSH plugin manager | todo | official page renders |
| V5.2 | Local profile inventory | todo | installed rows appear |
| V5.3 | Enable/disable/uninstall | todo | host-side effect verified |
| V5.4 | Local path/Git/tarball install | todo | no registry required |
| V5.5 | Private registry | todo | LAN registry works |
| V5.6 | No DSH web service | todo | no server process |

## P6 — Settings/parity

| ID | Task | Status | Acceptance |
| --- | --- | --- | --- |
| V6.1 | DSH General items | todo | theme/language/shortcuts/version/dev tools |
| V6.2 | Models | todo | provider/model roles |
| V6.3 | Built-in plugins read-only | todo | real host inventory |
| V6.4 | Agent presets | todo | only when Host serves it |
| V6.5 | No second settings shell | todo | one settings surface |

## P7 — Release

| ID | Task | Status | Acceptance |
| --- | --- | --- | --- |
| V7.1 | VSIX packaging | todo | clean install |
| V7.2 | First-run/upgrade/uninstall | todo | no stale process or state |
| V7.3 | Real VS Code acceptance | todo | prompt/tool/approval/reload/plugins |
| V7.4 | LAN smoke | todo | no public service required |

## Explicitly not in this backlog

- MesCode Docker visual-test repairs.
- MesCode corrupted documentation.
- MesCode plugin panel/community-kernel work.
- Roo/Zoo compatibility.
- A second plugin registry.
