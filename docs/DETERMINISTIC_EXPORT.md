# 确定性导出的下一步

研究日期：2026-10-07。本轮没有引入或执行以下第三方实现。现有 WebM 仍使用实时 MediaRecorder，不能宣称帧精确或已消除音画偏移。

## 方案比较

| 路径 | 能解决什么 | 仍需处理 |
| --- | --- | --- |
| WebCodecs + WebM 封装 | 按明确时间戳编码 Canvas 帧，脱离墙钟录制速度 | 输入解复用、关键帧解码、呈现顺序、音频编码与封装元数据 |
| 编号 PNG + PCM WAV + 外部编码器 | 便于检查每一帧和每个音频样本，作为诊断格式 | 大量文件与磁盘 I/O；不是完成的浏览器导出流程，输入帧仍需可靠解码 |
| OfflineAudioContext + 后续封装 | 按同一时间原点调度 PCM、增益和剪切 | 整源解码内存、压缩格式 priming、重采样、音频编码后的元数据 |

本轮选择第三条中的最小片：原创、零新增依赖的离线 PCM16 WAV。它可以验证采样位置和增益调度，但没有把确定性音频重新封装进现有 WebM。保守内存限制和浏览器实测状态见 [OFFLINE_AUDIO](OFFLINE_AUDIO.md)。

## 候选依赖与许可

- [webm-muxer](https://github.com/Vanilagy/webm-muxer) 的 [5.1.4 包信息](https://raw.githubusercontent.com/Vanilagy/webm-muxer/main/package.json) 标为 MIT，但作者明确宣布弃用、不再修复。它只负责输出封装，不解决输入解码。
- 维护中的 [Mediabunny v1.61.3](https://github.com/Vanilagy/mediabunny/releases/tag/v1.61.3) 提供输入、解复用、编码和输出流程，许可实际是 [MPL-2.0](https://raw.githubusercontent.com/Vanilagy/mediabunny/v1.61.3/LICENSE)，不能默认 MIT。若后续采用，应固定版本、保留许可和通知，并按 [MPL §3](https://www.mozilla.org/en-US/MPL/2.0/) 提供受覆盖文件对应源码；Filisi 独立原创文件可继续使用 MIT，但不能把整套依赖称为全 MIT。
- 原生 FFmpeg 的实际许可取决于编译配置，核心 LGPL 与可选 GPL 组件须区分，见 [官方许可说明](https://ffmpeg.org/legal.html)。本轮没有下载安装 ffmpeg.wasm 或运行未知仓库脚本。

## 可控的视频实验

未来可先限制 30 秒、720p、30 fps、48 kHz 立体声，支持正常速度剪切、现有 Canvas 覆盖层和增益：

1. 通过 [BlobSource / 输入 API](https://mediabunny.dev/guide/reading-media-files) 读取本地素材，先探测各轨道解码支持。
2. 用 [VideoSampleSink](https://mediabunny.dev/guide/media-sinks) 取得指定源时间对应的样本，遵守解码顺序和呈现时间戳；片段边界与空白必须由时间线决定，不能无限沿用之前的样本。
3. 第 n 帧的时间固定为 n / fps。编码时间戳使用 round(n × 1,000,000 / fps)，相邻时间戳相减得到帧时长，避免反复累计舍入误差。
4. 逐帧等待编码背压、及时关闭样本和 VideoFrame，使用 quality 延迟模式，最后 flush 并封装。依据 [WebCodecs 标准](https://www.w3.org/TR/webcodecs/#latency-mode) 与 [Chrome 指南](https://developer.chrome.com/docs/web-platform/best-practices/webcodecs)。
5. 音频从同一时间零点开始，样本时间戳连续。保留 [Opus pre-skip / priming](https://www.w3.org/TR/webcodecs-opus-codec-registration/#priming-samples) 等必要信息，不能只复制时间戳就宣称同步。
6. 短实验可使用缓冲输出；长片应采用支持带位置写入的流目标，不能随意拼接输出块。见 [输出目标](https://mediabunny.dev/guide/writing-media-files#output-targets)。

验收使用原创编号帧、颜色闪光和音频脉冲，再增加非关键帧处裁剪的已知输入。解码输出检查帧数、顺序、切点、音频样本位置、首中尾偏移与漂移，以及 CPU 忙碌时是否保持同一时间线。还需覆盖取消、重复导出和不支持的编码。

[HTML 媒体 seeking](https://html.spec.whatwg.org/multipage/media.html#seeking) 的 seeked 事件与 currentTime 小数位不是帧像素精确性的独立证明。原生 video 可继续用于交互预览，不能仅替换输出编码器就宣传输入也已逐帧确定。
