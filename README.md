# CRC: Codex Remote Control

通过 Tailscale 私有网络，在手机上查看 Codex 桌面版对话、任务活动与计划进度，并逐次批准或拒绝真实的 Codex 工具授权请求。

CRC 是社区项目，与 OpenAI 或 Tailscale 没有隶属关系。本版本面向 Windows，版本为 **0.2.0**。

## 功能

- 按项目目录分组的对话树，使用 Codex 保存的对话标题。
- 各对话独立显示运行、待授权、本轮结束、中断与关闭状态。
- Hook 事件持久化到本机，手机重连后可恢复记录。
- 显示命令、工具参数、工作目录和已识别文件；真实有效请求均可手动批准、拒绝或交回电脑。
- 有明确 `update_plan` 计划时显示步骤完成百分比；没有计划时显示活动条与工具调用状态。
- 手机离线保留当前请求，重新打开页面后继续审批；不自动弹出电脑审批。
- 手机接收结构化提问，可选择选项、填写文字并回传 Codex。
- 任务失败、网络重试和状态未确认会暂停进度动画。
- 连接状态下显示支持的账号余额或剩余额度。
- 通过 Tailscale Serve 提供私有 HTTPS 访问，服务自身仅监听 `127.0.0.1`。

## 环境要求

| 软件 | 要求 |
| --- | --- |
| 系统 | Windows 10/11；其他系统尚未验证 |
| Node.js | 22.13 或更高，推荐 24 LTS |
| Codex | 桌面版，以及可供目录查询的本机原生 Codex 可执行文件 |
| Codex 功能 | 支持 `PermissionRequest` 等 Hooks，用户已完成配置的信任审核 |
| Tailscale | 电脑与手机已安装，加入同一 Tailnet，ACL 允许访问 |

底层 Hook 授权链路曾在 Codex CLI / app-server **0.161.0** 环境验证。不同桌面版本可能有差异，安装后必须自行验证一个真实授权请求。目录查询模块有模拟 RPC 测试；它不能证明所有桌面版本的目录兼容性，也不能判断桌面任务的实时状态。

## 快速开始

下载或克隆仓库，在项目根目录打开 PowerShell。以下命令不需要把项目放到固定盘符或固定文件夹。

```powershell
npm ci
npm run setup
npm run hooks:install
npm start
```

1. `setup` 生成本机 `.env` 和两个独立随机令牌；不会覆盖已有配置。
2. `hooks:install` 在本机 Codex 配置目录合并 CRC Hooks，并备份已有文件。它保留不属于此 CRC 安装的 Hooks。**若之前已安装其他远程审批面板，应先卸载旧面板的 Hook，避免多个审批回调争用同一次请求。**
3. 在 Codex 中打开 `/hooks`，检查并信任新配置。必要时重启 Codex，以加载新的 Node.js PATH 和 Hooks。CRC 不会代替你完成信任。
4. 保持服务窗口运行，电脑浏览器打开 `http://127.0.0.1:8788/`。

如果 Codex 安装在自定义位置，在 `.env` 设置 `CODEX_BIN` 为原生 `codex.exe` 的绝对路径；不要填 `codex.cmd`。如有自定义 Codex 配置目录，安装脚本读取系统 `CODEX_HOME`，或使用：

```powershell
npm run hooks:install -- --codex-home "C:\Example\CodexConfig"
```

#### 任务异常

只读观察本机 Codex 当前对话的任务记录和日志。余额/额度不足、认证失败、网络异常等明确失败显示“失败·已中断”；自动重试显示“请求异常·重试中”。默认 120 秒没有真实活动且无明确结果时显示“状态未确认”，暂停动画，不误判为成功或强制结束长工具。等待审批和回答不受无活动阈值影响。记录格式是版本兼容读取，来源缺失时只能提示状态未确认。

## 余额

“实时连接正常”下方显示账号提供的余额或使用额度，约每 60 秒更新；锁屏暂停页面轮询，返回后重新读取。查询失败保留上次数据并标注，不估算数值。ChatGPT 使用官方只读 account/rateLimits/read；积分不是法币，套餐额度按窗口显示百分比。其他 API 平台未接入时可能无法查询。

