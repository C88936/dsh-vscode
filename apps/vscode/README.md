# DSH for VS Code

VS Code application entry for the DSH fork.

## What this is

A VS Code extension that runs the DeepSeek Harness application and renders the
DSH client shell in a webview. It owns no agent loop, no session store, and no
plugin registry: `packages/**` is used as-is.

## Runtime modes

| Mode | When | How |
| --- | --- | --- |
| `companion` | The supported production path | `lib/companion.cjs` runs `bootDsh` under the extension-selected Node and serves the webview bridge over stdin/stdout |
| `in-process` | Explicit internal experiment only | `bootDsh` boots Cordis inside an extension host that independently passed the full acceptance matrix |

The managed companion mode exists because the DSH runtime resolver's native module
(`node-addon-require-builtin`) refuses Electron 37's runtime fingerprint and
only accepts Electron 43+ / Node 24. The extension starts no HTTP server, no
socket, and no SDK sidecar; the companion speaks only newline JSON on stdio.

Production mode selection does not follow the extension host's Electron version.
`DSH_VSCODE_EXPERIMENTAL_IN_PROCESS=1` is an internal experiment switch, not a
user deployment setting.

## Transport

The webview reads the DSH client's documented transport seam:

- `window.__DSH_TRANSPORT__` — `fetch`, `openStream`, `loadBundle`,
  `resolveAsset`, `openResource`, `openExternal`, `openDiff`, `restartHost`,
  `pickLocalBundlePath`, `ownsHost: true`
- `window.__DSH_BOOT__` — the boot graph, injected from `bootInjections()`
- client bundles are materialized from `ctx.clientModules.fetchBundle()` into
  `<storage>/webview/bundles/*.js` and loaded as webview resources; each boot
  removes the files its current graph did not materialize

Unary RPC goes to `ctx.connection.createSharedFetchHandler('/api')`; logical
streams go to `ctx.typertGateway.wireStream.open(...)`; both are the same
interfaces the Web carrier uses.

`fetch` and the upload carrier normalize each call with the platform `Request`
constructor, so a `Request` input supplies its method, headers, body, and
signal, and an `init` overrides them with the standard rules. Relative routes
resolve against the Host root, never the Webview origin. A unary request
carries text only; a binary, streaming, or multipart body belongs to the
upload carrier, which is also what `__DSH_FILE_UPLOAD__` uses. An already
cancelled signal rejects before any frame is sent, and cancelling mid-request
sends one cancel frame and settles the promise once.

The upload carrier sends one chunk at a time: an acknowledgement follows only
after the route consumed the previous chunk, so a slow route cannot make the
bridge buffer an unbounded body. A response that arrives early stops the pump,
releases the waiting acknowledgement, and cancels the body reader.

A package's images and CSS `url()` references are materialized beside the
bundles before its code runs. The registry enumerates them from the package's
`lib/assets` directory, each read is validated through the same `./assets/*`
export the HTTP route enforces, and the file keeps its media extension so the
Webview serves the right type; nothing is written as `.js`. The first boot
prepares every active package, and loading a bundle the boot graph did not name
returns that package's map with its URI, which the page applies before the
script executes. A package that cannot be prepared fails that load instead of
running against literal references. An SVG reaches the page only through an
`<img>` element or a CSS `url()`, where its scripts do not run; the Webview has
no route that opens an asset as a document.

When the companion exits unexpectedly, the extension sends a transport reset
frame, and the page settles every pending fetch, upload, asset request, uplink
acknowledgement, and stream instead of waiting for a process that is gone. A
page that is hidden does the same for its own requests.

Fetch answers are text by default. A request may opt into a binary answer that
carries base64 plus the response media type; the page resolves the two detail
image routes (`/api/plugin-manager/detail-file`,
`/api/plugin-market/detail-file`) through that path into managed Blob URLs,
bounded to 5 MiB and revoked when the image leaves the page. No other route is
intercepted, and the CSP is unchanged.

