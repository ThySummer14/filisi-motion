# MP4 AAC 元数据探测

`src/audio-probe.js` 是原创 MIT 代码，零依赖。它只在本机读取 MP4 容器元数据，帮助离线 WAV 导出估算整段素材的解码内存；不解码、不上传、不检查音视频内容。

## API 与接入约定

```js
const metadata = await probeMp4Audio(blob);
// null，或者：
// {
//   channels: 2,
//   maxChannels: 2,
//   sampleRate: 48000,
//   codec: 'mp4a.40.2',
//   evidence: {
//     source: 'mp4-esds-asc', audioObjectType: 2,
//     channelConfiguration: 2, frequencyIndex: 3,
//     sbrSignaling: 'unspecified' | 'explicitly-absent',
//     monoExpansionReserved: false, moovBytes, bytesRead
//   }
// }
const reservedChannels = metadata?.maxChannels ?? 32;
```

- `channels` 是 AudioSpecificConfig（ASC）声明的声道数。配置 1 是单声道，绝不把它描述成实际立体声。
- `maxChannels` 是估算使用的声道预留值：`Math.max(2, channels)`。保留至少两声道，因为隐式参数立体声（PS）可能把单声道核心扩展为双声道。这个字段名称不表示已证明原生解码器的输出上限。
- `sampleRate` 是 ASC 声明的核心采样率。隐式 SBR 可能改变实际输出采样率，不能直接用它推断最终 PCM 大小。导出若固定在 48 kHz 解码，应以那个实际目标率和完整素材时长估算。
- `codec` 表示容器中的 AAC-LC 配置声明，不证明媒体包内容或浏览器支持情况。
- `evidence` 仅说明哪些字节得到了解析，不是可信输入标记、真实性证明或授权。`bytesRead` 是本次请求读取的字节数，`moovBytes` 包含 `moov` 头部。
- `null` 表示未知，包括不支持的合法格式、无音轨、损坏输入、读取失败和超限。调用方继续保留 32 声道预估，不能推断为无音轨、静音或两声道。

函数只依赖 `blob.size`、`blob.slice(start, end).arrayBuffer()`，不读取文件名、MIME、工程 JSON 中自报的声道数或源文件的完整 `arrayBuffer()`。结果不包含时长。

## 有意限制的格式子集

1. 顶层只有一个未压缩 `moov`，没有电影片段 `moof` / `mfra`、`mvex` 或保护头 `pssh`。通过 `trak → mdia → hdlr` 找到恰好一个 `soun` 音轨。其他已识别容器路径中的视频轨不能为音轨提供 ASC。
2. 音轨的 `minf → stbl → stsd` 有且只有一个样本描述，必须是未加密 `mp4a`。读取普通 ISO AudioSampleEntry 的版本 0 布局；版本 1 / 2、`enca`、`sinf`、`wave` 包装及未知样本扩展均返回未知。
3. 音频条目只允许直接 `esds` 和不改变音频配置的 `btrt`、`free`、`skip`。不使用其旧式 `channelcount` 或 `samplerate` 字段推断解码尺寸，尤其不能让常见的 `channelcount = 2` 覆盖 ASC 的多声道声明。
4. `esds` 必须有单一 ES_Descriptor，按顺序包含 DecoderConfigDescriptor 和 `SLConfigDescriptor(predefined = 2)`。不支持 URL、依赖流或 OCR 引用。DecoderConfigDescriptor 必须是 `objectTypeIndication = 0x40`、音频 streamType 5、非上行流，且恰好有一个 DecoderSpecificInfo。接受一至四字节的可扩展描述符长度，包括前导零续字节。
5. ASC 必须是 AOT 2；标准采样率索引 0–12，或本探测器支持的 7,350–96,000 Hz 范围内的 24 位显式采样率；配置映射为 `1→1, 2→2, 3→3, 4→4, 5→5, 6→6, 7→8`。配置 0 的 PCE、其他配置、其他 AOT 和保留索引不猜测。
6. 普通 GASpecificConfig 的三位标志须全为零。允许没有扩展，或 `syncExtensionType = 0x2b7`、扩展 AOT 5、`sbrPresentFlag = 0` 的 SBR 缺席声明，末尾仅允许最多七个零填充位。显式启用 SBR、任何显式 PS 和其他扩展都返回未知。
7. 允许经长度校验的音频预滚 `roll` 样本组：`sgpd` 版本 0，或版本 1 且固定条目长度为 2；`sbgp` 版本 0。未知分组或加密辅助信息 `senc / saiz / saio` 返回未知。预滚只用于确定配置是否属于支持的子集，不用于求时长或裁剪 PCM。
8. 样本 data_reference_index 必须为 1。若有 `dinf / dref`，须只有一个自包含 `url ` 数据引用，不接受远程资源地址。没有 `dinf` 的元数据也可被探测；成功不是完整文件合法性校验。

不要求文件品牌或 `mdat` 已存在，所以纯元数据夹具也可返回配置。函数不遍历不认识的盒子内部、不查找任意位置的 `esds` 字节签名，也不证明媒体采样表与媒体包一致。

