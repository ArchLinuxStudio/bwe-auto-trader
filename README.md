# BWE Auto Trader

本机优先的三端桌面程序：监听 Telegram `@BWEnews` 新消息，使用 ChatGPT Plus 做低延迟结构化判断，并在全部安全门槛满足后通过 OKX 独立子账户交易 USDT 永续。

> [!WARNING]
> 本程序能够发送真实合约订单，可能快速造成全部测试资金损失。当前版本没有自动止损、止盈或超时平仓，也不适合无人值守运行。请只使用隔离的专用子账户和可承受完全损失的极少量资金，并始终同时观察 OKX 官方客户端。

本项目是独立的非官方工具，与 BWEnews、Telegram、OKX 或 OpenAI 均无隶属、授权或背书关系；程序输出不构成投资建议。

## 当前范围

- Windows / macOS / Linux 源码与构建脚本（Electron + React + TypeScript）；`0.1.8` 在 Windows x64 提供 NSIS 安装包和便携 ZIP，并完成 afterPack、ZIP 完整解压及便携版隔离冷启动验证；macOS/Linux 仍需对应系统或 CI 验证
- Telegram 本人账号通过固定版本的 `teleproto` 连接 MTProto；现有加密 GramJS StringSession 可直接迁移。健康连接下实时推送会立即显示并开始 AI 分析；程序还会每 5 秒核对一次目标频道游标，实时推送漏失时先以“等待校验”显示，确认完整补拉顺序后开始 AI。若监听或连接在确认前停止，卡片会结束为“已跳过”，不会永久等待；启动、重连或游标探测补到的消息永远不会触发下单
- Telegram 与 ChatGPT 使用 Clash Party（默认 `127.0.0.1:7890`）
- ChatGPT Plus 官方 Codex 登录，10 秒超时即 `SKIP`；登录期间接收官方额度通知并每 60 秒完整刷新一次，界面显示本周期剩余额度。额度读取暂时失败时保留上次可信值；额度耗尽会明确提示并锁定自动下单，但 Telegram 监听和频道消息接收继续运行，每条消息仍会显示为“未分析、未下单”
- OKX REST 与私有 WebSocket 分别直连优先；直连失败时为本次连接固定使用应用内 Clash。连接时校验 Read + Trade、独立子账户、net 模式，以及普通挂单和 8 类未触发策略委托
- 程序不包含任何提现接口；若 OKX 返回 `Withdraw` 权限，只显示安全提醒，不再阻止连接
- USDT 永续、逐仓、单向、1x、每单 10 USDT、最多 1 仓、同币 60 分钟冷却
- 展示专用子账户全部 SWAP 持仓，并支持逐次输入“确认平仓”后的整仓 `reduceOnly` 市价平仓；即使 Telegram/AI/监听中断也可在 OKX 私有连接正常时减仓，平仓最终状态确认前禁止重复提交和自动开新仓
- REST 下单成功仅表示 OKX 已受理；成交、部分成交、撤单以私有订单流或只读对账为准
- 网络超时、网关异常或回包不完整时按唯一 `clOrdId` 锁定并只读对账，绝不自动重发
- 系统安全存储、审计日志、桌面通知、紧急停止、重启自动锁定实盘
- 点击主窗口右上角 `X` 会隐藏到系统托盘；单击托盘图标或选择“显示主窗口”可恢复，选择“退出 BWE Auto Trader”才会结束进程

首版不包含止损、止盈、超时平仓、链接或图片内容分析。应用退出不会自动平仓。

> [!IMPORTANT]
> 隐藏到托盘不等于停止程序。Telegram 监听、已连接服务和已解锁的实盘能力会继续运行。需要禁止新开仓时请先使用“紧急停止”；需要结束程序时请从托盘菜单显式退出。无论隐藏还是退出，都不会自动平掉已有 OKX 仓位。

## 开发

需要 Node.js 22 或更新版本。

```powershell
npm.cmd install
npm.cmd run check:dependencies
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run dev
```

如果终端只能通过 Clash 访问 npm，可只为当前 PowerShell 设置代理：

```powershell
$env:NODE_USE_SYSTEM_CA='1'
$env:HTTP_PROXY='http://127.0.0.1:7890'
$env:HTTPS_PROXY='http://127.0.0.1:7890'
npm.cmd install
```

这不会改变系统全局代理。Telegram 和 AI 使用 Clash；OKX REST 与私有 WebSocket 会先短时尝试应用直连，失败后分别固定使用 Clash，连接期间不会逐请求切换或自动重发订单。系统 VPN、Clash TUN 或全局代理仍可能改变“应用直连”的实际出口。

## 首次配置顺序

1. 从 `my.telegram.org` 获取 `api_id` 与 `api_hash`，保存后完成验证码/2FA 登录。
2. 通过浏览器登录 ChatGPT Plus，等待模型预热完成。
3. 在 OKX 独立子账户创建仅含 `Read + Trade` 的 API Key。仍强烈建议不要勾选 `Withdraw`，但它不是程序连接前置条件。
4. 可选运行网络诊断查看当前出口。界面会区分尚未检测、探针可达和检测已完成但未通过；OKX 端点探针失败仍只是可选诊断结果。是否给 OKX API Key 绑定 IP 白名单由你决定，不影响程序连接或解锁实盘。
5. 三个连接全绿后开启监听。观察分析结果无误，再输入“确认实盘”解锁真实下单。

