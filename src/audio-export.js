import {probeMp4Audio} from './audio-probe.js?v=0.4.1';
// Original MIT-licensed, dependency-free offline audio mix and PCM16 WAV writer.
import {isMediaLayer, validateMediaLayer} from './media-core.js?v=0.4.1';

export const AUDIO_SAMPLE_RATE = 48000;
export const AUDIO_CHANNELS = 2;
export const MAX_AUDIO_MEMORY_BYTES = 384 * 1024 * 1024;
const MAX_SOURCE_CHANNELS = 32;
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES = 128 * 1024 * 1024;
const HEADROOM_BYTES = 16 * 1024 * 1024;
const DECODE_DURATION_TOLERANCE = .3;
const CHUNK_FRAMES = 32768;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const fail = (code, message, cause) => Object.assign(new Error(message, cause ? {cause} : undefined), {code});
const integer = (value, low, high, name) => {
  if (!Number.isSafeInteger(value) || value < low || value > high) throw new RangeError(`${name} is out of range`);
  return value;
};
const checkCancelled = cancelled => {
  if (cancelled()) throw new DOMException('已取消音频导出', 'AbortError');
};
const yieldToUI = () => new Promise(resolve => setTimeout(resolve, 0));

/** The first sample at or after a time. Correct only floating-point noise near
 * an integer, not a meaningful fraction of a sample. Intervals are [start,end). */
export function sampleAtOrAfter(time, sampleRate = AUDIO_SAMPLE_RATE) {
  if (!Number.isFinite(time) || time < 0) throw new RangeError('Time must be finite and nonnegative');
  integer(sampleRate, 1, 384000, 'sampleRate');
  const value = time * sampleRate;
  const result = Math.ceil(value - Number.EPSILON * Math.max(1, value) * 4);
  return integer(result, 0, Number.MAX_SAFE_INTEGER, 'sample position');
}

export function projectAudioFrames(duration) {
  if (!Number.isFinite(duration) || duration < .1 || duration > 300) throw new RangeError('合成时长须在 0.1–300 秒以内');
  return sampleAtOrAfter(duration);
}

/** Snapshot only the fields used by audio, so edits during async work cannot
 * change a running export. Muted/hidden media still count toward the model cap. */
export function planOfflineAudio(project) {
  const frames = projectAudioFrames(project?.duration);
  if (!Array.isArray(project.layers) || project.layers.length > 100) throw new RangeError('最多支持 100 个图层');
  const assets = project.assets ?? [], assetSizes = new Map();
  if (!Array.isArray(assets) || assets.length > 32) throw new RangeError('最多支持 32 个媒体素材');
  let assetBytes = 0;
  for (const asset of assets) {
    if (typeof asset?.id !== 'string' || !asset.id || assetSizes.has(asset.id)) throw new TypeError('无效或重复的素材 ID');
    integer(asset.size, 1, MAX_ASSET_BYTES, 'asset.size');
    assetSizes.set(asset.id, asset.size); assetBytes += asset.size;
  }
  if (assetBytes > MAX_TOTAL_ASSET_BYTES) throw fail('AUDIO_ASSET', '工程媒体总量超过 128 MiB 上限');
  const media = project.layers.filter(isMediaLayer);
  if (media.length > 32) throw new RangeError('最多支持 32 个媒体片段');
  const clips = [];
  for (const layer of media) {
    validateMediaLayer(layer);
    if (layer.end > project.duration) throw new RangeError('媒体片段超出合成时长');
    if (layer.muted || layer.visible === false || layer.volume === 0) continue;
    const {id, type, assetId, start, end, sourceIn, mediaDuration, volume, muted, visible, fadeIn, fadeOut, fadeOrigin} = layer;
    clips.push({id, type, assetId, start, end, sourceIn, mediaDuration, volume, muted, visible, fadeIn, fadeOut,
      ...(fadeOrigin ? {fadeOrigin: {...fadeOrigin}} : {})});
  }
  return {frames, duration: project.duration, clips, assetSizes: [...assetSizes], assetBytes};
}

function linearEvents(start, end, knots, valueAt) {
  const times = [...new Set(knots.filter(time => time > start && time < end))].sort((a, b) => a - b);
  return [{time: start, value: valueAt(start), kind: 'set'},
    ...[...times, end].map(time => ({time, value: valueAt(time), kind: 'ramp'}))];
}