## 读取与工作量上限

- 最多 256 个顶层盒子，每个头部读 8 字节；64 位扩展尺寸再读 8 字节。按声明的盒子长度跳过 `mdat` 和其他顶层负载，不读媒体数据。
- 先完成顶层扫描，拒绝重复 `moov` 或后续损坏头部，再读取一次 `moov` 负载。`moov` 总大小最多 4 MiB；超限时不读取负载。
- 总请求读取量最多 `4 MiB + 4 KiB`；最多 513 次有界切片读取。不分配按文件大小增长的缓冲，即使 `mdat` 超过 4 GiB。
- `moov` 中最多解析 4,096 个盒子，最大允许深度 8；实际仅沿固定格式路径深入，不递归扫描任意未知盒子。
- 描述符最多 64 个，单个长度最多 4,096 字节，`esds` 负载最多 4,096 字节，ASC 最多 64 字节。描述符长度最多四个续字节，遍历必须前进。
- 检查父子边界、短读、整数安全范围、32 / 64 位尺寸和最小头部长度。尺寸 0 只接受在顶层表示直到 EOF；嵌套尺寸 0 返回未知。

上述上限针对探测器自己的请求与解析工作量，不保证浏览器文件缓存、原生媒体解码或垃圾回收的内存行为。

## 内存边界与验证

该探测用于减少普通已识别 AAC 素材被一律预留 32 声道时产生的过度拒绝。即使容器结构校验成功，恶意或损坏文件也可能让原生解码器产生与声明不一致的输出或额外内部开销。

调用方仍须在解码前执行总素材、整段 PCM、多副本及输出阶段的预算检查；解码后核对实际声道数、采样率、完整长度 / 时长与预算，超出预留立即拒绝后续导出。检查发生在原生解码之后，不能撤销已经发生的原生分配。384 MiB 等估算阈值不能表述为浏览器 RSS 硬上限。

`tests/audio-probe.test.mjs` 全部使用原创合成盒子 / ASC，不含私人媒体。覆盖多声道与旧式声道字段冲突、单声道预留、显式采样率、AAC 扩展、视频轨隔离、多音轨、多描述、加密 / 未知格式回退、截断 / 畸形长度、超大 / 重复 `moov`、4 GiB 以上 `mdat` 跳读、盒子 / 描述符数量上限和有界读取。RFC 3640 的短配置示例还提供独立的标准对照。

运行：`node --test tests/audio-probe.test.mjs`。集成后的调用方测试还应验证未知值仍使用 32 声道、实际解码输出超过 `maxChannels` 时失败，以及取消 / 失败时清理原生上下文。

## 一手格式依据

实现基于格式字段说明独立编写，没有复制第三方解析器或执行下载脚本。

- [W3C AAC WebCodecs Registration](https://w3c.github.io/webcodecs/aac_codec_registration.html)：AAC-LC 的 `mp4a.40.2` 标识及 AudioSpecificConfig 的角色。该登记本身是非规范性说明；它引用 ISO/IEC 14496-3。
- [Apple：Atoms](https://developer.apple.com/documentation/quicktime-file-format/atoms)、[Sound sample descriptions](https://developer.apple.com/documentation/quicktime-file-format/sound_sample_descriptions)、[MPEG-4 elementary stream descriptor atom](https://developer.apple.com/documentation/quicktime-file-format/mpeg-4_elementary_sound_stream_descriptor_atom)：盒子尺寸、层级、版本布局及 `esds` 定位。
- [Apple：音频预滚分组类型](https://developer.apple.com/documentation/quicktime-file-format/sample-to-group_atom/grouping_type) 与 [MP4 Registration Authority：Sample Groups](https://mp4ra.org/registered-types/sample-groups)：`roll` 的含义。
- [RFC 3640 §3.3.5、§3.3.6、§4.1](https://www.rfc-editor.org/rfc/rfc3640.txt)：ASC 示例 `1388`（22.05 kHz 单声道）、`11B0`（48 kHz 5.1）及配置字节的位序 / 零填充。
- [ETSI TS 102 428，附录 A](https://www.etsi.org/deliver/etsi_TS/102400_102499/102428/01.02.01_60/ts_102428v010201p.pdf)：ES / DecoderConfig / DecoderSpecificInfo 的描述符字段。
- [ITU-R BS.1196-7，附录 2 的声道配置表](https://www.itu.int/dms_pubrec/itu-r/rec/bs/R-REC-BS.1196-7-201901-S%21%21PDF-E.pdf)：AAC 声道配置，包括配置 7 的八声道。
- [ISO/IEC 14496-3:2001/Amd.1:2003 的 SIST 标准预览](https://preview.sist.si/sist-preview/38148/851f9e776ec346c0baf947a87f84a531/ISO-IEC-14496-3-2001-Amd-1-2003.pdf)：ASC 与 SBR 缺席声明的位语法。
- [ETSI TS 126 401 §10–11](https://www.etsi.org/deliver/etsi_ts/126400_126499/126401/06.02.00_60/ts_126401v060200p.pdf)：隐式增强 AAC 信令与 PS 单声道核心到立体声输出的关系。
