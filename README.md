# QQ 桌宠项目（溪颜 & 泡泡）

两条 QQ 桌宠鱼的完整工程备份。

## 架构总览

| 鱼 | 项目 | 通道 | 本体 |
|---|---|---|---|
| 溪颜（DSH） | `dsh-pet-qq/` | OneBot WS `127.0.0.1:3011` | bridge.mjs（Node） |
| 泡泡（Coo） | `coopanion/` | Coo qq world `127.0.0.1:3001` | Coopanion Electron 应用 + world 扩展 |

- **溪颜**：由 `bridge.mjs` 驱动的 OneBot 桥，接 QQ 消息、主动说话、语音（voice.mjs）、
  绘图（image-gen.mjs）、抖音共看（douyin-mode.mjs）、专注模式、看门狗（watchdog.ps1）等。
- **泡泡**：基于 Coopanion 的 world 扩展体系（`coopanion/extensions/` 下各 `cortico-world-*`），
  人设与运行配置在 `coopanion/companion/`（config.json、worlds/、表情包 data/emote-pics 等）。

## 目录结构

```
dsh-pet-qq/            溪颜 OneBot 桥（Node.js）
  bridge.mjs           主桥
  voice.mjs            语音合成/发送
  image-gen.mjs        绘图
  douyin-mode.mjs      抖音桌面共看
  watch-mode.mjs       共看/监控模式
  stickers.mjs         表情包
  watchdog.ps1         看门狗与自启
  config.json          运行配置（含 token，勿公开）

coopanion/
  extensions/          Coo world 扩展（qq、songs、wechat、daily-life 等）
  companion/           泡泡人设与状态配置
    config.json        主配置（含 token，勿公开）
    worlds/            world 定义
    data/emote-pics/   表情包图库
```

## 运行环境（原机）

- 本仓库是**备份仓库**，目录结构与原机不同，原机运行路径为：
  - 溪颜：`D:\dsh workplace\tools\dsh-pet-qq`
  - 泡泡：`D:\coopanion\data\extensions\local` + `D:\coopanion\data\home\companion`
- 未包含：node_modules（`npm install` / `pnpm install` 自行恢复）、语音模型
  （RVC / GPT-SoVITS / singer，约 4G+）、聊天记忆档案（archivist）、运行日志。

## 🔒 脱敏说明

本仓库已做全面脱敏后公开内容：

- 凭据 / token / API key → 全部替换为 `YOUR_CREDENTIAL_HERE` 占位符
- QQ 号 / 群号 → 替换为 10000 / 10001 / 20000 等占位号码
- 已移除：聊天记录、记忆档案、运行状态、登录 cookies（.secret/）、头像、telemetry、语音模型
- 保留：全部功能代码、人设 prompt、配置结构、world 扩展、表情包图库

若在原机恢复运行，需自行填回真实凭据与号码。
