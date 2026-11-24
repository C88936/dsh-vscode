---
name: dsh-mcp-setup
description: Configure an already downloaded MCP server for the current DSH profile when the user asks to add, install, enable, or repair that connection.
user-invocable: false
---

# Configure a downloaded MCP server

Read the publisher's local README and configuration example. Identify the installed program or remote URL, the launch arguments and working directory, and any credential references. Resolve relative program paths against the delivery directory. If an executable or dependency is missing, use the publisher's documented install method for the user-approved source, or report the missing dependency. A JSON file supplies configuration and may reference software that still needs installation.

Locate the active DSH profile before editing. In DSH for VS Code, the directory comes from the extension's host storage and may differ from a standalone DSH profile. Read `mcp-servers.json` when present to check UI-managed names and settings. Preserve those entries. For a hand-authored setup, use the profile's `cordis.patch.yml` and check both files for a conflicting server name. Preserve unrelated entries and prefer editing a matching hand-authored server over creating a duplicate.

Add an entry with a unique `id`, `name: '@deepseek-ai/dsh-mcp-client'`, and a `config` containing a unique `serverName`. In a Cordis patch, new entries belong under an `insert` operation. Set `disabled: true` on an incomplete entry. A local entry uses `transport: stdio` and takes `command`, `args`, `cwd`, and `env`. A remote entry uses `transport: streamable-http` and takes `url` and optional `headers`. Keep credentials in the user's approved secret source. Never copy passwords or tokens from examples into the profile or display them in the response.

Validate the profile before activation. Record incomplete entries as disabled and report the missing settings. When the user authorized activation and the required settings are available, apply the change through the active host's normal reload or restart flow and verify that the server's tools are registered. Avoid interrupting a running task. If a reload must be initiated by the user, report the exact pending step. MCP handshake and tool discovery are separate from verification of a downstream system such as Oracle.
