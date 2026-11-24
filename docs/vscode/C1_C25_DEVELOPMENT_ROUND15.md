# C1–C25 开发记录（第十五轮）：R4.3 占位模型阻断推理

开发日期：2026-11-18（Asia/Shanghai）。范围：[C1–C25 验收](C1_C25_ACCEPTANCE.md) 的 R4.3：配置完整前阻止正式推理提交，不把占位 id 发给真实网关。前几轮见[第十三轮](C1_C25_DEVELOPMENT_ROUND13.md)；第十四轮记录了一次失败尝试，结论是 overlay 里的“裸行”只会按 id 修补既有条目，新行必须写进 `insert:` 列表。

## 结论

公司路由在没有选模型时仍以 `dsh-unconfigured-model` 启动，但真正提交推理会在本地被拒绝：provider overlay 现在插入一个 `llm/stream` waterfall 插件，只拦占位 id，并给出“先到 Models 获取并选择模型”的动作说明。真实组合的 boot smoke 证明：请求被拦下，mock 端点**零请求**。配置与发现不受影响（它们不经过 `llm/stream`）。

## 修改

| 文件 | 变化 |
| --- | --- |
| [model-gate.ts](../../apps/vscode/src/host/model-gate.ts) | 新增：生成 `model-gate.mjs`（导出 `name`/`apply`），在 `llm/stream` 上对占位模型同步抛错，其余模型 `next()` 放行 |
| [provider.ts](../../apps/vscode/src/host/provider.ts) | `providerPatch(settings, gate?)`；占位且提供 gate 时以 `- insert:` 追加 `company-unconfigured-model-gate`，行内 config 携带模型 id |
| [host.ts](../../apps/vscode/src/host/host.ts) | `providerOverlay` 在“公司路由且未选模型”时写入 gate 模块并以 `file://` 插入；DeepSeek 模式或已有模型时不插入 |
| 测试 | 新增 [model-gate.spec.ts](../../apps/vscode/tests/model-gate.spec.ts)（拒绝、放行、写文件）；[provider.spec.ts](../../apps/vscode/tests/provider.spec.ts) 新增 insert 行与“无 gate 不插入”用例 |

## 实际运行的检查

| 命令 | 结果 |
| --- | --- |
| `vitest`（apps/vscode 全量） | 29 文件、281 测试通过，exit 0 |
| `tsc -p tsconfig.json --noEmit` | exit 0 |
| `tsdown` | 构建成功，exit 0 |
| 真实组合 boot smoke（`.tmp/r4.3-gate-smoke.mts`） | exit 0；`gate rows: [company-unconfigured-model-gate, applied:true]`、`refused:true`、`endpointRequests: []` |
| `package:standalone` | exit 0，35,925 条目，245 MB |
| 候选解包复验 | exit 0，8 项标记 + Office + 随包 pnpm + packaged companion smoke |

新候选：`apps/vscode/dsh-vscode.vsix`，257,031,650 字节，SHA-256 `d1c461f59b744e7a44cfb261b871f167018fd5bff537196c37ee0885df32f28c`；第十三轮的 `053d2673…` 已作废。

## 仍未验证

- 客户端 composer 没有在占位状态下禁用发送或显示专门提示；用户点发送后会看到门禁返回的错误文案，而“先获取并选择模型”的动作仍要用户自己到 Models 页完成。R4.3 的 UI 一半未做。
- mock 公司网关的完整“配置→发现→候选→选择→有效值→overlay→重启”链路（R4.2）仍未建立；本轮只验证了占位阻断。
- 真实公司网关、真实 VS Code 安装、双窗口未验证；R1.3/R1.4、R2.2/R2.4、R3 页面动作与 fixture、R4.2 未完成；C9/C10 维持暂缓。
