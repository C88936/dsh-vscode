# Deployment guide

Operator steps for installing DSH for VS Code on a private network.

## Prerequisites

- VS Code 1.96 or newer.
- A standalone release contains its managed Node and DSH runtime.
- A development VSIX requires Node.js 24.9 or newer and a DSH installation.
  The extension never downloads either dependency.

## Runtime composition

A standalone release embeds the VS Code runtime closure from `apps/vscode/deploy`: the base and Web profile bundles, the bundled Office skills with the Win32 x64 LibreOffice engine, the sandbox and terminal backends, and the other optional bundles switched off. That closure omits the CLI launcher and voice input, so the Plugins page offers no voice entry and an older profile that selected it loses that selection on the next start; the remaining optional bundles stay available.

The composition also drops the right Sidebar's page types and the Office converter only the document preview used. Conversation file links, references, and skill links use the [extension's file-opening routes](../../apps/vscode/README.md); external HTTP(S) links open through the system browser. The changed-files card opens a native diff of the turn-start and turn-end text the Host keeps, falling back to the file when no text comparison is served; its hover preview keeps the hunk comparison. A plan address has no native file editor yet and reports a warning instead of opening another path.

Office rendering, PDF export, and recalculation use the embedded LibreOffice engine. Standalone releases also require the pinned authoring payload at `runtime/primary-runtime` for `python-docx`, `python-pptx`, and `openpyxl`; preparation and packaging reject missing libraries or an unusable interpreter. See the [extension packaging instructions](../../apps/vscode/README.md) for payload preparation. Office/PDF file links use the system's registered viewer, so viewing requires a compatible file association; authoring, rendering and export use the embedded dependencies.

## Install

1. Install the VSIX: `code --install-extension dsh-vscode.vsix`.
2. A standalone release needs no runtime setting. For a development VSIX, point
   `dsh.runtimePath` at the installation or set `DSH_VSCODE_RUNTIME`.
3. Reload the window. The DSH view appears in the activity bar and the DSH
   output channel records the boot.

`DSH: Show Diagnostics` prints the mode, runtime version and installation path,
Harness home, working directory, provider route, key presence, shell backend and
the runtime range verdict. It never prints a credential.

## Provider

The internal product points at a private OpenAI-compatible endpoint. The DeepSeek account, balance, sign-in, and first-run credential dialogs are disabled in this composition; no DeepSeek login or API-key prompt appears.

| Setting | Example |
| --- | --- |
| `dsh.providerMode` | `openai-compatible` |
| `dsh.providerRoute` | `company` |
| `dsh.llmBaseUrl` | `http://llm.lan:8000/v1` |
| `dsh.llmModel` | the model id that endpoint serves |
| `dsh.llmApiKeyEnv` | `DSH_LLM_API_KEY` |

Store the key with `DSH: Set Private Endpoint API Key`. It stays in VS Code
`SecretStorage` and reaches the application only as the environment variable
named by `dsh.llmApiKeyEnv`.

The extension writes `provider.patch.yml` into its storage directory: one
`llm-pi-ai` route speaking `openai-completions` plus a patched
`agent-default-model`. That is the same patch a profile edit would carry, so a
later manual change to the profile keeps working.

## Plugins from the private network

Mirror the plugin inside the network (copy the directory or extract a tarball),
then list it:

```json
"dsh.localPlugins": [{ "id": "acme-tools", "path": "D:/lan/plugins/acme-tools" }]
```

The extension writes `plugins.patch.yml` with one `insert` row per plugin. No
registry, Git host, or public network access is involved.

Registry and Git installs remain DSH profile operations and need an internal
mirror.

### Prepared bundles for offline install

A raw module tree mounted through `dsh.localPlugins` is not a bundle
installation. To install or replace a bundle from a file, prepare it with the
`dsh-prepared-bundle/v1` record: run `pnpm install --frozen-lockfile` in the
package, keep `pnpm-lock.yaml`, and write `dsh-prepared-bundle.json` beside
`package.json` with the format, name, version, lockfile path and SHA-256,
host-provided names, packages (name, version, relative path, integrity),
install scripts and native platform sets. Record paths stay inside the package;
an archive carries the same files, including the closure, under npm's
`package/` entry.

Select the prepared directory or `.tgz` under Plugins → Install from folder /
archive. The page reports whether the closure is proven for offline install; a
package without the record, or with missing or unsupported items, is marked
`not proven`. This build sets `plugin-manager` `localInstallPolicy: require-record`,
so a package without the record is refused before pnpm runs: its dependency
closure could otherwise be resolved from the configured registry, which is not
the intranet mirror this build expects. Prepare the record to install it, or set
`localInstallPolicy: allow-unproven` in the profile overlay to deliberately keep
the ordinary path. A proven closure installs with the bundled pnpm in `--offline`
mode and does not ask a fallback registry. `pnpm pack` output alone is not a
prepared bundle.

Detail images follow the same rule: a bundle document's relative images are
served by the Host from the package's own files. A remote `http(s)` image in a
detail document is rendered, but the webview's content policy blocks the request,
so the page shows the image's alt text (the `Image unavailable · …` line) instead
of the picture. Ship icons and screenshots inside the bundle rather than linking
them from a website.

## Storage and backup

