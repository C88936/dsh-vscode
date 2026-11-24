# Migration from MesCode

Date: 2026-11-15

## Decision

The product is a new DSH fork at `E:\LLM_project\dsh-vscode`. MesCode is not the
runtime base. It remains a reference for VS Code integration and for lessons
learned. No MesCode source is copied into this repository by this migration.

## What was carried over

- The product goal: a VS Code application whose agent runtime is DSH.
- The constraint that the product must work on a LAN without a public DSH
  service.
- The requirement to reuse DSH UI and DSH extension points rather than draw a
  simplified copy.
- The requirement that plugin install/enable/uninstall are local profile
  operations, not a second plugin ecosystem.
- VS Code-specific capability requirements:
  - workspace/files;
  - terminal/process;
  - editor/diagnostics;
  - commands/webview;
  - SecretStorage/configuration;
  - VS Code theme and accessibility.
- The lesson that a DSH Web fallback or SDK sidecar is not the product.

## What was intentionally not carried

| MesCode artifact | Why not carried |
| --- | --- |
| `core/task/Task.ts` and the MesCode agent loop | DSH owns the agent runtime |
| `core/tools` | DSH tools/tool executors own tool semantics |
| `ClineMessage` display pipeline | DSH session/event model replaces it |
| `session_events.jsonl` and MesCode projections | DSH owns persistence |
| MesCode permissions/interaction implementation | DSH interaction/approval seam |
| `DshKernelService` / `DshKernelClient` | starts a sidecar; forbidden |
| `DshWebService` / Simple Browser | starts a DSH Web surface; forbidden |
| `PluginsPanel` / community-kernel UI | replaced by official DSH plugin page |
| Roo/Zoo compatibility paths | not part of this product |
| Docker visual baselines and their 18 failures | MesCode-specific test debt |
| Corrupted `PRODUCT_TECHNICAL_REFERENCE.md` | encoding is unrecoverable; do not copy |

## MesCode state at migration

Recorded so the old work is not mistaken for the new product:

- The official DSH plugin page was reachable from MesCode's workbench.
- Built-in cards existed as read-only summaries; full Host namespaces were not
  implemented.
- Local profile inventory and the official Experimental bundle catalog were
  visible.
- The old MesCode `PluginsPanel` and community-kernel entry were removed from
  the product roster.
- Docker visual tests were at 63/81; 18 failures remained and included real
  behavior differences (draft retention, composer movement).
- `docs/PRODUCT_TECHNICAL_REFERENCE.md` had lost UTF-8 characters and could not
  be reconstructed without a clean source.
- The DSH runtime was still an external sidecar, not an in-process host.

None of the unresolved MesCode test or documentation items are acceptance
criteria for this new product.

## Source references

The old working copy remains at:

```text
E:\LLM_project\FastMESCode-main
```

Its historical plans are there, but some documents are encoding-damaged. This
migration keeps only the decisions and product requirements, not the damaged
bytes.

## Open migration questions

1. Which DSH boot entry supports an in-process application without the Web
   server?
2. Which DSH packages are required at runtime for agent/session/tools, and what
   is their build order?
3. How will the DSH client bundles be produced for a VS Code webview?
4. Which VS Code APIs map cleanly to DSH capability services, and which need a
   narrow adapter?
5. How will a local DSH profile and local plugin packages be managed without a
   `dsh` CLI or HTTP service?
