# C1–C25 开发记录（第一轮）：R5、R7 与 R6

开发日期：2026-11-17（Asia/Shanghai）。范围：按 [C1–C25 验收](C1_C25_ACCEPTANCE.md) 的《剩余部分怎么做》开发，本轮只做 R5、R7 和 R6 的可验证部分，并保持 C9/C10 暂缓。所有“通过”仅指对应窄问题在本轮实际运行的证据；候选 VSIX、真实 GUI、真实公司网关仍未复验。

## 结论

R5 与 R7 已完成代码、回归用例与构建产物 smoke；R6 的数量/读取失败/上限语义与可配置上限已完成，目录图标物化仍未实现（按验收允许的替代方案：该格式只接受现有受限内联图片）。真实模型 API 已用用户提供的 DeepSeek 凭据通过环境变量完成两轮独立验证，凭据未写入任何仓库文件或日志。

## R5：transport 关闭后不得登记新等待（C21，关联 C25）

原缺陷（验收已复现）：`WebviewTransport.dispose()` 只结算当时已知的等待；之后调用 `fetch`、`upload`、`loadBundle` 仍会先登记 Promise，再由 `send` 静默丢弃帧，导致永久 pending；正文读取期间 dispose 也不取消读取。

修改：

| 文件 | 行为 |
| --- | --- |
| `apps/vscode/src/webview/main.ts` | 新增 `TransportClosedError`（`name`、`code: 'transport/closed'`、`reason`）；`ensureOpen()` 在每次公开调用入口和每个 `await` 之后检查；`postFrame()` 在帧无法投递时抛出结构化关闭错误 |
| 同上 | `sendIfOpen()` 只用于取消帧、上行确认等尽力而为的帧；关闭后不再发送，也不把投递失败当成调用结果 |
| 同上 | `dispose()` 先取消所有正文读取，再结算 fetch/upload/asset/stream，并唤醒全部上行与上传确认等待；`pendingCount` 暴露仍等待的请求、读取和确认数量供证据使用 |
| 同上 | 关闭后的 `fetch`、`binaryFetch`、`upload`、`openStream`、`loadBundle` 立即以 `TransportClosedError` 失败，不再登记等待 |
| 同上 | `transport-reset` 同时结算页面级打开/重启/保存模型/选择路径请求：非人为停止一律拒绝，人为停止（`deliberate: true`）解析重启请求，避免成功重启时页面显示一次无法处理的失败 |
| `apps/vscode/src/host/companion-bridge.ts` | `dispose()` 对仍在运行的 companion 先发送带 `deliberate: true` 的 `transport-reset`，再请求 shutdown；旧代次迟到帧仍被丢弃 |

回归用例（`apps/vscode/tests/webview-request.spec.ts`、`companion-response.spec.ts`）：关闭后五个公开入口全部拒绝且零发送；帧投递失败时已发送的请求被结算、后续调用被拒绝、`pendingCount` 归零；`transport-reset` 结算 fetch 与 upload 并清空等待；companion 人为停止发出一次 `deliberate` reset，异常退出仍只发一次普通 reset，停止后旧代次 `upload-ack` 不被转发。

## R7：正文读取期间取消（C25）

原缺陷（验收已复现）：`await request.text()` 期间没有取消路径，abort 或 dispose 后调用仍 pending，直到正文源结束。

修改（`apps/vscode/src/webview/main.ts`）：

- `readTextBody` 由 transport 自己持有 reader：读前安装 abort 监听并登记到 `bodyStops`，abort、`dispose` 或超限都会取消底层流；读循环在每个 chunk 后复查取消与关闭；取消后不返回已读文本，避免把截断正文当成功。
- 解码使用流式 `TextDecoder`，跨 chunk 的多字节字符保持完整。
- 新增可配置的单条 unary 正文上限（默认 8 MiB），超限抛 `RangeError` 且不发送任何帧；大流仍走 upload carrier。
- 标准 Request/init 归一化、已取消请求零发帧、GET 默认等既有行为不变。

回归用例：读取中 abort 取消 reader 且零发帧；读取中 dispose 取消 reader 并以 `TransportClosedError` 结束；超限在发帧前拒绝；UTF-8 字符跨三块边界还原正确；首块后取消不发送请求；`pendingCount` 归零。

