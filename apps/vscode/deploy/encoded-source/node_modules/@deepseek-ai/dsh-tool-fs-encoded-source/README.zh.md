---
description: "read、grep 与 glob 的可选编码感知替代实现：供 VB6/C# 混合工作区（源码为 GBK、GB2312、GB18030、UTF-8、带 BOM 的 UTF-8 或 UTF-16）的用户与维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-fs-encoded-source

[English](README.md) | 中文

## 概述

当一个工作区把旧编码源码与 UTF-8 源码混在一起时，使用 `dsh-tool-fs-encoded-source`：它以与被替代工具相同的名称、参数、结果字段、上限和卡片呈现注册 `read`、`grep` 与 `glob`，并按字节序标记、有序的按文件规则、严格 UTF-8、最后是限于已配置目录与扩展名的可选旧编码回退来逐文件确定编码。旧编码文件保持只读：只有被证明为严格 UTF-8 的文件才记录后续写入或编辑所依据的观察。本包是可选能力——不安装它的部署继续使用原生工具。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

本包替代 `@deepseek-ai/dsh-tool-fs` 的 `read`，以及 `@deepseek-ai/dsh-tool-fs-search` 的 `grep` 与 `glob`，因此这两个包不得在同一作用域注册同名工具。关闭原生 `read`、停用原生搜索条目，并在原位置挂载本插件：

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

`glob` 沿用已安装的实现：文件发现只列路径、从不读内容，因此插件以相同上限调用原始 `applyGlobTool`。

### 编码政策

解析顺序固定且显式：

1. 字节序标记优先，因为它是文件对自身字节的声明。带 BOM 的 UTF-8 按 UTF-8 处理。
2. 第一条匹配的规则优先。规则是运维人员对某路径的显式声明，因此它也会覆盖恰好是合法 UTF-8 的字节。
3. 严格、fatal 的 UTF-8 解码通过时按 UTF-8 处理。
4. 已配置的回退条目生效，且仅当严格 UTF-8 解码失败、文件位于该条目的某个目录内（相对 Session 工作目录解析）、扩展名属于该条目所列扩展名时。

没有 BOM、规则或可用回退时，无法解码的文件以 `FS_NOT_TEXT` 失败，而不是产生替换字符。

### 只读的旧编码文件

`read` 工具只在严格 UTF-8 解码之后发出 `fs/observed` 的 present 观察。因此经旧编码解码的文件不会记录观察，观察策略对该路径拒绝 `write`（其意图变为"仅新建"）与 `edit`（`FS_NOT_OBSERVED`）。这是第一阶段的约定：读取旧编码源码可用，重写不可用。

### 配置

`sampleOverCapGlobResults` 是必填项，与被替代的搜索插件一致。其余键使用下表默认值。

| 键 | 默认值 | 含义 |
|---|---|---|
| `sampleOverCapGlobResults` | 无（必填） | `true` 时超限 `glob` 页在顶层条目间取样；`false` 时保留按修改时间排序的开头部分 |
| `rules` | `[]` | 有序的按文件 `{ glob, encoding, mode: decode }` 规则；第一条匹配的 glob 决定编码 |
| `fallback` | `[]` | 可选的 `{ encoding, directories, extensions }` 回退；既未写目录也未写扩展名的条目在加载时被拒绝 |
| `sourceMaxBytes` | `16777216` | `grep` 解析候选编码时单文件读取的字节上限 |
| `readLimit` | `2000` | 单次 `read` 返回的默认与最大行数 |
| `readMaxLineLength` | `2000` | 单行返回的字符上限 |
| `readMaxBytes` | `51200` | 已选读取行的字节上限 |
| `readStreamMinSize` | `10485760` | 达到该大小的文件改为流式读取，而非整体载入 |
| `globMaxResults` | `100` | 单次 `glob` 内联展示的最大路径数 |
| `grepMaxMatches` | `250` | 单次 `grep` 内联保留的最大匹配数 |
| `grepMaxLineBytes` | `2000` | 每条匹配行预览的字节上限 |
| `searchMetaMaxBytes` | `65536` | 单次搜索序列化 `presentationMeta` 的字节上限 |
| `rawOutputMaxBytes` | `20000000` | 单次搜索解析的完整 `rg` 原始输出字节上限 |
| `graceMs` | `3000` | 交给子进程缝隙的终止升级宽限期 |
| `stderrMaxBytes` | `65536` | `rg` stderr 的诊断尾部预算 |
| `timeoutMs` | `30000` | 三个工具共享的协作式工具调用预算 |

### 二进制资源

`.frx` 窗体资源是二进制。`read` 以 `FS_NOT_TEXT` 拒绝它，`grep` 也从不报告路径以 `.frx` 结尾的匹配，无论该匹配来自原始扫描还是镜像扫描。

### 部署要求

这些工具需要一个能返回原始字节（`readBytes`、`readByteRange`）的 `ctx.fs` 后端、一个用于内置 ripgrep 二进制的 `ctx.subprocess` 后端，以及解析 Session 目录的 `workingDirectory` 服务——配置中的相对目录按该目录解析。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

### 设计概念