/** Pure source/cut schedule. Source positions use the nearest 48 kHz sample of
 * the absolute source-to-composition offset, preserving split continuity. Two
 * separate linear gain factors reproduce gainAt's multiplying overlap exactly. */
export function scheduleAudioClip(layer, {frames, sourceFrames, sampleRate = AUDIO_SAMPLE_RATE}) {
  validateMediaLayer(layer);
  integer(frames, 1, Number.MAX_SAFE_INTEGER, 'frames');
  integer(sourceFrames, 1, Number.MAX_SAFE_INTEGER, 'sourceFrames');
  integer(sampleRate, 1, 384000, 'sampleRate');
  if (layer.muted || layer.visible === false || layer.volume === 0) return null;
  const startFrame = sampleAtOrAfter(layer.start, sampleRate);
  const sourceOffset = (layer.sourceIn - layer.start) * sampleRate;
  // Split arithmetic can put a mathematical half-sample just below its tie.
  // Apply the same tiny floating-point correction as composition boundaries.
  const sourceStartFrame = startFrame + Math.floor(sourceOffset + .5 + Number.EPSILON * Math.max(1, Math.abs(sourceOffset)) * 4);
  const endFrame = Math.min(frames, sampleAtOrAfter(layer.end, sampleRate), startFrame + sourceFrames - sourceStartFrame);
  if (endFrame <= startFrame || sourceStartFrame >= sourceFrames) return null;
  if (sourceStartFrame < 0) throw new RangeError('Negative source sample');
  const start = startFrame / sampleRate, end = endFrame / sampleRate;
  const origin = layer.fadeOrigin ?? {sourceIn: layer.sourceIn, duration: layer.end - layer.start};
  const originStart = layer.start + origin.sourceIn - layer.sourceIn;
  const originEnd = originStart + origin.duration;
  return {startFrame, endFrame, sourceStartFrame, frameCount: endFrame - startFrame,
    when: start, offset: sourceStartFrame / sampleRate, duration: (endFrame - startFrame) / sampleRate,
    incoming: linearEvents(start, end, [originStart, originStart + layer.fadeIn], time =>
      layer.volume * (layer.fadeIn === 0 ? 1 : clamp((time - originStart) / layer.fadeIn, 0, 1))),
    outgoing: linearEvents(start, end, [originEnd - layer.fadeOut, originEnd], time =>
      layer.fadeOut === 0 ? 1 : clamp((originEnd - time) / layer.fadeOut, 0, 1))};
}

/** Validate RIFF limits without allocating a potentially enormous buffer. */
export function wavLayout(frames, sampleRate = AUDIO_SAMPLE_RATE, channels = AUDIO_CHANNELS) {
  integer(frames, 0, Number.MAX_SAFE_INTEGER, 'frames');
  integer(channels, 1, MAX_SOURCE_CHANNELS, 'channels');
  integer(sampleRate, 1, 384000, 'sampleRate');
  const blockAlign = channels * 2, dataBytes = frames * blockAlign;
  if (!Number.isSafeInteger(dataBytes) || dataBytes > 0xffffffff - 36) throw new RangeError('PCM16 WAV exceeds the RIFF 32-bit size limit');
  return {frames, sampleRate, channels, blockAlign, byteRate: sampleRate * blockAlign, dataBytes, totalBytes: dataBytes + 44};
}

export function pcm16Sample(value) {
  if (Number.isNaN(value)) return 0;
  const clipped = clamp(value, -1, 1);
  return Math.round(clipped * (clipped < 0 ? 32768 : 32767));
}

function wavBuffer(layout) {
  if (layout.totalBytes > MAX_AUDIO_MEMORY_BYTES) throw new RangeError('WAV buffer exceeds the 384 MiB allocation limit');
  const buffer = new ArrayBuffer(layout.totalBytes), view = new DataView(buffer);
  const text = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, layout.totalBytes - 8, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, layout.channels, true); view.setUint32(24, layout.sampleRate, true);
  view.setUint32(28, layout.byteRate, true); view.setUint16(32, layout.blockAlign, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, layout.dataBytes, true);
  return {buffer, view};
}

