# C1–C25 收尾交付说明

日期：2026-11-18（Asia/Shanghai）。范围：[C1–C25 验收](C1_C25_ACCEPTANCE.md) 的 R1–R10 开发清单在本线的完成情况、证据与未完成项。逐轮记录从 [ROUND12](C1_C25_DEVELOPMENT_ROUND12.md) 到 [ROUND34](C1_C25_DEVELOPMENT_ROUND34.md)，日常交接见 [READINESS_HANDOFF.md](READINESS_HANDOFF.md)。C9/C10 由另一作者推进，本线维持暂缓。

## 交付物

候选包：`apps/vscode/dsh-vscode.vsix`，257,244,974 字节，35,933 条目，SHA-256 `e087eebeaa8bebf433fbc40166aa60f3bed24cee7a1425f7049b8701965e0d97`。解包到仓库外验证：8 项标记、Office payload、随包 pnpm、packaged companion smoke 全部通过（`.tmp/r8-candidate-smoke.json`，exit 0）。构建使用合成标记 `DSH_CLIENT_COMMIT_HASH=0000000`，不对应任何 Git 修订。

## 逐项状态

| 项 | 状态 | 证据 |
| --- | --- | --- |
| R5 transport 关闭 | 完成 | `TransportClosedError`（`transport/closed`）、`ensureOpen`/`postFrame`、`dispose` 先取消正文读者再结算等待；`webview-request.spec`、`companion-response.spec` |
| R7 正文读取取消 | 完成 | 流式 UTF-8 解码与 `limits.unaryBodyBytes`；上传登记 `bodyStops`、abort 监听、`releaseLock` 容错；同批 spec |
| R2.1 内容绑定指纹 | 完成 | `directoryContentDigest`（50,000 条目 / 1 GiB 上限）与 `fingerprintOf`；`local-bundle.spec` |
| R2.2 离线闭环 | 部分 | `missingRecordedStore` 预检（repair 与 proven offline install）；真实空 store/断网 fixture 未建立 |
| R2.3 可离线闭包语义 | 完成 | `store: 'unverified'`/`loadable: 'unverified'` 必填；客户端 fixture 补齐；`manager.spec` |
| R2.4 本地导入政策 | 完成 | `localInstallPolicy`（默认 `allow-unproven`），VS Code profile 设 `require-record`；pnpm 前拒绝并给两条出路；`manager.spec`、[DEPLOY.md](DEPLOY.md) |
| R2.5 `hostProvided` 可满足性 | 完成 | 预检与测试 |
| R2.6 修复诊断 | 完成 | `repairBundle` 报出锁文件 specifier，不虚构版本 |
| R1.1 companion 活动 | 完成 | `CompanionActivity`、`activity(2000)`、`activities` 映射、`settleActivities`；`companion-activity.spec` |
| R1.2 停机窗口 | 部分 | 二次活动检查 + `freezeTransport` 先关页面再停机、失败重绘；应用内准入未实现（依赖 C9/C10 共享 host 接入点） |
| R1.3 待生效状态 | 完成 | `@Remote pendingRestartBundles()`（保存选择对比运行代次）与页面重建后采纳；`manager.spec`、`manager-store.client.spec` |
| R1.4 GUI 矩阵 | 未做 | 需要运行中的 GUI 与双窗口环境 |
| R4.1 公司端点发现 | 完成 | `/v1/models` 读取与错误分类；`company-setup.spec` |
| R4.2 Host 链集成 | 完成 | `company-route.integration.spec` |
| R4.3 占位阻断 | 部分 | 生成插件在 `llm/stream` 同步拒绝占位模型；ui 一半（composer 门禁 + “先获取并选择模型”入口）未做 |
| R4.4 有效保存 | 完成 | `writeEffectiveSetting` 拒绝被文件夹覆盖的层并回读；`settings.spec`、`configuration.spec` |
| R4.5 端点变化清模型 | 完成 | `writeCompanySettings` 在端点变化时清除 `dsh.llmModel` |
| R6.1–R6.4 资源准备 | 完成 | 全量成功或可见失败、可配置总量/单文件上限、枚举非 ENOENT 失败可见、`resolveAsset` 未准备即抛错 |
| R6.5 注册表→载体 | 完成 | 单条 combo 归属修复（`packageOf` 解码、combo 解析）与多包批次实测；`package-asset-bridge.spec`（8 用例）、`package-assets.client.spec` |
| R6.6 远端图标 | 完成（按“明确不支持 + 占位”） | 远端图片被内容策略拦截后显示 alt 文本；`markdown-image-entries.client.spec`；[DEPLOY.md](DEPLOY.md) 记录策略 |
| R3.1 页面本地修复 | 完成 | 修复失败通知在 `unrecorded-version`/`offline-store` 时提供“Install from plugin folder”；`components.client.spec` |
| R3.2 修复后端语义 | 完成 | 见 R2.6；`manager.spec` |
| R8 集成构建 | 完成 | `build:artifacts` 8/8、`build:check` 2/2、`runtime:standalone`、`package:standalone`、候选解包 smoke；文档对账见 [ROUND20](C1_C25_DEVELOPMENT_ROUND20.md)、[ROUND23](C1_C25_DEVELOPMENT_ROUND23.md) |

## 实际运行的检查（本轮累计）

| 命令 | 结果 |
| --- | --- |
| apps/vscode `vitest` | 41 文件、338 测试通过（含另一作者新增的 C9/C10 用例） |
| plugin-manager 全部 18 文件 | 495 通过、3 跳过 |
| client/modules + plugin-manager + ui-plugin-manager 合跑 | 32 文件、1,112 通过、3 跳过 |
| `pnpm run typecheck` | 5/5 gate，0 失败 |
| `pnpm run test:gui` | 12,177 通过、6 失败（均在未触碰包，环境绑定）、2 跳过 |
| `pnpm run build:artifacts` / `build:check` | 8/8（128s）/ 2/2（97s） |
| DeepSeek 真实网关 e2e | 20 通过、2 失败（`Loader package inventory` 两例流内 `error`，适配器源码未改动，归因网关侧）、5 跳过 |
| 候选解包复验 | exit 0，8 项标记、Office、随包 pnpm、companion smoke 通过 |
| `verify-md-links` | 2,317 文件全部解析 |

## 未完成与前置条件

- R1.2 应用内准入：需要一个共享 host 下的准入点；C9/C10 的共享 host 正在由另一作者推进，单窗口标记会误伤多窗口，故不在本线先做。
- R1.4 GUI 矩阵与真机验证：需要安装版 VS Code（含双窗口）与可用的公司网关；当前环境无法完成。
- R2.2 真实离线 fixture：需要 prepared 格式携带 tarball 与 store 导入步骤，属于格式扩展。
- R4.3 的 UI 一半：需要产品先定“未配置模型”在客户端如何可见（会话投影或设置事实），否则只能在发送后由 Host 拒绝。
- DeepSeek 两个 provider 用例：待网关恢复后复跑并抓取流内错误载荷。
