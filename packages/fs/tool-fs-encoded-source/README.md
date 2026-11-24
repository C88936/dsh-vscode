---
description: "The optional encoding-aware replacement for the read, grep, and glob tools: for users and maintainers of mixed VB6/C# workspaces whose sources are GBK, GB2312, GB18030, UTF-8, UTF-8 with BOM, or UTF-16."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-fs-encoded-source

English | [中文](README.zh.md)

## Summary

Use `dsh-tool-fs-encoded-source` when one workspace mixes legacy codepages with UTF-8 sources: it registers `read`, `grep`, and `glob` under the same names, arguments, result fields, caps, and card presentation as the tools it replaces, and resolves each file's encoding from a byte-order mark, an ordered per-file rule, strict UTF-8, and then an opt-in legacy fallback limited to configured directories and extensions. Legacy files stay read-only: only a file proven to be strict UTF-8 records the observation a later write or edit guards against. The package is optional — a deployment that never installs it keeps the native tools.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The package replaces `read` from `@deepseek-ai/dsh-tool-fs` and both `grep` and `glob` from `@deepseek-ai/dsh-tool-fs-search`, so those two packages must not register the same tools in the same scope. Set the native `read` off, disable the native search row, and mount this plugin in its place:

```yaml
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
  config:
    read: false
- id: tool-fs-search
  name: '@deepseek-ai/dsh-tool-fs-search'
  disabled: true
- insert:
    - id: tool-fs-encoded-source
      name: '@deepseek-ai/dsh-tool-fs-encoded-source'
      config:
        sampleOverCapGlobResults: false
```

`glob` keeps the installed implementation: discovery lists file names, never content, so the plugin calls the original `applyGlobTool` with the same caps.

### Encoding policy

Resolution order is fixed and explicit:

1. A byte-order mark decides, because it is the file's own claim about its bytes. A UTF-8 BOM counts as UTF-8.
2. The first matching rule decides. A rule is an operator's explicit statement about a path, so it also overrides bytes that happen to be valid UTF-8.
3. A strict, fatal UTF-8 decode decides. A file that passes is a UTF-8 file.
4. A configured fallback entry decides, and only when the strict UTF-8 decode failed, the file sits inside one of that entry's directories (resolved against the session working directory), and its suffix is one of that entry's extensions.

Without a BOM, rule, or admitting fallback, an undecodable file fails as `FS_NOT_TEXT` instead of producing replacement characters.

### Read-only legacy files

The `read` tool emits the `fs/observed` present observation only after a strict UTF-8 decode. A file decoded through a legacy codepage therefore records no observation, and the observation policy refuses `write` (its intent becomes "create only") and `edit` (`FS_NOT_OBSERVED`) for that path. This is the first-phase contract: reading legacy sources works, rewriting them does not.

### Configuration

`sampleOverCapGlobResults` is required, exactly as in the replaced search plugin. The remaining keys carry the defaults below.

| Key | Default | Meaning |
|---|---|---|
| `sampleOverCapGlobResults` | none (required) | `true` samples an over-cap `glob` page across top-level entries; `false` keeps the modification-time head |
| `rules` | `[]` | Ordered per-file `{ glob, encoding, mode: decode }` rules; the first matching glob decides |
| `fallback` | `[]` | Opt-in `{ encoding, directories, extensions }` fallbacks; an entry that names neither a directory nor an extension is rejected at load |
| `sourceMaxBytes` | `16777216` | Byte cap on one `grep` candidate read while resolving its encoding |
| `readLimit` | `2000` | Default and maximum lines returned by one `read` call |
| `readMaxLineLength` | `2000` | Character cap per returned line |
| `readMaxBytes` | `51200` | Byte cap on the selected read lines |
| `readStreamMinSize` | `10485760` | Files at or above this size stream instead of loading whole |
| `globMaxResults` | `100` | Max paths one `glob` call shows inline |
| `grepMaxMatches` | `250` | Max flat matches one `grep` call retains inline |
| `grepMaxLineBytes` | `2000` | Byte cap per matched-line preview |
| `searchMetaMaxBytes` | `65536` | Max bytes of one search's serialized `presentationMeta` |
| `rawOutputMaxBytes` | `20000000` | Max complete raw `rg` stdout one search parses |
| `graceMs` | `3000` | Terminate-escalation grace handed to the subprocess seam |
| `stderrMaxBytes` | `65536` | Diagnostic-tail budget for `rg` stderr |
| `timeoutMs` | `30000` | Cooperative tool-call budget on all three tools |

### Binary resources

`.frx` form resources are binary. `read` rejects them as `FS_NOT_TEXT`, and `grep` never reports a match whose path ends with `.frx`, whether the match came from the raw pass or from a mirror.

### Deployment requirement

The tools need a `ctx.fs` backend that can return raw bytes (`readBytes`, `readByteRange`), a `ctx.subprocess` backend for the packaged ripgrep binary, and the `workingDirectory` service that resolves the session directory relative configuration resolves against.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