| Location | Content | Back up |
| --- | --- | --- |
| `<globalStorage>/home` | sessions (`session.vN.jsonl.zstd`), credential store, profile data | yes |
| `<globalStorage>/home/skills` | personal DSH skills for this extension install's data scope | yes |
| `<globalStorage>/profile` | application-owned profile, bundle list, managed connections in `mcp-servers.json`, and hand-authored entries in `cordis.patch.yml` | yes |
| `<globalStorage>/runtime` | host endpoint token, spawn lock, and `host.log`; rebuilt on the next start | no |
| `<globalStorage>/updates` | staged VSIX downloads | no |
| `<globalStorage>/connections` | per-window materialized client bundles and package assets; regenerated | no |
| `<globalStorage>/webview/bundles` | materialized client bundles of the per-window companion fallback | no, regenerated |
| `context.secrets` | model API keys | no, re-enter after a profile reset |

The extension keeps the Harness home isolated from any other DSH installation,
so a shared home cannot mix storage schemas from different releases.

The extension loads its shipped Skill library from `profile/skills` inside the VSIX. It includes `/skill-creator` and a model-invocable MCP setup Skill. Keep team Skills in the repository's `.agents/skills`, and use `~/.agents/skills` for personal Skills shared with another compatible agent. Keep MCP executables in their own provisioned directory and reference that path from the DSH profile. Supply database credentials with the approved environment or credential mechanism for the MCP server. The VS Code SecretStorage integration above covers model keys.

In **Plugins → MCP**, select **Import MCP configuration** to review JSON with a `mcpServers` or `servers` object. Use the adjacent arrow to set up a local command or Streamable HTTP endpoint manually. New or edited connections are saved disabled. Enable the desired connection and use **Restart DSH** when prompted. Open the connection to refresh its tool list. An environment reference such as `${env:ORACLE_TRAINING_PASSWORD}` reads the named variable from the extension host's startup environment. Setting that variable in an already open terminal does not update the extension host. Hand-authored Cordis connections appear separately and retain their own configuration.

Use **Plugins → Skills** to browse the selected Workspace's Skills, personal Skills, and built-in Skills. **New skill** opens a separate conversation with `/skill-creator` in its draft and leaves existing drafts intact.

## Shared host across windows

Each connecting window registers its local folder in the shared Workspace registry before its page becomes ready. Reconnecting to the same canonical directory keeps the Workspace identity and existing Sessions, and concurrent connections do not seed duplicate initial Sessions. All windows can browse the same history. Choose a Workspace in the DSH picker to create a conversation there; opening a historical conversation preserves its recorded working directory, including when viewed from a different project's VS Code window. New Session follows the DSH selection rather than rewriting it to the window folder.

Within one VS Code profile (the extension's global storage), all windows share one DSH application. The first window that opens DSH starts a detached host process; other windows attach to that process, so they see the same session history, live execution state, and plugin state. Closing a window ends only its own connection: a task another window is observing keeps running, and the host exits on its own after the last window leaves and no turn, terminal command, or package operation is still running.

- `DSH: Restart Host` is a shared maintenance action. It checks host-wide activity, refuses while work is running, stops the host, and the next attach starts a new one; other windows reconnect automatically.
- The `dsh.*` deployment settings of the window that started the host own that host. A window with different settings joins the running host, shows a warning, and can run the shared restart to apply its own settings.
- Do not point two profiles at one storage through a junction or symlink: the host endpoint is derived from the storage path, so aliases create a second host that writes the same profile.
- `DSH_VSCODE_SHARED_HOST=0` restores the per-window companion for comparison or rollback; that mode keeps the old behavior and is not the supported default.
- Host diagnostics append to `<globalStorage>/runtime/host.log`.

## Updates

`package:release --runtime <dir>` produces the VSIX, a `runtime-<version>.zip`
and `release.json` with both digests and the compatibility verdict. Publish the
pair together.

- Extension update: install the newer VSIX; storage is preserved.
- Runtime update: extract the new runtime and point `dsh.runtimePath` at it,
  then run `DSH: Restart Host`.
- The manifest declares `dsh.runtimeRange`; diagnostics reports a mismatched
  runtime instead of failing later at a model call.

## Troubleshooting

| Symptom | Cause and action |
| --- | --- |
| `mode: companion` in diagnostics | Expected on current VS Code: its Electron runtime is outside the range the DSH resolver accepts. The companion boots the same application under the Node from `dsh.nodePath`. |
| `no supported Node executable` | No Node 24.9+ on `PATH`; set `dsh.nodePath` or `DSH_VSCODE_NODE`. |
| `SandboxUnavailableError ... SetNamedSecurityInfoW` | The Windows ACL sandbox runner cannot grant write on the workspace root. DSH refuses to run unconfined. Repair the directory permission, or run a preset whose mode is `danger-full-access`. |
| `dsh: no DSH installation at the configured dsh.runtimePath` | The setting points at a directory with no `package.json` and no `apps/cli/package.json`. |
| Shell commands invisible in the terminal | `dsh.terminalBackend` is `local` (the default) so sandbox policy and permission presets stay active. Set `vscode` to run in the terminal, which is unconfined and disables those presets. |
| Provider returns 401 | Store the key again with the matching command, and confirm `dsh.llmApiKeyEnv` names the variable the route reads. |
| `another window is starting DSH` / host stays unreachable | The first window holds the spawn lock while the host boots. If it does not appear, reload that window and retry; see `<globalStorage>/runtime/host.log`. |
| A window reports the host refused it | The storage token or the wire protocol changed (extension or host updated separately). Reload the window; the next attach reads the current token. |
| Two windows show different plugin or model settings | The host runs the deployment settings of the window that started it. A warning names this; run `DSH: Restart Host` to apply this window's settings. |
