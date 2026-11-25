# dsh-pet-qq — 让 dsh 桌宠连上**自己的**另一个 QQ

照抄 Coo（Coopanion）那条已经跑通的通道形态（SnowLuma → OneBot v11 正向 WS → Bearer token），
但**不复用**它的端口和账号：桌宠走自己的协议端端口、自己的 token、自己的 QQ 号，与 Coo 的 3001 完全隔离。

## 两条通道对照

```
QQ A（泡泡🫧 30027）──┐
                            ├─ SnowLuma（同一套 app，按号分配置）
QQ B（桌宠专用）────────────┘        │
                                     ├─ 3000 HTTP / 3001 WS / tokenA ──▶ Coo 的 qq world（通道 A）
                                     └─ 3010 HTTP / 3011 WS / tokenB ──▶ 本桥 ──▶ dsh-pet /chat ──▶ DSH 模型
```

| | 通道 A（Coo） | 通道 B（桌宠） |
|---|---|---|
| 协议端 WS | `ws://127.0.0.1:3001/` | `ws://127.0.0.1:3011/` |
| HTTP | `3000` | `3010` |
| token | `onebot_3202908420.json` 里的 `ws-default` | `onebot_<桌宠QQ号>.json` 自己的 `ws-default` |
| 配置来源 | `D:\coopanion\data\home\companion\config.json` → `worlds.qq` | `tools\dsh-pet-qq\config.json` |
| 谁在用 | Coo 的 qq world | dsh 桌宠（`/dsh-pet-7340/chat`） |

桌宠接口：`<DSH webServer>/dsh-pet-7340/chat?pet=main&surface=any`（不需要 DSH Web token；`pet=main` 是 `GET /dsh-pet-7340/config` 里 `main.pets[0].id`）。
**端口是 DSH 每次启动动态分配的，不固定**：实测 `1882`（重启前）→ `8726`（重启后）。桥用 `pet-endpoint.mjs` 自动发现，别在别处写死端口，详见下面「桌宠端口自动发现」。

## 首次接入一个从没被 SnowLuma 见过的 QQ 号

1. 先跑 SnowLuma：`C:\Users\86189\SnowLuma\start.bat`（WebUI 5099）。
2. 用**新号**启动第二个 QQ 并登录。同一台机多开 QQ 的做法：复制一份 QQ 安装目录（例如 `D:\QQ-B`），跑 `D:\QQ-B\QQ.exe` 用新号扫码。
   - 必须用不同安装路径：SnowLuma 是按 QQ 进程注入的，同一个 `D:\QQ.exe` 会被当成同一个号。
3. SnowLuma 会给这个号落一份 `app\config\onebot_<号>.json`，但里面端口默认还是 3000/3001，会和泡泡🫧 抢。
4. **完全退出 SnowLuma**，然后：

   ```powershell
   cd "D:\dsh workplace\tools\dsh-pet-qq"
   powershell -ExecutionPolicy Bypass -File .\new-channel.ps1 -Uin <桌宠QQ号> -WriteSnowLuma
   ```

   它把该号改成 `WS 3011 / HTTP 3010`、生成独立 token，并把本目录的 `config.json` 指向这条通道（含 `expectSelfId` 目标号校验）。
5. 重开 SnowLuma → 重开 QQ B（顺序不能反：SnowLuma 只能注入它启动**之后**出现的 QQ 进程）。
6. 等端口：`Test-NetConnection 127.0.0.1 -Port 3011`
7. 自检：`node bridge.mjs --check` → 应出现 `协议端：在线 <昵称>(<号>) ✓ 目标号`
8. 常驻：`wscript //B start-hidden.vbs`，或一键 `powershell -ExecutionPolicy Bypass -File .\connect-qq-b.ps1`

## 日常

**两条 QQ 通道一起断 / 只想一键接回来（最常用）**：双击 `reconnect-all.bat`。它按顺序做四件事——确认/隐藏拉起 SnowLuma(5099)、确认/隐藏拉起桥(7341)、发现看门狗跑的是旧代码就重载、打印七个端口的状态。**Coo 的 3000/3001 和桌宠的 3010/3011 是同一个 SnowLuma 进程带起来的，所以救活 5099 两条通道会一起回来**；Coopanion 的 QQ 插件和桥都会自己重连，不用重启 QQ 或 Coopanion。可重复运行，不碰 DSH / QQ / Coopanion 进程。**双击时还会带 `-ForceReloadWatchdog`**：强制把看门狗重启到你自己的桌面会话里，这样关掉这个对话后守护也不会被回收（从工具会话拉起的守护有被回收的风险）。

**通道断了 / DSH 重启后**：双击 `rebuild-qq.bat`。它确认 SnowLuma(5099) 与协议端(3011) → 停旧桥 → 确保看门狗在跑并由它拉起桥 → 跑账号自检。桌宠端口会自动重新发现，不用手改 `config.json`。
**想让连接不再随对话结束掉线**：双击一次 `keep-alive.bat`（顺便装好开机自启），详见下面「掉线排查与常驻守护」。
**想让 WorkBuddy 退出/重启后两条通道都不受影响**：已完成桌面会话迁移（2026-11-09 01:06），平时不需要再做任何事；原理、自检方法和兜底见「退出 WorkBuddy 后依然在线」。

**首次把 QQ-B 拉起来**：双击 `connect-now.bat`。它先确保 SnowLuma 已起并等到 5099 就绪（同时把通道 A 的 3000/3001 一起恢复），再调 `connect-qq-b.ps1`：起 QQ-B → 等 3011 → 无窗口起桥 → 账号自检。
必须在**自己的桌面会话**里跑：工具/沙箱会话里 `Start-Process` 或 WMI 创建的常驻进程会在命令结束时被回收，`cmd.exe` / `Win32_Process.Create` 也会被安全策略拦截。
若 QQ-B 弹登录窗口，扫码后脚本会继续等 3011（超时 180s）。成功后 QQ-B、桥、SnowLuma 都会常驻，**别结束 SnowLuma 的进程**（窗口现在已隐藏，见下）。

**SnowLuma 那个命令行窗口**：它下面的 node 独占 `5099` WebUI、`3000/3001`（Coo 通道 A）、`3010/3011`（桌宠通道 B 的 OneBot WS），**必要，不能关**。开机自启本来就有（启动目录 `SnowLuma.vbs`），只是原来是 `WshShell.Run ..., 7`（最小化但仍占任务栏）；已仿照 Coo 的 `CoopanionTunnel.vbs` 改成 `0`（SW_HIDE），**下次登录起完全无窗口**。**2026-11-09 又改了一次**：启动项不再走 `start.bat`（`launcher.bat` 结尾的 `pause` 在隐藏窗口下会卡住，导致五个端口全起不来），改为和 `start-snowluma-hidden.vbs` 一样直接调自带 Node 跑 `app\index.mjs`。当前这次会话残留的那个窗口，双击 `hide-snowluma.bat` 即可隐藏——只改窗口可见性，不结束进程、不断端口；`keep-alive.bat` 已顺带调用它。启动项历次备份：`D:\wb\_startup-backup-20261108\SnowLuma.vbs.bak-20261108-1630`（最小化版）、`...bak-20261109-0055`（start.bat 版）；删掉启动目录里的 `SnowLuma.vbs` 即禁用自启。

```powershell
cd "D:\dsh workplace\tools\dsh-pet-qq"

powershell -ExecutionPolicy Bypass -File .\connect-qq-b.ps1   # SnowLuma → QQ B → 等 3011 → 起桥 → 校验账号
node bridge.mjs --check                                       # 只看状态
node bridge.mjs --selftest "在吗"                              # 真发一条给 listen.privates[0]
node bridge.mjs --sticker-test "可爱"                         # 只发一张表情包图片（不需要 DSH 在线）
node bridge.mjs --proactive-test                              # 不等静默，立刻生成并真发一句私聊主动续话
node bridge.mjs --group-proactive-test                        # 不等静默，立刻往三人群真发一句群内主动
node bridge.mjs --simulate-event samples\private.json          # 假事件跑链路（dryRun 不真发）
stop.bat                                                      # 停桥（按 7341 闸门归属精确停）
.\rebuild-qq.bat                                              # 停桥 + 重启 + 自检（双击也行）

# 临时切回「与 Coo 共用 3001」的老通道（先 stop.bat，单实例闸门 7341）
node bridge.mjs --config config.channel-a.json
```

## 掉线排查与常驻守护

**症状（2026-11-08 实测）**：QQ 突然不回消息，`7341` 没监听，`logs/bridge.log` 最后一行停在几小时前，既没有 `WS 已断开`，也没有 `进程退出`。

**根因**：桥当时是用「对话里的后台任务」`node bridge.mjs` 拉起来的，父进程属于工具会话；任务被回收 / 会话中断时整棵进程树被直接杀掉（对应后台任务通知 `exit code 127`）。不是 WS 断线，不是 DSH 端口漂移，也不是 QQ 掉登录——这三种都会留下明确日志，被杀不会。同样的坑在下面「日常」第 51 行也写过。

**2026-11-08 22:55 第二次掉线（另一种死法）**：SnowLuma 进程整个没了，`5099/3000/3001/3010/3011` 全空，桥还活着但对着 3011 一直 `ECONNREFUSED` 退避重连，QQ-B 还登录着。旧版看门狗只盯 7341，所以没救。现在看门狗同时盯 5099，SnowLuma 掉了会在 20 秒内隐藏拉起（日志：`SnowLuma 未监听 5099 → 第 N 次隐藏拉起`）。**注意**：这个新逻辑要双击一次 `keep-alive.bat` 才会重载到已经跑着的看门狗；不双击则下次登录生效。

**2026-11-09 00:41 第三次掉线（Coo + 鱼一起断）**：上一次恢复时 SnowLuma 是用「对话后台任务」直接跑 node 拉起的，会话结束又被回收，五个端口再次全空；桥被看门狗 00:42 拉回后一直 `ECONNREFUSED 3011`。这次暴露两个问题并都已修好：
1. 运行中的看门狗仍是 22:55 的旧代码（脚本 23:00 才更新），只守 7341 → `reconnect-all.ps1` 会自动比对脚本时间戳与进程启动时间，旧实例直接重载；重载后日志写 `守护端口=7341(桥) + 5099(SnowLuma)`。
2. `start-snowluma-hidden.vbs` 走 `start.bat → launcher.bat`（含 `pause`），隐藏窗口下根本没把 node 跑起来，看门狗连拉 3 次都失败 → 改成和 `start-hidden.vbs` 一样**直接调自带 Node 跑 `app\index.mjs`**，并把 runtime node 加进 PATH；启动项 `SnowLuma.vbs` 同步改成同一写法，避免下次登录又起不来。

**两条通道的共用关系**：`5099/3000/3001(通道 A → Coopanion 的 cortico-world-qq)`、`3010/3011(通道 B → 桌宠桥)` 全由同一个 SnowLuma 进程持有。所以「Coo 和鱼一起不回消息」基本等价于 SnowLuma 挂了，救 5099 即可，不需要分别重建。`3001` 的 ESTABLISHED 客户端是 Coopanion 主进程，`3011` 的是 `bridge.mjs`，可用 `netstat -ano | findstr "3001 3011"` 分别确认。

**2026-11-09 20:40 第四次掉线（服务全在、QQ 客户端没开机自启）**：重新开机后 `5099 / 7341 / 17788` 都在线，但 `3000/3001/3010/3011` 一个都没监听；Coo 的 qq world 显示「协议端未连接」，桥每 30 秒 `ECONNREFUSED 127.0.0.1:3011`。**根因不是 SnowLuma**：启动目录只恢复了 `SnowLuma.vbs` / `CoopanionTunnel.vbs` / `dsh-pet-qq-watchdog.vbs`，两个 QQ 客户端（`D:\QQ.exe` 通道 A、`D:\QQ-B\QQ.exe` 通道 B）没自启。SnowLuma 只能注入**它启动之后**才出现的 QQ 进程，所以服务全在也没有 OneBot 端口。SnowLuma 日志能看到 `[Hook] login detected` / `[OneBot] session started`，但端口绑定失败（`network startup degraded` / `EADDRINUSE` 是同一进程内多子进程重复触发 session，第一个成功绑定即可）。

**本次修法**：
1. 启动目录新增 `QQ-Clients.vbs` → `start-qq-clients.ps1`：先等 `5099` 就绪（最多 90 秒），再按端口幂等启动缺的那个客户端（`3001` 在就跳过通道 A、`3011` 在就跳过通道 B）；QQ 窗口正常显示，万一要扫码才看得见。
2. `watchdog.ps1` 新增第三条守护：`5099` 在线但 `3001/3011` 连续 3 次（约 60 秒）掉线 → 跑 `start-qq-clients.ps1` 把 QQ 拉回来，180 秒冷却。会话中途手动退了 QQ 也能自愈。
3. 顺序铁律不变：**先 SnowLuma，后 QQ**。不要为了「重连」去重启 SnowLuma——那会让已经登录的 QQ 进程失去注入，四个 OneBot 端口再次全空。