function writePcm(view, channels, start, end) {
  let offset = 44 + start * channels.length * 2;
  for (let frame = start; frame < end; frame++) for (const channel of channels) {
    view.setInt16(offset, pcm16Sample(channel[frame]), true); offset += 2;
  }
}

/** Pure encoder for tests and small PCM arrays. Production encoding yields in
 * bounded chunks; neither encoder normalizes, dithers, or adds a limiter. */
export function encodePcm16Wav(channels, sampleRate = AUDIO_SAMPLE_RATE) {
  if (!Array.isArray(channels) || !channels.length || channels.some(channel => !(channel instanceof Float32Array) || channel.length !== channels[0].length)) throw new TypeError('Expected equal-length Float32Array channels');
  const layout = wavLayout(channels[0].length, sampleRate, channels.length), {buffer, view} = wavBuffer(layout);
  writePcm(view, channels, 0, layout.frames);
  return buffer;
}

/** Conservative phase peaks, not a browser RSS cap. Decode owns read/decoder
 * copies, and finishes/its AudioContext closes before rendering. Encode still
 * reserves ALL source PCM/acquired copies after explicit graph release: it does
 * not assume immediate collection of native PCM. Encoded Blobs stay counted in
 * every phase. pendingPcmBytes reserves two copies of the next whole-source
 * decode; an unknown channel count still uses 32. */
export function estimateAudioMemory({frames, encodedBytes = 0, maxEncodedBytes = 0, sources = [], pendingPcmBytes = 0}) {
  const output = wavLayout(frames);
  for (const [name, value] of Object.entries({encodedBytes, maxEncodedBytes, pendingPcmBytes})) integer(value, 0, Number.MAX_SAFE_INTEGER, name);
  let decodedBytes = 0, decodedPcmBytes = 0;
  for (const source of sources) {
    integer(source.frames, 1, Number.MAX_SAFE_INTEGER, 'source.frames');
    integer(source.channels, 1, MAX_SOURCE_CHANNELS, 'source.channels');
    integer(source.uses, 1, 32, 'source.uses');
    const pcmBytes = source.frames * source.channels * 4;
    decodedPcmBytes += pcmBytes;
    decodedBytes += pcmBytes * (1 + source.uses);
  }
  const encodedCopiesBytes = encodedBytes + maxEncodedBytes * 2;
  const renderCopiesBytes = frames * AUDIO_CHANNELS * 4 * 2;
  const wavCopiesBytes = output.totalBytes * 2;
  const outputCopiesBytes = renderCopiesBytes + wavCopiesBytes;
  const phases = {
    decode: encodedCopiesBytes + decodedPcmBytes * 2 + pendingPcmBytes * 2 + HEADROOM_BYTES,
    render: encodedBytes + decodedBytes + renderCopiesBytes + HEADROOM_BYTES,
    // No GC credit: reserve source buffers even after releasing their references.
    encode: encodedBytes + decodedBytes + renderCopiesBytes + wavCopiesBytes + HEADROOM_BYTES,
  };
  const peakStage = Object.keys(phases).reduce((peak, stage) => phases[stage] > phases[peak] ? stage : peak, 'decode');
  const estimatedBytes = phases[peakStage];
  if (!Number.isSafeInteger(estimatedBytes)) throw new RangeError('Unsafe memory estimate');
  return {estimatedBytes, peakStage, phases, encodedCopiesBytes, decodedPcmBytes, decodedBytes, sourceCarryoverBytes: decodedBytes,
    renderCopiesBytes, wavCopiesBytes, outputCopiesBytes, headroomBytes: HEADROOM_BYTES,
    limitBytes: MAX_AUDIO_MEMORY_BYTES, fits: estimatedBytes <= MAX_AUDIO_MEMORY_BYTES};
}

function requireBudget(input, reason = '') {
  const estimate = estimateAudioMemory(input);
  const stage = {decode: '整段素材解码', render: '离线混音', encode: 'WAV 编码'}[estimate.peakStage];
  if (!estimate.fits) throw fail('AUDIO_MEMORY_LIMIT', `离线音频在${stage}阶段预计需要 ${Math.ceil(estimate.estimatedBytes / 1048576)} MiB，超过 384 MiB 上限。${reason}请缩短合成、换用较短素材或预先导出 WAV；裁剪片段不会缩短整段素材的解码。`);
  return estimate;
}

