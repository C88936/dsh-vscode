# MES 国标编码读取与搜索（可选组合包）

「MES 国标编码读取与搜索」是适用于 VS Code 扩展 0.1.0（内置运行时 0.2.2-alpha.2）的可选组合包。它为 VB6/C# 混合工程提供 `read`、`grep` 和 `glob`，可读取和搜索 GB18030、GBK、GB2312 及 UTF-8 源码。

## 目的

DSH 原生的 `read` 只接受严格 UTF-8，原生 `grep` 没有编码参数，因此 GBK/GB2312/GB18030 源码里的中文既读不出来也搜不到。本组合包在**安装后**用同名、同参数、同结果字段、同上限与同卡片呈现的三个工具替代原生实现：`read` 与 `grep` 由 `packages/fs/tool-fs-encoded-source` 提供，`glob` 直接复用已安装的原始 `applyGlobTool`。未安装时行为与现在完全一致。

编码判定顺序固定：字节序标记（BOM）→ 有序的按文件规则 → 严格 UTF-8 → 仅限已配置目录与扩展名的旧编码回退。`.frx` 按二进制处理，永不作为文本读取或匹配。

## 交付物与当前位置

| 路径 | 作用 |
|---|---|
| `packages/fs/tool-fs-encoded-source/` | 新包：`read`/`grep`/`glob` 的实现与测试 |
| `apps/vscode/deploy/encoded-source/package.json` | 组合包声明（`dsh.bundle.patch` 只列 `presets.patch.yml`） |
| `apps/vscode/deploy/encoded-source/presets.patch.yml` | 组合包实际应用的唯一补丁层：只在 `preset-standard`、`preset-ptc` 内接管 |
| `apps/vscode/deploy/encoded-source/cordis.base.patch.yml` | 可选样例，**不在** `dsh.bundle.patch` 中：仅供顶层就是工具条目的 base/headless 组合手工套用 |
| `apps/vscode/deploy/encoded-source/dsh-prepared-bundle.json` | `dsh-prepared-bundle/v1` 离线闭包记录 |
| `apps/vscode/deploy/encoded-source/prepare-presets-patch.mjs` | 从已安装的 `@deepseek-ai/dsh-web-app` 预设重新生成 `presets.patch.yml` |

Web 配置把 agent 工具条目放在 Agent 预设的 `config.plugins` 里。Loader 的补丁组合器只按 id 索引顶层条目与 `group: true` 的子条目，无法按 id 定位预设内部的条目，因此 `presets.patch.yml` 的做法是**整份替换** `preset-standard` 与 `preset-ptc` 的 `config`。出厂预设变化后必须重新生成该文件。

启用范围只限标准与 PTC 两个预设。顶层 `insert` 会把替换工具注册给所有 Agent，实测会让本没有这些工具的 Minimal 预设也出现 `read`、`grep`、`glob`；因此组合包不应用 `cordis.base.patch.yml`。该样例只在确实把 `tool-fs`/`tool-fs-search` 作为顶层条目挂载的组合里手工使用，Minimal 预设由出厂文件定义、不被本组合包改写。

## 离线闭包（已内置）

组合包按 `dsh-prepared-bundle/v1` 记录依赖闭包，插件包已在闭包内，不需要安装侧另行提供：

| 文件 | 内容 |
|---|---|
| `tarballs/deepseek-ai-dsh-tool-fs-encoded-source-0.2.2-alpha.2.tgz` | `pnpm pack` 生成的插件包（`lib/index.js`、`lib/types/**`、README 与 LICENSE） |
| `node_modules/@deepseek-ai/dsh-tool-fs-encoded-source/` | 记录中 `packages[].path` 指向的安装后副本 |
| `pnpm-lock.yaml` | 该依赖的 importers、packages、snapshots 条目 |
| `dsh-prepared-bundle.json` | `hostProvided` 为空，`packages[].integrity` 与锁文件、tarball 的 sha512 三者一致 |

校验结果：用插件管理器的 `readPreparedBundle('path', <组合包目录>)` 读取，返回 `offline: "proven"`、`problems: []`、1 个闭包包和 1 个 tarball。重新校验的仓库内命令：

```sh
node --import tsx/esm --eval "import { readPreparedBundle } from './packages/boot/plugin-manager/src/local-bundle.ts'; const r = readPreparedBundle('path', '<组合包目录>'); console.log(r.ok ? r.closure.offline : r.reason)"
```

