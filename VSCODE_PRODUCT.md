# DSH for VS Code

This repository is a fork of DeepSeek Harness. It is **not** a MesCode feature
and does not import MesCode's runtime, task loop, tools, permissions or session
persistence.

## Product boundary

```text
VS Code extension
├─ VS Code adapters
│  ├─ webview host / commands
│  ├─ workspace and file system
│  ├─ editor, diagnostics and terminals
│  ├─ SecretStorage and configuration
│  └─ VS Code-specific UI affordances
└─ DSH application
   ├─ Cordis host and loader
   ├─ agent / agent-loop
   ├─ session and persistence
   ├─ tools and tool executors
   ├─ interaction and approvals
   ├─ subagents, plan, goal, schedule, skills
   └─ DSH client packages rendered in the webview
```

The extension entry is `apps/vscode`. It must bootstrap the DSH application
in-process. It must not start `dsh web`, a DSH SDK sidecar, an HTTP server, or a
Simple Browser page.

## What stays VS Code-specific

- File reads, writes, checkpoints and editor navigation.
- Terminal and process providers.
- Commands, menus, views and the webview container.
- VS Code settings and SecretStorage.
- VS Code theme tokens and keyboard conventions.

Everything else should use DSH source or DSH extension points. No second plugin
registry, no second agent loop, no parallel session store.

## First milestone

A window that opens the DSH client shell from the extension, with the DSH
application booted in-process and no MesCode runtime dependency.

## Non-goals

- Reusing MesCode `Task`, `AgentLoop`, `ToolRegistry`, `ClineMessage` or
  `session_events.jsonl`.
- Running the DSH Web server.
- Copying MesCode's plugin panel.
- Supporting Roo/Zoo compatibility paths in the new product.

## Product documents

- [Product boundary](docs/vscode/PRODUCT.md)
- [Roadmap](docs/vscode/ROADMAP.md)
- [Backlog](docs/vscode/BACKLOG.md)
- [Migration from MesCode](docs/vscode/MIGRATION.md)
- [Environment](docs/vscode/ENVIRONMENT.md)

## Source base

The fork starts from the pinned snapshot at:

```text
E:\LLM_project\FastMESCode-main\references\deepseek-harness-master
```

Keep the upstream license, NOTICE and source mapping. Do not edit the original
snapshot; this repository is the editable fork.
