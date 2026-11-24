# Roadmap

Each phase has a hard acceptance boundary. Later phases do not start on a
placeholder implementation that only renders a shell.

## Phase 0 — Fork builds

Tasks:

- Install the DSH workspace dependencies.
- Build the DSH packages needed by a desktop/extension application.
- Record the exact Node, pnpm and DSH version.
- Keep the upstream test/typecheck baseline.

Acceptance:

```text
pnpm install succeeds
DSH typecheck/build succeeds
the fork can run its existing app entry locally
```

## Phase 1 — In-process DSH host

Tasks:

- Identify the DSH application boot entry that does not require an HTTP server.
- Add `apps/vscode` as a VS Code extension host.
- Boot Cordis and the DSH agent/session/tool services inside the extension host.
- Provide a process-lifecycle owner for activation and disposal.

Acceptance:

```text
VS Code activates the extension
DSH services are live in-process
no dsh web / sidecar / SDK subprocess is started
deactivation drains and disposes the application
```

## Phase 2 — DSH webview shell

Tasks:

- Bundle the required DSH client packages for a VS Code webview.
- Add the webview host, CSP, asset URIs and theme bridge.
- Render the DSH shell rather than a MesCode workbench.

Acceptance:

```text
the webview renders the DSH client shell
VS Code light/dark theme tokens resolve
reload recreates the shell without a second runtime
```

## Phase 3 — First real task

Tasks:

- Connect the webview composer to the DSH session API.
- Run one user prompt through the DSH agent.
- Execute one harmless tool and render the result.
- Persist and restore the session through DSH.

Acceptance:

```text
prompt → model → tool → answer is visible
the transcript is recoverable after reload
no MesCode task/session store is involved
```

## Phase 4 — VS Code capability providers

Tasks:

- File read/write and workspace roots.
- Editor open/location and diagnostics.
- Terminal and process execution.
- SecretStorage and configuration.
- Approval/interaction mapping to VS Code UI.

Acceptance:

```text
a real workspace task reads and writes files
a terminal tool uses the VS Code terminal backend
approval is decided at execution time and is single-use
```

## Phase 5 — DSH plugin surface

Tasks:

- Render the official DSH plugin manager.
- Use a local DSH profile and installed packages.
- Support local path, Git and tarball installs for LAN use.
- Add private npm registry support without requiring a DSH web server.

Acceptance:

```text
installed plugins appear
enable/disable and uninstall work
a local tarball installs and loads
no network service is required for a local install
```

## Phase 6 — Settings and parity

Tasks:

- DSH General items mapped into VS Code settings.
- Models, built-in plugins and agent presets as read-only or real forms based
  on what the DSH host actually serves.
- No second settings shell.

Acceptance:

```text
DSH settings are reachable from the VS Code UI
unsupported Host namespaces are explicitly read-only
no fake save success
```

## Phase 7 — Packaging and release

Tasks:

- VSIX build with the DSH host bundle and webview assets.
- Install into a clean VS Code profile.
- First-run, upgrade and uninstall checks.
- Real VS Code acceptance for prompt, tool, approval, reload and plugin page.

Acceptance:

```text
fresh VSIX installs
first task works
plugin page works
no DSH Web/sidecar process exists
```