重建插件包时依次执行：`tsc -b packages/fs/tool-fs-encoded-source/tsconfig.json` 生成 `lib/types`，用 tsdown 把 `lib/types/index.js` 打成 `lib/index.js`（外部依赖保持 `@deepseek-ai/*` 与 `node:` 内置模块），`pnpm --dir packages/fs/tool-fs-encoded-source pack --pack-destination <组合包>/tarballs`，解包到 `node_modules/@deepseek-ai/dsh-tool-fs-encoded-source`，再按新的 tarball 摘要更新锁文件、记录里的 `integrity` 和锁文件 `sha256`。`.gitignore` 之外的构建产物（`lib/`）不随仓库分发，重建前需先构建。

## 安装与启用

1. 把整个 `apps/vscode/deploy/encoded-source/` 目录复制到内网可达位置。
2. 在 DSH 的 **插件** 页面，打开 **添加插件** 右侧的下拉菜单，选择 **从插件文件夹安装**，指向包含 `dsh-prepared-bundle.json` 的目录并确认安装。命令行维护人员也可对同一 profile 执行 `dsh plugin --profile <profile> add <组合包目录>`。
3. 按插件页提示重启 DSH，也可在 VS Code 命令面板运行 `DSH: Restart Host`。重启后，组合包自动在标准和 PTC 预设中接管读搜工具，无需逐个关闭原生工具。选用其他预设的会话继续使用该预设原有的工具。
4. 确认生效：新会话里 `read` 的工具描述不再写 “UTF-8”，`grep` 能搜到 GBK 文件中的中文。
5. 若 `presets.patch.yml` 需要随出厂预设更新，执行 `node prepare-presets-patch.mjs <已安装的 @deepseek-ai/dsh-web-app 包目录>` 覆盖生成，然后重启。

## 停用

1. 在 Plugins 页面停用（或移除）该组合包。
2. 重启 DSH。组合包的补丁层消失，`preset-standard`、`preset-ptc` 回到出厂定义，原生 `tool-fs`（含 `read`）与 `tool-fs-search`（`grep`、`glob`）重新接管。
3. 旧会话仍可打开；历史里的读取卡片与检索卡片按会话日志回放，不依赖插件是否安装。

## VB6/C# 工作区配置样例

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
        fallback:
          - encoding: gb18030
            extensions:
              - .cls
              - .bas
              - .frm
              - .ctl
              - .pag
              - .vbp
              - .cs
              - .csproj
