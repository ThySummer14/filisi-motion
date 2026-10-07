# 离线 WAV 音频导出

`src/audio-export.js` 是本项目原创的 MIT 代码，没有第三方依赖。它把视频原声和音频图层的本地素材解码为 PCM，通过 `OfflineAudioContext` 离线混音，输出 48,000 Hz、双声道、16-bit little-endian PCM WAV。

它不播放媒体、不录音、不读取麦克风、不上传素材，不使用媒体元素、实时录制或 `captureStream`。工程中的图片、图形、文字及视频画面不进入 WAV。

## 调用

```js
import {exportOfflineAudio} from './src/audio-export.js';

const wav = await exportOfflineAudio(project, {
  assetStore,                        // async get(id) -> {blob, meta, url}
  cancelled: () => exportCancelled, // optional; default false
  progress: (fraction, message) => updateProgress(fraction, message),
});
// wav is a Blob with type "audio/wav". The caller owns download/UI behavior.
```

空工程、所有媒体隐藏、静音或音量为零，都会导出完整合成时长的立体声静音 WAV；它们不读取素材、不创建解码用 `AudioContext`。可见且有音量的视频若没有可解码音轨，会明确报错，提示把无声视频的原声静音或提取 WAV 后重试，不会悄悄省略音轨。

`progress` 的比例在 0–1 之间，阶段文字包含解码、混音与写入。混音是浏览器的单个异步任务，不能提供内部百分比。失败会 reject；主动取消的异常 `name` 为 `AbortError`。主要错误码包括 `AUDIO_MEMORY_LIMIT`、`AUDIO_DECODE`、`AUDIO_METADATA`、`AUDIO_UNSUPPORTED`、`AUDIO_SAMPLE_RATE`、`AUDIO_RENDER`、`AUDIO_ASSET`。

## 时间、音量和声道

- 合成上限仍为 300 秒、100 图层，其中最多 32 个视频 / 音频片段。最短合成为 0.1 秒。模块先校验，再快照所需媒体字段，异步导出期间的图层修改不会改变已开始的结果。
- 输出总帧数是 `ceil(duration × 48000)`；只消除靠近整数边界的浮点运算噪声。最后不足一个采样周期的部分按一个样本输出，差值小于 1/48000 秒。
- 片段区间为 `[start,end)`。入点、出点都映射到“该时间或之后的第一个输出样本”。同一拆分边界不会重叠发声，也不会空出一个样本。
- 源入点使用固定一倍速模型：`sourceIn + compositionTime - start`。绝对源与合成的偏移量舍入到最近的 48 kHz 样本，半样本向正方向取整；偏差最多半个样本。拆分后的两段共享这个偏移，不各自重新累计播放时间。
- `volume`、`muted`、`visible`、`fadeIn`、`fadeOut` 和 `fadeOrigin` 与 `media-core.js` 的 `gainAt` 语义一致。淡入和淡出使用串联的两个线性 GainNode，重叠时相乘，保留裁剪、拆分、移动后的源时间渐变。
- 输出始终为立体声。单声道复制到左右两声道；多声道采用 Web Audio 的 `speakers` 下混规则，不添加自定义声像。最多接受 32 个解码声道。
- 混音不自动归一化，不加限幅器或抖动。多轨叠加或提升音量可以超过满幅；写 PCM16 时硬裁剪至 −32768…32767。NaN 写为零，正负无穷裁剪到相应极值。

## 384 MiB 内存预算

每次导出都强制检查估算不超过 **384 MiB**，包括：

1. 本次使用的编码素材 Blob，以及最大单个文件的两份读取 / 解码副本。
2. 全长解码 PCM，以及每个播放片段可能取得的 PCM 副本；重复使用素材只解码一次，但仍计算片段的潜在副本。
3. 立体声 Float32 混音 / 读取副本，WAV ArrayBuffer / 最终 Blob 两份。
4. 16 MiB 的图节点、头部检查和分配余量。

素材仍须满足单文件 64 MiB、所用素材总量 128 MiB 的限制。输出大小为 `44 + 输出帧数 × 4` 字节。RIFF 的 32 位长度也独立校验，溢出会在分配 WAV 缓冲前被拒绝。

