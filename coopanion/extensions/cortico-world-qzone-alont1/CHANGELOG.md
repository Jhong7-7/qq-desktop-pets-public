<!-- Owner: packaged source and lifecycle contract -->
# 更新记录

## 0.2.1 - 2026-10-26

- 详情配置不再包含宿主启用总开关，避免过期表单保存其他设置时意外关闭扩展。
- 启用/停用统一使用宿主卡片；真实业务子开关仍可配置，中文教程明确保存与重新挂载的区别。

迁移：升级后重载宿主并刷新控制台页面；如果旧版已把总开关保存为 false，请在宿主卡片重新激活一次。若旧实例仍显示在线，可先停用再激活。修复不会猜测或覆盖用户已有停用选择。

<!-- Owner: package.json and packaged source -->
# 更新记录

## 0.2.0 - 2026-10-25

- 状态与默认图库隔离在 dataDir/qzone；stickerDir 可显式指定图片目录。
- 串行发布、按宿主时区执行额度与静默；网络结果不确定时不自动换图片格式重发。
- 面板保留快速交替启停的最终停止，显示执行中调用与耗时，按 failed:true 统计失败；面板代码随包内置。
- 按 Cortico 0.2.7 的 World API 6 / Bot API 7 检查适用契约；单包产物不引入其他扩展。

迁移：状态改为 dataDir/qzone/qzone.json，可停用并备份后手动复制旧 qzone.json；默认图库 dataDir/qzone/stickers。旧共享 stickers 或 workspace/blobs/stickers 只能显式配置或手动选图迁移。