Black AI Coding 接入核对 Codex 当前提供方配置，仅对明确配置的 HTTPS 域名 www.blackaicoding.com / blackaicoding.com 查询 GET /v1/usage，复用本机既有 API Key。钱包余额按平台美元单位显示，API Key 限额、套餐额度另行标注。凭据不发给手机，不新增外部账号登录，不跟随重定向，不写原始响应。运行 npm run balance:check 可只读诊断；此命令只输出余额，不输出凭据。

## 配置手机外出访问

确认电脑和手机的 Tailscale 在线，在电脑运行：

```powershell
tailscale serve --bg http://127.0.0.1:8788
tailscale serve status
```

如果 PowerShell 找不到 `tailscale`，可使用安装路径：

```powershell
& "$env:ProgramFiles\Tailscale\tailscale.exe" serve --bg http://127.0.0.1:8788
& "$env:ProgramFiles\Tailscale\tailscale.exe" serve status
```

手机打开 **Serve 输出的你自己的 HTTPS 地址**，形如 `https://your-device.your-tailnet.ts.net/`。这是示例域名，不能直接使用。无需与电脑连接同一 Wi-Fi；两端需保持加入同一 Tailnet，电脑保持开机并且未休眠。使用 Serve，不要使用 Funnel 对外公开此服务。

获取本机访问令牌：

```powershell
npm run token
```

把输出的 **phone access token** 输入手机面板，点击“连接”。勾选“此设备接收手机审批”，保持页面可见，并确认“手机审批在线”。不要使用 `.env` 中的 Hook 令牌登录，也不要把令牌放入网址或截图。

## 每次开机后

电脑 Tailscale 登录并在线后，在项目目录执行 `npm start`，或双击 `start.cmd`。Serve 的后台配置通常保留，可用 `tailscale serve status` 检查。手机打开自己的 HTTPS 地址，输入访问令牌连接。CRC 不设置开机自启，也不会阻止 Windows 休眠。

若同一端口已经运行 CRC，启动脚本会提示服务已存在；其他程序占用端口时会报错。修改 `.env` 中的 `PORT` 后，必须重启服务并修改 Tailscale Serve 的代理目标。

## 授权与离线行为

批准只允许 **本次 Codex 工具调用**，不创建永久允许规则。命令、文件操作、MCP 等经 `PermissionRequest` Hook 发出的有效请求均可批准。文件范围识别只是辅助说明，不保证列出了操作影响的所有文件。无法识别范围时会默认展开原始参数，由你决定。

新请求出现时，如果手机 CRC 没有实时连接，直接使用 Codex 内置审批或提问界面，不在 CRC 中等待。手机已在线时接收的请求使用可恢复模式：锁屏、切后台或关闭页面后仍保留，重新进入页面会恢复登录（cookie 仍有效时）、重建实时连接并继续处理同一个请求。任一端已处理的请求会同步移除，不能重复执行。电脑本地 CRC 页面仍可手动处理请求。已有请求不会因手机离线自动交回原生审批。

默认最多等待 24 小时；任务结束、失败、中断、超时或回调失联会关闭旧请求。只有主动“转到原生审批”、超时或服务故障时才交回 Codex；交回后无法从手机接回。重启服务会失去仍在等待的回调，因此先处理待办再重启。更新代码后，停止旧服务再执行 npm start；重复启动检测不会更新已运行的进程。

### 手机提问

“授权与提问”区域支持每题选项、文字及选项加补充说明；每题必须明确回答，不自动提交推荐项。通过真实 PreToolUse Hook 捕获 request_user_input/request_user_input_async，再把手机答案作为模型可见 Hook 反馈返回；Stop Hook 可在明确提问时续跑。这不是直接回答 Codex 桌面原生 RPC；不触发相关 Hook 的工具无法捕获，普通自然语言提问只能保守识别。

答案只在内存暂存，不写 CRC 事件日志；但仍会进入 Codex 对话上下文。每题最多 4000 字符。切换对话、同步或重连保留当前页面的草稿；完整刷新或关闭标签页会丢失未提交草稿，未处理问题仍保留。

从 0.1.0 升级：重新运行 npm ci 和 npm run hooks:install，并在 Codex /hooks 重新信任 PreToolUse、Stop、PermissionRequest。三个等待 Hook 的安装超时均为 86460 秒。旧执行轮次可能缓存原来的 5 秒配置，需结束旧轮次后测试，必要时重新打开 Codex。CRC 不替用户完成 Hook 信任，也不自动批准系统请求。

