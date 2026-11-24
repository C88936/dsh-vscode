# C1–C25 开发记录（第三十四轮）：R3 本地修复快捷入口

开发日期：2026-11-18（Asia/Shanghai）。范围：R3.1 的页面动作——修复无法从离线记录证明时，通知上直接提供“Install from plugin folder”，复用既有本地安装流程。前一轮见[第二十九轮](C1_C25_DEVELOPMENT_ROUND29.md)。

## 结论

Plugins 页的修复失败通知现在带一个动作：问题为 `unrecorded-version`（profile 锁文件没有精确版本）或 `offline-store`（本机 pnpm 存储不满足依赖）时，显示“Install from plugin folder”，点击关闭通知并打开既有的本地目录选择流程。其它问题（未安装、包管理器失败、版本不一致）、已完成的修复、以及没有原生选择器的载体都不显示该动作。文案复用既有的 `installFromFolder`，未新增 locale 键。

## 修改

| 文件 | 变化 |
| --- | --- |
| [PluginManagerPage.tsx](../../packages/client/ui-plugin-manager/src/client/PluginManagerPage.tsx) | 新增导出助手 `repairLocalActions()`：限定 `repair` + `failed` + 两种可解问题 + 有选择器；返回 `{ label, onClick }`，点击先关通知再 `choose('folder')`；通知 `Toast` 传入 `actions` |
| [components.client.spec.tsx](../../packages/client/ui-plugin-manager/tests/components.client.spec.tsx) | 新增两个用例：两种问题的动作内容与点击行为；其余问题、已修复、无选择器、`null` 均不提供动作 |

## 过程记录：一次误用导致的自伤与修复

用 PowerShell `Get-Content`/`Set-Content` 改写该 spec 以插入 import 时，控制台编码把文件里的中文 UTF-8 字面量写坏（15 处丢字符、部分行双重编码、换行变 CRLF）。处理：逐个恢复 14 行被破坏的内容（中文文案取自渲染断言自身的上下文与 locale），把文件转回 UTF-8 + LF；运行完整 spec 后 **174 个用例全部通过**，证明恢复后的字面量与组件实际渲染一致。教训：源码文件一律用编辑工具改，不用 PowerShell 文本 cmdlet 重写整个文件。

## 实际运行的检查

| 命令 | 结果 |
| --- | --- |
| `ui-plugin-manager` 全部 9 个 spec | 398 测试通过，exit 0 |
| 该包 client 面 `tsc --noEmit` | exit 0 |
| `build:artifacts` / `build:check`（合成标记） | 8/8（123s）、2/2（90s），exit 0 |
| `runtime:standalone` + `package:standalone` | exit 0，35,933 条目 |
| 候选解包复验 | exit 0，8 项标记、Office、随包 pnpm、companion smoke 全通过 |

新候选：`apps/vscode/dsh-vscode.vsix`，257,244,974 字节，SHA-256 `e087eebeaa8bebf433fbc40166aa60f3bed24cee7a1425f7049b8701965e0d97`；第二十九轮的 `5c93b2dc…` 作废。构建仍用合成标记 `0000000`，不对应 Git 修订。

## 仍未验证

- 没有 GUI 实测点击该通知动作；证据来自组件 spec 与页面单测。
- 动作在通知自动消失（3–8 秒）前有效，未评估长文案下的可点击窗口是否够用。
- R1.2 应用内准入、R1.4、R2.2 真实离线 fixture、R4.3 的 composer 门禁、R6.6 未完成；真实公司网关/GUI/双窗口未验证；C9/C10 维持暂缓。
