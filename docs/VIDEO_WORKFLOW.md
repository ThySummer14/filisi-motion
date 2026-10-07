# 0.3 视频 / 音频第一片

本版以真正的剪辑闭环为目标：导入本机媒体 → 定位 → 裁剪 / 拆分 / 移动 → 调整原声与淡入淡出 → 保存 → 混音导出。它仍是早期编辑器，不是专业媒体解码器或完整 AE 替代品。

## 使用

1. 新建空白工程，点击工具条「视频 / 音频」选择本机文件。支持的实际编码由浏览器决定；优先 H.264/AAC MP4、MP3、WAV。
2. 空白工程导入视频时采用素材尺寸和时长；FPS 不会自动识别，请按素材设置。单文件最多 64 MB，工程媒体合计 128 MB，最多 32 个媒体片段。
3. 用预览底部的秒数输入精确定位。暂停定位会等待解码器返回；「媒体定位中」不能当作画面已就绪。
4. 拖时间线条两端裁剪；拖中间移动。入点裁剪会同步改变源入点。媒体属性里的「源入点」可以替换该片段使用的源区间。
5. 播放头放在片段内部，点击「拆分」或按 S。拆分保留共享素材、原本的关键帧运动和淡入淡出连续性。
6. 右侧「媒体与原声」控制音量、静音、淡入淡出。视频淡入淡出同时影响画面与声音；「分离原声」产生独立音频层并静音原视频，避免重复播放。
7. 位置、缩放、旋转、不透明度、模糊和已有贝塞尔曲线继续可用于视频层。

## 保存、隐私和兼容

媒体 Blob 保存在本浏览器 IndexedDB，工程历史只保存元数据，不复制每段视频。刷新用本地自动存档恢复，但浏览器清理、配额不足或私人模式都可能使缓存失效。

「保存工程」下载 v3 `.filisi` 文件，**包含内嵌媒体**；在其他设备重开不应依赖原设备缓存。文件较大，分享前确认其中内容。旧 v1 / v2 工程可读；v3 媒体工程需 0.3 或更新版。旧版自动存档不会被覆盖。

编辑器不会把导入媒体发往服务器，不获取麦克风。用户作品、歌曲和私有素材不能随开源编辑器发布。公开测试代码仅描述原创几何图形和合成音。运行 `scripts/generate-media-fixture.py` 可在本机生成 `examples/media-sync-test.mp4`，仓库不附带测试视频二进制。

## 时间模型

媒体片段的源时间为 `sourceIn + compositionTime - start`。可见区间是 `[start,end)`，播放速度暂固定为 1。

拆分不把两个边界关键帧硬插进贝塞尔曲线，而是保留同一组原始全局时间关键帧，让两段各自限制可见范围。移动时所有键点整体平移，允许键点在合成范围外，避免挤成一团改变缓动。

`fadeOrigin` 在源时间中保留拆分 / 裁剪前的渐变范围。修改淡入 / 淡出参数时会重新以当前片段范围应用渐变。

## 预览与导出边界

- 预览以 Web Audio 时钟驱动时间线，媒体通过各自原生解码器定位和播放；大素材或复杂重叠仍可能缓冲。
- WebM 使用 Canvas + MediaRecorder，并加入 Web Audio 混音轨。**实时尽力录制**，可能丢帧或有小幅音画 / 时长误差；保持页面前台。不是逐帧确定性编码，不输出 MP4。
- GIF 逐次定位视频后渲染，帧数由设置决定，但视频取帧精度仍由浏览器决定；GIF 没有声音。
- 暂不包含变速、视频编码信息探测、代理生成、专业音频波形 / 响度监测、字幕、素材重连、WebCodecs 编解码 / 封装。

## 方案依据

[EffectCraft / FilmCraft 研究](STORYTOLD_RESEARCH.md) 提供时间模型与渲染分层参考。本版没有运行或拷贝其编解码实现。

实际 API 依据：
- [HTMLMediaElement.currentTime](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/currentTime)：定位是解码管线行为，时间的小数位不代表帧精度。
- [MediaElementAudioSource](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/createMediaElementSource) 与 [MediaStreamDestination](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/createMediaStreamDestination)：媒体原声经过增益节点后混入录制流。
- [MediaRecorder](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder)：由浏览器提供编码。
- [WebCodecs](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API)：可作为后续受控帧编码方向，但仍需解复用、封装和音画调度；本版未实现。
- [IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)：大媒体本地存储。

具体实际验收与未验证项见 QA，不能用单元测试代替浏览器剪辑。
