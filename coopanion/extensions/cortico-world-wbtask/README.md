# cortico-world-wbtask

把本机的 WorkBuddy（CodeBuddy Agent）接成泡泡的一双手。

她能把一句话交出去——「把这批 xls 按序号合并成一张表，放在 D:/wb/泡泡/out」——由 WorkBuddy 在电脑上真去办，办完把结果递回来。她不能读写文件、不能跑命令，但这个 World 可以替她跑。

## 它和 QQ 世界是什么关系

没有关系。这个 World 不连 OneBot、不读聊天记录、不碰 QQ 世界的代码。

QQ 里的消息怎么进来、泡泡怎么开口，仍然由 `cortico-world-qq` 负责；这里只提供两个工具和一条完成通知。所以：

- QQ 世界升级、重装、回滚，都不影响这个 World。
- 反过来，卸载这个 World 也只是少了一双手，聊天照旧。

## 装法

```bash
# 1) 目录已经在本地：
#    D:/coopanion/data/extensions/local/cortico-world-wbtask

# 2) 在扩展目录登记（改 extensions/package.json 的 dependencies）：
cd D:/coopanion/data/extensions
#   "cortico-world-wbtask": "link:D:/coopanion/data/extensions/local/cortico-world-wbtask"

corepack pnpm install
```

3) 重启 Coo（扩展包在启动时装载，热装不生效）。

4) 控制台 →「模块」→ 启用「WorkBuddy 任务」，或直接改 `config.json`：

```jsonc
"worlds": {
  "wbtask": {
    "enabled": true,
    "nodePath": "C:/Users/86189/.workbuddy/binaries/node/versions/22.22.2-6/node.exe",
    "cliEntry": "D:/wb/WorkBuddy/resources/app.asar.unpacked/cli/bin/codebuddy",
    "cwd": "D:/wb/泡泡",
    "timeoutSec": 120,
    "maxOutputChars": 1200,
    "permissionMode": "acceptEdits",
    "skipPermissions": false
  }
}
```

## 先让 CLI 能用

这个 World 是壳，真正干活的是 WorkBuddy 自带的 `codebuddy` CLI。它在无头模式下需要身份：

- **方式一（推荐）**：在终端跑一次 `codebuddy`，输入 `/login`，浏览器授权一次。之后同一台机器上 `codebuddy -p ...` 直接可用。
- **方式二**：设 `CODEBUDDY_API_KEY` 环境变量（官方文档说明：非交互模式下始终用它调模型）。

没配好的表现很明确：`wb_run` 会返回「WorkBuddy CLI 还没登录」，并说明怎么补。

自检命令：

```bash
"C:/Users/86189/.workbuddy/binaries/node/versions/22.22.2-6/node.exe" \
  "D:/wb/WorkBuddy/resources/app.asar.unpacked/cli/bin/codebuddy" \
  -p "只回复两个字：在线" --output-format json --tools ""
```

## 泡泡怎么用它

环境提示词（`ENV_PROMPT.md`）会告诉她：什么时候该派活、活要怎么描述、回执怎么读。不需要改人设文件。

对话里就是自然语言：

> 主人：把这周的工作日志整理成一页纸，放桌面。
> 泡泡：（调 `wb_run`，task="读取 D:/wb/泡泡/.workbuddy/memory 下本周的日志，合并成一页摘要，写到 D:/wb/泡泡/out/weekly.md"）

## 工具

| 工具 | 作用 |
|---|---|
| `wb_run` | 交办。默认当场等结果；`background: true` 则立刻返回任务号，办完推 `wbtask.done` 事件 |
| `wb_status` | 查最近任务，或按任务号看详情 |

## 已知边界

- **串行**：默认一次只跑一个（`maxConcurrent: 1`）。同时跑多个 CLI 会互相抢文件、抢额度，不建议调大。
- **权限**：`skipPermissions: false` 时，CLI 不能写文件、不能跑命令——只能读和答。要它真的动手，得开 `-y`，这是安全边界，想清楚再开。
- **超时**：同步任务超过 `timeoutSec` 会被掐掉并杀进程树；长活用 `background`。
- **额度**：每次交办都是一次真实的模型调用，会花额度。
- **日志**：任务记录在 `data/wbtask-jobs.json`，保留最近 100 条。

## 卸载

控制台停用 → 从 `extensions/package.json` 删掉依赖 → 删 `node_modules/cortico-world-wbtask` → 重启 Coo。