```

说明：随包配置不带按路径规则，只用扩展名限定的旧编码回退。严格 UTF-8 能解开的文件（包括原本就是 UTF-8 的 `.cls`、`.cs`）继续按 UTF-8 读取；只有严格 UTF-8 失败且扩展名在列表内时，才按 GB18030 解码。GB18030 是 GB2312 与 GBK 的超集，一份回退条目即可覆盖三种旧码页；`encoding` 可按工程实际情况改成 `gbk`、`gb2312`、`utf-16le` 等本包支持的编码。相对目录按 Session 工作目录解析；不写 `directories` 表示扩展名列表在整个工作区生效。`rules` 是更强的显式声明：命中后即使字节恰好是合法 UTF-8 也按声明的编码解码，仅在某条路径确实已知为旧编码、却能被 UTF-8 误解开时使用。UTF-16 不写配置：带 BOM 的文件由 BOM 判定，无 BOM 的 UTF-16 不在本包判定范围内。

## 验收走查

前置：用独立的 VS Code 配置与一份 VB6/C# 混合测试工程，工程内至少包含 GBK 的 `.cls`、GB2312 的 `.bas`、GB18030 的 `.frm`、UTF-8 的 `.cs`、带 BOM 的 `.csproj`、UTF-16 的 `.cs` 与一个 `.frx`。

1. **中文检索**：新会话里请模型用 `grep` 搜索一个只出现在旧编码文件里的中文词。预期：结果按文件分组，`Line N:` 后是解码后的中文，行号与文件一致；`.frx` 从不出现。
2. **读命中行**：对命中文件调用 `read`（可用 `offset`/`limit` 跳到命中行）。预期：返回相同的 `<path>/<type>/<content>` 信封，行号与检索一致，行尾是续读或文件结束脚注。
3. **点回编辑器**：点击读取卡片或检索卡片中的文件位置。预期：VS Code 打开对应文件并定位到同一行。旧编码文件在编辑器里显示为乱码属于预期，因为定位的是文件本身而不是解码视图。
4. **重开会话**：关闭并重新打开该会话。预期：历史中的读取与检索卡片、行号与定位仍可回放；再次检索仍然命中。
5. **标准与 PTC 两种模式**：分别在标准预设与 PTC 预设下重复第 1～4 步。PTC 模式经 `run_code` 调用同一批工具，结果与标准模式一致。
6. **停用后回到原生工具**：按“停用”一节移除组合包并重启，重复第 1 步。预期：`grep` 不再命中旧编码文件中的中文（原生实现只按 UTF-8 处理），`read` 打开旧编码文件报 `FS_NOT_TEXT`；`.cs` 等 UTF-8 文件仍正常。

每次走查记录：扩展与运行时版本、组合包目录摘要、profile 名称、实际执行的命令与结果、仍待验证项。只写已实际观察到的结果。

## 旧编码只读限制

`read` 只在严格 UTF-8 解码成功后发出 `fs/observed` 的 present 观察。经旧编码解码的文件不记录观察，因此观察策略对该路径下 `write` 的意图是“仅新建”，`edit` 直接以 `FS_NOT_OBSERVED` 拒绝。第一期只提供读取与检索，旧编码写回不在本组合包范围内。

## 已知限制

- **正则语法**：两遍检索使用同一 ripgrep 模式与引擎，环视与反向引用仍不支持；模式不会按编码重新解释。
- **文件大小**：超过 `readStreamMinSize`（默认 10 MiB）的文件改为流式解码，此时只依据 BOM、规则或严格 UTF-8，无法使用旧编码回退，因为回退的前提在流被消费之后才发现；这类大文件必须由规则指明编码。`grep` 解析候选编码时单文件读取受 `sourceMaxBytes`（默认 16 MiB）限制，超限的候选只被原始扫描覆盖。
- **二进制**：前 8192 字节含 NUL 的字节按二进制处理，`read` 以 `FS_NOT_TEXT` 拒绝，与原生读取一致；带 BOM 的 UTF-16 不受此规则影响。
- **`.frx`**：窗体资源按二进制处理，`read` 以 `FS_NOT_TEXT` 拒绝，`grep` 从不报告以 `.frx` 结尾的匹配。
- **检索成本**：编码感知的 `grep` 只为可能命中编码政策的候选读取字节——即路径命中 `rules` 或扩展名在 `fallback` 列表内；其余候选只走原生 ripgrep 扫描。这样普通工程不会为每个文件多读一次，但旧编码候选多时需要把解码文本写入临时目录再检索，工程越大越明显；这也是该组合包保持可选的原因。
- **预设层**：`presets.patch.yml` 整份重写 `preset-standard` 与 `preset-ptc` 的插件列表，出厂预设变化（新增或改名条目）后必须重新生成，否则该预设会缺少新条目。

## 本次已执行的验证

以下结果由源码仓内实际运行得到，仅覆盖本页所述范围：

- `pnpm exec vitest run packages/fs/tool-fs-encoded-source/tests`：5 个测试文件、73 项测试通过。覆盖编码政策顺序、六种编码解码、二进制 NUL 样本拒绝（含流式）与 UTF-16 豁免、读取窗口/上限/信封/元数据与原生工具逐项一致、`read` 与 `grep` 暴露给 PTC 的参数与输出 schema 与原生工具一致、旧编码读取不产生观察而 UTF-8 读取产生观察、各编码中文检索与行号、include 过滤、上限与 spill、取消、`.frx` 排除、重复匹配消除、组合包记录与 tarball/锁文件摘要一致性、启用范围（无工具条目的组合不新增 `read`/`grep`/`glob`，Minimal 预设原样保留），以及通过 Loader 加载测试专用 `cordis.yml` 并叠加 `presets.patch.yml`（顶层样例另测）后的真实组合（模型可见的 `read`、`grep`、`glob` 结果）。
- 构建：`tsc -b packages/fs/tool-fs-encoded-source/tsconfig.json` 生成 `lib/types`；tsdown 打包出 `lib/index.js`（55,384 字节），外部依赖只有 `@deepseek-ai/*` 与 `node:` 内置模块；在该包目录 `node -e "import('./lib/index.js')"` 加载成功，导出 `name`、`inject`、`Config`、`apply`。
- 闭包：`readPreparedBundle('path', <组合包目录>)` 返回 `offline: "proven"`、`problems: []`、1 个闭包包、1 个 tarball。
- `node --import tsx/esm scripts/verify-translation-pairing.ts packages/fs/tool-fs-encoded-source/README.md`：该双语对一致。

隔离运行时已验证离线安装、标准和 PTC 读搜、Minimal 预设保持原工具集，以及停用后恢复原生读搜。VS Code 中点击命中行回编辑器和重开完整会话仍待实机验证。安装级证据见[验收交接记录](READINESS_HANDOFF.md)。
