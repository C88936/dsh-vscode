# 我们在 DSH 上做了什么

English summary: this fork adds a VS Code extension over DeepSeek Harness, an offline runtime, a deployment-owned model route, the official MCP manager and a memory plugin. It also lists what an intranet deployment needs, how to build from source, what fails, and what is not verified yet.

## 一、与上游的差别

上游 DeepSeek Harness 自带 CLI、Web 与 Desktop 三种形态。这个 fork 只保留一条产品线：**在 VS Code 里使用 DSH**。

| 增加或改变 | 位置 | 说明 |
|---|---|---|
| VS Code 扩展 | `apps/vscode` | 扩展宿主 + 同级 companion 进程 + webview 客户端，DSH 应用在扩展旁边启动，不启 HTTP 服务器、不起 sidecar |
| 无 HTTP 的宿主组合 | `apps/vscode/profile/vscode.patch.yml` | 关掉 `webserver`、HMR、侧栏页面类型，保留应用行；传输改走 webview 桥 |
| 官方 MCP 管理 | 同上 | 直接使用上游 `@deepseek-ai/dsh-mcp-manager`，不再自建服务器管理 |
| 公司模型路由 | `apps/vscode/src/host/provider.ts` | 生成 `openai-compatible` 私有路由，地址/模型/上下文由部署方设置 |
| 记忆插件 | 同上 | 挂载 `@lixiangzhong/dsh-memory`，会话间记忆落在项目 `.memory/` 下的 Markdown |
| 离线运行时 | `apps/vscode/deploy`、`scripts/prepare-standalone-runtime.mjs` | VSIX 自带 Node、DSH 运行时闭包、pnpm 与 Office 载荷，目标机不需要 Node 或 Python |
| 自带 Skill 库 | `apps/vscode/profile/skills` | 随 VSIX 分发的只读 Skill，通过文件系统 Skill provider 发现 |

上游的 CLI、Desktop、Web 形态仍在这棵树里，但本产品不使用它们。

## 二、内网部署需要准备什么

- Windows 10/11 x64，VS Code 1.96 或更新。
- 一个 VSIX 文件：`code --install-extension dsh-vscode.vsix`，重载窗口。
- 一台可达的 OpenAI 兼容网关（内网地址即可，不需要公网）。
- 目标机**不需要** Node、pnpm、Python、Git、办公套件或任何语言编译环境。

## 三、第一次使用要配什么

模型地址与模型名由部署方决定，默认值是占位符，必须按实际环境改。两种方式任选：

1. 命令面板执行 `DSH: Configure Company Endpoint`，填 URL、模型名和 key。
2. 或在设置里写：

| 设置 | 含义 |
|---|---|
| `dsh.providerMode` | `openai-compatible`（私有网关）或 `deepseek`（公网官方 API） |
| `dsh.llmBaseUrl` | 网关根地址，例如 `http://your-gateway:8080/v1` |
| `dsh.llmModel` | 网关提供的模型 id |
| `dsh.llmApiKeyEnv` | 承载 key 的环境变量名，默认 `DSH_LLM_API_KEY` |
| `dsh.llmContextWindow` | 该模型的上下文窗口 |
| `dsh.terminalBackend` | `local`（受沙箱与权限预设约束）或 `vscode`（集成终端，无沙箱） |

### Key 放在哪里

内网分发的 VSIX 已经把网关地址、模型名和上下文窗口写成默认值，所以同事**不需要输入任何网址**，只缺一把 key。三种放法，按管理方式选一种：

| 方式 | 谁来做 | 优点 | 代价 |
|---|---|---|---|
| 命令 `DSH: Set Private Endpoint API Key` | 每个用户一次 | 进 VS Code SecretStorage，不落明文，不泄露给其他进程 | 每台机器要做一次 |
| 机器环境变量 `DSH_LLM_API_KEY`（IT 用组策略下发） | IT 一次 | 用户零操作，打开就能用 | 环境变量对子进程可见，模型执行的命令理论上能读到 |
| 工作区 `.env` 里写 `DSH_LLM_API_KEY` | 用户或项目 | 随项目走 | 明文落盘，慎用 |

默认取 `DSH_LLM_API_KEY`；如果内部约定换名字，改 `dsh.llmApiKeyEnv` 即可。

两种构建只差默认值：**内网版**内置公司网关与模型，**公开版**（GitHub release）是占位符。内网版不要上传到公开仓库。

排查用两条命令：`DSH: Show Diagnostics`（模式、运行时版本、工作目录、路由、key 是否就绪、shell 后端）与 `DSH: Show Log`。