/** Bounded header inspection for ordinary PCM/float RIFF WAV. Other containers
 * or fmt chunks outside the first 64 KiB receive the 32-channel reservation. */
export function inspectWavHeader(buffer, fileBytes) {
  const view = new DataView(buffer);
  const text = offset => String.fromCharCode(...new Uint8Array(buffer, offset, 4));
  if (view.byteLength < 12 || text(0) !== 'RIFF' || text(8) !== 'WAVE' || view.getUint32(4, true) + 8 > fileBytes) return null;
  let format = null;
  for (let offset = 12; offset + 8 <= view.byteLength;) {
    const kind = text(offset), size = view.getUint32(offset + 4, true), body = offset + 8;
    if (body + size > fileBytes) return null;
    if (kind === 'fmt ' && size >= 16 && body + 16 <= view.byteLength) {
      const tag = view.getUint16(body, true), channels = view.getUint16(body + 2, true), sampleRate = view.getUint32(body + 4, true);
      const align = view.getUint16(body + 12, true), bits = view.getUint16(body + 14, true);
      if (![1, 3].includes(tag) || channels < 1 || channels > MAX_SOURCE_CHANNELS || sampleRate < 1 || sampleRate > 384000 || ![8, 16, 24, 32, 64].includes(bits) || align !== channels * bits / 8) return null;
      format = {channels, sampleRate, align};
    }
    if (kind === 'data' && format && size % format.align === 0) return {channels: format.channels, sampleRate: format.sampleRate, duration: size / format.align / format.sampleRate};
    offset = body + size + (size % 2);
  }
  return null;
}

function automate(param, events) {
  param.value = 0;
  for (const event of events) {
    if (event.kind === 'set') param.setValueAtTime(event.value, event.time);
    else param.linearRampToValueAtTime(event.value, event.time);
  }
}

function releaseGraph(nodes, decoded, records) {
  for (const node of nodes) {
    try { node.disconnect(); } catch { /* Release the remaining nodes too. */ }
    if ('buffer' in node) { try { node.buffer = null; } catch { /* The memory estimate retains the native PCM reserve. */ } }
  }
  nodes.length = 0; decoded.clear(); records.clear();
}

/** Explicit dependency injection keeps tests isolated; no browser API is
 * monkeypatched. The public wrapper below uses the genuine native constructors. */
