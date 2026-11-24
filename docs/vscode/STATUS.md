# Status

Recorded 2026-11-15.

## Working

- `apps/vscode` extension: activation, commands, DSH activity-bar view, webview.
- DSH application boots with the shipped `web` composition minus its HTTP rows
  (`webserver`, `web-runtime`, `client-hmr` disabled by `profile/vscode.patch.yml`).
- Live services in the running tree: `agents`, `sessions`, `tools`, `llm`,
  `connection`, `clientModules`, `typertGateway`.
- The DSH client shell renders in the webview from the built `apps/web/dist`
  entry, with the boot graph injected from `ctx.clientModules`.
- Transport over `postMessage`: unary RPC to
  `ctx.connection.createSharedFetchHandler('/api')`, logical streams to
  `ctx.typertGateway.wireStream.open(...)`, client bundles materialized from
  `ctx.clientModules.fetchBundle(...)`.
- No HTTP listener, no WebSocket, no iframe, no SDK sidecar protocol.
- One closed turn, driven against the repository's Messages-compatible mock
  server (`scripts/turn-smoke.ts`): durable events `turn/start`, `step/start`,
  `user/message`, `request/header`, `assistant/message`, `tool/call`,
  `tool/result`, `step/end`, `turn/end`; the answer comes from the second model
  request, which carries the tool result; the session persists as
  `session.v4.jsonl.zstd`.
- The application's working directory follows the first VS Code workspace
  folder.
- `pnpm --filter @deepseek-ai/dsh-vscode run package:vsix` produces
  `apps/vscode/dsh-vscode.vsix` (6 MB, shell included). Installing it into a
  clean profile and launching VS Code loads the DSH shell: the log shows
  `webview: injections applied` and `webview: shell loaded`.
- The VSIX carries no DSH installation. `dsh.runtimePath` (or
  `DSH_VSCODE_RUNTIME`) names one; a source checkout anchors on
  `apps/cli/package.json`, and every DSH package loads through that anchor rather
  than from the extension directory.
- `SecretStorage` adapter: `DSH: Set DeepSeek API Key` stores the provider key in
  VS Code's secret storage, `credentialEnv()` turns it into launch environment
  values, and the companion receives them at spawn. `scripts/secret-smoke.ts`
  proves the value reaches the provider: the mock server accepts exactly one key,
  records `x-api-key`, and the turn completes.
- Terminal adapter, extension half: `runInTerminal()` creates the integrated
  terminal, executes through shell integration, streams the output and waits for
  the reported exit code. The installed extension logs
  `dsh: terminal smoke exit=0 output=dsh-terminal-smoke`; shell-integration OSC
  sequences are stripped before the text reaches DSH. A `DSH: Run Command in
  Terminal` command exposes the same path.
- Terminal adapter, DSH half: `provider/terminal-provider.cjs` is a
  `ShellExecutor` implementation loaded by the DSH Loader from the extension
  directory; it forwards `ctx.shell` calls over the companion bridge to
  `runInTerminal`. Against the installed extension the log shows
  `dsh: shell smoke exit=0 output=provider-ok`, so a real tool call now runs in
  the VS Code terminal. The profile disables `bash-sandbox`, `pwsh-sandbox` and
  `permission`: the integrated terminal does not confine, so sandbox modes and
  permission presets cannot compose over it. `dsh.terminalBackend: "local"`
  restores the sandboxed executors.
- Editor adapter: `provider/editor-provider.cjs` registers the `/open <path>`
  human command; the handler asks the extension to show the file. The command is
  visible in `ctx.commands.list(agent)` (`commands: export,feedback,open`), and
  the installed extension logs `dsh: editor smoke opened README.md` for the same
  bridge path.
- Workspace/file path: with the workspace folder as the application cwd,
  `ctx.fs` resolves workspace-relative paths and reads, writes and lists real
  files there. `scripts/workspace-smoke.ts` reports `read back matches: true`,
  `listed entries: session.md` and `on disk matches: true`. A
  `vscode.workspace.fs` provider is only needed for remote or virtual
  workspaces.
- No listener: with the installed extension running, the companion `node`
  processes own no listening TCP socket (`Get-NetTCPConnection -State Listen`
  with their PIDs returns none), no `dsh web` process is started, and the
  webview document loads only webview-scheme resources.