**范围限制：** Windows UAC、系统 ACL、企业策略、Codex Hook 信任提示及未通过 `PermissionRequest` 发出的确认，不由 CRC 授予。CRC 不提供远程桌面，也不保证把桌面助手回复逐字同步到手机。对话目录通过只读 `thread/list` 查询，不启动或恢复任何任务；实时活动由 Hooks 提供。

## 进度说明

计划进度 = 已标记完成的步骤 / 计划总步骤数，不是耗时比例，计划调整后百分比可能下降。没有计划时不推算百分比。等待审批或连接中断时暂停活动动画，新一轮任务重置计数。`Stop` 表示本轮结束，不代表整个项目完成；未完成的计划步骤保留真实状态。

## 配置

参见 [.env.example](.env.example)。令牌至少 32 个字符且互不相同，初始化生成 32 字节随机十六进制值。系统环境变量优先于 `.env`。

| 变量 | 用途 |
| --- | --- |
| `PORT` | 本机 HTTP 端口，默认 8788 |
| `CODEX_REMOTE_TOKEN` | 手机登录凭证 |
| `CODEX_HOOK_TOKEN` | 本机 Hook 独立凭证 |
| `MOBILE_PRESENCE_TTL_MS` | 手机心跳有效期，默认 7000 毫秒 |
| `CODEX_BIN` | 可选：原生 Codex 可执行文件路径 |
| `CODEX_REMOTE_DATA_DIR` | 私有事件存储目录，默认 `data/` |
| `CODEX_HOME` | 可选：本机 Codex 配置及记录目录 |
| `CODEX_APPROVAL_TIMEOUT_MS` | 请求保留时间，默认 86400000 毫秒 |
| `CODEX_TASK_STALE_MS` | 无活动状态提示阈值，默认 120000 毫秒 |

服务不支持绑定公网地址。不要上传 `.env`、事件日志、Codex 数据库或真实会话截图。消息请求体有 256 KB 上限；超限或服务故障时 Hook 回到原生电脑审批，不会静默截断命令和工具参数后让你批准。

## 排查问题

```powershell
npm run doctor
tailscale serve status
```

| 现象 | 检查 |
| --- | --- |
| 502 | 本机首页能否打开；Serve 是否指向当前 `PORT` |
| 手机完全打不开，电脑能打开 | 两端 Tailscale 在线、手机 VPN 冲突、Tailnet ACL；切换 Wi-Fi/流量后重连 |
| 令牌无效 | 使用 `npm run token` 的访问令牌；确认打开的是这台电脑的面板 |
| 没有手机审批 | 页面可见且在线；Hook 已信任；该操作确实触发 `PermissionRequest` |
| 只见部分项目或对话 | 检查 `CODEX_BIN`、目录同步提示、Codex 版本及归档状态 |
| 电脑批准后仍拒绝访问文件 | 检查 Windows 文件权限；Codex 授权不提升系统管理员权限 |
| 端口占用 | 停止重复服务，或修改 `PORT` 和 Serve 目标 |

提交问题请使用 [.github/ISSUE_TEMPLATE](.github/ISSUE_TEMPLATE) 的模板，并遵循 [SECURITY.md](SECURITY.md) 的隐私规则。

## 开发与测试

```powershell
npm ci
npm test
```

测试自行生成随机凭证、随机本机端口和临时数据目录，不读取你的 `.env`，不执行模拟授权中的命令，不安装或修改真实 Codex Hooks。CI 在 Windows 上覆盖 Node.js 22 和 24。

结构与数据流见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。贡献说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 卸载

在服务窗口按 `Ctrl+C`，然后执行：

```powershell
npm run hooks:uninstall
```

卸载仅删除指向本安装目录的 CRC Hook，保留其他 Hook。自定义配置目录请使用与安装相同的 `--codex-home`。卸载不删除 `.env`、本地事件或备份，不修改 Tailscale Serve；确认没有其他服务共用 HTTPS 443 后，可自行运行 `tailscale serve --https=443 off`。

移动项目目录前请先卸载旧路径的 Hook，再在新路径重新安装，否则 Codex 会继续调用旧路径。

## 许可证

[MIT](LICENSE)。
