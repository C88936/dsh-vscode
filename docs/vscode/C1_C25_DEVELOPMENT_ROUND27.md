# C1–C25 开发记录（第二十七轮）：R6.5 combo 归属修复与候选重建

开发日期：2026-11-18（Asia/Shanghai）。范围：R6.5 的“真实 registry→carrier”验证暴露并修复了 combo URL 无法归属包的问题；同时把第二十六轮遗留的候选重建完成。前一轮（含第二十六轮的尝试记录）见[交接记录](READINESS_HANDOFF.md)。

## 结论

真实模块图把每个启动 bundle 发布为**单条 combo**（`plugins/??<pkg>/client.js&rev=…`）。`packageOf` 原先既不能解码 scoped 名称，也不能解析 combo，于是 VS Code carrier 在启动与懒加载时都无法把 combo URL 归属到包，插件图片不会被物化。现在 `packageOf`：

- 先剥离 origin，再在**任何 query 处理之前**识别 combo（combo 的 `??` 属于路由而不是查询分隔符）；
- 单条 combo 返回包名（解码后），多条 concat 不归属任何单包；
- 非 combo 的 chunk 形式继续按包路由匹配；
- 非法百分号转义返回 undefined。

## 修改

| 文件 | 变化 |
| --- | --- |
| [modules/src/index.ts](../../packages/client/modules/src/index.ts) | `packageOf` 重写：origin 剥离、combo 优先解析、单条归属/多条不归属、包名解码、非法转义安全返回 |
| [package-assets.client.spec.ts](../../packages/client/modules/tests/package-assets.client.spec.ts) | 新增单条 combo、多条 combo、编码 scoped 名称、非法转义断言 |
| [package-asset-bridge.spec.ts](../../apps/vscode/tests/package-asset-bridge.spec.ts) | fake registry 改为可发布 combo URL，并使用**真实** `ClientModuleRegistry.prototype.packageOf`；新增“启动图谱 combo 也能准备资源”与懒加载 combo 请求用例；fake 的 `fetchBundle` 按真实路由方式从 query 中还原 combo |

## 实际运行的检查

| 命令 | 结果 |
| --- | --- |
| `client/modules` 全量 | 5 文件、218 测试通过（含新断言），exit 0 |
| apps/vscode 全量 | 330 测试通过，exit 0 |
| 两个包 `tsc --noEmit` | exit 0 |
| `build:artifacts` / `build:check`（合成标记） | 8/8（149s）、2/2（138s），exit 0 |
| `runtime:standalone` + `package:standalone` | exit 0，35,927 条目 |
| 候选解包复验 | exit 0，8 项标记、Office、随包 pnpm、companion smoke 全通过 |

新候选：`apps/vscode/dsh-vscode.vsix`，257,093,393 字节，SHA-256 `3b746e49496a9315a1a8bf91a01ef9258a798c7706ee9a94842228ab963e2c64`；第二十四轮的 `adfd818e…` 以及第二十六轮的未打包改动都已包含在内。构建仍用合成标记 `0000000`，不对应 Git 修订。

## 仍未验证

- 没有在真实 VS Code Webview 中加载一个带图片的插件包来观察图片实际显示；证据来自 registry 单测与 carrier 单测。
- 多条 concat combo 只验证了“不归属”，没有验证多包 concat 场景下各包资源如何准备（每包仍有自己的单条 entry，推断可覆盖，但未实测）。
- 其余 R2.2/R2.4、R3 页面动作、R1.2 准入、R4.3 UI、R6.6 未完成；真实公司网关/GUI/双窗口未验证；C9/C10 维持暂缓。