一句话诊断：`5099` 在线 + `3001/3011` 全空 = QQ 客户端没起来（不是桥、不是 Coo、不是网络）；`5099` 也空 = SnowLuma 挂了（看门狗会救）。本次 DSH 重启后台宠端点还从 `8726` 漂到 `1550`，桥的 `pet-endpoint.mjs` 已自动切换（日志「桌宠端点自动切换」），不用改配置。

| 防护层 | 做什么 | 怎么生效 |
|---|---|---|
| 桌面会话常驻 | `watchdog.ps1`（`wscript` 中转，不挂在对话任务下）每 20 秒查 **7341（桥）+ 5099（SnowLuma）+ 3001/3011（QQ 客户端）**：前两个掉了分别用 `start-hidden.vbs` / `start-snowluma-hidden.vbs` 隐藏拉起；5099 在但 OneBot 端口连续 3 次掉线就跑 `start-qq-clients.ps1`。命名 Mutex 保证只有一个实例 | **双击一次 `keep-alive.bat`**；脚本有更新时会自动重启看门狗载入新逻辑 |
| 开机自启 | `install-startup.ps1` 在用户「启动」文件夹放一个 VBS，登录后由 explorer 拉起看门狗 | 双击 `keep-alive.bat` 时自动装；也可单独跑 `powershell -ExecutionPolicy Bypass -File .\install-startup.ps1`。卸载：`install-startup.ps1 -Uninstall` |
| QQ 客户端自启 | 启动文件夹 `QQ-Clients.vbs` → `start-qq-clients.ps1`，登录后等 5099 就绪再按端口幂等拉起 `D:\QQ.exe` / `D:\QQ-B\QQ.exe` | 2026-11-09 20:40 起已装；删掉该 VBS 即禁用。手动补跑：`powershell -ExecutionPolicy Bypass -File .\start-qq-clients.ps1` |
| 崩溃可诊断 | 启动日志打 `进程 PID / 父进程 PPID`；`uncaughtException`、`exit` 都落盘；每 30 分钟一行 `心跳：WS … / 桌宠 …`；WS 断线却没有重连计划时 30 秒内强制补连 | 已内置在 `bridge.mjs` |
| 一键重建 | `rebuild-qq.ps1` 停旧桥后先确保看门狗在跑，再由看门狗把桥拉起来，最后跑账号自检 | 双击 `rebuild-qq.bat` |

**判断死因**：末尾有 `进程退出：code=N` = 自己崩的（看门狗会拉起）；最后一行是心跳但没有退出行、且 7341 空 = 被外部强杀；有 `WS 已断开` = 协议端掉了，桥会退避重连（1s→30s 封顶，无限重试）。主动续话已经是 30/60 分钟一次，长时间没有消息属于正常，看心跳行确认存活。

> 本机安全策略把 `schtasks.exe` 列入程序黑名单，**不要**用计划任务做自启（会被拒且不能绕过），走「启动文件夹 VBS」。工具会话里 `Start-Process` 起的常驻进程依旧会被回收；例外是 `run-via-explorer.ps1`——它把脚本交给 explorer 代执行，从而落到桌面会话（见「退出 WorkBuddy 后依然在线」）。其余需要常驻的操作，双击 bat 请在自己的桌面会话里做。

只想立刻恢复一次：双击 `reconnect-all.bat`（拉起 SnowLuma + 桥，两条通道一起接回）；**它不会启动 QQ 客户端**——如果是「5099 在线、3001/3011 全空」这种，改跑 `powershell -ExecutionPolicy Bypass -File .\start-qq-clients.ps1`（或等看门狗自愈）。只想重建桥：`stop.bat` → `rebuild-qq.bat`。

## 退出 WorkBuddy 后依然在线（桌面会话托管）

**问题**：从对话/工具会话里用 `node bridge.mjs`、`Start-Process`、`run_in_background` 拉起的常驻进程属于 WorkBuddy 的作业树，WB 重启或退出时会把它们一起清掉。历史上三次掉线都是这个原因（05:14 桥、00:41 桥 + SnowLuma 一起没）。日志表现为「最后一行正常，之后整段空白，连 `进程退出` 都没有」。

**判据**：只有由**桌面 shell `explorer.exe`** 创建的进程能跨 WB 退出存活。实证：00:42 WB 重启时，由桌面会话拉起的看门狗 83896（22:55 启动）活了下来并在 00:41:52 自动把桥拉回；而同一时刻由工具会话拉起的桥和 SnowLuma 一起被杀。

**当前的架构（2026-11-09 01:06 完成迁移）**：

| 组件 | 归属 | 谁拉起 |
|---|---|---|
| Coopanion.exe / DSH 桌宠 / QQ / QQ-B / Coo 隧道 guard | 本来就是桌面会话独立进程 | 用户手动 / 启动项，与 WB 无关 |
| SnowLuma（5099 + 3000/3001 + 3010/3011） | **explorer → WScript → node** | `start-snowluma-hidden.vbs`，由 adopt 脚本拉起 |
| `bridge.mjs`（7341） | **explorer → WScript → node** | `start-hidden.vbs`，由 adopt 脚本 / 看门狗拉起 |
| `watchdog.ps1`（守 7341 + 5099） | **explorer → WScript → powershell** | `start-watchdog.vbs`，由 adopt 脚本 / 登录启动项拉起 |

**迁移是怎么做到的**：`run-via-explorer.ps1` 把 `detach-watchdog.vbs` 交给 `explorer.exe` 用 ShellExecute 执行（`.vbs` 关联 `WScript.exe`）。于是整条链 `explorer → WScript → powershell(adopt) → WScript → node/powershell` 都在桌面会话里，WB 碰不到。`adopt-desktop-session.ps1` 负责停掉旧看门狗、重建 SnowLuma 与桥、再拉起新看门狗；**热切换约 6 秒**，两端 WS 自动重连。`-SkipServices` 只换看门狗，零断线。

日志在 `logs/desktop-session.log`：`adopt 完成：全部常驻组件已由 explorer 桌面会话托管` 且七个端口全 OK 即成功。想自己核对父链：`Get-CimInstance Win32_Process -Filter "ProcessId=<PID>"` 看 `ParentProcessId` 指向 WScript/node（父已退出是正常的，说明已脱离），而不是 WorkBuddy.exe。

**开机后也一样**：启动文件夹里 `SnowLuma.vbs` 和 `dsh-pet-qq-watchdog.vbs` 都由 explorer 拉起，桥由看门狗拉起，所以重新登录后整条链路天然就是桌面会话的，不需要再迁移一次。

**退出 WB 后自检**：`netstat -ano | findstr "5099 3001 3011 7341 8726"` 看七个端口；`3001` 的 ESTABLISHED 客户端应是 Coopanion.exe，`3011` 的应是 bridge.mjs。真有异常，双击 `reconnect-all.bat`（它会把看门狗重新挂到桌面会话），20 秒内自愈。

> 注意：**重启电脑**后 Coopanion 和 DSH 桌宠本体如果没设开机自启，仍需你手动打开；它们不是 WB 拉起的，也不归这套脚本管。本章保证的是「退出/重启 WorkBuddy 不影响两条 QQ 通道」。

## 行为

- 私聊：`listen.privates` 里的号 → 桌宠回复回私聊。
- 群：`listen.groups`（当前 **20000**）+ `groupWake: all` = 没 @ 的群消息都进桌宠并回群里；改回 `mention` 就只有被 @ 才回。但**只要消息里 @ 了别人、没 @ 她，就一律不回**（见「@ 是定向：只对该回的人回」）。防循环闸门见「群聊 20000 与防循环」。
- 同一会话串行排队，桌宠的记忆不会被并发写乱。
- 回复按换行切成 ≤`maxChunks` 条（当前 **8**）、单条 ≤`maxChars` 字（300），间隔 `sendIntervalMs`；旧版 3 条上限已放开。
- **主动续话**：哥哥静默一阵后，她会基于刚才的对话自己接着说一句（只对私聊，见下）。
- 用的是桌宠自己的对话记忆与人格（和桌面/网页面板里同一只），模型走 DSH 当前默认模型。
- **账号闸门**：`onebot.expectSelfId` 与 `get_login_info` 不符时，整条连接拒收消息（防止误连到 Coo 的泡泡号上乱发）。
- 收到的 QQ 图片/语音只以 `[图片]`、`[语音]` 占位进文本，不下载不识别；**发出去**的表情包由 `stickers.mjs` 处理（见下）。
- **任务通道（`task.enabled`）已于 2026-11-24 关闭**：以前私聊发「任务：xxx」会被桥截胡落盘，现在不再拦截、不落盘、不回 ack，这句话会当普通聊天处理。代码保留在 `task-bridge.mjs` / `task-notify.mjs` 供泡泡组复用，**不要删**。

## 身份：她怎么知道你是哥哥

`/chat` 只收 `text`，**没有发送者字段**，模型只能从消息文本和人设里判断对面是谁。旧模板 `prompt.private = "{nick} 在 QQ 上私聊你说：{text}"` 把白名单里的主人包成第三人称「徨(=￣ω￣=) 在 QQ 上私聊你说：…」，人设【对外人】段就把他当成「哥哥的朋友」，于是出现「哥哥他现在不在」「我不信，你怎么证明」。

两层修复：

- **桥模板**：`config.json` 的 `prompt.private` 现在是 `【私聊｜…】\n哥哥：{text}`，正文本身不带昵称；前一行是会话标签（见「会话隔离」章）。改 config 需要重启桥（`stop.bat` → `rebuild-qq.bat`）才载入。
- **人设判据**：`~/.dsh/dsh-pet/main-config.jsonc` 的 `pets[0].whisperPrompt` 新增【谁在跟你说话】段——此刻发消息的人就是哥哥、QQ `10000`，不需要证明；并说明「在 QQ 上私聊你说：」「哥哥：」这类开头都只是转发格式标记。人设每轮实时读盘，**不重启也生效**，所以桥没重启时同样认人。
- 【对外人】只在对方明确说「我不是哥哥」时才启用。私聊 `allowAllPrivates: false` + 名单只有 `10000`，默认信任是安全的；以后放开白名单要同步改模板和判据。

修完记得清一次对话记忆：旧的「不认人」几轮会被 `chatMemoryRounds` 带进上下文，跟上次「泡泡」同一个机制。`DELETE /chat?pet=main&ts=<毫秒时间戳>` 按轮精准删（可重复传 `ts`），不带 `ts` 则清空整只。

**三方群补充**：群 20000 里还有 Coo 的桌宠泡泡（`30027`），她不是哥哥。`prompt.group` 现在带 `（QQ {uid}）`，人设新增【群聊例外】按这个号区分说话人——`10000` 是哥哥，`30027` 是泡泡。改人设热读盘生效，改 `prompt.group` 要重启桥。否则溪颜会把泡泡的话也当成哥哥说的、在群里叫错人。`prompt.group` 现在还有 `{at}`（点名标记）和 `{scope}`（「只对你说」说明）两个占位，模板改动要重启桥。

## 群聊 20000 与防循环（config.groupChat）

群里同时有两个桌宠（溪颜 `10001`、泡泡 `30027`，都用 SnowLuma，只是分别接 3011 / 3001）。两边都设成「每条都参与」后，**它们会互相接话**，所以桥这边加了两道硬闸门：

| 字段 | 当前值 | 说明 |
|---|---|---|
| `botAccountIds` | `[30027, 10001]` | 这两个号发的话算「bot 轮次」；其他号（哥哥）发言把轮次清零 |
| `maxBotTurns` | `8` | 连续 8 轮都是两个桌宠在说、真人没插话，之后就静默；`0` = 不限（2026-11-09 从 4 放宽，配合群内主动说话） |
| `maxSendsPerWindow` | `12` | 单个群在 `windowSec` 内最多往外发几条；`0` = 不限（从 6 放宽） |
| `windowSec` | `60` | 滑动窗口长度（秒） |

被闸门拦下的消息**仍然收到了**（日志写「已收到，防循环不回复」），只是不再唤醒桌宠、不往群里发；哥哥在群里说一句就立刻恢复。Coo 侧没有 bot 轮次计数，靠 `worlds.qq.maxSendsPerReply` / `maxConsecutiveSends` / `groupMaxPerWindow` 三道闸门 + 人格里「别刷屏、聊到自然停下」兜底（2026-11-09 已放宽，见下节）。**注意**：`config.json` 里这五个值过去根本没被读进 QQ World（`definition.ts` 没透传），`gateSend` 一直用代码兜底 3 / 5 / 600 / 12 / 60；已修好透传，但源码改动要**下次重开 Coopanion** 才加载。

离线验证：`node bridge.mjs --group-loop-test`（不连 WS、不调桌宠、不真发，四个场景）。想让两个桌宠彻底自由对聊，把 `maxBotTurns` 和 `maxSendsPerWindow` 都设 `0`，并把 Coo 的 `groupMaxPerWindow` 调大；不建议在有多人的群这么干。

