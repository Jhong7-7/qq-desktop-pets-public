# cortico-world-qq

Cortico World「QQ」,由 [Cortico](https://github.com/Pal-AI-Lab/Cortico) 仓库 `src/worlds/qq/` 生成,包版本就是生成时的框架版本。
源码直接 import 框架内部模块,宿主的 Cortico 版本要与包版本相同。完整 Cortico 已内建这个 World,
装了也会因 id 冲突不加载;这个包给不带它的发行版用。

Generated from `src/worlds/qq/` of [Cortico](https://github.com/Pal-AI-Lab/Cortico); the package version is the framework
version it was generated from, and the host must run that same Cortico version. Full Cortico already
ships this World built in; the package is for distributions that leave it out.

```bash
cd extensions && corepack pnpm add cortico-world-qq
```

配置与用法见 [src/worlds/qq](https://github.com/Pal-AI-Lab/Cortico/tree/main/src/worlds/qq)。
