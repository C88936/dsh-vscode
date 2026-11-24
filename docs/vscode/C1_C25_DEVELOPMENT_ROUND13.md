# C1–C25 开发记录（第十三轮）：R5.3 上传读取取消与候选复打包

开发日期：2026-11-17（Asia/Shanghai）。范围：补 R5.3 中遗漏的“上传正文 reader 在关闭/取消时释放”，并把本轮修复重新打进候选 VSIX，使 R8 的候选哈希重新对应当前源码。前几轮见[第十二轮](C1_C25_DEVELOPMENT_ROUND12.md)。

## 结论

新增回归用例时发现真实缺陷：`upload()` 的 pump 只在 `reader.read()` 之后检查关闭/取消，等待正文时 `dispose()` 或 abort 不会取消 reader，上传会一直挂着。已修复：pump 现在把 reader 的取消登记到 transport 的 `bodyStops`，并监听请求的 abort，关闭或取消时立即释放等待中的读取；既有“不再发 chunk/end”“pendingCount 归零”语义不变。候选 VSIX 已重打并复验，第十二轮的哈希随之作废。

## 修改

| 文件 | 变化 |
| --- | --- |
| [webview/main.ts](../../apps/vscode/src/webview/main.ts) | `pumpUpload` 新增 `stop()`（幂等取消 reader）、abort 监听与 `bodyStops` 登记；finally 中移除监听、注销登记、未读完时取消、releaseLock 容错 |
| [webview-request.spec.ts](../../apps/vscode/tests/webview-request.spec.ts) | 新增“上传等待正文时 transport 关闭：reader 被取消、无 chunk/end、pendingCount 归零”；新增“关闭后的页面由新 transport 继续服务”；原“无 body 拒绝”用例保留 |

## 实际运行的检查

| 命令 | 结果 |
| --- | --- |
| apps/vscode `webview-request.spec.ts` | 31 测试通过，exit 0 |
| apps/vscode 全量 `vitest` | 28 文件、276 测试通过，exit 0 |
| apps/vscode `tsc -p tsconfig.json --noEmit` | exit 0 |
| apps/vscode `tsdown` + 构建产物 `transport-smoke.mjs` | 构建成功、smoke 全项 true，exit 0 |
| `pnpm run package:standalone` | exit 0，35,923 条目，245 MB |
| 候选解包复验 `node .tmp/r8-candidate-smoke.mjs` | exit 0，8 项标记、Office payload、随包 pnpm、packaged companion smoke 全部通过 |

新候选：`apps/vscode/dsh-vscode.vsix`，256,994,284 字节，SHA-256 `053d26737b3f36eb82a98d5ac7efeb4cfa26d640023cf335e088d69b0ecc4647`。第十二轮的 `ceef6711…` 只对应修复前的源码，已被本轮取代。

## 仍未验证

- 新用例覆盖的是“等待正文时关闭”；上传中途收到 ack 后 abort 的路径仍由既有用例覆盖，未增加逐 chunk 的取消矩阵。
- 候选包仍未跑 mock 公司网关整链（R4.2/R4.3 未实现）、真实 VS Code 安装、真实公司网关或双窗口。
- R1.3/R1.4、R2.2/R2.4、R3 页面动作与 fixture、R4.2/R4.3 未完成；C9/C10 维持暂缓。
