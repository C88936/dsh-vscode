# DSH for VS Code (fork)

This repository is a fork of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that adds a VS Code extension under `apps/vscode`: the DSH application boots beside the extension host and renders its own client shell in a webview.

- Upstream: deepseek-ai/deepseek-harness, tag `dsh-v0.2.3-alpha.2`
- Extension: `apps/vscode` (TypeScript, VS Code 1.96 or newer)
- Licence: MIT (see `LICENSE`); third-party notices stay in `THIRD_PARTY_NOTICES.md`

## Build

Prerequisites: Windows 10/11 x64, Node.js 24.22.3 or newer, pnpm 11.x.

```sh
node apps/vscode/scripts/bootstrap-vscode.mjs
```

That runs dependencies, artifacts, the extension bundle, the Office payload, the managed runtime and the VSIX packaging in order, then prints the artifact path and SHA-256. [`docs/vscode/SELF_DEPLOY.md`](docs/vscode/SELF_DEPLOY.md) documents every step, the offline equivalents, and troubleshooting.

What this fork adds, what an intranet deployment needs, what to configure, what can fail and what is not verified yet: [`docs/vscode/WHAT_WE_DID.md`](docs/vscode/WHAT_WE_DID.md) (written in Chinese).

Deployment defaults, intranet review records and packaged runtimes are not part of this repository.