- A DSH status-bar item shows the host state and opens the view on click.
- Shell backend default: `local` (DSH's sandboxed executor) rather than the
  VS Code terminal, so permission presets and sandbox policy stay active by
  default; `dsh.terminalBackend: "vscode"` opts into the auditable but
  unconfined terminal. Verified from a clean profile:
  `dsh: shell smoke exit=0 output=provider-ok` with only the three expected
  pending rows and `permission` active.
- A window without a workspace folder fails with an actionable "open a folder"
  error instead of starting the application in the user profile.
- Development-sandbox limit: under the `codexsandboxoffline` command account,
  `workspace-write` reports `SetNamedSecurityInfoW failed (Win32 5)`; DSH refuses
  to run unconfined with `SandboxUnavailableError`. A normal Windows 10 desktop
  user still needs the same sandbox smoke before the host is classified as
  working or broken.
- Private-network plugins: `dsh.localPlugins` turns configured `{ id, path }`
  rows into a `plugins.patch.yml` overlay that inserts Loader rows pointing at
  already-mirrored local directories or modules. `scripts/plugin-smoke.ts`
  mounts a fixture plugin from a temporary directory and reports
  `local plugin mounted: true`.
- Paired release: `package:release --runtime <dir>` builds the VSIX and writes
  `release.json` with the VSIX SHA-256, the declared runtime range, the verdict
  for that runtime, and a `runtime-<version>.zip` of the directory with its own
  SHA-256. Against this checkout:
  `runtime 0.2.2-alpha.2 compatible: true`; against a 0.3.0 fixture it exits 1
  with `0.3.0 does not satisfy >=0.2.2-alpha.2 <0.3.0`. The archive was expanded
  back and listed its `package.json` and `lib/index.js`, so the container is
  readable by standard zip tooling.
- Runtime compatibility: the extension manifest declares
  `dsh.runtimeRange` (`>=0.2.2-alpha.2 <0.3.0`) and the packaged manifest keeps
  it; diagnostics reports the verdict. Installed extension:
  `runtime compatibility: 0.2.2-alpha.2 satisfies >=0.2.2-alpha.2 <0.3.0`.
  A separately updated VSIX or runtime therefore states its mismatch instead of
  failing at the first model call.
- Diagnostics: `DSH: Show Diagnostics` and the activation log print mode,
  extension version, runtime version and installation path, harness home,
  working directory, provider route and endpoint, whether a provider key is
  stored, and the shell backend — never a credential value. Verified from the
  installed extension: `runtime: 0.2.2-alpha.2 (...apps/cli/package.json)`,
  `provider: deepseek`, `shell backend: local`.
- Private / LAN provider: `dsh.providerMode: openai-compatible` makes the
  extension write `provider.patch.yml` — an `llm-pi-ai` route with
  `api: openai-completions`, the configured `baseURL`, an `apiKeyEnv` reference,
  and a model id — and patch `agent-default-model` to that route.
  `scripts/openai-provider-smoke.ts` verifies the whole path against a local
  Chat Completions server: the request reached the endpoint with the user text,
  the assistant answered, and the turn closed.
- Unit tests: the extension suite covers credential and provider configuration,
  installation-anchor resolution, plug-in entry resolution, diagnostics,
  terminal control-sequence handling, managed-host mode selection, and
  single-generation lifecycle behavior.
- Fresh-profile install: the companion creates its storage directory before
  writing the generated shell overlay, so a first install (no prior global
  storage) boots. Verified from an empty profile:
  `dsh: editor smoke opened README.md`, `webview: shell loaded`,
  `dsh: shell smoke exit=0 output=provider-ok`.

## Runtime constraint

Every current VS Code extension host runs Electron's Node (VS Code 1.117 ships
Node 22.22.1 / Electron 37). The DSH runtime resolver's native module
(`node-addon-require-builtin`) refuses that fingerprint and accepts only
Electron 43, 44, 44.7 and 45. In-process boot is therefore unavailable today.

The extension selects `companion` mode: `lib/companion.cjs` runs the same
`bootDsh` composition under the system Node (>= 24.9) and serves the webview
bridge over stdin/stdout. When a VS Code release ships a supported Electron
build, `extensionHostSupportsDsh()` selects `in-process` with no other change.

## Host architecture

The managed companion host is the supported production architecture. It is not
an HTTP server, DSH SDK process, external service, or second runtime; it is this
application's own Node host process, started and disposed by the extension.

In-process boot remains an explicit internal experiment until it passes the
same lifecycle, protocol, sandbox, and VS Code acceptance matrix. The extension
does not switch production host modes automatically when VS Code changes its
Electron release.

## Packaged runtime

`pnpm --filter @deepseek-ai/dsh deploy <dir> --prod --legacy` produces a portable
tree of about 493 MB with its own `node_modules` and virtual store, and
`scripts/prepare-runtime.mjs` completes its peer closure by copying peer-only
workspace packages from the checkout.

That tree does not boot yet:

- copies land in `node_modules/<pkg>` without their own dependency links, so
  their imports fail (`Cannot find package '@deepseek-ai/dsh-timeout' imported
  from .runtime/node_modules/@deepseek-ai/dsh-session-title-llm/lib/index.js`,
  and the same for `dsh-session`, `dsh-util-values`);
- completing that closure transitively means copying nearly every workspace
  package, which grows the tree further;
- five third-party optional peers stay unresolved
  (`@modelcontextprotocol/sdk`, `@smithy/hash-node`, `kerberos`, `bufferutil`,
  `utf-8-validate`).

Hand-assembling a runtime from a checkout does not scale. A shippable runtime
has to come from a real install — published packages or packed tarballs plus
`npm install` — which is a distribution decision, not an extension change.

## Not started

- Terminal backend selection beyond the default: the sandbox and permission
  tradeoff above is fixed in the generated overlay; making it a profile-level
  choice is not designed yet.
- Editor adapters beyond `/open`: document references inside the conversation
  still open in the webview, because the DSH client carries no intent the
  extension can observe.
- A workspace file provider: local workspaces already work through `fs-local`
  with the workspace folder as the application cwd; virtual or remote workspaces
  need a `ctx.fs` provider over `vscode.workspace.fs`.
- A packaged DSH installation beside the extension: the VSIX expects
  `dsh.runtimePath`, so a machine without a checkout cannot install and run it
  yet.
