# storytold 参考研究与本轮落地

核验日期：2026-10-07。通过 GitHub 仓库文件与提交记录核验；未编译或运行这些仓库，不将 README 自述当作独立实测结果。

## 找到的项目

| 项目 | 与本项目的关系 | 本轮核验的维护证据 |
| --- | --- | --- |
| [EffectCraft](https://github.com/storytold/effectcraft) | 最直接的动效 / 合成参考 | `38e4c52`，2026-10-07，修复输入字段和面板堆叠 |
| [FilmCraft](https://github.com/storytold/filmcraft) | 剪辑、时间模型、渲染任务和编码分层 | `771b614`，2026-10-06，字体构建输入 |
| [PhotoCraft](https://github.com/storytold/photocraft) | 图层、蒙版、图像处理与工程模型 | `7eb3b2e`，2026-10-07，命令输入和异步任务一致性修复 |
| [VectorCraft](https://github.com/storytold/vectorcraft) | 矢量、路径、几何与UI/引擎隔离 | `a9c31fc`，2026-10-07，日文文件名测试 |

另有 LightCraft、PrintCraft、DesignCraft 等仓库，但未逐个深度评估。EffectCraft 自己明确说明项目始于 2026-10-01，不兼容 `.aep`，也还没有系统测量其与 AE 的一致性。因此本研究不采用其功能百分比或“所有效果”等表述来判断生产成熟度。

## 具体值得借鉴的设计

1. **关键帧求值不依赖界面。** [keyframe 模块](https://github.com/storytold/effectcraft/blob/38e4c52d4553b87485d945ef280ac324170a0c66/crates/keyframe/src/lib.rs) 将数值取样、时间缓动、空间路径分开；界面和渲染使用共同求值逻辑。
2. **曲线图是编辑器。** [graph.rs](https://github.com/storytold/effectcraft/blob/38e4c52d4553b87485d945ef280ac324170a0c66/crates/ui-egui/src/panels/graph.rs) 有可编辑键点、手柄和数值/速度视图。Filisi 本轮只实现数值图与受限时间贝塞尔，不冒充完整速度或空间路径编辑。
3. **渲染阶段明确。** [render 模块](https://github.com/storytold/effectcraft/blob/38e4c52d4553b87485d945ef280ac324170a0c66/crates/render/src/lib.rs) 区分源画面、蒙版、效果、变换、轨道遮罩、混合。可作为后续分层设计参考，本轮没有加入这些未实现模块。
4. **渲染任务和编码器分开。** [export 模块](https://github.com/storytold/effectcraft/blob/38e4c52d4553b87485d945ef280ac324170a0c66/crates/export/src/lib.rs) 逐帧渲染后按顺序送编码器，进度与取消在任务边界处理。现有 WebM 仍是浏览器实时录制；不会因读过此代码就声称拥有其编码能力。
5. **工程模型独立于 UI。** [FilmCraft project](https://github.com/storytold/filmcraft/blob/771b614ad4c3fbefda5d668ce4384504b8c13f6d/crates/project/src/lib.rs) 将序列、轨道、片段和源媒体时间区分。未来扩展音视频时，比把所有数据放在 DOM 中更稳妥。

## 界面参考：实际看过什么

查看了 [主工作台截图](https://github.com/storytold/effectcraft/blob/38e4c52d4553b87485d945ef280ac324170a0c66/docs/images/effectcraft-hero.png)、[曲线编辑器截图](https://github.com/storytold/effectcraft/blob/38e4c52d4553b87485d945ef280ac324170a0c66/docs/images/effectcraft-graph-editor.png)，并阅读 [theme.rs](https://github.com/storytold/effectcraft/blob/38e4c52d4553b87485d945ef280ac324170a0c66/crates/ui-egui/src/theme.rs)。

采用的视觉原则：深灰层次让内容优先；紧凑横向工具条；右侧属性栏贯穿全高；时间线与曲线图共享下方面积；冷蓝用于交互状态，曲线用暖色区分。Filisi 保留自己的品牌、图形、中文措辞和适合浏览器的字号，没有复制它的图标、字体文件、截图或品牌资源。

## 许可不是一个结论套所有仓库

- EffectCraft、FilmCraft、PhotoCraft、VectorCraft：README 声明 `MIT OR Apache-2.0`，已分别读取各仓库 `LICENSE-MIT`；EffectCraft 还核对了 `LICENSE-APACHE`、`NOTICE`、`ATTRIBUTION.md`。
- [ArtCraft 主仓库 LICENSE.md](https://github.com/storytold/artcraft/blob/main/LICENSE.md) 是限制商业售卖、竞争产品等用途的 fair-source WIP，不能当作 MIT 开源库纳入我们的项目。
- [EffectCraft 品牌许可](https://github.com/storytold/effectcraft/blob/38e4c52d4553b87485d945ef280ac324170a0c66/docs/brand/LICENSE-brand.txt) 对品牌标识单独限权。字体、图标、模型、素材也不能只根据根许可判断。
- [FilmCraft codecs 的 Cargo.toml](https://github.com/storytold/filmcraft/blob/771b614ad4c3fbefda5d668ce4384504b8c13f6d/crates/codecs/Cargo.toml) 使用 `symphonia`，其声明为 MPL-2.0。将来若采用编解码实现，需要检查完整依赖和适用权利，而不是推断所有依赖均为 MIT。

**本轮没有直接复用上述源码、包或资源。** 新增 `curve.js`、`graph.js` 和工作台布局为原创实现，参考记录用于说明设计来源。没有执行第三方脚本或新增第三方依赖。

## 本轮交付范围

Filisi Motion 0.2：数值曲线、可拖动键点、自定义贝塞尔手柄与数值输入、撤销重做、共享预览/导出求值、v1 工程向 v2 迁移，以及工作台布局重整。暂不包含速度图、空间运动路径、超调、自动切线、完整渲染队列或新的编码器。