## R6：资源准备必须全量成功或可见失败（C22）

已完成部分：

- 取消“只准备前 256 项然后成功”：数量在读取任何字节之前比较，超限直接失败并说明“发布了 N 项，超过 M 项上限”。
- 注册表报告的每个引用都是包自己声明的资源，因此任一引用非 2xx、超大或超预算都使整个包失败；不再跳过失败项后发布半包。
- 启动时失败的包从 boot payload 中撤下它的 bundle；页面随后请求该 bundle 并收到失败原因，只影响该插件，不再先 log 后执行工厂/样式。
- `require.asset` 对声明但未准备的包资源直接抛出带引用的错误，不再返回不可用的字面引用。
- 上限改为部署配置：`dsh.limits.unaryBodyBytes`、`dsh.limits.packageAssetCount`、`dsh.limits.packageAssetBytes`、`dsh.limits.packageAssetTotalBytes`、`dsh.limits.binaryResponseBytes`；非法值记一条日志并回到默认值，配置经 boot payload 同时约束 Host 与页面。
- 回归用例：257 项与可配置 3/2 项均失败且 bundle 被撤下；声明资源 404 使整包失败并可展开错误；单文件超限同样整包失败；后续分片首次到达的包仍能按需准备并返回映射。

未完成：R6.6 目录 HTTP(S) 图标物化。本轮不支持该形式；目录格式仍只接受现有受限内联图片，未新增任意网络读取。真实 registry→carrier 的最小图片 import、CSS 背景和 split chunk 的端到端 fixture 仍待补。

## 附带修复：Office 包来源限定

`apps/vscode/src/host/office.ts` 的 `resolvePackage` 现在要求解析结果位于本次启动的安装目录内。原因：验收环境中该用例在隔离临时安装中删包后仍能解析成功，实际解析到了工作区源码包；按模块文档“从本次启动的安装解析”的既有约定，安装外的同名包不应被挂载。`office.spec.ts` 由红转绿，未放宽断言。

## 实际运行的检查

| 命令 | 结果 |
| --- | --- |
| `pnpm exec vitest run --config vitest.config.ts`（apps/vscode） | 27 文件、258 测试通过，exit 0 |
| `pnpm exec tsc -p tsconfig.json --noEmit`（apps/vscode） | exit 0 |
| `pnpm exec tsdown`（apps/vscode） | 构建成功；仅保留原有的 IIFE `output.name` 提示 |
| `node scripts/transport-smoke.mjs`（构建产物） | 全部检查 true，exit 0 |
| `pnpm run smoke:upload`（apps/vscode） | 上传 200、业务成功、disposed，exit 0 |
| `vitest --config vitest.e2e.config.ts packages/llm/llm-deepseek`（真实 DeepSeek 网关） | 2 文件、17 通过、5 跳过，exit 0 |
| 真实 OpenAI-compatible 公司 route smoke（`bootDsh` + 生成的 provider overlay + 一轮对话） | assistant answered、turn closed、disposed，exit 0 |

真实网关验证说明：凭据只通过进程环境变量传入，未写入仓库文件、日志或文档；DeepSeek 的公开 Messages 端点验证了流式文本、思考强度、工具历史续写、取消和 Files 上传。另有一轮把 `dsh.llmBaseUrl` 指向 DeepSeek 的 OpenAI-compatible 端点，用与公司部署相同的 `providerPatch`（`openai-compatible` + `company` route）完成一次真实对话，证明该代码路径可对真实网关工作。脚本在 `.tmp/real-company-route-smoke.mts`，仅从环境读取地址、模型和凭据。

## 仍未验证

- R1（companion 活动查询与 pending 重建）、R2（离线本地包闭环与内容绑定）、R3（公司包来源修复动作）、R4（发现→选择→有效保存）、R8（统一重建与候选 VSIX）尚未实施。
- 真实公司网关的 `/models`、401/403、超时、工具调用与取消仍未验证；本轮真实网关是 DeepSeek 公开端点。
- 真实 GUI、安装包内启动、双窗口实机未运行；候选 VSIX 未重打包。
- C9/C10 维持暂缓，任务一验收状态不变。
