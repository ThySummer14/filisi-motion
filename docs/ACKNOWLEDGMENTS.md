# 研究与许可记录

研究日期：2026-10-07。仓库代码和示例图形为本次从零实现，没有 vendored 源码、第三方字体、音频、照片或外部图标库。没有克隆或运行下列项目的脚本。

| 项目 | 核实的许可 | 本项目如何参考 |
| --- | --- | --- |
| [Motionity](https://github.com/alyssaxuu/motionity) | [MIT](https://github.com/alyssaxuu/motionity/blob/main/LICENSE) | 研究浏览器可视化动效编辑器的产品方向；未复制源码或素材 |
| [Motion Canvas](https://github.com/motion-canvas/motion-canvas) | [MIT](https://github.com/motion-canvas/motion-canvas/blob/main/LICENSE) | 研究用可重复的时间取样驱动画面这一架构方向；未使用其包或源码 |
| [Friction](https://github.com/friction2d/friction) | [GPL-3.0-only](https://github.com/friction2d/friction/blob/main/LICENSE.md) | 研究二维动效工具覆盖面；未合入其代码，避免把 GPL 代码错误标为 MIT |

本项目不以 Remotion 为依赖，也不对它作 MIT 假设。后续引入依赖、复用代码或素材，必须逐项核实许可，并保留对应版权与许可文本。

GIF 编码基于公开 GIF89a 格式的一般知识，当前 literal LZW 编码器为原创实现。UI 中使用系统字体与 Unicode 符号，未打包任何字体文件。系统字体本身的许可由运行设备负责。

Filisi Motion 是独立开源项目，不隶属于 Adobe，也不包含 Adobe 的代码、商标素材或项目解析器。
