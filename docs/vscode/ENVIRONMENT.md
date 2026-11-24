# Environment

Recorded at fork creation.

```text
DSH source version: 0.2.2-alpha.2
Engine requirement: Node >=24.9.0
Package manager declared by DSH: pnpm@11.28.5
Host machine Node: 24.19.0
Host machine pnpm: 10.8.1
```

Before installing, align pnpm with the repository declaration. Do not silently
change the DSH engine or package-manager version to make a local command pass.

## Docker

The separate DSH product does not use MesCode's Docker visual harness. Docker
is not a product runtime dependency.

## VS Code

The extension target version will be recorded in `apps/vscode/package.json` when
that manifest is created. Do not reuse MesCode's VSIX metadata.