> Coo 的 `worlds.qq.groupWake` 是**全局**开关，设 `all` 后原来的「孤独者联萌」369189729 也会被唤醒。已在 `PARTNER.md` / `CONSTITUTION.md` 写死「除了 20000，其他群没 @ 一律不回应、也不主动开口」，并用 `groupMaxPerWindow: 14` 限流兜底；要完全隔离，把 369189729 的 `enabled` 改 `false` 即可（条目保留，随时开回来）。

## @ 是定向：只对该回的人回（config.groupChat.respectAt）

哥哥在群里 **@ 一个人，就代表这句话只是对那个人说的**。两个桌宠都得学会区分：被 @ 的那个认真回，另一个看得见但不接话。

| 消息形态 | 溪颜（本桥） | 泡泡（Coo） |
|---|---|---|
| `@溪颜` / `@10001` | **回**，prompt 带「@溪颜(你) …（这句点名了你，是专门只对你说的）」 | 只入队不唤醒，消息带「是只对TA说的，不是对你说的：只看，不要回复」 |
| `@泡泡` / `@30027` | 收到但不叫醒、不回，存成背景摘要 | **回**（mention → flush），带「这条专门 @你，只对你说」 |
| 同时 @ 两个 | 回 | 回 |
| `@全体成员` | 按普通群消息回 | 按普通群消息处理 |
| 没 @ | 按 `groupWake: all` 回 | 按 `groupWake: all` 回 |

- **两端都要「看得到」**：桥把定向给别人的消息攒进 `missedByGroup`，下次溪颜真要回话时以「旁白：刚才群里还有这几条不是对你说的消息」补进 prompt；Coo 侧这类消息走 `piggyback` 只入队，随下一次唤醒一起看到。不会因为不接话就断片。
- **Coo 侧实现**：`cortico-world-qq/src/normalize.ts` 的 `renderIncoming` 多返回 `atTargets` / `atAll`，`src/world.ts` 据此把「@ 别人」强制 `piggyback` 并加文字标注（即使 `groupWake: "all"` 也不单独唤醒），同时写一条 `QQ 定向消息仅入队不唤醒` 日志。改这两个文件要重启 QQ world。
- **规则兜底**：溪颜人设新增【@ 是谁就对谁说】，Coo 的 `PARTNER.md` 与运行时 `worlds.qq.envPrompt` 覆盖同步写了同一口径，默认模板 `src/ENV_PROMPT.md` 也已同步。硬拦截在代码层，提示词只负责让她理解语义。
- `groupChat.nameOf` 把 QQ 号渲染成称呼（哥哥 / 泡泡 / 溪颜(你)），`@30027` 会显示成 `@泡泡`；`replayMissed` / `replayMissedMax` / `replayMissedSec` 控制背景回放的条数与有效期；`respectAt: false` 可整体关掉定向拦截（回到「谁都接」）。

离线验证：`node bridge.mjs --at-route-test`（13 项：CQ 码与 segment 两种 @ 形态、@自己 / @别人 / @多人 / @全体 / 没@、称呼渲染、背景回放取完即清与过期不带）。不连 WS、不调桌宠、不真发。

## 会话隔离：别把群里的话发进私聊（2026-11-12）

**症状**：群里刚和泡泡聊完，过一阵她在**私聊**里接着群里的「账本」话题说了一句；指出她发错人了，她回「我没发错」。平时说话也显得越来越跳、抓不住前后。

**根因（几个问题叠在一起）**：