两个事实决定了设计。编码判断需要字节，因此 `read` 向文件系统缝隙索取原始字节而不是解码后的文本。而 ripgrep 的模式是 UTF-8，永远无法匹配同一段中文的 GBK 字节，因此 `grep` 对单次扫描无法读取的那些文件的解码副本追加第二遍扫描。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 函数插件：`name`、`inject`、`Config`、`apply` 与上限校验 |
| [`src/encoding-policy.ts`](src/encoding-policy.ts) | schemastery 配置、glob 匹配与固定的解析顺序 |
| [`src/decode.ts`](src/decode.ts) | 整文件与流的 fatal 解码、BOM 剥离、观察事实 |
| [`src/read-render.ts`](src/read-render.ts) | 被替代工具呈现的读取窗口、信封、语言提示与元数据收窄 |
| [`src/read.ts`](src/read.ts) | `read` 模式、目标解析、政策应用与观察规则 |
| [`src/grep.ts`](src/grep.ts) | `grep` 模式、两遍搜索、镜像生命周期、保留与 spill |
| [`src/glob.ts`](src/glob.ts) | 以本部署的上限注册已安装的 `applyGlobTool` |

### 搜索如何执行

第一遍 ripgrep 就是已安装的命令，未做改动，因此正则语义、路径与 include 处理、忽略规则、退出码分类与原始输出预算都保持原样。随后用 `rg --files` 在相同的路径与 include 规则下列出候选，并用共享政策解码每个候选的字节。只有解析为旧编码的候选才被镜像到一个新建的临时目录（UTF-8），再由第二次 `rg --json` 调用以模型的模式搜索该目录。匹配路径被映射回工作区展示路径，两份匹配列表按 `(path, lineNumber)` 合并，并优先采用解码后的文本，因为原始扫描对非 UTF-8 行只给出占位符。

临时目录在 `finally` 块中删除，因此成功、失败与取消都会清理它。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [文件系统子系统](../../../docs/subsystems/filesystem.zh.md) — `ctx.fs` 契约、观察事件与错误分类。
- [tool-fs](../tool-fs/README.zh.md) — 本包镜像的原生 `read`，以及保持原生的 `write` 与 `edit`。
- [tool-fs-search](../tool-fs-search/README.zh.md) — 本包替代的原生 `grep` 与 `glob`。
- [文件系统包组](../README.zh.md) — 同级包及其角色。

-----

<a id="model-experience"></a>
## 模型体验

### 系统提示

#### 模型看到什么

三个指引小节保持被替代工具注册的文本，并且各自只在当前作用域内其工具可见时渲染：

```markdown
Use the read tool — not shell commands like cat — to inspect text files. Use offset and limit to continue reading large files.
```

```markdown
Use the grep tool — not shell grep or rg — to search file contents. Use read on a matched file when you need surrounding context.
```

```markdown
Use the glob tool — not shell find — to discover files by path pattern.
```

#### Token 影响

指引开销随可见工具变化，与挂载被替代工具的组合同样大小。

#### KV 缓存影响

在可见工具集与指引文本不变时前缀稳定；卸载或作用域限制可能从第一个变化的段落起使复用失效。

### 工具模式

#### 模型看到什么

`read`、`grep` 与 `glob` 保持名称、参数模式与描述，只有一处有意改动：`read` 不再声称"UTF-8"，因为它现在按配置的编码读取文本。`grep` 仍声明其内联匹配上限与 spill 恢复路径。

#### Token 影响

在工具可见的每个请求上都有固定的模式开销，与被替代的套件一致。

#### KV 缓存影响

在工具可见性与定义不变时前缀稳定。

### 结果

#### 模型看到什么

`read` 返回相同的 `<path>` / `<type>` / `<content>` 信封、带行号的正文与续读或文件结束脚注，其中文本已按政策解码。`grep` 与 `glob` 返回原有的分组文本、上限、脚注与 spill 定位符。

#### Token 影响

受读取窗口、`readMaxBytes`、`globMaxResults`、`grepMaxMatches`、`grepMaxLineBytes` 与 `searchMetaMaxBytes` 约束。

#### KV 缓存影响

仅追加；新增可见内容接在可复用的请求前缀之后，不会使已有 KV 缓存条目失效。

### 工具错误

#### 模型看到什么

无法解码的文件以 `cannot read "<path>": the file is not valid UTF-8 and no configured fallback encoding applies` 失败，`.frx` 目标按二进制资源失败，搜索保留被替代工具的包自有 `SEARCH_*` 错误码。

#### Token 影响

只有失败的调用才会增加这些留存 token。

#### KV 缓存影响

仅追加。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **旧编码源码只读** — 经旧编码解码的文件不记录观察，因此在出现编码感知的写入路径之前，该路径的 `write`（仅新建）与 `edit`（`FS_NOT_OBSERVED`）一直被阻止。
- **流式文件无法使用回退** — 超过 `readStreamMinSize` 时，读取只依据 BOM、规则或严格 UTF-8 解码，因为回退的前提在流已被消费之后才被发现；需要旧编码回退的大文件必须由规则指明。
- **搜索开销随候选数量增长** — 每个候选的字节都会被读取一次以解析编码。极大工作区会让编码感知的 `grep` 慢于原生版本，这也是该组合包默认不启用的原因。
- **正则语法即 ripgrep 语法** — 两遍使用同一模式与引擎，因此环视与反向引用仍不支持，模式也不会按编码重新解释。
- **`.frx` 是二进制** — 窗体资源从不会被当作文本读取或匹配，即使其字节恰好可以解码。
- **Web 配置需要预设层** — 当 agent 工具条目位于 Agent 预设内部时，Loader 补丁组合器无法按 id 定位它们；`apps/vscode/deploy/encoded-source/presets.patch.yml` 承载该层，随出厂预设变化需重新生成。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

读取窗口、信封与结果元数据收窄刻意复制了 `@deepseek-ai/dsh-tool-fs` 的 `read-render.ts`：替代实现必须渲染逐字节相同、且持久化元数据一致的文本，而该模块并未从已安装包根导出。请保持两者同步，或将渲染辅助函数提升为共享导出。

</details>
