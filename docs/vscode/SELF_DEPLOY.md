# Building a VSIX from source

This page takes a clean checkout to one installable `dsh-vscode.vsix`. It is written for someone who has the repository and nothing else.

## Prerequisites

- Windows 10 or 11 on x64. The packaged runtime is `win32-x64` only; the runtime preparation step refuses another host.
- Node.js 24.22.3 or newer in the 24.x line, or 26.13.1 and newer. The workspace `engines` field enforces it.
- pnpm 11.x. `corepack enable` installs the pinned version from the `packageManager` field.
- Network access to the npm registry for `pnpm install`, and to PyPI for the Office authoring payload wheels.
- About 3 GB free disk: dependencies, build outputs, a ~1 GB unpacked runtime, and the ~325 MB VSIX.

## One command

```powershell
node apps/vscode/scripts/bootstrap-vscode.mjs
```

The script checks the platform, Node and pnpm versions, then runs the release chain and prints the VSIX path, size and SHA-256.

## What it runs

| Step | Command | Result |
|---|---|---|
| Dependencies | `pnpm install` | workspace links and the lockfile's package set |
| Artifacts | `pnpm run build:artifacts` | host bundles, client bundles, the Web shell |
| Extension | `pnpm --filter @deepseek-ai/dsh-vscode run build` | `apps/vscode/lib` |
| Office payload | `node scripts/primary-runtime/prepare.ts --target win-x64 --output .tmp/office --python-only` | pinned Python plus the document libraries |
| Runtime | `node apps/vscode/scripts/prepare-standalone-runtime.mjs --office-payload .tmp/office/primary-runtime` | `apps/vscode/runtime` with Node, pnpm and the DSH closure |
| Package | `pnpm --filter @deepseek-ai/dsh-vscode run package:release` | `apps/vscode/dsh-vscode.vsix` and `release.json` |

`--skip-install` reuses an existing `node_modules`. `--skip-office` reuses an existing `.tmp/office/primary-runtime`.

## Offline or air-gapped builds

Each networked step has a prepared-input equivalent; run the networked half on a connected machine and carry the output across.

- **npm packages.** On the connected machine run `pnpm fetch` (or one `pnpm install`), then copy the store directory `.pnpm-store` with the checkout. `pnpm install --offline` on the target consumes it.
- **Office payload.** Build `.tmp/office/primary-runtime` on the connected machine and copy it in; pass the same path to the runtime step.
- **Runtime deploy.** `prepare-standalone-runtime.mjs` deploys with `--offline`, so the store must carry the closure. A store built by `pnpm install` in the same checkout does.

The packaged runtime never downloads anything at run time.

## Verifying the result

- `package:release` refuses a runtime that does not satisfy `dsh.runtimeRange`, prints the VSIX SHA-256, and verifies the Office payload before writing `release.json`.
- Install with `code --install-extension apps/vscode/dsh-vscode.vsix`, then reload the window.
- `DSH: Show Diagnostics` prints the boot mode, runtime version and installation path, the Harness home, the working directory, the provider route, key presence and the shell backend.

## Where the pieces live

| Concern | File |
|---|---|
| Extension manifest, settings, commands | `apps/vscode/package.json` |
| Extension sources | `apps/vscode/src` |
| VS Code composition overlay | `apps/vscode/profile/vscode.patch.yml` |
| Runtime closure (generated) | `apps/vscode/deploy/package.json`, produced by `apps/vscode/scripts/sync-deploy-closure.mjs` |
| VSIX packaging | `apps/vscode/scripts/package-vsix.mjs`, `package-release.mjs` |
| Runtime staging and pruning | `apps/vscode/scripts/prepare-standalone-runtime.mjs`, `runtime-layout.mjs` |
| Office payload pins | `scripts/primary-runtime/lock.json` |

## Troubleshooting

- **`Node ... or newer is required`** — the bootstrap check compares against 24.22.3; switch Node and rerun.
- **`spawnSync pnpm ENOENT` or `EINVAL`** — the script runs pnpm through a Windows shell because Node refuses to spawn a `.cmd` shim directly; if you replaced the script, keep that behaviour.
- **`the Office authoring payload is missing`** — run without `--skip-office`, or pass your prepared payload to the runtime step.
- **`ERR_PNPM_NO_OFFLINE_...` during the runtime deploy** — the offline store lacks a package in the closure; refresh it with a connected `pnpm install`.
- **`EPERM ... mkdir ...\Temp\...` during the runtime boot check** — the companion's sandbox is rooted at the extension, so its smoke storage lives under `apps/vscode/.tmp/companion-smoke`; a build script that points it at the system temp root reintroduces the Windows ACL path.
- **`runtime layout validation failed`** — a foreign prebuild survived pruning; report it with the failing path rather than deleting the rule.
