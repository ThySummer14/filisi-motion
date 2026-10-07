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

每次导出都分别计算**解码、渲染、编码**三阶段的峰值，取最大值，强制检查不超过 **384 MiB**。不会把不同阶段才需要的缓冲一律视为同时存活：

1. **解码阶段**：仍缓存的编码素材 Blob、最大单个待解码文件的两份读取 / 解码工作副本、已解码 PCM 的两份预留、当前整段解码的两份预留。此时尚未创建离线渲染上下文或 WAV 缓冲。
2. **渲染阶段**：编码素材 Blob、全长源 PCM 与每个播放片段可能取得的 PCM 副本、立体声 Float32 渲染 / 读取两份预留。解码已经完成，临时编码字节引用已解除，解码用 AudioContext 已等待关闭。此时还没有 WAV 缓冲。
3. **编码阶段**：编码素材 Blob、Float32 渲染 / 读取两份、WAV ArrayBuffer / 最终 Blob 两份。虽然已经断开源节点、设置源缓冲为 null、清空解码与素材记录并解除离线上下文引用，**仍保留全部源 PCM 与已取得副本的预算**，不假设浏览器立即回收它们。
4. 每一阶段都另加 16 MiB 的图节点、头部检查和分配余量。

Blob 不会因为模块清空记录而从预算中减去，素材仓库仍可能保有它。工程提供素材元数据时，所有当前工程素材的编码字节都会计入，包括已静音的视频；实际读取发现更多字节也会向上修正。未属于当前工程的其他缓存及编辑器资源不在这份导出预算内。

素材仍须满足单文件 64 MiB、工程媒体总量 128 MiB 的限制。输出大小为 `44 + 输出帧数 × 4` 字节。RIFF 的 32 位长度也独立校验，溢出会在分配 WAV 缓冲前被拒绝。

`decodeAudioData` 解码的是**整个源文件**。把长片段裁成几秒，并不会减少那份源文件的解码内存。现有导入元数据没有音频声道数，因此压缩音频 / 视频默认按 **32 声道**预留整段 48 kHz Float32 解码与一份副本，另留 0.3 秒的解码时长容差。读取前 64 KiB 能识别的普通 PCM / float RIFF WAV 使用头部的已知声道数；复杂 WAV、其他容器或更靠后的头部继续采用保守值。它不是 MP4 解复用器。

因此，一段 169 秒的压缩源可能在任何实际解码前被拒绝，即使剪辑很短或用户知道它实际为立体声。错误说明达到峰值的阶段、预计需求、384 MiB 上限、未知声道的预留原因及整段解码限制。可以先在其他工具中裁短源文件或导出普通 WAV，再导入编辑器。模块不会为了让文件通过而降低未知声道假设。

一个具体例子：169 秒、48 kHz、PCM16 立体声 WAV 文件大小为 32,448,044 字节，作为**一条连续音轨**导出同长度工程时，三个阶段的估算依次为约 232.61 / 294.50 / **356.39 MiB**。这个通过结果仍包含全部源 PCM 的回收延迟预留。若工程另外缓存 20 MiB 静音视频，估算峰值约 376.39 MiB，仍可通过；另外缓存 28 MiB 时会超过预算。把同一个长 WAV 拆成很多独立播放片段仍须计算每个源节点的潜在副本，不能用“只解码一次”绕过上限。实际文件大小、时长、其他素材及声道数不同，结果也会不同。

解码完成后再次按实际样本数、声道数和片段数检查预算。**这是按逻辑资源生命周期计算的导出工作集估算，不是浏览器进程的硬内存上限**：关闭解码上下文和解除 JS 引用不能强制浏览器归还原生分配。原有编辑器资源、解码器内部工作区、原始采样率转换、垃圾回收、内存碎片及实现自己的分配无法由 Web Audio 限制。源 PCM 在编码阶段仍保守预留；临时解码工作区退出该阶段后不继续叠加，但不声称其进程内存已经归还。浏览器仍可能因资源不足而拒绝低于预算的项目。

## 取消和清理

读取、解码、渲染的每个异步边界都检查取消。WAV 写入以 32,768 个输出帧为一批，批次之间让出主线程并检查取消。

原生 `decodeAudioData` 与 `OfflineAudioContext.startRendering` 没有终止当前工作的 API。点击取消后，当前原生任务要先完成或失败，随后丢弃结果；界面应保持“正在取消 / 等待当前步骤结束”，不要提前宣布资源已经释放。没有超时伪装成成功、没有后台继续交付取消结果，也没有覆盖浏览器 API。