`openResource`, `openExternal`, and `openDiff` make the extension the page's opener. The DSH right Sidebar notices the carrier hooks and registers no seats. Conversation, reference, and skill links resolve Session-relative paths. Text opens in VS Code at the requested line, images use VS Code's viewer, and Office/PDF files use the system's registered application; install a compatible viewer if no association exists. Opening a file never writes an unsaved buffer. External webpage links accept only HTTP(S). A plan or change-review address without a file reports a visible warning.

The changed-files card opens a native diff of the Host's turn-start and turn-end text in read-only virtual documents, falling back to the file when no text comparison is served; its hover preview keeps the Host's hunks. Open tabs keep their historical content, with twenty additional closed comparisons cached. Comparison URIs are unique across extension restarts. An expired URI reports that the comparison must be reopened from the changed-files card.

## Composition

`profile/vscode.patch.yml` is applied over the shipped `web` profile. It
disables the rows that need a listening HTTP server:

- `webserver`, `web-runtime`, `client-hmr`

It also removes the right Sidebar's page types and the converter only the
document preview consumed:

- `ui-sidebar-documentpreview`, `ui-sidebar-files`, `ui-sidebar-terminal`,
  `ui-sidebar-browser`, `office-to-pdf`

`web-startup` stays enabled: Connection reads its trusted-host configuration
from `ctx.webStartup`, and it binds nothing by itself. The companion writes an
Office overlay that mounts `dsh-skill-office` from the runtime it boots, so
Office rendering and PDF export keep the bundled LibreOffice engine.