`decodeAudioData` 解码的是**整个源文件**。把长片段裁成几秒，并不会减少那份源文件的解码内存。现有导入元数据没有音频声道数，因此压缩音频 / 视频默认按 **32 声道**预留整段 48 kHz Float32 解码与一份副本，另留 0.3 秒的解码时长容差。读取前 64 KiB 能识别的普通 PCM / float RIFF WAV 使用头部的已知声道数；复杂 WAV、其他容器或更靠后的头部继续采用保守值。它不是 MP4 解复用器。

因此，一段 169 秒的压缩源可能在任何实际解码前被拒绝，即使剪辑很短或用户知道它实际为立体声。错误说明预计需求、384 MiB 上限、未知声道的预留原因及整段解码限制。可以先在其他工具中裁短源文件或导出普通 WAV，再导入编辑器。模块不会为了让文件通过而降低未知声道假设。

解码完成后再次按实际样本数、声道数和片段数检查预算。**这是导出工作集的保守估算，不是浏览器进程的硬内存上限**：原有编辑器资源、浏览器解码器内部工作区、原始采样率转换、垃圾回收及实现自己的分配无法由 Web Audio 限制。浏览器仍可能因资源不足而拒绝低于预算的项目。

## 取消和清理

读取、解码、渲染的每个异步边界都检查取消。WAV 写入以 32,768 个输出帧为一批，批次之间让出主线程并检查取消。

原生 `decodeAudioData` 与 `OfflineAudioContext.startRendering` 没有终止当前工作的 API。点击取消后，当前原生任务要先完成或失败，随后丢弃结果；界面应保持“正在取消 / 等待当前步骤结束”，不要提前宣布资源已经释放。没有超时伪装成成功、没有后台继续交付取消结果，也没有覆盖浏览器 API。

每次导出最多创建一个短期 `AudioContext`，串行解码去重后的素材，随后在离线渲染之前关闭。无论完成、取消或异常，模块都会断开创建的节点、解除素材缓冲引用，并尝试关闭尚存的解码上下文。`OfflineAudioContext` 没有 `close()`，不能声称强行关闭它。返回的 WAV Blob 及调用者为下载创建的 URL 由调用者管理。

## 编解码与确定性边界

固定的是输出采样率、输出帧数、片段调度、源偏移及增益规则，不是所有浏览器对所有容器的解码结果。压缩格式、编码延迟 / priming、容器编辑列表、音轨时间戳和重采样可能影响首尾 PCM；不能据此宣称跨浏览器或跨编码样本完全一致。Web Audio 解码多音轨文件时只取第一条音轨。

解码音轨与素材描述相差超过 0.3 秒会拒绝；在容差内，短于描述的末尾输出静音，超出的尾部按片段出点截断。这不是自动补偿音轨偏移。对同步精度要求高的素材，建议先提供对齐好的 PCM WAV。

## 验证状态和可测试 API

`node --test tests/audio-export.test.mjs` 覆盖准确帧数、半开裁切、源偏移、音量 / 静音 / 隐藏、拆分 / 裁剪 / 移动渐变、立体声交错、削波、RIFF 上限、内存估算、素材去重、取消和异常清理。

导出的纯辅助函数：`sampleAtOrAfter`、`projectAudioFrames`、`planOfflineAudio`、`scheduleAudioClip`、`wavLayout`、`pcm16Sample`、`encodePcm16Wav`、`estimateAudioMemory`、`inspectWavHeader`。

`createOfflineAudioExporter({AudioContext, OfflineAudioContext, yieldControl})` 用于显式注入测试构造器。生产入口 `exportOfflineAudio` 读取浏览器提供的原生构造器。测试没有替换任何全局浏览器 API。

**本模块提交时只完成 Node 纯逻辑与模拟 API 测试；尚未进行真实浏览器 WAV、压缩音轨、多声道、取消交互或长时间资源压力验收。** 模拟渲染器验证调度与连线，不能代替浏览器解码 / DSP 测试。

API 依据：[W3C Web Audio 解码](https://www.w3.org/TR/webaudio/#dom-baseaudiocontext-decodeaudiodata)、[离线渲染](https://www.w3.org/TR/webaudio/#OfflineAudioContext)、[AudioBuffer 数据取得与副本](https://www.w3.org/TR/webaudio/#acquire-the-content)、[声道上下混](https://www.w3.org/TR/webaudio/#channel-up-mixing-and-down-mixing)。只参考标准的行为说明，没有借用第三方实现。