任何重启、已确认的连接中断、OKX 数据流异常或订单状态不明确，都会自动锁定实盘。Telegram 一出现疑似断线就会立即关闭内部交易门禁，禁止在校验/补拉期间解锁或发单；如果在一个健康检查周期内恢复，程序原有的实盘授权不会被误撤销。如果断线持续超过一个周期或再次收到失败状态，则确认进入重连、锁定实盘；恢复后必须人工重新输入确认词。每条实时消息还会绑定其到达时的授权与连接代次：到达时未解锁，或分析期间发生锁定、恢复、停止监听、重新解锁，该消息都只能展示 AI 结果。此门禁会一直复核到 OKX 真实订单 POST 前。补拉消息同样永远不能下单。teleproto 的一般可恢复错误只作诊断，不能单独触发锁定。状态不明确的订单只会只读对账，永不自动重试。专用子账户持仓区会显示该子账户的全部 SWAP 持仓，不会把其他来源的仓位误称为本程序仓位。

更换为另一组 OKX API 凭据前，程序要求旧凭据仍连接，并重新只读确认旧账户没有 SWAP 仓位、普通未完成订单、8 类未触发策略委托、本地待确认订单或重启前遗留的 mutation journal 记录。先断开旧账户或重启程序不能绕过这项检查；保存、连接、断开、解锁和平仓也由主进程串行互斥，避免在切换账户期间发出交易请求。

## 第一次真实小额检查

1. 使用只放极少量资金、没有普通挂单或策略委托的专用子账户，并在 OKX 确认为 `net` 单向持仓模式。
2. 连接后先保持“安全锁定”，确认 Telegram、ChatGPT、OKX 和 REST/私有 WebSocket 路由均正常。
3. 开启监听后输入“确认实盘”解锁。当前固定为逐仓、1x、每单约 10 USDT、最多 1 个仓位。
4. OKX REST 回包后界面会先显示“已受理/等待确认”；只有私有订单流或只读对账确认后才显示成交。
5. 测试平仓时选择仓位、输入“确认平仓”并只提交一次。界面显示“平仓处理中”期间不会允许重复提交或自动开新仓；若该交易对还有触发单、条件单等策略委托，请先在 OKX 官方客户端处理。

本版本不会自动设置止损、止盈或按时间平仓；这些不属于当前已确认的简单功能范围。首次测试请全程同时观察 OKX 官方客户端，确认仓位后及时手动处理。

如果界面提示“订单结果未知”或连接在下单期间中断，不要再次点击、不要更换 API 凭据来尝试清除状态。程序会在真实订单 POST 前原子写入脱敏的 mutation journal，并在 ACK、部分成交、未知或终态时更新；崩溃或重启不会清除仍未取得终态的互锁。重启后不会自动连接或解锁；使用原账户凭据显式连接时，程序只按账户身份和客户订单号做只读恢复。精确匹配的终态可以解除记录，但新 client 即使多次“未找到”也会继续锁定。请同时在 OKX 官方客户端按交易对、客户订单号和订单号核对，不要把重启当作交易所侧核验的替代品。

## 构建

```powershell
npm.cmd run package:win
npm.cmd run package:mac
npm.cmd run package:linux
```

macOS 和 Linux 安装包应分别在对应系统或 CI runner 上生成。当前 `0.1.8` Windows 安装包和主程序未配置发布者代码签名，Windows SmartScreen 可能警告；长期正式分发建议配置 Windows 代码签名，macOS 则需 Developer ID 签名与公证。

## 测试安全说明

自动测试全部使用 mock transport，不读取真实凭据，也不发送真实订单。第一次真实验证请继续使用专用子账户和可承受损失的极少量资金，并先保持“安全锁定”观察信号。

## 安全与隐私

- 不要把 Telegram、OKX 或 ChatGPT 凭据、会话文件、应用数据目录、日志或真实公网 IP 提交到仓库或 Issue。
- 项目默认忽略常见密钥、证书、会话、审计日志和用户数据文件；提交前仍应人工检查暂存区。
- 报告安全问题时优先使用 GitHub Private Vulnerability Reporting（若仓库已启用）；否则只提交不含敏感信息的最小复现说明。
- 未决订单 journal 只保存订单类型、账户 UID 的不可逆指纹、交易对、客户订单号/订单号、生命周期与时间证据，不保存 API Key、Secret、Passphrase、请求签名或下单 body。journal 损坏、账户不匹配或恢复查询不确定都会保持锁定。

## 许可证

本项目采用 [PolyForm Strict License 1.0.0](LICENSE)，属于源码可见许可证，不是开源许可证。

- 仅允许非商业用途。
- 不允许分发本软件。
- 不允许修改本软件或基于它制作衍生作品。
- 商业使用、修改或分发需要事先取得 ArchLinuxStudio 的单独书面授权。

以上限制仅覆盖 ArchLinuxStudio 的原创代码。第三方依赖和运行时继续适用其各自的许可证；本项目许可证不会覆盖、替代或缩减第三方在 MIT、ISC、Apache-2.0、BSD、LGPL 等许可证下已经授予的权利。完整 npm 生产依赖清单、许可证证据和 OpenAI Codex NOTICE 见 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt) 与 `licenses/third-party-manifest.json`。

构建会检查 npm 生产依赖许可证、禁止旧 `telegram` / `@cryptography/aes` 链路，并在打包后再次扫描 ASAR。Windows 包还必须保留 Electron 的 `LICENSE.electron.txt` 和 Chromium 的 `LICENSES.chromium.html`；后者包含 FFmpeg 等 LGPL-2.1-or-later 组件。因此可以表述为“已移除旧 GramJS GPL 依赖”，不能把完整 Electron 安装包表述成“不含任何 GPL-family 或弱 copyleft 组件”。该工程检查和随包清单仍不等同于法律意见。