Two facts drive the design. A codepage decision needs the bytes, so `read` asks the filesystem seam for raw bytes instead of decoded text. And a ripgrep pattern is UTF-8, so it can never match the GBK bytes of the same Chinese text, which is why `grep` adds a second pass over decoded copies of exactly the files a single pass cannot read.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Function plugin: `name`, `inject`, `Config`, `apply`, cap validation |
| [`src/encoding-policy.ts`](src/encoding-policy.ts) | Schemastery config, glob matching, and the fixed resolution order |
| [`src/decode.ts`](src/decode.ts) | Fatal whole-file and stream decoding, BOM stripping, observation fact |
| [`src/read-render.ts`](src/read-render.ts) | The read window, envelope, language hint, and metadata narrowing the replaced tool renders |
| [`src/read.ts`](src/read.ts) | `read` schema, target resolution, policy application, observation rule |
| [`src/grep.ts`](src/grep.ts) | `grep` schema, two-pass search, mirror lifecycle, retention, spill |
| [`src/glob.ts`](src/glob.ts) | Registers the installed `applyGlobTool` with this deployment's caps |

### How a search runs

The first ripgrep pass is the installed command, unchanged, so regex semantics, path and include handling, ignore rules, exit-code classification, and the raw-output budget are the originals. Candidates are then enumerated with `rg --files` under the same path and include rules, and each candidate's bytes are decoded with the shared policy. Only candidates that resolve to a legacy codepage are mirrored into one fresh temporary directory as UTF-8, and a second `rg --json` invocation searches that directory with the model's pattern. Match paths are mapped back to the workspace display path, and the two match lists are merged by `(path, lineNumber)` with the decoded text preferred, because the raw pass reports a placeholder for a non-UTF-8 line.

The temporary directory is removed in a `finally` block, so success, failure, and cancellation all clean it up.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Filesystem subsystem](../../../docs/subsystems/filesystem.md) — the `ctx.fs` contract, the observation events, and the error taxonomy.
- [tool-fs](../tool-fs/README.md) — the native `read` this package mirrors, plus `write` and `edit`, which stay native.
- [tool-fs-search](../tool-fs-search/README.md) — the native `grep` and `glob` this package replaces.
- [Filesystem package group](../README.md) — the sibling packages and their roles.

-----

<a id="model-experience"></a>
## Model Experience

### System prompt

#### What the model sees

The three guidance sections keep the text the replaced tools register, and each renders only while its tool is visible in the current scope:

```markdown
Use the read tool — not shell commands like cat — to inspect text files. Use offset and limit to continue reading large files.
```

```markdown
Use the grep tool — not shell grep or rg — to search file contents. Use read on a matched file when you need surrounding context.
```

```markdown
Use the glob tool — not shell find — to discover files by path pattern.
```

#### Token effect

Guidance cost follows the visible tools and is identical to a composition that mounts the replaced tools.

#### KV Cache effect

Prefix-stable while the visible tool set and guidance text are unchanged; disposal or a scoped restriction may invalidate reuse from the first changed section.

### Tool schemas

#### What the model sees

`read`, `grep`, and `glob` keep their names, argument schemas, and descriptions, with one deliberate edit: `read` no longer says "UTF-8", because it now reads text in the configured encodings. `grep` still advertises its inline match cap and spill recovery.

#### Token effect

Fixed schema cost on every request where the tools are visible, matching the replaced suite.

#### KV Cache effect

Prefix-stable while tool visibility and definitions are unchanged.

### Results

#### What the model sees

`read` returns the same `<path>` / `<type>` / `<content>` envelope with numbered lines and the continuation or end-of-file footer, now carrying text decoded through the policy. `grep` and `glob` return their original grouped text, caps, footers, and spill locators.

#### Token effect

Bounded by the read window, `readMaxBytes`, `globMaxResults`, `grepMaxMatches`, `grepMaxLineBytes`, and `searchMetaMaxBytes`.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Tool errors

#### What the model sees

An undecodable file fails as `cannot read "<path>": the file is not valid UTF-8 and no configured fallback encoding applies`, a `.frx` target as a binary resource, and searches keep the package-owned `SEARCH_*` codes of the replaced tool.

#### Token effect

Only a failing call adds these retained tokens.

#### KV Cache effect

Append-only.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Legacy sources are read-only** — a file decoded through a legacy codepage records no observation, so `write` (create only) and `edit` (`FS_NOT_OBSERVED`) stay blocked for it until a future encoding-aware write path exists.
- **A streamed file cannot use the fallback** — above `readStreamMinSize` the read decodes from the BOM, a rule, or strict UTF-8 only, because the fallback's precondition is discovered after the stream has been consumed; a large file that needs a legacy fallback must be named by a rule.
- **Search cost grows with the candidate count** — every candidate's bytes are read once to resolve its encoding. A very large workspace makes an encoding-aware `grep` slower than the native one, which is why the bundle is opt-in.
- **Regex syntax is ripgrep's** — both passes use the same pattern and engine, so lookaround and backreferences stay unsupported, and the pattern is never reinterpreted per codepage.
- **`.frx` is binary** — form resources are never read or matched as text, even when their bytes happen to decode.
- **A Web profile needs its preset layer** — when the agent tool rows live inside an Agent preset, the Loader patch composer cannot address them by id; `apps/vscode/deploy/encoded-source/presets.patch.yml` carries that layer and must be regenerated when the shipped presets change.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The read window, envelope, and result-metadata narrowing duplicate `@deepseek-ai/dsh-tool-fs`'s `read-render.ts` on purpose: the replacement has to render byte-identical text and persisted metadata, and that module is not exported from the installed package root. Keep the two in step, or promote the render helpers to a shared export.

</details>
