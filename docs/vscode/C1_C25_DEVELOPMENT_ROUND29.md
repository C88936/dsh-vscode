# C1–C25 开发记录（第二十九轮）：R2.4 本地导入离线政策

开发日期：2026-11-18（Asia/Shanghai）。范围：R2.4 的后端与部署策略——VS Code 构建现在用显式配置要求本地导入必须携带 prepared 记录，未证明完整的本地包在 pnpm 之前被拒绝。前一轮见[第二十七轮](C1_C25_DEVELOPMENT_ROUND27.md)。

## 结论

`plugin-manager` 新增 `localInstallPolicy`（`allow-unproven` 默认 / `require-record`）。VS Code 的 profile overlay 设为 `require-record`：Plugins 页选择未带 `dsh-prepared-bundle.json` 的目录或归档时，安装会在 pnpm 之前失败并说明原因，避免依赖闭包静默走到配置的 registry（可能是公网默认）。要显式放行，可把该策略改回 `allow-unproven`。

## 修改

| 文件 | 变化 |
| --- | --- |
| [index.ts](../../packages/boot/plugin-manager/src/index.ts) | `Config` 新增 `localInstallPolicy` 与默认值；构造函数读取；`installBundle` 在本地且未记录、策略为 `require-record` 时于 pnpm 之前抛错，错误文案给出两条出路 |
| [vscode.patch.yml](../../apps/vscode/profile/vscode.patch.yml) | `plugin-manager` 行增加 `localInstallPolicy: require-record` 与注释 |
| [DEPLOY.md](DEPLOY.md) | “离线 prepared bundle”段落改为说明该策略与放行方式 |
| [manager.spec.ts](../../packages/boot/plugin-manager/tests/manager.spec.ts) | 新增：`require-record` 下未记录本地包被拒、诊断含 `requires a prepared bundle` 与 `localInstallPolicy`、pnpm 未调用 |

## 实际运行的检查

| 命令 | 结果 |
| --- | --- |
| plugin-manager `manager` + `tools` | 2 文件、216 测试通过，exit 0 |
| plugin-manager `tsc --noEmit` | exit 0 |
| `build:artifacts` / `build:check`（合成标记） | 8/8（168s）、2/2（166s），exit 0 |
| `runtime:standalone` + `package:standalone` | exit 0，35,931 条目 |
| 候选解包复验 | exit 0，8 项标记、Office、随包 pnpm、companion smoke 全通过 |

新候选：`apps/vscode/dsh-vscode.vsix`，257,199,480 字节，SHA-256 `5c93b2dca084a6eff0108fc863d0cc53f5a5ec0fbeeedfc4421185af7817d485`；第二十七轮的 `3b746e49…` 作废。构建仍用合成标记 `0000000`，不对应 Git 修订。

## 仍未验证

- 没有在 GUI 里点击这条拒绝路径；证据来自 manager 单测与 profile overlay 配置。
- 拒绝文案没有专门的 client 本地化条目（作为 operation-error 诊断显示），也没有“改用内网 registry”的按钮；用户需按文案准备记录或改策略。
- R2.2 的真实离线 fixture 仍未建立；R3 页面动作、R1.2 应用内准入、R4.3 UI 一半、R6.6 未完成；真实公司网关/GUI/双窗口未验证；C9/C10 维持暂缓。
