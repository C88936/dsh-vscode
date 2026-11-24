# C1–C25 开发记录（第六轮）：R4.5 端点切换不沿用旧模型

开发日期：2026-11-17（Asia/Shanghai）。范围：R4.5 中的“URL 切换不沿用旧模型成功提示，重新发现并确认对应目标”。前几轮见[第五轮](C1_C25_DEVELOPMENT_ROUND5.md)等记录。

## 结论

`DSH: Configure Company Endpoint` 在端点 URL 变化时会清空 `dsh.llmModel`，并在成功提示里说明“还没有为新端点选择模型”，不再复用上一个端点列出的模型 id。端点为同一地址时行为不变，仍会报出已保存的模型。

## 修改（[extension.ts](../../apps/vscode/src/extension.ts)）

- 记录输入端点是否与保存的端点不同（比较前后 `dsh.llmBaseUrl`，去空白）。
- 变化时调用 `writeEffectiveSetting('llmModel', '')`；失败则报告“端点已保存，但旧模型选择未能清除”，提示用户手动清空 `dsh.llmModel`，避免旧 id 被发到新端点。
- 成功文案按“端点变化或模型为空”走“请先获取并选择模型”的分支。

## 回归用例（[company-setup.spec.ts](../../apps/vscode/tests/company-setup.spec.ts)）

- 新增“端点未变化时仍报出已保存模型”，断言只有两次部署设置写入。
- 新增“端点变化时清除旧模型”，断言写入 `llmModel: ''` 且提示要求重新选择。
- 默认 fixture 的 `baseUrl` 改为与输入相同，让端点变化只出现在针对性用例里；既有全局写入、key 保存失败、部分保存、重启失败用例保持不变。

## 实际运行的检查

| 命令 | 结果 |
| --- | --- |
| 定向 `company-setup` + `configuration` | 2 文件、17 测试通过，exit 0 |
| 全量 `vitest`（apps/vscode） | 28 文件、267 测试通过，exit 0 |
| `tsc -p tsconfig.json --noEmit` | exit 0 |

## 仍未验证

- R4.2（一条 mock 网关整链）与 R4.3（占位模型阻断正式推理提交）仍未实现；清空模型后下一次启动会用占位 id，该 id 仍可能被发到真实网关。
- R2.2/R2.4/R2.6、R1、R3、R8 未完成；真实 GUI、候选 VSIX、真实公司网关未验证；C9/C10 维持暂缓。
