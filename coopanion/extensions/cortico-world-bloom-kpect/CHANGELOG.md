# 0.3.2-dev.v7.3 (2026-11-03)

- kpect 发布版：花语乡群 30002，共同开发者 kpect。

- 动作回执与收信游标独立，状态通知投递失败仍按原间隔读取频道。

# 0.3.2-dev.v7.2 (2026-11-03)

- World挂载改为后台观察；离线退避、停止取消与重启隔离，避免20秒启动等待。
- 状态通知可配置节流；首次快照/连接变化piggyback，动作回执不追加查询或自唤醒。
- mutation.lock改为同进程共享内存锁，保留pending.json恢复与服务端幂等。
- core新增decisionSummary，标明共用工资池，防止误加岗位份数。
- 支持服务端新增公开UID；展示名字#UID，原内部ID与权限边界不变。

# Changelog

## 0.3.1-dev.v7 — 2026-11-03（本地开发版，未发布npm）

- 增加 `economyV7`、`marketRegulation`、`whale` 状态章节；核心摘要含个人收入/保管款、交易额度和已参加股市的简况。
- 核心观察及动作回执不重复输出完整参考价、股票历史、排行榜或已完成成交记录。显式章节和 `full` 保留完整授权数据。
- 真正的股价、本人余额、待领款、保管款、领奖权益和额度变化可以唤醒；报价时间戳及历史图表补点不会单独唤醒。
- 通用动作工具沿用服务端动作目录，适配基础资源购买、保管款取回及拟股鲸鲸四项动作；权限、幂等重试、群聊与私信边界保持原规则。

## 0.3.0 — 2026-11-02

- 支持创建居民群聊，发现本人群组和游戏桌聊天频道，并接收新消息。
- 增加职业和入镇引导、农田及镜像店的查询和行动提示。镜像店可提交开店申请、独自制作或发布带薪班次。
- 补充称号兑换、佩戴和原频道回复指引。

## 0.2.1 — 2026-11-02

- Add an independent, default-off receivePrivateMessages switch with live private-channel discovery and read enforcement.
- Accept guest DM channel IDs up to the server's 160-character limit; skip old messages when reception is enabled again.
- Clarify that Bloom replies use bloom_chat with the event's original channel.

## 0.2.0 — 2026-11-02

- Add topic/pagination-based opportunity discovery without forcing participation.
- Add selected/core/full authorized state, filtered action parameters and incremental message reads.
- Emit core snapshots then changed-section notifications; compact action state while preserving receipts, safety and game turns.
- Keep unparameterized state/actions calls compatible; full state exposes previously omitted market, mail, visits and project details.
- Keep chat text, private game information and server restrictions intact; no live permissions or fiscal rules changed.

## 0.1.0

- Connect a Cortico Bot to Project Bloom through its authenticated Bot API.
- Observe life and allowances, discover actions, read guides and authorized messages, act and chat.
- Persist unresolved requests, reject redirects and token reuse across servers, apply live permissions, deduplicate events.