The webview also omits the DeepSeek account surface and its first-run credential
prompt: `ui-settings-account` and `account-controller` are disabled and
`ui-settings-models` sets `credentialOnboarding: false`. The company route comes
from `dsh.providerMode`/`dsh.llmBaseUrl`/`dsh.llmModel`; the generated provider
overlay also sets `deploymentOwnedRoute` to the actual `dsh.providerRoute`, so
only that route's endpoint, model and limits are read-only in the Models page,
while user-added providers stay editable (see
[Company model endpoint](#company-model-endpoint)).

The webview's boot table is built with one `webserver/index-inject` emit, the
same way the served Web app builds it. That gives the page the module-system
bootstrap plus theme, shortcuts, and onboarding globals from the host rows;
calling `clientModules.bootInjections` alone would omit them.

## Develop

The operator-facing steps — install, private provider, mirrored plugins, storage
and backup, updates, troubleshooting — live in
[docs/vscode/DEPLOY.md](../../docs/vscode/DEPLOY.md).

```sh
pnpm install
pnpm run build:artifacts        # builds packages/*, lib/types and apps/web/dist
pnpm --filter @deepseek-ai/dsh-vscode run build
code --extensionDevelopmentPath=apps/vscode --disable-extensions
```

The extension needs `apps/web/dist` (the built DSH shell) and the workspace
installation (`apps/cli/package.json` is the installation anchor).

`DSH_VSCODE_OPEN_ON_START=1` opens the DSH view on activation during
development; `DSH_VSCODE_NODE` overrides the Node executable the companion uses.

## Package and install

```sh
pnpm --filter @deepseek-ai/dsh-vscode run build
pnpm --filter @deepseek-ai/dsh-vscode run package:vsix
code --install-extension apps/vscode/dsh-vscode.vsix
```

`runtime:standalone` deploys the VS Code runtime composition (`apps/vscode/deploy`) and the Node 24 executable into `apps/vscode/runtime`. The deploy root carries the base and Web profile bundles, the bundled Office skills with the Win32 x64 LibreOffice engine, the sandbox and terminal backends, and the optional bundles switched off. It deliberately omits the CLI launcher and voice input; the rest of the plugin ecosystem stays shipped. Preparation drops Windows debug symbols and foreign prebuild trees, validates the win32-x64 payload and its license files, verifies the staged companion boot, and only then replaces the previous runtime.

Preparation also stages the repository-installed pnpm at `runtime/node_modules/pnpm`, using the version the root `packageManager` pins, and records it in `standalone-runtime.json`. A missing payload, an absent CLI entry, or a version other than the pinned one fails preparation.

`package:standalone` requires that directory and refuses a release without it. The runtime carries no CLI launcher, so the release version is read from the base bundle. At boot the extension writes an Office overlay that mounts `dsh-skill-office` and the bundled authoring interpreter. Standalone preparation and packaging require the pinned Windows x64 Python libraries and execute an isolated import/version check; missing or unusable Office authoring dependencies stop packaging. Normal users do not set `dsh.runtimePath` or `dsh.nodePath`, and the development `package:vsix` command warns when the runtime directory is absent. A configured `dsh.runtimePath` must supply pnpm in its own `node_modules/pnpm`: the companion runs package operations with the payload at the installation it boots, never with a `pnpm` from `PATH`, and a boot without that payload stops with a message naming the missing location.

`runtime:standalone` never gets the Office payload from the pnpm deploy closure: the payload is generated, not installed as a package dependency. Without `--office-payload` it reuses `runtime/primary-runtime` from the previous runtime. Pass `--office-payload <primary-runtime directory>` to package a payload built with `node scripts/primary-runtime/prepare.ts --target win-x64 --output .tmp/office --python-only` from the repository root (`../../.tmp/office/primary-runtime` from this directory). A missing record fails preparation before the deploy runs and names that command. The companion already supplies Node; the Python-only payload includes the document libraries without a second Node installation. The payload is copied as a complete directory, never merged with an older interpreter. `release.json` records its identity.

`package:release --runtime <dir>` builds the VSIX and writes `release.json` with the VSIX SHA-256 and the embedded runtime details. For an internal release, the VSIX version, including any prerelease suffix, must match the embedded DSH version. The script also checks the extension's runtime range and runs the companion boot smoke before packaging.

A development VSIX carries the extension, overlay, and built shell, but no DSH
installation. In that mode only, set `dsh.runtimePath` to a source checkout or
to a directory with `package.json` and `node_modules`, or set
`DSH_VSCODE_RUNTIME` before launching VS Code. Configured `dsh.nodePath` or
`DSH_VSCODE_NODE` override a bundled Node.

## Workspaces across windows

Windows using the same VS Code global storage share one DSH Workspace registry and all session history. Before a window's DSH page becomes ready, the host registers that window's local folder and creates an initial blank Session only if the Workspace has no members. Reconnecting to the same canonical directory preserves the Workspace identity and its existing Sessions; concurrent connections share initialization. An invalid or unavailable directory refuses that connection without stopping other windows.

Select a Workspace in the DSH workspace picker to create a conversation there. Add Workspace in that picker opens the host's native folder chooser; the selected local directory becomes a DSH Workspace even when it is outside the VS Code workspace. The VS Code binding stays the first folder; DSH Workspaces are independent of it. Opening history from another project keeps that Session's recorded working directory. The window's folder does not rewrite historical Sessions or change the host process's working directory. The regular DSH selection behavior remains: New Session follows the selected Workspace or conversation, so switching to a different project's history does not implicitly select the VS Code folder again.

`node --experimental-transform-types scripts/shared-windows-smoke.ts` exercises two real folder registrations through one built companion, creates Sessions in each, opens one from the other connection, checks the owner-local Session-state oracle, and verifies reconnect/restart preservation without a model key. It also rejects an invalid directory while leaving the other connection usable. Run `pnpm run build` in this app before the smoke so it uses the current companion.

In shared mode, a request to open a file or run an integrated terminal command prefers the ready VS Code window that initiated it. Host work without a connected initiating window uses the most recently connected ready window. An in-flight request stays with the selected window and reports failure if that window disconnects. `/open` resolves relative paths from the Session's directory and is available with either terminal backend.

`node --experimental-transform-types scripts/shared-turn-smoke.ts` checks shared output, Session switching, approval settlement, stop, reconnection, and the editor request path against a local mock model. `node --experimental-transform-types scripts/shared-session-queue-smoke.ts` checks that a second window can queue a prompt on the same Session and that it reaches the model after the first reply. With `DSH_VSCODE_EXTENSION_PATH` set, both probes use an extracted standalone VSIX.

The shared Host serializes plugin changes and refuses them while a turn, package operation, or terminal command is active. While a change is running, the Host refuses new window prompts and blocks model steps started inside the Host. Closing the initiating window skips any of its changes still waiting for admission. An admitted change holds maintenance until its Host call settles, even if the window disconnects before receiving the result. `node --experimental-transform-types scripts/shared-plugin-concurrency-smoke.ts` checks concurrent changes, cross-window cancellation, and disconnect recovery.

An editor or terminal adapter failure returns to the Host as a failed request. An active maintenance restart notice is sent to every ready window, including a window that connects while admission is closed. If the restart is refused, every connected window receives the reopened state.

## Shell backend

`dsh.terminalBackend` chooses where DSH shell tools run:

| Value | Runs in | Sandbox | Permission presets |
| --- | --- | --- | --- |
| `local` (default) | a child process under DSH's executor | enforced by the sandbox policy | available |
| `vscode` | the VS Code integrated terminal | none — it is your own shell | disabled by the generated overlay |

`vscode` is the auditable/interactive option: every command is visible in the
terminal, and the price is that the terminal does not confine. `local` keeps
DSH's sandbox and approval behavior, at the cost of not showing commands in the
terminal.

The Windows ACL sandbox runner must be able to grant write on the workspace
root. When it cannot, DSH refuses to run the command unconfined with
`SandboxUnavailableError`; choose a preset whose mode is `danger-full-access`
or repair the permission, rather than expecting the extension to bypass it.

## Company model endpoint

The company distribution defaults to the private OpenAI-compatible route:
`dsh.providerMode` is `openai-compatible`, and an incomplete company setup is
reported at activation with actions to configure the endpoint, open the settings,
or store the key. The generated launch overlay then fails loudly on an unusable
endpoint instead of substituting the public DeepSeek provider.

`DSH: Configure Company Endpoint` pre-fills the saved `dsh.llmBaseUrl` and accepts an optional API key as password input. The key is stored in VS Code `SecretStorage` for that URL. When changing URLs, a blank key clears the destination URL's stored key, and DSH clears the previous model selection before saving the new URL. Leaving the key blank for the same URL preserves its stored key. The command writes `dsh.providerMode` and `dsh.llmBaseUrl` where they take effect, then starts the configuration through `DSH: Restart Host`. If a save fails, the command stops before restart. If the restart is blocked by running work, the saved configuration takes effect after a successful shared restart.

When upgrading from `0.0.0`, re-enter any company key previously saved in VS Code with `DSH: Set Private Endpoint API Key`. The legacy key has no recorded endpoint and remains available to the old extension if you roll back.

The command does not ask for a model id. Until `dsh.llmModel` names one, the
overlay lists and pins `dsh-unconfigured-model`, a marked placeholder that lets
the application boot so the Models page can run discovery. The placeholder is
not served by the endpoint and is not usable for inference; the Models page
refuses it as a saved choice.

The extension writes one overlay that mounts an `llm-pi-ai` route speaking
`openai-completions`, lists the model `dsh.llmModel` names (or the placeholder),
and pins that model. Each value has one owner:

| Value | Owner | Where it is set |
| --- | --- | --- |
| Endpoint URL | Deployment | `dsh.llmBaseUrl`, written into the generated overlay |
| Served model id | Deployment | `dsh.llmModel`, written into the generated overlay's model entry |
| Credential reference | Deployment | `dsh.llmApiKeyEnv`, written into the generated overlay |
| Active model selection | Deployment | `dsh.llmModel`, pinned as `agent-default-model` by the generated overlay |
| API key | VS Code `SecretStorage` | `DSH: Set Private Endpoint API Key`, with the harness managed-credential fallback |

The deployed provider profile (endpoint, credential reference, model entry, and
the default model) is written by the launch overlay at the command-line layer,
above the profile. A Models-page edit to those values cannot win: the overlay
replaces the row's configuration and the configuration editor refuses the save.
Changing the company model or its limits is therefore a deployment change
(`dsh.llmModel`, `dsh.llmContextWindow`, `dsh.llmMaxTokens`), not a profile edit.

The company route's Models card keeps its endpoint, model list, and limits
read-only, but its discovery action stays available because it only reads the
endpoint. Each listed candidate offers **Use this model**, which saves that id to
global `dsh.llmModel` through the Webview transport; it does not write the
profile. The card names the saved model, and the existing saved-versus-active
notice offers `Restart DSH`, after which the overlay generates the real model
entry. Other provider routes keep their own editable endpoints and model lists,
so the action appears only on the deployment-owned route.

The overlay pins `agent-default-model` to the company route and its model.
Without that pin a fresh profile keeps the composition default
(`deepseek-official/deepseek-flash`) and tries the public provider first. A
profile-owned model selection would need a first-run step that seeds the
profile; this extension does not add a second writer for that value.

| Setting | Default | Meaning |
| --- | --- | --- |
| `dsh.providerMode` | `openai-compatible` | `deepseek` selects the public DeepSeek API instead |
| `dsh.providerRoute` | `company` | Route name selected by requests (lowercase, hyphenated) |
| `dsh.llmBaseUrl` | — | Chat Completions root, for example `http://llm.lan:8000/v1` |
| `dsh.llmModel` | — | Model id the company route serves and lists |
| `dsh.llmApiKeyEnv` | `DSH_LLM_API_KEY` | Environment name carrying the key into the application |
| `dsh.llmContextWindow` | unset | Context window written into the route's model entry |
| `dsh.llmMaxTokens` | unset | Output-token cap written into the route's model entry |

`dsh.llmContextWindow` and `dsh.llmMaxTokens` describe the deployed model rather
than the adapter. Unset leaves pi-ai's adapter defaults in place: a context
window of 1,000,000 tokens and an output capability of 128,000 tokens. Those are
assumptions, not measurements of the gateway; set the values the endpoint
actually serves, and do not infer them from a model name.

The key itself lives in VS Code `SecretStorage`, never in the generated overlay
or the Harness home. `llm-pi-ai` resolves the `apiKeyEnv` reference per request
through the harness credential seam. `DSH: Clear Private Endpoint API Key`
removes only the SecretStorage value and restarts the host; a managed credential
saved by the Models page still resolves the route, so clearing the secret does
not disable authentication.

`dsh.providerMode`, `dsh.providerRoute`, `dsh.llmBaseUrl`, `dsh.llmModel`,
`dsh.llmApiKeyEnv`, and the two limit settings are read at launch. After a saved
change the extension shows a saved-versus-active notice with a `Restart DSH`
action; it never restarts on its own and states that restarting stops a running
turn.

`DSH: Show Diagnostics` reports the selected provider's stored key state rather
than both stored keys, and redacts credential-bearing userinfo from the endpoint
URL. The route URL must not embed credentials: the extension refuses such a URL
so a key cannot reach the generated overlay.

### Plugins and updates on a private network

- `dsh.localPlugins` mounts plugins that the network already mirrored. Each row
  is `{ id, path }`: the extension writes a `plugins.patch.yml` overlay that
  inserts one Loader row per plugin, pointing at the local directory or module.
  This needs no registry and no Git host — copy the plugin folder or extract a
  tarball inside the network, then list the extracted folder. An archive path
  itself is refused: install archives as bundles from the Plugins page.
- Registry or Git installs go through DSH's profile package operations, run with the staged pnpm from `runtime/node_modules/pnpm`; they need an internal mirror when the network has no public access.
- The Plugins page keeps a saved-versus-active notice for every plugin change that needs a restart and offers `Restart DSH` through the Webview transport. It never restarts on its own and states that restarting stops a running turn. Removing a loaded bundle keeps its stop-profile refusal and points to switch off → restart → remove for the profile this window manages.
- The extension is a VSIX: updating means installing a newer VSIX, which keeps
  `globalStorage` (sessions, credentials, profile) intact. The DSH installation
  is separate — updating it means pointing `dsh.runtimePath` at the new tree and
  running `DSH: Restart Host`.
- The manifest declares the DSH runtime range it supports (`dsh.runtimeRange`).
  Diagnostics reports the installed runtime against that range, for example
  `runtime compatibility: 0.2.2-alpha.2 satisfies >=0.2.2-alpha.2 <0.3.0`, so a
  VSIX and a runtime that were updated separately show their mismatch instead of
  failing later. It also prints `package tooling: pnpm <version> (<entry>)` for
  the payload package operations run, or why that payload is unavailable; no
  credential value appears in either line.

### Intranet update check

The company build sets `dsh.update.feedUrl` to the Windows release share and `dsh.update.checkIntervalMinutes` to 60. The extension checks at activation and on its timer. An automatic check that cannot read the feed only writes to the DSH output channel. An available update appears in the status bar and opens the same details and confirmation as `DSH: Check for Updates`. The user's install action downloads and verifies the VSIX's size and SHA-256 before installation and reload. `apps/vscode/scripts/publish-update.mjs` writes or verifies the feed against `release.json` and the VSIX. See the [intranet update operator guide](../../docs/vscode/INTRANET_UPDATE.md).

## Commands

| Command | Purpose |
| --- | --- |
| `DSH: Open Chat` | Focus the DSH view |
| `DSH: Restart Host` | Dispose and boot the application again |
| `DSH: Configure Company Endpoint` | Save the company endpoint and optional key, then restart through the guarded path |
| `DSH: Show Log` | Open the DSH output channel |
| `DSH: Set DeepSeek API Key` | Store the provider key in VS Code `SecretStorage` |
| `DSH: Clear DeepSeek API Key` | Delete the stored key |
| `DSH: Set Private Endpoint API Key` | Store the company endpoint key in VS Code `SecretStorage` |
| `DSH: Clear Private Endpoint API Key` | Delete the key stored in VS Code for the configured URL |
| `DSH: Run Command in Terminal` | Run a command in the integrated terminal and report its output and exit code |
| `DSH: Show Diagnostics` | Print mode, runtime version, package tooling, provider route, the selected provider's key state and the shell backend to the DSH channel |
| `DSH: Check for Updates` | Read the configured intranet feed and report the available version, notes, and source |
| `DSH: Install Update` | Download, verify, install, and reload for the available update |

The key never enters the Harness home: `credentialEnv()` turns it into
`DEEPSEEK_API_KEY` for the application launch, which is the same layer the CLI
reads. `dsh.apiBaseUrl` (or `DEEPSEEK_BASE_URL`) points the provider at another
Messages-compatible endpoint.

## Verification scripts

One command runs the whole local gate — typecheck, unit tests, bundle and VSIX:

```sh
pnpm --filter @deepseek-ai/dsh-vscode run verify
```

Unit tests cover the host helpers that need neither VS Code nor a running tree:

```sh
pnpm --filter @deepseek-ai/dsh-vscode run test
```

| Script | Checks |
| --- | --- |
| `node --import tsx/esm scripts/boot-smoke.ts` | In-process boot: live services and boot graph |
| `node --import tsx/esm scripts/shell-smoke.ts` | Boot payload, bundle materialization, and one successful unary RPC |
| `node scripts/companion-smoke.mjs` | Companion stdio protocol end to end |
| `node scripts/transport-smoke.mjs` | Fetch metadata and abort, stream uplink, and acknowledged binary upload |
| `node --import tsx/esm scripts/bridge-upload-smoke.ts` | Browser-style upload chunks through the bridge into DSH attachment storage |
| `node scripts/sandbox-smoke.mjs` | Companion shell execution under `workspace-write` without falling back to full access |

`package:release` runs the companion smoke against the selected runtime before
recording it as compatible. The release record therefore carries runtime boot
evidence in addition to the version-range verdict.

For extension activation acceptance, install the VSIX into an extension directory outside the source checkout and run `DSH: Open Chat`. The editor loads the extension entry before the companion starts. The entry bundles its version-range checker, so a standalone installation can load it without access to the checkout's dependencies.
