# cortico-world-wechat

Coopanion 的微信 world：自带 DeepSeek 客户端与**友利奈绪**人设，按群独立记忆，不碰桌宠「泡泡」的人设与记忆。

```
微信 (VM)  ── wxauto4 ──▶  wechat_bridge v4  ──WS──▶  本扩展
                                    ◀── send ──
```

## 特点

- **零依赖**：不装 `ws`、不跑 pnpm，Node 22 自带能力 + 自写最小 WebSocket 服务端。
- **独立大脑**：直接调 DeepSeek（与 Coopanion 同一个 key），系统提示词是奈绪；每群一份短期上下文（默认 12 轮）。
- **只回 @**：非 @ 消息只进上下文，不回复。
- **限速**：每群 60 秒最多 6 条、回复最多 3 片、片间 1.5 秒。
- **不接入主 agent**：不 pushEvent，所以不会污染泡泡的时间线。

## 配置（`companion/config.json` 的 `worlds.wechat`）

```json
"wechat": {
  "enabled": true,
  "host": "0.0.0.0",
  "port": 17900,
  "token": "YOUR_CREDENTIAL_HERE",
  "rooms": ["测试群"],
  "provider": {
    "baseUrl": "https://api.deepseek.com",
    "model": "deepseek-flash",
    "secretName": "YOUR_CREDENTIAL_HERE",
    "temperature": 0.85,
    "maxTokens": 300,
    "timeoutMs": 30000
  },
  "context": { "maxTurns": 12 },
  "limits": {
    "maxSendsPerReply": 3,
    "sendIntervalMs": 1500,
    "roomMaxPerWindow": 6,
    "roomWindowSec": 60
  }
}
```

- `token` 必须与 bridge 的 `config.json` 一致。
- `rooms` 留空表示不限制；建议显式写测试群名。
- 密钥走 `.env`（`DEEPSEEK_API_KEY`），不写进 config。

## 安装

```powershell
cd D:\wb\测试1\wechat_bridge\coopanion-world-wechat
.\install.ps1            # 复制到扩展目录、登记依赖、建 junction
```

然后：

1. 把上面的 `worlds.wechat` 合并进 `D:\coopanion\data\home\companion\config.json`（改前先备份）。
2. **完全退出 Coopanion 再打开**（新装扩展必须重启进程，ESM 缓存）。
3. 看 `D:\coopanion\data\logs\core.log` 是否出现 `wechat world 已启动`。

## 验证（不依赖微信）

在 VM 的 bridge 还没起来前，可以在宿主机模拟 bridge：

```powershell
python - <<'PY'
import json, websocket
ws = websocket.create_connection("ws://127.0.0.1:17900/ws", timeout=5)
ws.send(json.dumps({"v":1,"type":"hello","token":"<token>","client":"probe",
                    "self":{"nick":"奈绪"},"rooms":["测试群"]}))
print(ws.recv())
ws.send(json.dumps({"v":1,"type":"msg","id":"m1","room":"测试群","sender":"小明",
                    "text":"在吗","at_me":True,"is_group":True}))
print(ws.recv())   # 应收到 {"type":"send", ... "text":"在。说。"}
PY
```

收到 `send` 帧就说明 WS、鉴权、模型、回复链路都通了。

## 排障

| 现象 | 看 |
|---|---|
| 端口没监听 | `core.log` 里有没有 `wechat world 已启动`；端口被占用 |
| 连上就断 | token 不一致（会收到 `error auth`） |
| 收到 msg 不回 | `core.log` 里 `缺少 DeepSeek 密钥` / `回复失败` |
| 回复重复 | 检查 bridge 是否重连重复投递（bridge 侧有 id 去重） |
| 上下文错乱 | 删 `data/wechat-context.json` 重来 |

## 文件

| 文件 | 作用 |
|---|---|
| `src/index.js` | world 定义与默认配置 |
| `src/world.js` | WS 服务端、收发、限速、上下文 |
| `src/brain.js` | DeepSeek 客户端 |
| `src/prompt.js` | 奈绪系统提示词、清洗、分片 |
| `src/wsmin.js` | 最小 WebSocket 服务端（无依赖） |
