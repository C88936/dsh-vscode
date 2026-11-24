# Product boundary

## Product

A VS Code extension that runs the DeepSeek Harness application in an
extension-managed Node companion and renders the DSH client experience in a VS
Code webview.

It is a **VS Code application of DSH**, not a MesCode fork and not a DSH client
that connects to a remote DSH server.

## Architecture

```text
VS Code Extension Host
├─ apps/vscode
│  ├─ activation and commands
│  ├─ webview container
│  └─ VS Code capability adapters
└─ Managed companion host
   └─ DSH application
      ├─ Cordis host + loader
      ├─ agent and agent-loop
      ├─ session and persistence
      ├─ tools and tool executors
      ├─ interaction and approvals
      ├─ subagent / plan / goal / schedule / skills
      └─ DSH client packages served to the webview
```

## VS Code adapters

Only these capabilities are VS Code-specific:

- Workspace roots, file read/write/delete and file watching.
- Editor open, document location and diagnostics.
- Terminal and process execution.
- Commands, menus, views and webview host.
- VS Code settings and `SecretStorage`.
- VS Code theme tokens and accessibility conventions.

Adapters are capability providers for DSH services. They do not own an agent
loop or make model-visible decisions.

## Hard constraints

1. DSH is the only agent runtime.
2. One session/persistence model, owned by DSH.
3. One plugin ecosystem, owned by DSH.
4. No DSH Web server, SDK subprocess, HTTP listener or Simple Browser for normal use. The extension-managed companion is the supported Node host for DSH, not an external service.
5. No MesCode `Task`, `AgentLoop`, `ToolRegistry`, `ClineMessage` or
   `session_events.jsonl`.
6. No hidden second configuration or secrets store.
7. LAN operation must not require a public DSH service.

## Host lifecycle

The default mode uses one extension-managed companion host per VS Code global storage. Windows attach to that host with separate connections, peers and materialized resources; the host owns DSH sessions and plugins. Closing one window closes its connection. The host waits for running work before an idle exit after the last window leaves. The per-window companion remains an explicit fallback. Current acceptance limitations are recorded in [the product acceptance](C1_C25_PRODUCT_ACCEPTANCE.md).

In-process execution is an explicit internal experiment. A VS Code or Electron
upgrade never changes the production host mode automatically.

## Current non-goals

- Recreating MesCode's plugin panel in the new product.
- Reusing MesCode's workbench/session UI wholesale.
- Carrying MesCode visual-test debt or its corrupted documentation.
- Supporting Roo/Zoo compatibility paths in this product.

## Source and attribution

The editable source is this repository, forked from the pinned DSH snapshot.
Keep the upstream MIT license, NOTICE and source mapping. Do not edit the
original read-only snapshot.
