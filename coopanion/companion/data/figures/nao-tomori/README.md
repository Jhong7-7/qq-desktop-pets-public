# 友利奈绪 · Q版 v0.2（静态原脸）

Coopanion 形象包 v0.2（figure manifest 2 / api 2）。

## 这一版的原则

- **保留 Seedream 原脸**：不抹脸、不画 SVG 眼嘴，脸部就是原图。
- 只做身体/姿态：走路、坐下、被拎起由 Coopanion 的 kit 移动整组；坐下时整张图轻微下沉。
- 表情暂不变化：19 个表情词仍在 `vocab` 里，但视觉上保持原脸；以后要换表情，用整脸贴图替换，而不是代码画。

## 文件

```
figure.json      清单：id / 名字 / 37 词 / 打扮 / 封面 / persona
figure.js        入口：createNaoBody，只画整身贴图
model.json       256 空间：body 盒、坐标、颜色、锚点
tex/body.png     整身贴图（原脸）
thumbs/cover.png 512×512 封面
README.md
LICENSE
CREDITS.md
```

## 已知限制

- 走路/坐下是整组移动，腿和裙摆没有网格变形；画面会像整体滑动。
- 没有眨眼、口型、表情变化——这是本版刻意不做。
- 2.39 头身。
- 角色版权归 Key / ANIPLEX / Charlotte Project 等权利人；仅限个人自用，不公开分发。

## 安装

装扮页 → 形象行「导入」→ 选 `nao-tomori-v0.2.zip`；或复制到 `data/figures/nao-tomori/`。