每次导出最多创建一个短期 `AudioContext`，串行解码去重后的素材，随后在离线渲染之前关闭。渲染 promise 完成后、读取输出声道和分配 WAV **之前**，就会断开创建的节点、把源缓冲设为 null、清空解码与素材记录并解除离线上下文引用；不会一直拖到 WAV 写完才清理。取消或异常也会执行相同清理，并尝试关闭尚存的解码上下文。`OfflineAudioContext` 没有 `close()`，不能声称强行关闭它。返回的 WAV Blob 及调用者为下载创建的 URL 由调用者管理。

## 编解码与确定性边界

固定的是输出采样率、输出帧数、片段调度、源偏移及增益规则，不是所有浏览器对所有容器的解码结果。压缩格式、编码延迟 / priming、容器编辑列表、音轨时间戳和重采样可能影响首尾 PCM；不能据此宣称跨浏览器或跨编码样本完全一致。Web Audio 解码多音轨文件时只取第一条音轨。

解码音轨与素材描述相差超过 0.3 秒会拒绝；在容差内，短于描述的末尾输出静音，超出的尾部按片段出点截断。这不是自动补偿音轨偏移。对同步精度要求高的素材，建议先提供对齐好的 PCM WAV。

## 验证状态和可测试 API

`node --test tests/audio-export.test.mjs` 覆盖准确帧数、半开裁切、源偏移、音量 / 静音 / 隐藏、拆分 / 裁剪 / 移动渐变、立体声交错、削波、RIFF 上限、三阶段内存估算、保留的 PCM 与缓存 Blob 预算、素材去重、取消和异常清理。其中一个模拟原生 API 的完整长度测试实际编码 169 秒 / 8,112,000 帧的合成立体声静音 WAV，验证 32,448,044 字节输出，并断言源节点在声道读取之前已清理；它不解码真实私有素材。

导出的纯辅助函数：`sampleAtOrAfter`、`projectAudioFrames`、`planOfflineAudio`、`scheduleAudioClip`、`wavLayout`、`pcm16Sample`、`encodePcm16Wav`、`estimateAudioMemory`、`inspectWavHeader`。

`createOfflineAudioExporter({AudioContext, OfflineAudioContext, yieldControl})` 用于显式注入测试构造器。生产入口 `exportOfflineAudio` 读取浏览器提供的原生构造器。测试没有替换任何全局浏览器 API。

模块最初仅有 Node 模拟测试；现已补做桌面 Chrome 的短片、完整 AAC-LC 音轨及取消交互实测，数据见 [QA](QA.md)。多声道输入、其他浏览器与长时间资源压力仍未全面验证。模拟渲染器本身不能代替浏览器解码 / DSP 测试。

API 依据：[W3C Web Audio 解码](https://www.w3.org/TR/webaudio/#dom-baseaudiocontext-decodeaudiodata)、[离线渲染](https://www.w3.org/TR/webaudio/#OfflineAudioContext)、[AudioBuffer 数据取得与副本](https://www.w3.org/TR/webaudio/#acquire-the-content)、[声道上下混](https://www.w3.org/TR/webaudio/#channel-up-mixing-and-down-mixing)、[动态节点生命周期](https://www.w3.org/TR/webaudio/#DynamicLifetime)。只参考标准的行为说明，没有借用第三方实现。

## 0.4.1：受限 AAC 配置探测与缓存预算

普通单音轨 MP4 的 AAC-LC 可通过[有界只读探测](MP4_AUDIO_PROBE.md)识别实际 `esds/AudioSpecificConfig` 声道配置。预算使用探测的 `maxChannels`；不依赖工程文件自报的声道数，也不直接相信常被写死为 2 的 sample-entry 字段。PCM WAV 继续使用有校验的头部。其余不支持、不明确或损坏的配置仍回退到 32 声道估算。

原生解码完成后，还会确认声道数没有超过文件头预算，否则停止导出。配置探测不能保证原生解码器内部的内存上限，仍保留实际样本数 / 时长校验与保守阶段估算。

预算还合并 `AssetStore.retainedAssets()` 返回的实际缓存 Blob 大小，避免遗漏旧工程仍驻留的素材或低估当前工程元数据。切换工程后只释放已经持久化、且当前工程不再使用的内存 Blob / URL 引用；不删除 IndexedDB 数据，未能持久化的素材继续保留，以免丢掉唯一副本。

测试构造器额外接受 `probeAudioMetadata` 注入以检验预算和解码维度不一致的失败分支；生产入口固定使用本项目的真实文件头探测函数，不接受工程内的可信声明覆盖。