## 四、从源码编译一个 VSIX

前提：Windows x64、Node.js 24.22.3 及以上、pnpm 11.x。

```powershell
node apps/vscode/scripts/bootstrap-vscode.mjs
```

它依次执行依赖安装、产物构建、扩展打包、Office 载荷准备、运行时装配和 VSIX 打包，最后打印产物路径、大小和 SHA-256。每一步的细节、以及完全离线时怎么替换成"先在有网机器上准备、再拷进内网"，见 [SELF_DEPLOY.md](SELF_DEPLOY.md)。

## 五、这个仓库验证了什么，没验证什么

已验证：

- 从干净克隆用上面一条命令构建出 323 MB 的 VSIX，运行时自带的 Node v24.22.3 能启动 companion、初始化 profile、创建会话、绑定工作区。
- 在隔离的 VS Code 用户目录里安装该 VSIX（VS Code 1.117）：扩展激活、命令出现在命令面板、DSH 视图渲染出中文界面（工作区选择器、标准模式 预设、输入框与附件/权限/发送按钮），首次打开视图时启动 companion 并初始化 profile、home、connections 目录。
- 用 mock 模型跑通一次完整回合：会话按 standard 预设挂载后，模型可见 **36 个工具**（ead、edit、glob、grep、pwsh、web_fetch、web_search、记忆工具、子代理、工作流等），工具调用被执行、结果回灌给模型、助手回复产生、会话落盘。
- 扩展与客户端的 TypeScript 聚合编译通过，`build:artifacts` 的八个门禁全过。
- 记忆插件的 `memory_add`、`memory_query`、`memory_status`、`memory_dream` 在启动探针里注册成功。

未验证（需要一块真实屏幕和一把真实 key）：

- 在真实窗口里**发送消息并看到流式输出**（自动化输入没有打进 webview，这一步要人工点一次）、审批允许/拒绝、终端交互、图片与文件附件、多窗口、重启后恢复会话。
- 模型侧的记忆写入与下次召回。
- Windows 标准用户下 `workspace-write` 沙箱的授权，历史上在这台机器上失败过。

换句话说：**能装、能启动、能构建**是验证过的；**界面走一遍**没有。

## 六、可能出错的地方

| 现象 | 原因 | 处理 |
|---|---|---|
| `Node ... or newer is required` | Node 低于 24.22.3 | 换 Node 版本 |
| `spawnSync pnpm ENOENT` / `EINVAL` | Node 不能直接 spawn Windows 的 `.cmd` 垫片 | 用仓库里的 `bootstrap-vscode.mjs`，它通过 shell 调 pnpm |
| `EPERM ... mkdir ...\Temp\...` | companion 的沙箱以扩展目录为根，存储落在系统 TEMP 时要额外申请 ACL | 保留仓库默认的 `.tmp/companion-smoke` 存储位置 |
| `the Office authoring payload is missing` | 跳过了 Office 载荷准备 | 不加 `--skip-office`，或传入已准备的载荷 |
| `ERR_PNPM_NO_OFFLINE_...` | 离线商店缺包 | 在有网机器上重跑一次 `pnpm install` 后拷贝 `.pnpm-store` |
| 模型请求 401 / 连接被拒 | 网关地址、端口或 key 不对 | `DSH: Show Diagnostics` 看路由与 key 状态 |
| `web_search` 失败 | 该工具走公网 | 内网环境预期失败，不影响本地文件与命令工具 |
| 命令执行报沙箱授权失败 | Windows 标准用户下的 ACL 问题 | 先用 `read-only` 验证，再报告具体错误 |

## 七、已知限制

- 没有浏览器自动化：本包没有打 browser-use，模型看不到网页渲染结果。
- 没有 LSP：代码补全与跳转来自 VS Code 自己的扩展，不来自 DSH。
- 没有容器：沙箱是进程级的，不提供整机隔离或可重置工作区。
- 记忆插件用 `@lixiangzhong/dsh-memory` 而不是 `dsh-memory-palace`：后者硬依赖 HTTP 服务器，本组合没有。
- 侧栏、右侧面板、文件树等 Web 形态的界面被关闭，文件打开走 VS Code 自己的编辑器与 diff。

- 升级到 0.2.3 时一度回退了自研界面细节（侧边栏 238px 默认宽、24px 折叠轨道、预设卡片隐藏内部 id、卸载自研 MCP 页签），已在 0.2.3 上恢复：侧边栏默认 238px / 最小 224px / 折叠 48px，预设卡片只显示本地化名称，MCP 页签删除、由官方 MCP 管理器接管。