export function createOfflineAudioExporter({AudioContext, OfflineAudioContext, yieldControl = yieldToUI, probeAudioMetadata = probeMp4Audio}) {
  return async function exportAudio(project, {assetStore, cancelled = () => false, progress = () => {}} = {}) {
    if (typeof cancelled !== 'function' || typeof progress !== 'function') throw new TypeError('Expected export callbacks');
    checkCancelled(cancelled);
    const plan = planOfflineAudio(project), records = new Map(), decoded = new Map(), nodes = [];
    const assetSizes = new Map(plan.assetSizes);
    if (typeof assetStore?.retainedAssets === 'function') {
      const retained = assetStore.retainedAssets();
      if (!Array.isArray(retained)) throw new TypeError('Expected cached asset summaries');
      for (const asset of retained) {
        if (typeof asset?.id !== 'string') throw new TypeError('Invalid cached asset identity');
        integer(asset.size, 0, Number.MAX_SAFE_INTEGER, 'cached asset bytes');
        assetSizes.set(asset.id, Math.max(asset.size, assetSizes.get(asset.id) ?? 0));
      }
    }
    const memory = {frames: plan.frames, encodedBytes: [...assetSizes.values()].reduce((n,size)=>n+size,0), maxEncodedBytes: 0, sources: []};
    requireBudget(memory);
    if (typeof OfflineAudioContext !== 'function' || (plan.clips.length && typeof AudioContext !== 'function')) throw fail('AUDIO_UNSUPPORTED', '此浏览器不支持离线音频导出');
    if (plan.clips.length && typeof assetStore?.get !== 'function') throw new TypeError('assetStore.get is required');
    let decoder = null, offline = null, usedEncodedBytes = 0;
    try {
      progress(0, '检查离线音频与内存预算');
      for (const clip of plan.clips) {
        if (records.has(clip.assetId)) {
          const record = records.get(clip.assetId);
          if (Math.abs(record.duration - clip.mediaDuration) > .0001) throw fail('AUDIO_METADATA', '同一素材的片段时长描述不一致');
          record.uses++; continue;
        }
        checkCancelled(cancelled);
        const entry = await assetStore.get(clip.assetId);
        checkCancelled(cancelled);
        const blob = entry?.blob;
        if (!blob || !Number.isSafeInteger(blob.size) || blob.size < 1 || blob.size > MAX_ASSET_BYTES || typeof blob.arrayBuffer !== 'function' || typeof blob.slice !== 'function') throw fail('AUDIO_ASSET', '音频素材缺失或超过单文件 64 MiB 上限');
        if (!Number.isFinite(entry.meta?.duration) || Math.abs(entry.meta.duration - clip.mediaDuration) > .0001) throw fail('AUDIO_METADATA', '素材时长与片段描述不一致，请重新导入素材');
        // Include all current-project encoded assets, even muted video Blobs.
        // Never deduct a still-cached Blob when export releases its own reference.
        memory.encodedBytes += Math.max(0, blob.size - (assetSizes.get(clip.assetId) ?? 0));
        assetSizes.set(clip.assetId, Math.max(blob.size, assetSizes.get(clip.assetId) ?? 0));
        memory.maxEncodedBytes = Math.max(memory.maxEncodedBytes, blob.size);
        usedEncodedBytes += blob.size;
        if (usedEncodedBytes > MAX_TOTAL_ASSET_BYTES) throw fail('AUDIO_ASSET', '音频素材总量超过 128 MiB 上限');
        requireBudget(memory);
        const header = await blob.slice(0, 65536).arrayBuffer();
        checkCancelled(cancelled);
        const wav = inspectWavHeader(header, blob.size);
        if (wav && Math.abs(wav.duration - clip.mediaDuration) > DECODE_DURATION_TOLERANCE) throw fail('AUDIO_METADATA', 'WAV 时长与片段描述不一致，请重新导入素材');
        const mp4 = wav ? null : await probeAudioMetadata(blob);
        checkCancelled(cancelled);
        const channels = wav?.channels ?? mp4?.maxChannels ?? MAX_SOURCE_CHANNELS;
        integer(channels, 1, MAX_SOURCE_CHANNELS, 'probed channel reservation');
        records.set(clip.assetId, {blob, duration: clip.mediaDuration, uses: 1, channels, unknownChannels: !wav && !mp4,
          probeLabel: wav ? 'PCM WAV 头部' : mp4 ? 'MP4 AAC-LC 配置' : '未知格式'});
      }
      let completed = 0;
      for (const [id, record] of records) {
        checkCancelled(cancelled);
        const reserveFrames = sampleAtOrAfter(record.duration + DECODE_DURATION_TOLERANCE);
        requireBudget({...memory, pendingPcmBytes: reserveFrames * record.channels * 4}, record.unknownChannels ? '此素材的音频声道数未知，按 32 声道保守预留整段解码内存。' : `${record.probeLabel}按 ${record.channels} 声道预留整段解码内存。`);
        if (!decoder) {
          decoder = new AudioContext({sampleRate: AUDIO_SAMPLE_RATE});
          if (decoder.sampleRate !== AUDIO_SAMPLE_RATE) throw fail('AUDIO_SAMPLE_RATE', '浏览器无法以 48 kHz 解码音频');
        }
        progress(.05 + .45 * completed / records.size, `解码音频 ${completed + 1} / ${records.size}（取消需等待当前解码完成）`);
        checkCancelled(cancelled);
        let encoded = await record.blob.arrayBuffer();
        checkCancelled(cancelled);
        let buffer;
        try { buffer = await decoder.decodeAudioData(encoded); }
        catch (error) {
          checkCancelled(cancelled);
          throw fail('AUDIO_DECODE', '浏览器无法解码素材音轨，或视频没有音轨。请改用 WAV 音频；无声视频请将原声静音后重试。', error);
        }
        finally { encoded = null; }
        checkCancelled(cancelled);
        if (buffer.sampleRate !== AUDIO_SAMPLE_RATE || !Number.isSafeInteger(buffer.length) || buffer.length < 1 || !Number.isInteger(buffer.numberOfChannels) || buffer.numberOfChannels < 1 || buffer.numberOfChannels > MAX_SOURCE_CHANNELS) throw fail('AUDIO_DECODE', '解码后的音频格式超出支持范围');
        if (!record.unknownChannels && buffer.numberOfChannels > record.channels) throw fail('AUDIO_METADATA', '实际解码声道数超出文件头预算，已停止导出');
        if (Math.abs(buffer.length / AUDIO_SAMPLE_RATE - record.duration) > DECODE_DURATION_TOLERANCE) throw fail('AUDIO_METADATA', '解码音轨时长与素材描述不一致，请重新导入或提取 WAV 音轨');
        memory.sources.push({frames: buffer.length, channels: buffer.numberOfChannels, uses: record.uses});
        requireBudget(memory);
        decoded.set(id, buffer);
        completed++;
        await yieldControl();
      }
      if (decoder) { await decoder.close(); decoder = null; }
      checkCancelled(cancelled);
      requireBudget(memory);
      offline = new OfflineAudioContext(AUDIO_CHANNELS, plan.frames, AUDIO_SAMPLE_RATE);
      for (const clip of plan.clips) {
        const buffer = decoded.get(clip.assetId), schedule = scheduleAudioClip(clip, {frames: plan.frames, sourceFrames: buffer.length});
        if (!schedule) continue;
        const source = offline.createBufferSource(); nodes.push(source);
        const incoming = offline.createGain(); nodes.push(incoming);
        const outgoing = offline.createGain(); nodes.push(outgoing);
        source.buffer = buffer;
        incoming.channelCount = AUDIO_CHANNELS; incoming.channelCountMode = 'explicit'; incoming.channelInterpretation = 'speakers';
        automate(incoming.gain, schedule.incoming); automate(outgoing.gain, schedule.outgoing);
        source.connect(incoming); incoming.connect(outgoing); outgoing.connect(offline.destination);
        source.start(schedule.when, schedule.offset, schedule.duration);
        source.stop(schedule.endFrame / AUDIO_SAMPLE_RATE);
      }
      progress(.55, '离线混音中（取消需等待浏览器完成当前渲染）');
      checkCancelled(cancelled);
      const rendered = await offline.startRendering();
      // Rendering is settled before dropping graph references. Do this BEFORE
      // channel readback or WAV allocation, including if cancellation arrived.
      // Keep every source PCM byte charged in encode: native GC is not provable.
      releaseGraph(nodes, decoded, records);
      offline = null;
      checkCancelled(cancelled);
      if (rendered.length !== plan.frames || rendered.numberOfChannels !== AUDIO_CHANNELS || rendered.sampleRate !== AUDIO_SAMPLE_RATE) throw fail('AUDIO_RENDER', '浏览器返回了意外的离线音频格式');
      requireBudget(memory);
      progress(.78, '混音完成，已解除源音频引用，准备写入 WAV');
      checkCancelled(cancelled);
      const channels = [rendered.getChannelData(0), rendered.getChannelData(1)];
      const {buffer, view} = wavBuffer(wavLayout(plan.frames));
      for (let start = 0; start < plan.frames; start += CHUNK_FRAMES) {
        checkCancelled(cancelled);
        const end = Math.min(plan.frames, start + CHUNK_FRAMES);
        writePcm(view, channels, start, end);
        progress(.8 + .19 * end / plan.frames, '写入 48 kHz / 16-bit 立体声 WAV');
        await yieldControl();
      }
      checkCancelled(cancelled);
      const blob = new Blob([buffer], {type: 'audio/wav'});
      progress(1, 'WAV 导出完成');
      checkCancelled(cancelled);
      return blob;
    } finally {
      releaseGraph(nodes, decoded, records);
      offline = null;
      if (decoder) { try { await decoder.close(); } catch { /* Preserve the original failure/cancellation. */ } }
    }
  };
}

export function exportOfflineAudio(project, options) {
  return createOfflineAudioExporter({
    AudioContext: globalThis.AudioContext ?? globalThis.webkitAudioContext,
    OfflineAudioContext: globalThis.OfflineAudioContext ?? globalThis.webkitOfflineAudioContext,
  })(project, options);
}