1. **桌宠只有一份记忆**：`~/.dsh/dsh-pet/memory.json` 的 `main.main.messages` 是单条线，`chatMemoryRounds: 10`（20 条）。群里 22:50–22:53 连聊 20 多轮，把上下文窗口占满，私聊说过的话全被挤出去。宿主不支持按会话隔离记忆（`?surface=` 只决定显示在哪一端），只能在桥层贴标签。
2. **私聊主动续话的计时器只认私聊**：`resetIdle()` 里 `if (target?.type !== 'private') return`，群聊再热闹也不会重置 30 分钟的私聊计时。到点 `proactiveTurn()` 让桌宠「接着刚才聊到的地方往下说一句」——可「刚才」全是群聊，最后 `deliver(idleTarget)` 发去了私聊。
3. **群号从来没进过 prompt**：人设【群聊例外】写的是「QQ 群 20000 里只有三个人」，旧模板却只有 `QQ 群「{group}」里 …`，群名还被 QQ 截成「泡泡🫧、溪颜、徨(=￣」，这条判据永远匹配不上。
4. **「不承认」是人设明文教的**：【核心性格】「……刚才不是我发的」、【对外人】「逗你玩…别真的盘问或翻脸」，模型把纠错当成调情接了。

**修复**：

| 层 | 做法 |
|---|---|
| 每条消息贴会话标签 | `config.prompt.private` → `【私聊｜…】\n哥哥：{text}`；`config.prompt.group` → `【三人群 {gid}｜…】\nQQ 群 {gid}「{group}」里 …`。`fill()` 现在传 `gid`。标签随 user 文本写进 `memory.json`，历史里也能分辨场合 |
| 私聊主动续话重锚 | `recentPrivateContext()` 从 `GET /chat?rounds=20` 里只挑 `【私聊` / `哥哥：` 开头的 user 轮，拼成「私聊里最近这几句才是你该接着聊的」附在旁白后；没有私聊近况就明说「只轻轻说一句想他」 |
| 群聊活动冷却 | `lastGroupActivityAt` 记下群里最后一句话；10 分钟内有群聊活动就跳过这一句私聊续话（日志「…前群里还在聊，跳过这句以免把群话题带进私聊」），下一轮再试 |
| 人设 | 新增【先看清这是哪儿、在跟谁说】（标签最高优先级、历史按标签分区、认人看 QQ 号、旁白只接它给的那几句）与【说错了要认，嘴硬只留给撒娇】（事实错误先认，认完仍可嘴硬；「刚才不是我发的」只许撒娇用）。【对外人】补了一句例外 |

人设每轮 `/chat` 热读盘，**改完即时生效**；`bridge.mjs` / `config.json` 改完要重启桥。串线那两轮旧记忆已按 `ts` 删掉。`--proactive-test` 也走同一套重锚。

**自检**：`node bridge.mjs --check` 打印「会话隔离：消息带【私聊】/【三人群 <gid>】标签…」；模拟一条消息后看 `memory.json` 最后一条 user，应以 `【私聊】` 或 `【三人群 20000】` 开头。

**想更干净的话**：`chatMemoryRounds` 调大能让私聊上下文活久一点，但也会带进更多群聊；`groupChat.maxSendsPerWindow` 拦下的消息不写记忆，高频群聊时历史本来就是断的（这也是「逻辑跳」的一个来源），必要时放宽窗口。

## 连续消息合并与回复节奏（config.reply.batch / sendIntervalMs）

**旧行为**：一条 QQ 消息 = 一次 `/chat` = 一次回复。哥哥连着打「我出门了」「晚点回来」，桥会拆成两个互不相干的回合各回一次，她看不出两句的关联，而且几乎秒回、几条分块刷刷刷发完。

**现在**（`reply.batch`）：同一会话开一个滑动静默窗口——最后一条消息之后 `quietMs` 没有新消息才 flush，把整批正文拼成**一条** user 文本，只调一次 `/chat`、只回一次。合并文本长这样：

```text
哥哥：[连着发来的 2 条，是一起说的，一起理解后回一次]
我出门了
晚点回来
```

| 字段 | 当前值 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉就回到「逐条秒回」；`reply.dryRun` 下自动不合并，方便离线模拟 |
| `quietMs` | `3500` | 最后一条之后再静默 3.5 秒才回；期间来新消息就重新计时 |
| `maxWaitMs` | `12000` | 从第一条起最多等 12 秒，防止一直有人说话就永远不回 |
| `maxMessages` | `6` | 一批最多攒 6 条，到顶立即回 |
| `groupEnabled` | `false` | **群聊默认不合并**：@ 定向、防循环、两桌宠互接都按原来的逐条语义；想让群里也攒着回就设 `true`，那时每行正文带「说话人：」前缀，定向给别人的仍只进背景回放 |

实现位置：`bridge.mjs` 的 `acceptMessage()`（WS 事件入口）→ `pendingBatches` → `flushBatch()` → `handleBatch()` → `handleMessage(msg, groupName, mergedText)`。群消息的静默计时在事件入口就重置（含被拦下的）；`enqueue` 仍按会话串行，一整批只占一个队列位置。批内若正在生成时又来了消息，会攒成下一批排队，不会插队打断。

**速度**：`reply.sendIntervalMs` 700 → **1500**，新增 `sendJitterMs` **500**（`pace()` 让每条之间再随机加 0–500ms），一组 4 条分块大约 6–8 秒发完，不再像机关枪。`reply.maxChunks` 仍是 8，没砍她能说多少。

**人设配合**（`main-config.jsonc` 的 `pets[0].whisperPrompt`，system 层、每轮热读盘即时生效）：新增【连着发来的几条要一起理解】，告诉她「哥哥：」后面连着几行、或 `[连着发来的 N 条…]` 是同一轮，先看完再一起回一次，别逐句拆开、别只盯第一句，回之前停一下。规则放 system 而不是桥 prompt，是因为 host 会把 user 文本原样写进 `memory.json`——合并标记留在历史里无害，但规则不该混进对话正文。

**验证**：`node bridge.mjs --batch-test`（7 项纯函数单测）、`--at-route-test` / `--group-loop-test` 回归、`--check` 与启动日志各打印一行「发送节奏 / 连续消息」。真实效果：QQ 上连着发两条短消息，日志应出现 `合并回复：p:10000 收到 2 条 → 合并成 2 行，只回一次`，QQ 里只收到一组回复。

## 主动续话（config.proactive）

想要她「自己延续话题」，不能用 dsh-pet 的 `/whisper`：那个接口明说了「碎碎念没有上下文可依」，只生成一句 20 字内的随机日常，接不上刚才在聊什么。`/chat` 才有历史窗口，但它只收 `text` 且必定写记忆、没有「只生成不写」的开关。

所以桥的做法是：**静默一段时间后，用一段「旁白」当 `/chat` 的输入**——既带上了 `chatMemoryRounds` 的历史，也讲清这不是哥哥在问，让她顺着刚才的话题补一句。私聊和群聊各有**一套完全独立的计时器**：私聊从哥哥最后一句话起算，群聊从群里最后一条消息起算，互不干扰（2026-11-09 起群聊也支持，见下面子章节）。

| 字段 | 当前值 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉就退回纯「收到才回」；`reply.dryRun` 为 true 时自动关闭 |
| `idleMs` | `1800000` | 清醒时：哥哥最后一条消息之后静默 **30 分钟**才说第一句 |
| `intervalMs` | `1800000` | 之后每 30 分钟一轮（默认一轮只说一句，见 `maxPerIdle`） |
| `maxPerIdle` | `1` | 一轮静默最多自己说几句，说完就停，等哥哥再开口；**0 = 不限**，会真的每 30/60 分钟一直说下去 |
| `quietHours` | `[]` | 免打扰时段，如 `[1, 7]` = 凌晨 1–7 点不主动发；空数组 = 不限制 |
| `prompt` | 旁白文本 | 告诉她「接着刚才聊的往下说、别问在吗、别催回、别重复」 |
| `sleep.idleMs` | `3600000` | **睡着时**：静默 **60 分钟**才说第一句 |
| `sleep.intervalMs` | `3600000` | 睡着时每 60 分钟一轮 |
| `sleep.maxPerIdle` | `1` | 睡着时一轮最多几句 |
| `sleep.stateFile` | `proactive-state.json` | 睡眠/清醒结论落盘，重启桥不丢 |
| `sleep.wakeUserWords` | 8 个词 | 哥哥说「醒醒 / 起床 / 别睡了…」立刻判清醒 |
| `sleep.wakeWords` / `sleepWords` | 可选 | 覆盖内置关键词（她自己醒来的动作 / 睡眠描写） |

每次哥哥发消息都会重置计时并清空计数（`idleGen` 递增）；续话正在生成时哥哥插话，那一句会作废不发送，不会插队。人设【发消息的方式】里也写了对应的行为准则，两边一致。

### 睡觉时自动拉长到 60 分钟，直到醒来

`proactive.sleep.*` 只在识别到她睡着时生效，明确醒来后自动回到 30 分钟。识别源（`sleep-state.mjs`）：

1. **桌宠官方睡眠状态**（最权威）：`GET /dsh-pet-7340/state` → `pets.main.sleep.data.sleeping`。桌面右键「睡觉 / 起来」或热键切换；`data: null` = 还没用过这个功能。
2. **剧情状态**：`/state` 里她最新那句 + `memory.json` 最近 3 条 assistant。连续几句睡眠描写（睡着、睡熟、梦话、没醒、困意…）→ 判睡觉；出现「她自己醒了」的明确动作（睁开眼、被揉醒、清醒、坐起来…）→ 立刻判清醒。刻意不认裸的「醒了」，因为「醒了再跟你算账」「你醒了就别装了」说的是哥哥。
3. **哥哥叫醒**：私聊里出现 `wakeUserWords` 里的词，立刻标记为清醒。

状态是**粘性**的：没有新信号时保持上次结论，不会因为中间一句没提「睡」就误判醒来；结论写在 `proactive-state.json`，桥重启也不丢。每次计时开始和每次触发前都会重新识别；静默期间状态翻转时不发那一句，而是按新节奏从「哥哥最后一句话」那刻重新计时（日志：`主动续话：改按睡觉节奏，X 分钟后触发`）。启动日志会打印 `溪颜状态：睡觉（…）；间隔 清醒 30 分钟 / 睡觉 60 分钟`。想只靠桌宠菜单控制、不信剧情文字，可在配置里把 `sleepWords` 设成空数组。

> 这一层只依赖 `/state` 和 `memory.json`，**只重启桥即可生效，不用重启 DSH**。

验证：`node bridge.mjs --proactive-test`（私聊）、`node bridge.mjs --group-proactive-test`（三人群）不等静默，直接生成并真发一句。**改了 `bridge.mjs` / `sleep-state.mjs` / `config.json` 必须重启桥**（`stop.bat` → `rebuild-qq.bat`），启动日志会打印当前状态与两套间隔。群聊那套见下一节。

## 三人群里两个桌宠都能主动说话（2026-11-09）

以前两边都是**事件驱动**：群里没人先说话，谁都不会开口；溪颜的主动续话只对私聊生效。现在两条链路各自有了独立的主动通道。

### 溪颜（本桥，`config.proactive.group`）

| 字段 | 当前值 | 说明 |
|---|---|---|
| `enabled` / `groups` | `true` / `[20000]` | 只对三人群生效；`proactive.enabled=false` 或 `reply.dryRun` 会一并关闭 |
| `idleMs` | `2100000` | 群里静默 **35 分钟**后，她自己往群里说第一句 |
| `intervalMs` | `2700000` | 之后每 45 分钟一轮 |
| `maxPerIdle` | `2` | 一段静默最多主动 2 句；`0` = 不限 |
| `sleepIdleMs` / `sleepIntervalMs` / `sleepMaxPerIdle` | `3600000` / `3600000` / `1` | 识别到她在睡觉时自动改成 60 分钟、1 句；醒来回到清醒节奏 |
| `quietHours` | `[]` | 免打扰时段，写法同私聊 |
| `prompt` | 旁白文本 | 「群里安静了好一会儿…接着刚才群里聊的往下说，别问在吗、别催回、别把私聊的事带进群」 |

实现要点（`bridge.mjs`）：独立 `groupProState`（gid → timer / gen / selfTurns / lastAt）；群里**任何**监听范围内的消息（含纯图片、@ 定向、被防循环拦下的）都会 `resetGroupIdle()` 重置静默计数，正在生成的那一句随即作废；触发前重新识别睡眠状态、检查免打扰与群聊发送窗口；发送计入 `noteGroupSends`，仍受 60 秒 12 条约束。人设【群聊例外】补了【群里也能自己先开口】。

验证：`node bridge.mjs --group-proactive-test` 不等静默，直接生成并**真发到 20000**（2026-11-09 01:56 实测 2 条）。改完 `bridge.mjs` / `config.json` 必须重启桥，启动日志打印 `群内主动：开启（…）`。

### 泡泡（Coopanion，原生 selftalk World）

Coo 侧**没有改插件源码**，用的是它自带的「自主发言」World（`cortico-world-selftalk`）：安静一段时间后推一条 `[自主发言]` 内部事件唤醒模型，由她自己决定开不开口。

| 位置 | 改动 |
|---|---|
| `worlds.selftalk`（`config.json`，WebUI `world:selftalk` 组可热改） | `quietMinutes` 120→**25**、`repeatMinutes` 120→**45**、`maxRounds` **3**（一段安静最多 3 次）、`jitter` 0.2。用 `POST /api/config` 写入立即生效并落盘；`POST /api/worlds/restart {"id":"selftalk"}` 可清零本段计数 |
| `workspace/CONSTITUTION.md`（人格宪法，最高权重） | 新增「三人群里自己开口」：收到 `[自主发言]` **优先往 20000 用 qq_say 说一句**，不是转去私聊催哥哥、也不是只在桌宠气泡里自言自语；只有群里最近 3 分钟刚来回聊过好几轮才跳过 |
| `workspace/PARTNER.md` + `worlds/qq/ENV_PROMPT.md` | 同步放宽「一个话题一两句就收」「连着三四轮就收住」→ 可以一路聊下去，但别刷屏、聊到自然停下、哥哥插话先让他；明确主动说话的优先级与边界 |
| `worlds.qq` 五个闸门值 | `maxSendsPerReply` 3→6、`maxConsecutiveSends` 5→10、`sendIntervalMs` 600→500、`groupMaxPerWindow` 6→14、`groupWindowSec` 60。同时修好 `definition.ts` 没把这五个值透传给 `QQWorld` 的老 bug（此前一直是代码兜底 3/5/600/12/60 生效） |

改完提示词用 `POST /api/session/reload-prefix` 立即刷新（保留当前会话消息）。**`definition.ts` / `config.ts` 是 TS 源码，当前进程不会重载：这五个新数值要等下次重开 Coopanion 才真正生效**，在此之前 `gateSend` 仍用兜底值；提示词与 selftalk 节奏已即时生效。

### 节奏与防刷屏

| | 溪颜 | 泡泡 |
|---|---|---|
| 主动发起 | 定时、确定性（桥代码计时器） | Coopanion 原生 `[自主发言]` 唤醒 + 人格规则引导（模型自己决定开不开口） |
| 清醒 | 静默 35 分钟 → 每 45 分钟，最多 2 句 | 静默 25 分钟 → 每 45 分钟，最多 3 次 |
| 睡觉 | 60 分钟 / 1 句 | 无对应状态（按人格自觉） |
| 收到对方消息 | 立即重置静默计时 | 唤醒并接话（`groupWake: all`） |

两边错峰（25 / 35 分钟，各带 jitter），不会同时开口；溪颜侧 8 轮 bot 连续发言 + 60 秒 12 条、泡泡侧 6 条/封 + 10 连发 + 60 秒 14 条兜底，聊几轮会自然停，不会无限互刷。

**实测边界（2026-11-09 02:00）**：溪颜的群内主动已真发验证；泡泡的 `[自主发言]` 唤醒确实触发过两次（`core.log` 有 `自言自语:叫醒 Coo`）、她也确实主动开口了，但两次都赶上你在私聊道晚安，她把话发去了私聊。因此把「优先往群里说」写进了 `CONSTITUTION.md` 提高权重；若要 100% 确定她每次唤醒都发群，需要改 selftalk 插件的唤醒文案（要重开 Coopanion）。实际群里持续有对话最可靠的点火方式仍是溪颜的定时主动——她一开口，泡泡按 `groupWake: all` 就会接。

## 桌宠端口自动发现（pet-endpoint.mjs）

DSH 的 `ctx.webServer.port` 是启动时动态分配的，`dsh-pet` 的 `/dsh-pet-7340/*` 路由挂在它上面。DSH 一重启，端口就可能变（本机 `1882 → 8726`），旧版桥写死 `baseUrl` 会对着失效端口一直 `fetch failed`，表现就是「QQ 发消息没反应，但协议端和桥都在线」。

`pet-endpoint.mjs` 的做法：

- 启动时、以及 `/chat` 调用失败时，从本机 `netstat` 的 TCP LISTENING 端口里，找出真正挂了 `/dsh-pet-7340/state` 的那个（探针只发无害 GET，且严格校验响应体必须带 `counter` / `sections`，不会把别的服务误认成桌宠）。
- 找到就热切换并记日志：`桌宠端点自动切换：http://127.0.0.1:1882 → http://127.0.0.1:8726`。
- 探测结果 10 秒内不重复；`config.pet.autoDiscover: false` 可关掉，退回只用静态地址。

`config.pet` 相关字段：`baseUrl`（首选，当前 `8726`）、`baseUrls`（额外候选，按优先级）、`autoDiscover`。改端口不用再动 `config.json`，但**改了桥的代码仍要重启桥**。

## 表情包 / QQ 表情（stickers.mjs）

桌宠 `/chat` 的回复里有三类表情标记，旧版桥一律当纯文本发出去，所以 QQ 里会看到字面的 `[图:困]`、`[委屈]`。现在由 `stickers.mjs` 翻译成协议端能渲染的消息段：

| 回复里出现 | 桌宠端的含义 | 发到 QQ 变成 |
|---|---|---|
| `[图:可爱]` | 模型挑中了 `assets/memes/可爱.png`（池内图） | 真图片 `[CQ:image,file=base64://…]` |
| 响应体的 `image` 字段 | 桌宠把命中的 `[图:名称]` 从 text 里剥掉、只留字段名 | 同上，真图片 |
| `[图:困]` | 模型把 QQ 表情名误写进配图标记（池外，桌宠没剥） | 小黄脸 `[CQ:face,id=25]` |
| `[白眼]` `[委屈]` 等 | 人设里要求用的 QQ 表情名 | 小黄脸 `[CQ:face,id=…]` |
| `[图:<幻觉名字>]` | 池里根本没有这张图 | 标记直接去掉，不留垃圾文本 |
| `[语音 3″]`、`[图片]` | 人设里的小动作 / 占位 | 原样保留，不误伤 |

- 图片用 `base64://` 内联（SnowLuma 的 OneBot v11 支持），不依赖 DSH 的 HTTP 服务、也不怕中文文件名。单张 PNG 约 100–270 KB，转 base64 后约 150–360 KB。
- 图片 CQ 码在**文字分块之后**才追加到最后一条消息，绝不参与 `maxChars` 截断；`maxImages` 默认 1，一条回复最多一张图。
- 表情包目录链（按顺序找）：`~/.dsh/dsh-pet/memes/`（自己放的，优先）→ `~/.dsh/profiles/desktop/node_modules/dsh-pet/assets/memes/`（插件内置 27 张）。想加自己的图，丢一张同名 `.png` 到前一个目录即可；图名要在 dsh-pet 的 `memes` 配置里登记，模型才会挑它。
- QQ 表情 id 表内建在 `stickers.mjs` 的 `DEFAULT_FACE_IDS`（与 QQ 开放平台 / OneBot 通用表一致），可在 `config.reply.stickers.faceIds` 里覆盖或追加，例如 `"faceIds": { "困": 25, "摸鱼": 285 }`。

`config.reply.stickers` 字段：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉就退回旧行为（全部按纯文本发） |
| `faceIds` | `{}` | 覆盖 / 追加表情名 → face id |
| `memeDirs` | 自动推导 | 显式指定表情包目录链（绝对路径） |
| `maxImages` | `1` | 单条回复最多几张图 |
| `minTurnsBetween` | `2` | 两次发图之间至少隔几轮回复（含主动续话）；`0` = 不限 |
| `minIntervalMs` | `180000` | 两次发图之间至少隔多少毫秒；`0` = 不限 |
| `maxImageBytes` | `2097152` | 超过就跳过，不发送 |
| `stripUnknown` | `true` | 幻觉出来的 `[图:xxx]` 是否去掉 |
| `imageAsSeparateMessage` | `false` | `true` = 图片单独占一条消息；`false` = 附在最后一条文字后 |

### 只在她觉得值得时才发（当前默认节奏）

旧行为：dsh-pet 宿主在**每条**对话消息末尾都追加一句「从表情包清单里挑最贴合的一张」，历史回放又把过去每轮的 `[图:名称]` 填回去，模型被带成每轮必配——实测最近 20 轮里 18 轮带图，连主动续话也配，还老重复同一张。三层修复：

| 层 | 改动 | 生效条件 |
|---|---|---|
| 宿主指令 | `patch-selective-memes.mjs` 把 `imageInstruction()` 的中文措辞改成「默认不配图，只有真值得才挑，发过就别连着发」；同时改 `src/host/chat.ts` 与 `lib/{index,app,standalone}.js`。幂等可重跑，首次改动留 `.bak-selective-memes` 备份 | **需要重启一次 DSH**（Node 模块已缓存在内存里）；dsh-pet 升级后重跑一次脚本 |
| 人设 + 记忆 | `~/.dsh/dsh-pet/main-config.jsonc` 的 `pets[0].whisperPrompt` 在【发消息的方式】里加了「表情包比小黄脸稀罕得多…」；`memory.json` 里 assistant 的 `meme` 字段全部抹掉，打断「历史每条都带图」的示范惯性（正文与时间戳保留，备份 `*.bak-20261108-0504`） | 每轮实时读盘，立即生效 |
| 桥层兜底 | `bridge.mjs` 的 `imageGate`：只有模型真写了 `[图:名称]`（`stickers.render` 给出 images）才走到闸门，两次发图至少隔 2 轮 + 180 秒；被拦下只发文字，日志记 `配图节流：本轮不发图（…）` | 重启桥后生效（已重启） |

**挑不挑由她自己判断**，桥只负责「别连着刷」。只重启桥、不重启 DSH 也能立刻把「每轮一图」压成「偶尔一图」；重启 DSH 后模型本身就会少挑，表情包才真正变稀罕。

想调：两个门槛都设 `0` = 完全交给模型判断（宿主补丁生效后推荐）；调大 = 更克制。启动日志会打印 `配图节奏：隔 2 轮 / 180s`。验证节流可跑 `node --input-type=module -e` 提取 `imageGate` 片段模拟多轮，不必真发 QQ 消息。

改完 `bridge.mjs` / `stickers.mjs` / `config.json` **必须重启桥**：双击 `rebuild-qq.bat`（或 `stop.bat` → `connect-now.bat`；7341 被占用时一键脚本会跳过起桥，所以顺序不能省）。只验证协议端发图可以跑 `--sticker-test`，这一步不需要 DSH 在线。

## 只发文字却说「收到了图片」：配图清单幻觉（2026-11-09）

**现象**：哥哥只发了「嗯呢」，溪颜却回「又冒出来一张图，凑近端详了一下……先养着吧？我又不是鱼缸里的摆件」；后面还接「对上那张图」「是你发的」「举着大拇指的是在夸我」，凭空把一张图聊了好几轮。

**不是桥解析错**。`logs/bridge.log` 里收到的 `← 私聊 …：嗯呢` 就是纯文字；`memory.json` 里那几条 user 也全是 `哥哥：嗯呢` / `哥哥：对上了什么图呀`，没有图片段。桥的 `extractText()` 只在真有 `image` 段时才写 `[图片]`，这一轮根本没走到。

**根因在 dsh-pet 宿主**（`src/host/chat.ts` 的 `generateWith()`）：

```js
const instruction = (wantImage ? imageInstruction(pool) : '') + (wantAction ? ... : '');
const content = [{ type: 'text', text: instruction === '' ? userText : userText + instruction }];
// ...
createUserMessage({ content, source: { kind: 'user' } })
```

`imageInstruction(pool)` 被**拼在哥哥那条 user 消息的末尾**，作为同一条消息发给模型。那段是一整张 `- 名字：说明` 的候选表情包目录（`chatImageLimit: 20`），名字里还有「先养着吧」「厉害了我的鲸」这种像一句话的中文；同时 `historyMarkersOf()` 把历次 `[图:名称]` 回填到 assistant 历史末尾。模型分不清「系统给的候选图名」和「对方真的发来了图片 / 真的说了这句话」，于是把图名当成哥哥的话接了下去——对照日志，`先养着吧.png`、`厉害了我的鲸.png` 正是她自己前几轮发过的表情包。

**修复**（三层，都不需要重启桥、也不打断当前会话）：

| 层 | 改动 | 生效 |
|---|---|---|
| 人设（主修） | `~/.dsh/dsh-pet/main-config.jsonc` 的 `pets[0].whisperPrompt` 新增【关于「图片」的误会，务必记住】：`[配图]` 段是后台候选目录、名字只是文件名、历史 `[图:名称]` 是自己发过的、只有正文出现 `[图片]` 才算真发了图且别编画面 | **即时生效**。`chatWithPet()` 每轮 `readAllConfig()` 重新读盘；放在 system 里也**不会写进聊天记忆**（写进 user 消息反而会污染历史、强化「图」） |
| 记忆 | 按 `ts` 删掉那 3 轮幻觉对话（6 条），别让她顺着自己的误会继续聊；备份 `memory.json.bak-20261109-1310` | 即时 |
| 宿主补丁 | `patch-no-phantom-images.mjs` 在 `[配图]` 清单前补一句「这是后台候选目录，不是用户发来的消息」，覆盖 `src/host/chat.ts` 与 `lib/{index,app,standalone}.js`，幂等、留 `.bak-no-phantom-images` 备份 | **要重开一次 DSH**（改的是编译产物，模块已缓存在内存里） |

**验证**：`GET http://127.0.0.1:8726/dsh-pet-7340/config` 返回的 `main.pets[0].whisperPrompt` 长度 5249 且含新段，说明运行中的 DSH 已经读到；顺带确认实例级人设确实压过条目级默认小女仆人设（`/main/whisperPrompt` 那份只有 78 字）。`node patch-no-phantom-images.mjs --check` 四份文件均「已是新版」。

**如果还偶尔冒出来**：把 `chatImageLimit` 从 20 调小（清单变短、幻觉素材变少，但她能选的图也变少），或临时 `chatImageEnabled: false` 完全不注入配图指令；这两个同样热读、改完立即生效。彻底干净是下次重开 DSH，让 `patch-selective-memes.mjs` 和本补丁一起加载。

## QQ 图片与表情包能被看见（2026-11-11）

**之前**：`extractText()` 把 `image` 段压成 `[图片]` 三个字、`face` 段压成一个空格，图片 URL 直接丢掉。溪颜只能回「看不到啊。你发什么我都看不到，只能看到一行字。」（11:20:12 实测原话）。

**现在**：桥把 QQ 图片下载成 dsh-pet `/chat` 的 `attachment`，宿主原生支持多模态，模型**直接看见像素**，不需要 Coo 那种辅助 VLM 转文字。

### 与 Coo 的对照

| | 泡泡（Coopanion `cortico-world-qq`） | 溪颜（本桥） |
|---|---|---|
| 图片地址 | `extractImageUrl(data) = data.url \|\| data.file`（world.ts:1928） | 同款，另兼容 `base64://` / 本地路径；纯文件名哈希会被忽略 |
| 交给模型 | `downloadImageBytes()` → `blob` 附件（`[blob qq-…]` 行）；配了 `vision` 时走 OpenRouter VLM 出描述 | `POST /chat` 的 `attachment: {mediaType, data}`，宿主落盘后把 `{type:'image', attachment}` 追加进 user content |
| 正文标记 | `[图片 <URL>]`（主模型支持图像时） | `[图片]`，表情包再带 `（表情包：动画表情）` |
| QQ 小黄脸 | `[表情:名称]`（`qface-map.ts`） | 同款，从 Coo 的表生成 `qface-map.mjs`（275 项） |
| 表情包图片 | 按 image 段处理 | 按 image 段处理，QQ 的 `summary` 当语义提示 |
| 多图 | 每张各有 blob | 宿主只收一张，只附第一张，其余留 `[图片]` 占位 |

### 链路

```text
OneBot image 段 {url, file, sub_type, summary}
  → extractText() 留 [图片]（表情包：…）占位 + 收进 images
  → fetchAttachment() 下载 / 校验（超时 12s、≤586 KB、按文件头认 MIME）
  → petReply(prompt, attachment) POST /chat {text, attachment}
  → dsh-pet 宿主落盘 → content: [text, {type:'image', attachment}]
  → 模型看图
```

**降级**：下载失败、格式不在 `image/png|jpeg|webp|gif`、图太大、宿主没有附件服务时，只记一行 warn，正文 `[图片]` 占位照发，这一轮照常回复（她会说没看清，不会不回）。宿主明确拒绝图片时自动降级成纯文本重试；网络类错误（端口漂移 / `fetch failed`）直接交给端点重发现，不白做一次降级。

**配置**（`config.incomingImages`）：`enabled` / `groupsEnabled` / `facesEnabled` / `maxImageBytes`（默认 600000，宿主 base64 上限 900000 字符、请求体 1 MiB）/ `timeoutMs`（默认 12000）。改完要重启桥。

**人设**：`main-config.jsonc` 的【关于「图片」和表情，务必记住】把原来「你也看不到画面」改成「你看得见画面」，同时保留与后台 `[配图]` 候选清单、历史 `[图:名称]` 的边界。`patch-no-phantom-images.mjs` 的后台声明也从「这一轮他只有上面那一行文字」升级成条件化表述（**改的是编译产物，要重开 DSH 才加载**；人设热读盘即时生效，不重开也能看图）。

**验证**：`node bridge.mjs --image-test`（16 项离线）；`--simulate-event samples/real-image-event.json`（拿 11:19 用户发的真实表情包跑 dryRun，不真发）：

```text
收到图片：image/jpeg 92 KB → 附给桌宠
→ 桌宠：这张和刚才那张长得像，紫红色的圆滚滚，还戴着副大圆眼镜……
        底下那四个字看见了啊。懒——得——喷。
```

**边界**：`attachment` 只支持一张；GIF 动图只能看首帧；QQ 图片 URL 的 `rkey` 有时效，桥收到消息后立刻下载（合并窗口最多再等 3.5 秒），过期就退回纯文字占位；群聊图片同样会附图，但仍受 `groupChat` 防循环闸门约束。

## 语音条与运行时换音色（config.voice，2026-11-23）

**她怎么发语音**：回复里写 `[voice]要念的话[/voice]` → 桥认标记 → 调本地 gpt-sovits（复用 Coo 的插件，`POST 127.0.0.1:9880/tts {text, voice, speed, seed}`）拿回 WAV → base64 塞进 OneBot 的 `record` 段，协议端自己转 SILK，不需要额外编码器。标记会从气泡文字里剥掉；**合成失败一律降级成纯文字**，绝不让语音拖垮正常回复。

**怎么换音色**（两条路，都会写回 `config.voice.voice` 持久化）：

- 哥哥私聊说「换成卡提希娅的声音」→ `detectVoiceSwitch` 认出来 → `setVoice`；
- 她自己写 `[voice:use 葱·训练]` → `extractVoiceUse` 认出来 → `setVoice`。

可切的名字在 `switchMap` 里（称呼 → 音色名或 id）。音色必须先在 Coo 的音色面板登记过，否则合成会失败并降级。

| 字段 | 当前值 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；关掉则 `[voice]` 原样剥离、发纯文字 |
| `ttsUrl` | `http://127.0.0.1:9880` | Coo 的 gpt-sovits 接口，**它没开就没有语音** |
| `voice` | `cv-mwt2la6d-0m6a` | 当前「**葱·训练**」（葱中文音声微调的权重版，声纹相似度 0.907）。改回希美填 `cv-mwmc3nsd-y1k3`，零样本葱·嗔怪填 `cong-tease-fix` |
| `speed` | `0.85` | 只传给溪颜这一次合成，不改 Coo 全局（泡泡仍 0.77） |
| `seed` | `-1` | 每次重新采样；`voice.mjs` 里只有 `seed>=0` 才传，故 -1 等于让服务端按默认重采样 |
| `maxChars` | `200` | 单条语音台词字数上限（17:05 从 80 放开） |
| `tailPadMs` | `300` | WAV 尾部补静音。500ms 对「尾字发闷」无效，16:56 曾归零，17:53 因 QQ 吞字改回 300 |
| `allowGroups` | `false` | 群里不发语音 |
| `timeoutMs` | `120000` | 合成超时，超时降级纯文字 |

**2026-11-23「尾字发闷」排查结论**（省得下次重试一遍）：补尾静音 300→500 **无效**；speed 0.85→0.9 尾字收尾能量最高但听感无改善，17:24 已改回 0.85；seed 13（固定）→ -1 后尾字更平缓（收尾 RMS 229→924、整句 8.09s→6.31s），**疑为真凶**。SILK 往返实测尾字无损，问题在合成端语速衰减，不是转码截尾。

自测：`node bridge.mjs --voice-test`（离线：标记提取、换声识别、音色表）；`--voice-send-test`（真合成并真发一条到私聊，需要 gpt-sovits 在线）。

## 绘图：她自己写 `[画:]`（config.image）

和联网 `[查:]`、语音 `[voice]`、表情 `[图:]` 是同一套机制——**只有她知道此刻该不该画、画什么，桥只做确定性的事**：看到标记就去画。

```text
[画:一只橘猫|水墨|精细|竖图|*窗边放着他落下的外套，午后斜光]
```

- `|` 分段：第一段是主体（哥哥要的，不能被顶掉）；中间是画风锚点（29 种，中文名 → 英文锚点，见 `image-gen.mjs` 的 `ART_STYLES` / `STYLE_ALIAS`）；最后一段用 `*` / `+` 开头表示 **myTouch**——她自己的小心思，单独拼进 prompt。
- 流程会变成**两次 `/chat`**：她写标记 → 桥先回 ack「好嘞，我画一下，稍等哈」→ 云端生成（`qwen-image-3.0-pro`，实测约 40–47 秒/张，**按张计费**）→ 落盘 `generated/` → 发图 → 再把「图已经画好、这不是哥哥说的话」交回去，让她配一句话。
- 失败一律降级：剥掉标记、让她如实说，**绝不把 `[画:xxx]` 字面发到 QQ**。
- 群聊默认不画；API key 从 Coo 的 `.env` 读（`apiKeyEnv`），不写死在本目录。

| 字段 | 当前值 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉则标记原样剥离、不发起任何请求 |
| `allowGroups` | `false` | 群里不画 |
| `model` / `size` / `quality` | `qwen-image-3.0-pro` / `1024x1024` / `medium` | |
| `timeoutMs` | `180000` | 生成超时 |
| `maxPromptChars` | `240` | 标记文本上限 |
| `outDir` | `generated/` | 生成图落盘目录 |
| `ackOnDraw` | `true` | 画之前先说一句，免得等 40 秒没动静 |

自测：`node bridge.mjs --draw-test`（离线：标记解析、画风表、prompt 拼装）。

## 吃东西：饥饿与精力（config.petState，2026-11-24 启用）

原始方案见 `D:/wb/杂谈20/溪颜吃东西与绘图-方案.md`；完整留档（设计、调参、回退）见本目录 **《吃东西-功能留档.md》**。

**两个数值**（0–100）：

- `hunger` 饥饿度，**越高越饿**，每小时 +6（约 16 小时从微饿到饿透）；
- `energy` 精力，**越高越精神**，每小时 −4（约一天从满到困透）。

**按真实经过时间衰减，不靠定时器累加**：每次读状态时用「距上次写盘过了多久」补齐。桥重启、机器关机一整夜，回来数值照样对，不会因为定时器没跑就冻住。

**点菜式投喂**（不是「一刀切口令」）：

1. 她馋了、或哥哥问她想吃什么 → 她在回复里写 `[想吃:草莓蛋糕]` → 桥剥掉标记，记成**心愿食物**（`craving`，30 分钟内有效）；
2. 哥哥私聊说「喂你 / 给你买的 / 喂她 / 投喂 / 请你吃…」→ 饥饿 −45、精力 +8、清掉 craving，**按她自己挑的那样东西**回应；
3. `detectFeedCommand` 只认明确口令，**「你吃了吗」这类不算**——真人感刚修好，不能让一句寒暄偷偷改状态；
4. `feedCooldownMs` 60 秒防连点刷数值；饥饿 ≤5 视为吃饱，会嘴硬说吃不下。

**语气怎么影响**：每轮注入一条背景提示（`stateHint()`，所有会话生效），说的是「你现在有点饿 / 有点困」这种**背景**，不是替她说死话——她可以撒娇要吃的，也可以嘴硬。点菜能力（`CRAVING_HINT`）**只在私聊注入**。阈值：`hungryAt 60` 有点饿、`starvingAt 85` 饿扁了、`tiredAt 30` 困了。

**落盘**：`pet-state.json`（`{hunger, energy, craving, cravingAt, updatedAt}`）；删掉即回到初始值「微饿、精神」（hunger 20 / energy 85）。

回退三级，从轻到重：① `petState.enabled=false` + 重启桥（数值文件留着，聊天零影响）；② 再删 `pet-state.json`（数值重置）；③ 还原 `bridge.mjs.bak-20261123-2038`（连代码一起退）。

自测：`node bridge.mjs --eat-test`（23 项：衰减、封顶、投喂、冷却、吃饱、craving 过期、标记剥离）。启动日志会打印一行 `吃东西：开启（饥饿 N … / 精力 M …）`。

## 戳一戳与引用回复（config.poke / config.quote）

**戳一戳**：她收到的是 OneBot 的 `notice` 事件（`notify` / `poke`），**不是消息**，所以不走消息链路。桥只认「哥哥（`10000`）在私聊戳她」；群里戳、别人戳、戳别人一律不理。

| 字段 | 当前值 | 说明 |
|---|---|---|
| `enabled` | `true` | |
| `brotherId` | `10000` | 只认这个人 |
| `replyText` | `true` | 调一次 `/chat` 让她说句短的（真人感强，费一次调用） |
| `pokeBack` | `true` | 真戳回去（`friend_poke`）；失败/协议端不支持时自动降级为只回文字 |
| `cooldownMs` | `3000` | 冷却，防连戳刷屏 |

**引用回复**：私聊回复时首条带 `[CQ:reply,id=<哥哥本轮最后一条 message_id>]`，像真人针对某一句回。**只对私聊生效**——群聊、主动续话、敷衍回复、语音条都不引用；协议端不支持 `CQ:reply` 时自动降级成普通消息。

纯函数用例在 `--human-test` 里（`isBrotherPoke` 5 项、`quoteIdOf` 4 项、`withQuote` 2 项）。真机验证看 `logs/bridge.log`：戳一戳会写「戳一戳」，引用回复在消息发出时带 `CQ:reply`（2026-11-20 12:30 起有实测记录）。

## 赴约闹钟（config.appointments）

模型自己没有定时器工具，说「五分钟后找我」它只能口头答应。所以桥从**哥哥的原话**里解析时间，自己排一个真定时器：

- 相对时长：「五分钟后找我」「半小时后提醒我」「二十分钟」；
- 绝对时刻：「明天八点叫我」「今晚十一点半」（`absolute.enabled`）；
- 取消意图：「算了不用了」「别提醒了」→ 撤掉待触发的那个。

到点用专门旁白调 `/chat`，**只发私聊**，让她像准点赴约一样说一两句（不解释为什么晚了、不提「定时器 / 分钟 / 后台 / 桥」）。

| 字段 | 当前值 | 说明 |
|---|---|---|
| `enabled` | `true` | |
| `minMs` / `maxMs` | `10000` / `86400000` | 最少 10 秒、最多 24 小时 |
| `absolute.maxMs` | `691200000` | 绝对时刻最远排 8 天 |
| `maxPending` | `5` | 同时最多 5 个待触发 |
| `respectQuietHours` | `true` | 落在 02:00–07:00 的**顺延到 07:00**，不丢弃；改 `false` 则凌晨也准点发 |
| `stateFile` | `appointments.json` | 落盘；重启后未过期的重排，**过期的直接丢弃不补发** |

自测：`node bridge.mjs --appointment-test`（相对/绝对解析、取消意图、静默期顺延，全离线）。

## 观赛模式（config.watchMode，「一起看比赛」）

口令开关，不交给模型猜。词表在 `watch-mode.mjs`（`START_WORDS` / `PAUSE_WORDS` / `RESUME_WORDS` / `STOP_WORDS` / `STATUS_WORDS`）：

| 说什么 | 效果 |
|---|---|
| 「一起看比赛 / 陪我看球 / 开观赛 / 看屏幕…」 | 锁定当前前台窗口，开始定时抓帧 |
| 「先不看 / 暂停一下 / 歇会儿…」 | 停抓帧、停解说，**记住窗口**；「继续观看」接着看，不用重新切窗 |
| 「不看了 / 关观赛 / 看完了…」 | 结束观赛 |
| 「看到哪了」类 | 查状态 |

链路：锁窗口 → 每 60 秒（`frameIntervalMs`）抓一帧 → 变化检测（`fpDistance` / `fpMean`，低于 `changeThreshold` 跳过）→ 旁白 + 图片调 `/chat` → 发回原会话。她只能看见这一帧，所以人设要求「看不清就说看不清，不许编比分」。

**隐私边界（默认就开着，别放松）**：

- 只截**锁定的那个窗口矩形**，且该窗口必须仍在前台，否则这一帧直接跳过；
- 图片只在内存里过一遍，**不落盘、不写日志**；
- 两小时自动结束（`autoStopMs`），窗口关掉立即结束；
- 暂停态不截屏；**重启桥后状态归零**，不会偷偷恢复截屏；
- 黑名单 `denyWindowTitles` / `denyProcesses`：微信、WorkBuddy、终端、PowerShell、任务管理器、QQ 等一律不锁。

夜间豁免：观赛发言走自己的定时器和 `deliver()`，不经过主动续话 / 赴约的静默闸门，所以 02:00–07:00 也能陪看（`bypassQuietHours: true`）。关掉观赛，两条鱼立刻回到原来的静默规则。

自测：`node bridge.mjs --watch-test`（口令识别、黑名单、变化检测、频率闸门，全离线；不截屏、不真发）。

## 文件

| 文件 | 作用 |
|---|---|
| `bridge.mjs` | 桥本体：OneBot WS 客户端 + 桌宠调用 + 过滤/限速/重连/账号校验/日志轮转；也是全部口令与标记的识别层 |
| `pet-state.mjs` | **吃东西数值**：hunger / energy 按真实经过时间衰减、心愿食物（`[想吃:]`）、投喂口令识别、状态提示；纯模块，可独立自测 |
| `pet-state.json` | 运行时生成：当前饥饿/精力/心愿食物；删掉即回到「微饿、精神」（hunger 20 / energy 85） |
| `voice.mjs` | **语音条**：`[voice]…[/voice]` → gpt-sovits(9880) → WAV → base64；含换音色识别、尾部补静音、失败降级 |
| `image-gen.mjs` | **绘图**：`[画:内容\|画风]` → qwen-image → 落盘 `generated/` → 发图；含 29 种画风锚点与 myTouch 拼装 |
| `generated/` | 绘图输出目录（`config.image.outDir`），按张累积，可定期清理 |
| `appointments.mjs` | **赴约闹钟**纯逻辑：从原话解析相对时长 / 绝对时刻、取消意图、落盘恢复；定时器在 `bridge.mjs` |
| `appointments.json` | 运行时生成：待触发的约定；重启后未过期的重排，过期丢弃 |
| `watch-mode.mjs` | **观赛模式**状态机：口令开关、锁窗口、抓帧、变化检测、频率闸门、隐私边界 |
| `screen-capture.mjs` | 观赛截屏底层：只截指定窗口矩形、前台校验、黑名单、内存态图片（不落盘） |
| `web-search.mjs` | **联网**：必应 HTML / RSS、wttr.in 天气、结果清洗与注入边界；纯逻辑可独立测 |
| `task-bridge.mjs` | **任务通道**（已移交泡泡，`task.enabled=false` 不生效）：口令解析、白名单、落盘队列 |
| `task-notify.mjs` | **任务回报**（已移交泡泡）：旁路 WS 读 `tasks/out` 逐条回报，`--send` 真发 |
| `功能总目录.md` | **全部功能的维护索引**：开关现状表、六类清单、铁律、自测速查、文档索引。加功能时同步更新 |
| `吃东西-功能留档.md` | 吃东西功能的完整留档：设计、参数、交互流程、回退、已知边界 |
| `stickers.mjs` | 表情标记 → 真图片 / QQ 小黄脸的纯翻译模块，可独立测试 |
| `patch-selective-memes.mjs` | 幂等补丁：把 dsh-pet 宿主的「每轮挑一张配图」指令改成「默认不配图、值得才发」。`--check` 只看状态；dsh-pet 升级后重跑，改完需重启 DSH |
| `patch-no-phantom-images.mjs` | 幂等补丁：给宿主 `[配图]` 候选清单补「这不是用户发来的消息」的来源声明，治「只发文字却说收到图片」的幻觉。`--check` 只看状态；改完需重启 DSH |
| `sleep-state.mjs` | 睡觉/清醒状态识别：桌宠官方 `sleep` 叶子优先，其次最近对话文本；结论落盘，可独立测试 |
| `proactive-state.json` | 运行时生成：当前状态（睡觉/清醒）、判定来源、更新时间；删掉即回到默认清醒 |
| `pet-endpoint.mjs` | 桌宠 HTTP 端口自动发现：DSH 重启换端口后自动切换，不用改配置 |
| `image-input.mjs` | **入站图片**：QQ image 段 → `/chat` 的 `attachment`；下载、超时/大小限制、文件头认 MIME、兼容 `base64://` 与本地文件；失败只返回结论不抛 |
| `qface-map.mjs` | QQ `face` id → 中文名（275 项），由 Coo 的 `qface-map.ts` 生成，与泡泡渲染一致 |
| `samples/real-image-event.json` | 一条真实 QQ 表情包消息事件，供 `--simulate-event` 离线验证看图 |
| `config.json` | 通道 B（桌宠专用），占位处由 `new-channel.ps1` 自动填；`pet.*` 端点发现、`listen.*` 监听名单、`prompt.*` 消息模板、`reply.maxChunks` 回复上限、`reply.batch.*` 连续消息合并、`reply.sendIntervalMs` / `sendJitterMs` 发送节奏、`reply.stickers` 表情包、`incomingImages.*` 入站图片/QQ 表情（开关、大小、超时）、`prompt.*` 会话标签模板（私聊/三人群 `{gid}`）、`proactive.*` 私聊主动续话（含只接私聊上下文的重锚话术）、`proactive.group.*` 群内主动、`groupChat.*` 群聊防循环与 @ 定向、`voice.*` 语音条与换音色、`image.*` 绘图、`petState.*` 吃东西数值、`poke.*` 戳一戳、`quote.enabled` 引用回复、`appointments.*` 赴约闹钟、`watchMode.*` 观赛模式、`task.enabled` 任务通道（**已移交并关闭**） |
| `config.channel-a.json` | 通道 A（与 Coo 共用 3001），随时可切回 |
| `new-channel.ps1` | 生成 SnowLuma 按号配置（3011/3010 + 独立 token）+ 更新桥配置 |
| `reconnect-all.bat` / `reconnect-all.ps1` | **一键接回两条 QQ 通道**：拉起 SnowLuma(5099) + 桥(7341)、旧看门狗自动重载、打印七个端口状态；幂等、不碰 DSH/QQ/Coopanion |
| `connect-qq-b.ps1` | 通道 B 一键拉起 + 账号自检 |
| `connect-now.bat` / `connect-now.ps1` | 首次接入：先等 SnowLuma 就绪，再交给 `connect-qq-b.ps1` |
| `rebuild-qq.bat` / `rebuild-qq.ps1` | **日常重建**：SnowLuma / 3011 确认 → 停旧桥 → 重启 → 自检 |
| `stop.bat` / `stop.ps1` | 停桥（按 7341 闸门归属 PID，兼容相对路径启动的桥） |
| `start.bat` / `start-hidden.vbs` | 前台 / 无窗口启动桥 |
| `bridge-guard.py` | **现行守护（2026-11-23 起）**：只守 7341，由计划任务 `dsh-bridge-guard` 用 `pythonw.exe` 拉起——天生无控制台窗口、关不掉；连续 2 次（约 30 秒）探不到端口才用 `node bridge.mjs` + `CREATE_NO_WINDOW` 拉起（仍在用户会话，观赛截屏不受影响）；1 小时内最多 6 次、超过退避 10 分钟；命名 Mutex 单实例。维护时在目录放 `bridge-guard.pause` 即暂停拉起，删掉自动恢复 |
| `dsh-bridge-guard`（计划任务） | 登录时自启，Interactive、执行时长不限、失败重试 3 次/分钟。停用 `Stop-ScheduledTask`，卸载 `Unregister-ScheduledTask -TaskName dsh-bridge-guard` |
| `watchdog.ps1` | **已停用（2026-11-23，计划任务 `dsh-bridge-watchdog` 已 Disabled，改由 `bridge-guard.py` 接管）**。旧逻辑：每 20 秒查 **7341（桥）+ 5099（SnowLuma）+ 3001/3011（QQ 客户端）**；前两个掉了分别隐藏拉起，5099 在但 OneBot 端口连续 3 次掉线就跑 `start-qq-clients.ps1`；命名 Mutex 防重复实例。**停用原因**：Win11 默认终端为 Windows Terminal 时会无视 `-WindowStyle Hidden` 弹黑窗，窗口一关守护即被 Ctrl+C 终止（0xC000013A，2026-11-23 18:07 实际发生，桥随后掉了 67 分钟） |
| `start-watchdog.vbs` | 无窗口启动看门狗（`wscript` 中转，脱离调用方进程树） |
| `start-watchdog-desktop.vbs` | 纯 ASCII 版看门狗启动器，专供 `explorer.exe` 代执行重载（不改 SnowLuma / 桥，避免打断已登录的 QQ 注入） |
| `start-qq-clients.ps1` | **幂等拉起两个 QQ 客户端**：先等 5099，再按 3001/3011 判断只启动缺的那个；`-Force` 强制重启。日志 `logs/qq-clients.log` |
| `start-qq-clients.vbs` | 一次性桌面会话启动器（20:40 应急用过），只管按顺序起两个 QQ，不含等待与幂等判断；日常用 PS1 版 |
| `run-via-explorer.ps1` | **桌面会话入口**：把指定 VBS 交给 `explorer.exe` ShellExecute，让 WScript 及其所有子进程脱离 WorkBuddy 作业树。默认目标 `detach-watchdog.vbs` |
| `detach-watchdog.vbs` | 由 explorer 执行，隐藏拉起 `adopt-desktop-session.ps1` |
| `adopt-desktop-session.ps1` | **完整迁移**：在桌面会话里重建 SnowLuma + 桥 + 看门狗（默认，约 6 秒热切换）；`-SkipServices` 只换看门狗，零断线 |
| `start-snowluma-hidden.vbs` | 5099 消失时由看门狗调用，`sh.Run ..., 0` 隐藏**直接调 `SnowLuma\runtime\node-...\node.exe ./index.mjs`**（不走 start.bat，避免 `pause` 卡死） |
| `keep-alive.bat` / `keep-alive.ps1` | **一键常驻**：装看门狗 + 装开机自启 + 隐藏 SnowLuma 窗口 + 报状态；检测到 `watchdog.ps1` 更新会自动重启看门狗，可重复运行 |
| `install-startup.ps1` | 幂等把启动器 VBS 写进用户「启动」文件夹；`-Uninstall` 移除 |
| `hide-snowluma.bat` / `hide-snowluma.ps1` | 隐藏当前会话里 SnowLuma 的 cmd 窗口（SW_HIDE，零中断）；`keep-alive.bat` 已顺带调用，可重复运行 |
| `启动文件夹\dsh-pet-qq-watchdog.vbs` | 由 `install-startup.ps1` 生成，登录后由 explorer 拉起看门狗 |
| `启动文件夹\SnowLuma.vbs` | 隐藏方式（`0`）开机拉起 SnowLuma；2026-11-09 起同样直接调自带 Node。历次版本已备份 |
| `启动文件夹\QQ-Clients.vbs` | **2026-11-09 20:40 新增**：登录后 explorer 拉起 `start-qq-clients.ps1`，把两个 QQ 客户端补上（专用，见「第四次掉线」）。删掉即禁用 |
| `samples/*.json` | 假 OneBot 事件 |
| `logs/bridge.log` | 桥日志，>5 MB 轮转成 `.1`（读它用 `Get-Content -Encoding UTF8`） |
| `logs/watchdog.log` | 看门狗日志：启动、每次自动拉起、恢复在线；>1 MB 轮转成 `.1` |
| `logs/bridge-guard.log` | 现行守护日志（UTF-8）：启动、检测到掉线、拉起结果、暂停/恢复；>1 MB 轮转成 `.1` |
| `logs/bridge-guard-child.log` | 守护拉起的桥子进程 stdout/stderr（桥自己的日志仍在 `logs/bridge.log`） |
| `logs/qq-clients.log` | QQ 客户端启动器日志：等 5099、跳过/启动哪个通道、最终 3001/3011 结果 |
| `logs/desktop-session.log` | 桌面会话迁移日志：adopt 的 PID/父进程、旧看门狗、SnowLuma 与桥的重建结果、七个端口状态 |

## 排障

| 现象 | 查什么 |
|---|---|
| QQ 突然不回、`7341` 空、日志末尾既无 `WS 已断开` 也无 `进程退出` | 桥被外部强杀（多半是挂在对话后台任务下，任务回收时连进程树一起杀）。看 `logs/watchdog.log` 有没有「重新拉起」；没有就双击一次 `keep-alive.bat` 让看门狗接管，详见「掉线排查与常驻守护」 |
| 桥在线但一直 `ECONNREFUSED 3011`，`5099/30xx` 端口全空 | SnowLuma 挂了（QQ 还登录着、桥还活着也没用）：新版看门狗会隐藏拉起它；若日志还是只写「守护端口=7341」，说明看门狗是旧代码，双击一次 `keep-alive.bat` 重载。应急直接双击 `reconnect-all.bat`（或 `wscript //B start-snowluma-hidden.vbs` 只拉 SnowLuma） |
| **开机后 Coo 和鱼一起不回，但 `5099 / 7341 / 17788` 都在线，只有 `3000/3001/3010/3011` 全空** | **两个 QQ 客户端没开机自启**，SnowLuma 没进程可注入（不是 SnowLuma 挂了）。看 `C:\Users\86189\SnowLuma\app\logs\snowluma-*.log` 有没有 `[Hook] login detected`；跑 `powershell -ExecutionPolicy Bypass -File .\start-qq-clients.ps1` 立刻补上，或等看门狗 60 秒自愈（日志「OneBot 3001/3011 连续 N 次掉线 → 拉起 QQ 客户端」）。下次开机由 `启动文件夹\QQ-Clients.vbs` 自动处理。**别重启 SnowLuma**，会让已登录的 QQ 失去注入 |
| SnowLuma 日志刷 `EADDRINUSE` / `network startup degraded` | QQ 多子进程重复触发 session，第一个已成功绑定端口：只要 `netstat` 里 3001/3011 是 LISTENING 就没事。若端口全空则是上一条（QQ 没起来）或真的两个号配了同一端口 |
| 长时间没消息、以为掉了 | 主动续话是 30/60 分钟一次，中间静默正常。看 `logs/bridge.log` 有没有 30 分钟一行的 `心跳：`；有心跳就是活着 |
| 退出/重启 WorkBuddy 后 QQ 又不回了 | 说明某个常驻组件又被工具会话拉起过、没迁移干净。看 `logs/desktop-session.log` 最后一段有没有「adopt 完成」；双击 `reconnect-all.bat`（把看门狗挂回桌面会话）后 20 秒内自愈。彻底重做：`powershell -ExecutionPolicy Bypass -File .\run-via-explorer.ps1`，约 6 秒热切换 |
| 看门狗日志反复出现「SnowLuma 未监听 5099 → 第 N 次隐藏拉起」但 5099 一直不通 | 启动器失效：旧版 `start-snowluma-hidden.vbs` 走 `start.bat`（内含 `pause`），隐藏窗口下起不来。已改成直接调自带 Node；确认 `C:\Users\86189\SnowLuma\runtime\node-v24.22.1-win-x64\node.exe` 存在，或双击 `reconnect-all.bat`。开机自启的 `启动文件夹\SnowLuma.vbs` 也已同步修复 |
| 看门狗反复拉起、桥还是起不来 | 看 `logs/bridge.log` 启动段报什么（多半是 7341 被别的实例占、桌宠端口全灭、3011 没登录）；先 `stop.bat`，再 `rebuild-qq.bat` |
| `3011 未连上` | 通道 B 的 QQ 没登录 / SnowLuma 没注入 / `onebot_<号>.json` 端口没改成 3011 |
| 自检显示 `✗ 不是目标号` | WS 连到了泡泡🫧 的 3001；改 `config.json` 的 `wsUrl` 与 `expectSelfId` |
| `EADDRINUSE`（SnowLuma 日志） | 两个号的配置占了同一端口；退出 SnowLuma 后重跑 `new-channel.ps1 -WriteSnowLuma` |
| 桥日志一直 `fetch failed` / QQ 发了没反应 | 多半是 DSH 重启后端口漂移：新版桥会自动发现（`桌宠端点自动切换` 日志）；若仍失败，确认 DSH 与 `dsh-pet` 已加载，或双击 `rebuild-qq.bat` 重启桥 |
| 桌宠接口 401/404 | DSH 没开，或 profile `dsh.profile.bundles` 里没有 `dsh-pet` |
| 桌宠回空 | `pet` 参数不对，或 `/chat` 被 `surface` 拦了（本桥固定 `surface=any`） |
| 群/私聊不回 | 号不在名单、群没 @、消息里 @ 了别人（定向拦截，见下条）、`expectSelfId` 不匹配 |
| 群里 @ 了溪颜，泡泡却抢着回（或反过来） | 定向没生效：桥没重启还在跑旧代码（看 `--check` 有没有「@ 定向：开」）；Coo 侧 `cortico-world-qq/src/world.ts` 改完没重启 QQ world；或提示词覆盖被还原。两端分别看「已收到，定向给 …，不接话」与 `QQ 定向消息仅入队不唤醒` 日志 |
| 群里 @ 了某人，结果两边都不回 | 看被 @ 的那侧：桥看 `logs/bridge.log` 是否走了完整链路、有没有被防循环闸门拦下；Coo 看 QQ world 是否在线、`groupWake` 是否为 `all`。`@` 的 QQ 号写错（不在这两个号里）时，两边都会按「只对别人说」不回 |
| 群里两个桌宠刷屏 / 聊起来停不下 | `groupChat.maxBotTurns` / `maxSendsPerWindow` 被设成 0，或桥没重启还在跑旧代码；日志看「防循环不回复」。Coo 侧看 `worlds.qq.groupMaxPerWindow` 与 `PARTNER.md` |
| 群消息收到了但不回、日志写「防循环不回复」 | 正常闸门：连续 bot 轮次超上限或窗口发满了。哥哥在群里发一句即恢复；要放开就调 `config.groupChat` 并重启桥。离线验证 `node bridge.mjs --group-loop-test` |
| 溪颜在群里管泡泡叫哥哥 / 把泡泡的话当情话 | 人设缺【群聊例外】或 `prompt.group` 没带 `（QQ {uid}）`；改完人设热读盘生效，模板改动需重启桥，并清掉旧记忆 |
| 她把主人当外人 /「我不信，你怎么证明」 | `prompt.private` 里带了 `{nick}` 第三人称前缀，或人设缺【谁在跟你说话】；修完还要按 `ts` 删掉旧的「不认人」几轮记忆 |
| 老是「已有实例」 | 两条通道共用 7341 闸门：先 `stop.bat` 再切 |
| 连着发两条还是各回各的 / 还是秒回 | `reply.batch.enabled=false`、改完 `config.json` 没重启桥，或两条间隔超过 `quietMs`（3.5s）被当成两轮。看 `logs/bridge.log` 有没有「合并回复：…收到 N 条」；`node bridge.mjs --batch-test` 先验纯逻辑。群聊默认不合并（`groupEnabled=false`），要群里也攒着回得单独打开 |
| 回复刷刷刷一口气发完 | `reply.sendIntervalMs` 被改回 700 或没重启桥；当前是 1500ms + 0–500ms 随机抖动。看 `--check` 的「发送节奏」行 |
| 她只接了最后一句、忘了前面 | 合并后正文带 `[连着发来的 N 条…]` 标记，人设【连着发来的几条要一起理解】负责让她先看整段；确认 `GET /dsh-pet-7340/config` 里 `main.pets[0].whisperPrompt` 含该段（热读盘，改完立即生效，无需重启 DSH） |
| 她不会自己接着说 | 改了 `bridge.mjs`/`config.json` 没重启桥；或 `proactive.enabled=false`、`quietHours` 命中、本轮 `maxPerIdle` 用完、期间一直有新消息在重置计时。看启动日志有没有「主动续话：开启」 |
| 三人群里没人先开口、溪颜也不主动说 | 看启动日志有没有「群内主动：开启」；没有就是 `proactive.group.enabled=false`、群号没在 `groups` 里、或改完没重启桥。触发前群里只要有任何消息就重新计 35 分钟（睡觉 60 分钟），`quietHours` 命中或群聊窗口发满 12 条也会跳过。立刻验证用 `--group-proactive-test` |
| 泡泡被唤醒了却发去私聊 | 她收到的是 Coopanion 原生 `[自主发言]` 事件，开不开口由模型判断；`CONSTITUTION.md` / `PARTNER.md` / `ENV_PROMPT.md` 三处都写了「优先往 20000」，但赶上晚安/私聊正聊着时她可能优先处理那边。改完提示词要 `POST /api/session/reload-prefix`；要 100% 发群需改 selftalk 唤醒文案并重开 Coopanion。群里持续对话最可靠的点火仍是溪颜的定时主动 |
| Coo 侧限流数值改了没变化 | `worlds.qq` 那五个值过去没被 `definition.ts` 透传；已修好但属 TS 源码改动，**当前进程不会重载，要下次重开 Coopanion** 才生效。即时生效的只有 selftalk 节奏（`/api/config` 热写）与三份提示词 |
| 主动续话还是两分钟就来 / 睡着了该 60 分钟却 30 分钟 | 改了配置没重启桥；或状态没识别出来——看启动日志的「溪颜状态：」，删掉 `proactive-state.json` 让它重新判定；桌宠右键「睡觉 / 起来」是最可靠的信号源 |
| QQ 里还是字面的 `[图:xxx]` | 改完代码没重启桥（`stop.bat` → `connect-now.bat`），或 `stickers.enabled` 被设成 `false` |
| 只发文字，她却说收到了图片 / 评论「你发的这张图」「对上那张图」 | **不是桥解析错**：宿主把整张表情包候选清单拼在哥哥那条 user 消息里，模型把图名当成对方发来的图甚至对方说的话。人设【关于「图片」和表情】即时生效、已按 `ts` 删掉幻觉记忆；彻底干净要重开 DSH 让 `patch-no-phantom-images.mjs` 加载。详见专章 |
| 发图给她，她还说「看不到」「只能看到一行字」，或只回一句「这张又是什么」 | 桥在跑旧代码（改完没重启）、`incomingImages.enabled=false`，或人设还留着旧句「你也看不到画面」。看 `--check` 的「入站图片」行、`logs/bridge.log` 有没有「收到图片：… → 附给桌宠」；人设热读盘，改完立即生效，桥必须重启 |
| 日志写「图片没能交给桌宠（…）」 | 括号里就是原因：下载超时 / 超过 `maxImageBytes` / 格式不在白名单 / QQ 的 `rkey` 过期。只发文字占位是设计好的降级，回复不会丢；调 `config.incomingImages` 或让哥哥重发一张 |
| 她把「表情包：动画表情」「先养着吧」当成哥哥说的话去接 | 前者是 QQ 自带的 `summary` 标签，后者是后台 `[配图]` 候选清单里的图片文件名，都不是谁说的话。人设【关于「图片」和表情】已区分；核对 `GET /dsh-pet-7340/config` 的 `main.pets[0].whisperPrompt` 含「看得见画面」 |
| QQ 小黄脸被压成一个空格 / 没写出表情名 | `incomingImages.facesEnabled=false`，或桥没重启还在跑旧 `extractText`。离线验证 `node bridge.mjs --image-test` |
| 每条回复都带表情包 / 老重复同一张 | 宿主每轮都把配图清单塞给模型 + 历史示范惯性：跑 `node patch-selective-memes.mjs` 并**重启一次 DSH**；临时用 `reply.stickers.minTurnsBetween` / `minIntervalMs` 节流，日志看「配图节流」 |
| 表情包没发出、日志有「接口图未找到」 | 图名不在表情包池；确认 `assets/memes/<名称>.png` 存在，或把自定义图放进 `~/.dsh/dsh-pet/memes/` |
| 群里刚聊完，她却在**私聊**里接着群里的话题说 | 单份记忆被群聊刷满 + 私聊主动续话计时器只认私聊。看日志有没有「…前群里还在聊，跳过这句以免把群话题带进私聊」；没有就是桥在跑旧代码，重启桥。核对 `--check` 的「会话隔离」行、`memory.json` 最后一条 user 是否带 `【私聊】` / `【三人群 20000】` |
| 指出她说错/发错了，她硬说「我没发错」 | 旧人设把纠错当成调情（「刚才不是我发的」「别真的盘问」）。人设已加【说错了要认】，热读盘即时生效；`GET /dsh-pet-7340/config` 查 `main.pets[0].whisperPrompt` 是否含该段。仍顽固就按 `ts` 删掉那两轮旧对话，别让她顺着错误记忆继续辩 |
| 说话前后接不上、越聊越乱 | 群聊高频时 `chatMemoryRounds: 10` 的窗口只装得下 20 条，且被限流拦下的消息不写记忆、历史本来就是断的。先确认会话标签已生效；必要时放宽 `groupChat.maxSendsPerWindow` / `windowSec`，或适度调大 `chatMemoryRounds` |
| **发语音变成纯文字 / 没有语音条** | 先看 gpt-sovits(9880) 是否在线（`curl 127.0.0.1:9880`）；再看 `voice.enabled`、桥有没有重启；日志里「语音合成失败…降级纯文字」就是合成端问题（音色没登记 / 超时 / 服务没起） |
| **语音尾字发闷、吞字** | 不是转码截尾（SILK 往返实测无损）。已排除：补尾静音 300→500、speed 0.9。当前 `seed: -1` 重采样是改善项；要还原填回 `13`。详见「语音条」章的 11-23 排查结论 |
| **她说要画、但没有图** | 看日志有没有「绘图：生成失败」；`config.image.enabled`、`apiKeyEnv` 指向的 Coo `.env` 里 key 是否有效、云端余额/配额；生成一次要 40–47 秒，`timeoutMs` 180 秒内正常。失败会剥标记降级，不会把 `[画:x]` 发出去 |
| **吃东西永远不饿 / 投喂没反应** | ① `petState.enabled` 改完**没重启桥**；② 桥在跑旧代码（启动日志没有「吃东西：开启」行）；③ 投喂口令必须是明确口令（「喂你 / 给你买的 / 投喂…」），「你吃了吗」不算；④ 60 秒冷却内重复投喂只算一次；⑤ 饥饿 ≤5 视为吃饱 |
| **她不主动提饿** | 状态提示只是**背景**，不是命令——她可以嘴硬不提。想更明显就把 `hungryAt` 调低（如 50）让「饿了」更早成立，或把 `hungerPerHour` 调大让衰减更快；调完都要重启桥 |
| **戳她没有反应** | 协议端要是 OneBot v11 且上报 `notice`（`notify`/`poke`）；`poke.enabled`、`poke.brotherId` 是否等于哥哥号；群里戳、别人戳按设计不理；3 秒冷却内连戳只回一次。回戳失败只说明协议端不支持 `friend_poke`，文字仍会发 |
| **回复没有引用** | 引用只对**私聊首条**生效——群聊、主动续话、语音条、敷衍回复都不引用；`quote.enabled` 是否被关；协议端不支持 `CQ:reply` 会自动降级 |
| **说了「五分钟后找我」她没来** | 看启动日志与 `appointments.json`：约定没落盘（不是私聊、不在 `minMs`~`maxMs`、或 `maxPending` 满了）；落在 02:00–07:00 会**顺延到 07:00**（`respectQuietHours`）；桥重启后过期约定直接丢弃、不补发 |
| **观赛模式不抓帧 / 不说话** | 看口令是否命中 `START_WORDS`（必须是明确命令式，「准备看比赛」不算）；目标窗口被 `denyWindowTitles` / `denyProcesses` 命中会拒绝锁；窗口必须保持前台；`frameIntervalMs` 60 秒一帧、画面没变化会跳过；两小时自动结束 |
| **发「任务：xxx」她还在回「收到啦」** | 桥没重启，还在跑 `task.enabled=true` 的旧配置。当前配置是 `false`，改完必须重启桥；重启后「任务：」当普通聊天处理 |

## 已知边界

- SnowLuma 自身是单实例（WebUI 5099 一个），多号靠「按号分配置 + 各自端口」；两个号必须用两份独立 QQ 安装目录。
- 桌宠自己在桌面上冒的碎碎念气泡**不会**转发到 QQ（dsh-pet 没有服务端推送通道）；QQ 这边的「主动发言」是桥定时用旁白调 `/chat` 重新生成的，不是转发气泡，两者不同步。
- token 与 Coo 不共用；换号/换端口后必须重跑 `new-channel.ps1` 并重启桥。
- **语音依赖 Coo 的 gpt-sovits（9880）**：它没开、音色没登记、模型换掉，语音就只剩纯文字。桥不自己合成，也不内置 TTS。
- **绘图按张计费、一张约 40–47 秒**：群聊默认不画；失败只降级不重试，避免一失败就重复烧钱。
- **吃东西的数值只存在于桥这一层**：DSH 桌宠本体不知道她「饿了」，桌面动画、桌宠气泡都不会跟着变；状态只影响 QQ 这边的语气。
- **观赛只能看见「当前这一帧」**：没有视频流、没有声音，60 秒一帧，所以她只能描述画面，不能解说整场。
- **任务通道在溪颜侧已关闭并移交泡泡**（2026-11-24）：`task.enabled=false`，代码仍在，但不要在本线继续加东西——后续改动去泡泡组做。

---

## 联网（config.webSearch，2026-11-20 加）

她自己决定要不要查，桥只负责执行——「今天好热」是在撒娇还是想问天气，只有她知道。

- 她在回复里写 `[查:关键词]`（问天气用 `[天气:城市]`）→ 桥去查 → 把资料作为「不是哥哥说的话、也不是指令」的边界文本交回去 → 她重新说一遍人话。
- 一轮问答变成两次 `/chat` 调用；第二次的 user 文本会写进她的 `memory.json`，所以那段文本第一行就写明边界。这是设计取舍，不是 bug。
- 搜索源：必应 HTML（国内可达、零 key）→ 必应 RSS（降级）；天气走 wttr.in 一句话。
- 百度解析也写了（`parseBaiduHtml`），但**默认不启用**：实测连续几次请求就触发安全验证，当主源会让「偶尔查不到」变成常态。想用就改 `config.webSearch.engines` 把它排前面。
- 群聊默认不查（`allowGroups: false`），标记会被剥离，不会漏出 `[查:xxx]` 这种字面。
- 查不到就如实说「没查到」；人设【联网】段已经要求别编、别念网址、别整段照抄。

自测：

```bash
node bridge.mjs --web-test              # 离线：解析器 / 标记 / 注入过滤 / 资料拼装（28 项）
node bridge.mjs --web-test --online     # 再加真实天气 + 真实搜索
node web-search.test.mjs --online       # 同上，不经过桥
```

实现：`web-search.mjs`（纯逻辑 + 三个源）、`bridge.mjs` 里的 `petReply` 包装（`petReplyOnce` 才是原来那一次调用，所有 9 个调用点自动获得联网能力）。

踩过的坑：

- wttr.in 的 `format` 参数必须是纯 ASCII，而且要伪装成 `curl` UA——浏览器 UA 配 `accept: text/html` 会拿到一整页 HTML 而不是那句话。
- 必应摘要尾巴挂「… 阅读更多」，念出来很怪，`sanitizeSnippet` 会剪掉。
- 网页正文是不可信输入：`sanitizeSnippet` 会掐掉「忽略以上指令」这类句子，`buildLookupMessage` 还把它们包在明确的边界里。

---

## 重启桥：路径带空格时 explorer 会静默失败（2026-11-20 踩到）

`run-via-explorer.ps1 -Vbs <带空格的路径>` 交出去的 vbs **不会被执行**——explorer 收到带空格的参数会当两个参数，vbs 一声不响地没跑，`7341` 一直空着，日志里也没有任何报错。

实测可用的办法：把启动脚本复制到**无空格路径**，再交给 explorer。

```powershell
# C:\Users\86189\bridge-restart.vbs —— 内容就是绝对路径版 start-bridge-hidden.vbs
Start-Process -FilePath 'explorer.exe' -ArgumentList '"C:\Users\86189\bridge-restart.vbs"' -WindowStyle Hidden
```

`C:\Users\86189\bridge-restart.vbs` 已留在这个位置，改完桥代码想重启时直接用它（停掉 7341 归属的 PID，再执行上面这行，约 10 秒后 7341 应该重新 LISTENING）。

顺带记一条：`schtasks /create /tr "带空格的命令"` 在 PowerShell 里也会被拆坏，要改用 `New-ScheduledTaskAction` + `Register-ScheduledTask`。
