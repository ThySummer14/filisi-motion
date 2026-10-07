import test from 'node:test';
import assert from 'node:assert/strict';
import {gainAt, splitClip, trimClip, moveClip} from '../src/media-core.js';
import {AUDIO_SAMPLE_RATE, MAX_AUDIO_MEMORY_BYTES, sampleAtOrAfter, projectAudioFrames, planOfflineAudio,
  scheduleAudioClip, wavLayout, pcm16Sample, encodePcm16Wav, estimateAudioMemory, inspectWavHeader,
  createOfflineAudioExporter} from '../src/audio-export.js';

const rate = AUDIO_SAMPLE_RATE;
const near = (actual, expected, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const clip = (props = {}) => ({id: 'clip', type: 'audio', assetId: 'asset-a', start: 0, end: .1, sourceIn: 0,
  mediaDuration: .1, volume: 1, muted: false, visible: true, fadeIn: 0, fadeOut: 0, ...props});
const project = (layers = [clip()], duration = .1) => ({duration, layers});
const buffer = (frames = 4800, channels = 1, fn = () => .25) => {
  const data = Array.from({length: channels}, (_, channel) => Float32Array.from({length: frames}, (_, frame) => fn(frame, channel)));
  return {length: frames, numberOfChannels: channels, sampleRate: rate, getChannelData: channel => data[channel]};
};
function eventValue(events, time) {
  let previous = {time: 0, value: 0};
  for (const event of events) {
    if (time < event.time) return event.kind === 'ramp'
      ? previous.value + (event.value - previous.value) * (time - previous.time) / (event.time - previous.time) : previous.value;
    previous = event;
  }
  return previous.value;
}
const scheduleGain = (schedule, frame, sampleRate = rate) => !schedule || frame < schedule.startFrame || frame >= schedule.endFrame ? 0
  : eventValue(schedule.incoming, frame / sampleRate) * eventValue(schedule.outgoing, frame / sampleRate);

function mocks(options = {}) {
  const state = {opened: 0, closed: 0, decoded: 0, offline: [], reads: [], nodes: [], order: [], yields: 0};
  class Decoder {
    constructor(settings) { assert.equal(settings.sampleRate, rate); this.sampleRate = options.decoderRate ?? rate; state.opened++; state.order.push('open'); }
    async decodeAudioData(bytes) { state.decoded++; state.order.push('decode'); return options.decode ? options.decode(bytes, state.decoded) : buffer(); }
    async close() { state.closed++; state.order.push('close'); }
  }
  class Param {
    constructor() { this.events = []; this.value = 0; }
    setValueAtTime(value, time) { this.events.push({kind: 'set', value, time}); }
    linearRampToValueAtTime(value, time) { this.events.push({kind: 'ramp', value, time}); }
  }
  class Node {
    constructor(kind) { this.kind = kind; this.disconnected = false; if (kind === 'gain') this.gain = new Param(); else this.buffer = null; state.nodes.push(this); }
    connect(target) { this.target = target; }
    disconnect() { this.disconnected = true; }
    start(...args) { this.startArgs = args; }
    stop(time) { this.stopTime = time; }
  }
  class Offline {
    constructor(channels, frames, sampleRate) {
      assert.equal(channels, 2); assert.equal(sampleRate, rate);
      this.frames = frames; this.sources = []; this.destination = {}; state.offline.push(this); state.order.push('offline');
    }
    createBufferSource() { const source = new Node('source'); this.sources.push(source); return source; }
    createGain() { return new Node('gain'); }
    async startRendering() {
      state.order.push('render');
      if (options.render) return options.render(this);
      // A small independent scheduler interpreter, not a native-browser test.
      const output = buffer(this.frames, 2, () => 0);
      for (const source of this.sources) {
        const [when, offset, duration] = source.startArgs;
        const first = Math.round(when * rate), last = Math.min(this.frames, Math.round((when + duration) * rate), Math.round(source.stopTime * rate));
        for (let frame = first; frame < last; frame++) {
          const sourceFrame = frame - first + Math.round(offset * rate);
          const gain = eventValue(source.target.gain.events, frame / rate) * eventValue(source.target.target.gain.events, frame / rate);
          for (let channel = 0; channel < 2; channel++) output.getChannelData(channel)[frame] += source.buffer.getChannelData(Math.min(channel, source.buffer.numberOfChannels - 1))[sourceFrame] * gain;
        }
      }
      return output;
    }
  }
  const store = {async get(id) {
    state.reads.push(id);
    if (options.get) return options.get(id);
    return {blob: new Blob([new Uint8Array([1])]), meta: {duration: .1}, url: 'unused'};
  }};
  const run = createOfflineAudioExporter({AudioContext: Decoder, OfflineAudioContext: Offline,
    ...(options.probeAudioMetadata ? {probeAudioMetadata: options.probeAudioMetadata} : {}),
    yieldControl: async () => { state.yields++; await options.yieldControl?.(state.yields); }});
  return {state, store, run};
}
const assertReleased = state => {
  assert.equal(state.closed, state.opened);
  assert.ok(state.nodes.every(node => node.disconnected));
  assert.ok(state.nodes.filter(node => node.kind === 'source').every(node => node.buffer === null));
};
const waveSample = (view, frame, channel = 0) => view.getInt16(44 + frame * 4 + channel * 2, true);

test('fixed 48 kHz output count and exclusive boundaries resist floating-point noise', () => {
  assert.equal(projectAudioFrames(.1), 4800);
  assert.equal(projectAudioFrames(.1 + .2), 14400);
  assert.equal(projectAudioFrames(300), 14400000);
  assert.equal(sampleAtOrAfter(.1 + .2, 10), 3);
  assert.equal(sampleAtOrAfter(.30001, 10), 4);
  assert.equal(sampleAtOrAfter(1 / 60), 800);
  for (const duration of [0, .099, 300.001, Infinity, NaN, '1']) assert.throws(() => projectAudioFrames(duration));
  assert.throws(() => sampleAtOrAfter(-1)); assert.throws(() => sampleAtOrAfter(1, 0));
});

test('schedule quantizes cuts to half-open sample intervals and rounds absolute source offset', () => {
  const layer = clip({start: .11, end: .41, sourceIn: .2, mediaDuration: 2});
  const s = scheduleAudioClip(layer, {frames: 10, sourceFrames: 20, sampleRate: 10});
  assert.deepEqual([s.startFrame, s.endFrame, s.sourceStartFrame, s.frameCount], [2, 5, 3, 3]);
  assert.deepEqual([s.when, s.offset, s.duration], [.2, .3, .3]);
  assert.equal(scheduleGain(s, 1, 10), 0); assert.equal(scheduleGain(s, 2, 10), 1); assert.equal(scheduleGain(s, 5, 10), 0);
  const tail = scheduleAudioClip(layer, {frames: 10, sourceFrames: 4, sampleRate: 10});
  assert.equal(tail.endFrame, 3);
  assert.equal(scheduleAudioClip(layer, {frames: 10, sourceFrames: 3, sampleRate: 10}), null);
});

test('exact source samples and multiplying overlapping fades survive splits, trims and moves', () => {
  const original = clip({start: .05, end: .65, sourceIn: .1, mediaDuration: 1, volume: 1.7, fadeIn: .5, fadeOut: .4});
  const [left, right] = splitClip(original, .234567, 'right');
  const all = scheduleAudioClip(original, {frames: rate, sourceFrames: rate});
  const split = [left, right].map(layer => scheduleAudioClip(layer, {frames: rate, sourceFrames: rate}));
  for (let frame = 0; frame < rate; frame += 7) {
    const time = frame / rate;
    near(scheduleGain(all, frame), gainAt(original, time));
    near(split.reduce((sum, schedule) => sum + scheduleGain(schedule, frame), 0), gainAt(original, time));
    for (const s of split) if (frame >= s.startFrame && frame < s.endFrame) assert.equal(s.sourceStartFrame + frame - s.startFrame, all.sourceStartFrame + frame - all.startFrame);
  }
  const trimmed = trimClip(right, .3, .6), moved = moveClip(trimmed, .1, 1);
  const schedule = scheduleAudioClip(moved, {frames: rate, sourceFrames: rate});
  for (let frame = schedule.startFrame; frame < schedule.endFrame; frame += 3) near(scheduleGain(schedule, frame), gainAt(moved, frame / rate));
});

test('mute, hidden layers, zero volume, source exhaustion, and sub-sample clips emit no schedule', () => {
  for (const values of [{muted: true}, {visible: false}, {volume: 0}, {start: .010001, end: .010002}])
    assert.equal(scheduleAudioClip(clip(values), {frames: 4800, sourceFrames: 4800}), null);
  assert.throws(() => scheduleAudioClip(clip(), {frames: 0, sourceFrames: 4800}));
  assert.throws(() => scheduleAudioClip(clip({sourceIn: -1}), {frames: 4800, sourceFrames: 4800}));
});

test('project limits include hidden media and snapshots do not retain mutable fadeOrigin', () => {
  const layer = clip({fadeOrigin: {sourceIn: 0, duration: .1}}), p = project([layer, {type: 'rect'}]);
  const result = planOfflineAudio(p);
  layer.volume = 0; layer.fadeOrigin.duration = 99;
  assert.equal(result.clips[0].volume, 1); assert.equal(result.clips[0].fadeOrigin.duration, .1);
  assert.throws(() => planOfflineAudio(project(Array.from({length: 33}, () => clip({muted: true})))), /32/);
  assert.throws(() => planOfflineAudio(project([clip({end: .2, mediaDuration: .2})])), /时长/);
  assert.throws(() => planOfflineAudio(project([clip({fadeIn: NaN, muted: true})])));
  assert.throws(() => planOfflineAudio(project(Array.from({length: 101}, () => ({type: 'rect'})))));
});

test('PCM16 stereo WAV has exact RIFF/header sizes, little endian interleaving and hard clipping', () => {
  const left = new Float32Array([-2, -.5, 0, .5, 2, NaN]);
  const right = new Float32Array([1, .25, -.25, -1, Infinity, -Infinity]);
  const result = encodePcm16Wav([left, right]), view = new DataView(result);
  assert.equal(result.byteLength, 68); assert.equal(new TextDecoder().decode(result.slice(0, 4)), 'RIFF');
  assert.equal(new TextDecoder().decode(result.slice(8, 16)), 'WAVEfmt ');
  assert.deepEqual([view.getUint32(4, true), view.getUint32(16, true), view.getUint16(20, true)], [60, 16, 1]);
  assert.deepEqual([view.getUint16(22, true), view.getUint32(24, true), view.getUint32(28, true)], [2, 48000, 192000]);
  assert.deepEqual([view.getUint16(32, true), view.getUint16(34, true), view.getUint32(40, true)], [4, 16, 24]);
  assert.deepEqual(Array.from({length: 6}, (_, frame) => waveSample(view, frame)), [-32768, -16384, 0, 16384, 32767, 0]);
  assert.deepEqual(Array.from({length: 6}, (_, frame) => waveSample(view, frame, 1)), [32767, 8192, -8192, -32768, 32767, -32768]);
  assert.equal(view.getUint8(44), 0); assert.equal(view.getUint8(45), 128);
  assert.equal(pcm16Sample(-1), -32768); assert.equal(pcm16Sample(1), 32767);
});

test('WAV rejects invalid channels and RIFF overflow before allocation', () => {
  const maxFrames = Math.floor((0xffffffff - 36) / 4);
  assert.ok(wavLayout(maxFrames).totalBytes <= 0xffffffff + 8);
  assert.throws(() => wavLayout(maxFrames + 1), /RIFF/);
  for (const value of [-1, 1.5, NaN, Number.MAX_SAFE_INTEGER]) assert.throws(() => wavLayout(value));
  assert.throws(() => wavLayout(1, rate, 0)); assert.throws(() => wavLayout(1, rate, 33));
  assert.throws(() => encodePcm16Wav([]));
  assert.throws(() => encodePcm16Wav([new Float32Array(2), new Float32Array(1)]));
  assert.throws(() => encodePcm16Wav([[1, 2]]));
  assert.equal(encodePcm16Wav([new Float32Array()]).byteLength, 44);
});

test('memory estimate uses conservative decode/render/encode peaks and retains PCM carryover after release', () => {
  const base = estimateAudioMemory({frames: 4800});
  assert.equal(base.estimatedBytes, 4800 * 24 + 88 + 16 * 1024 * 1024);
  const estimate = estimateAudioMemory({frames: 4800, encodedBytes: 1000, maxEncodedBytes: 600,
    sources: [{frames: 4800, channels: 2, uses: 3}], pendingPcmBytes: 512});
  assert.equal(estimate.encodedCopiesBytes, 2200);
  assert.equal(estimate.decodedBytes, 4800 * 2 * 4 * 4);
  assert.equal(estimate.decodedPcmBytes, 4800 * 2 * 4);
  assert.equal(estimate.sourceCarryoverBytes, estimate.decodedBytes);
  assert.equal(estimate.phases.decode, 2200 + estimate.decodedPcmBytes * 2 + 1024 + estimate.headroomBytes);
  assert.equal(estimate.phases.render, 1000 + estimate.decodedBytes + 4800 * 16 + estimate.headroomBytes);
  assert.equal(estimate.phases.encode, base.estimatedBytes + 1000 + estimate.decodedBytes);
  assert.equal(estimate.estimatedBytes, Math.max(...Object.values(estimate.phases)));
  assert.equal(estimate.peakStage, 'encode');
  assert.equal(estimate.limitBytes, 384 * 1024 * 1024);
  assert.equal(estimate.fits, true);
  assert.equal(estimateAudioMemory({frames: 4800, pendingPcmBytes: MAX_AUDIO_MEMORY_BYTES}).fits, false);
  assert.throws(() => estimateAudioMemory({frames: 4800, sources: [{frames: 1, channels: 33, uses: 1}]}));
});

test('169-second stereo PCM WAV fits all phase peaks without assuming native PCM collection', () => {
  const frames = 169 * rate, encodedBytes = wavLayout(frames).totalBytes, pcmBytes = frames * 2 * 4;
  const estimate = estimateAudioMemory({frames, encodedBytes, maxEncodedBytes: encodedBytes,
    sources: [{frames, channels: 2, uses: 1}]});
  assert.equal(estimate.phases.decode, 3 * encodedBytes + 2 * pcmBytes + estimate.headroomBytes);
  assert.equal(estimate.phases.render, encodedBytes + 4 * pcmBytes + estimate.headroomBytes);
  assert.equal(estimate.phases.encode, 3 * encodedBytes + 4 * pcmBytes + estimate.headroomBytes);
  assert.equal(estimate.sourceCarryoverBytes, 2 * pcmBytes);
  assert.equal(estimate.fits, true); assert.equal(estimate.peakStage, 'encode');
  assert.equal(Math.ceil(estimate.estimatedBytes / 1048576), 357);
  assert.ok(estimate.estimatedBytes + 2 * encodedBytes > MAX_AUDIO_MEMORY_BYTES, 'the old simultaneous-allocation estimate rejected this case');
  const predecode = estimateAudioMemory({frames, encodedBytes, maxEncodedBytes: encodedBytes,
    pendingPcmBytes: sampleAtOrAfter(169.3) * 2 * 4});
  assert.equal(predecode.fits, true);
  const unknown = estimateAudioMemory({frames, encodedBytes, maxEncodedBytes: encodedBytes,
    pendingPcmBytes: sampleAtOrAfter(169.3) * 32 * 4});
  assert.equal(unknown.fits, false); assert.equal(unknown.peakStage, 'decode');
  const cachedVideo = extra => estimateAudioMemory({frames, encodedBytes: encodedBytes + extra, maxEncodedBytes: encodedBytes,
    sources: [{frames, channels: 2, uses: 1}]});
  assert.equal(cachedVideo(20 * 1048576).fits, true);
  assert.equal(cachedVideo(28 * 1048576).fits, false, 'still-cached muted video is not free');
  assert.equal(estimateAudioMemory({frames, encodedBytes, maxEncodedBytes: encodedBytes,
    sources: [{frames, channels: 2, uses: 16}]}).fits, false, 'multiple acquired-source copies remain charged');
});

test('bounded WAV probe extracts ordinary PCM dimensions, handles odd chunks, rejects malformed headers', () => {
  const wav = encodePcm16Wav([new Float32Array(4800), new Float32Array(4800)]);
  assert.deepEqual(inspectWavHeader(wav.slice(0, 100), wav.byteLength), {channels: 2, sampleRate: rate, duration: .1});
  assert.equal(inspectWavHeader(new ArrayBuffer(8), 8), null);
  assert.equal(inspectWavHeader(wav, 40), null);
  const padded = new Uint8Array(wav.byteLength + 10);
  padded.set(new Uint8Array(wav, 0, 12)); padded.set(new TextEncoder().encode('JUNK'), 12);
  new DataView(padded.buffer).setUint32(16, 1, true); padded[20] = 7;
  padded.set(new Uint8Array(wav, 12), 22); new DataView(padded.buffer).setUint32(4, padded.length - 8, true);
  assert.equal(inspectWavHeader(padded.buffer, padded.length).channels, 2);
});

test('runtime decodes one asset once for video and split audio, returns exact stereo samples and closes decoder first', async () => {
  const fixture = buffer(4800, 2, (frame, channel) => channel ? -.25 : frame / 4800);
  const {state, store, run} = mocks({decode: () => fixture});
  const left = clip({type: 'video', start: .02, end: .04, sourceIn: .01});
  const right = clip({id: 'right', start: .04, end: .08, sourceIn: .03});
  const values = [];
  const result = await run(project([left, right]), {assetStore: store, progress: value => values.push(value)});
  assert.equal(result.type, 'audio/wav'); assert.equal(result.size, 44 + 4800 * 4);
  assert.equal(state.opened, 1); assert.equal(state.decoded, 1); assert.deepEqual(state.reads, ['asset-a']);
  assert.ok(state.order.indexOf('close') < state.order.indexOf('offline'));
  const view = new DataView(await result.arrayBuffer());
  for (let frame = 0; frame < 4800; frame++) {
    const audible = frame >= 960 && frame < 3840;
    assert.equal(waveSample(view, frame), audible ? pcm16Sample(fixture.getChannelData(0)[frame - 480]) : 0);
    assert.equal(waveSample(view, frame, 1), audible ? -8192 : 0);
  }
  assert.equal(values.at(-1), 1); assert.ok(values.every((value, i) => i === 0 || value >= values[i - 1]));
  assertReleased(state);
});

test('runtime mixes mono into both channels with exact fades and hard clips summed peaks', async () => {
  const {state, store, run} = mocks({decode: () => buffer(4800, 1, () => 1)});
  const layer = clip({volume: 2, fadeIn: .08, fadeOut: .08});
  const result = await run(project([layer, {...layer, id: 'duplicate'}]), {assetStore: store});
  const view = new DataView(await result.arrayBuffer());
  for (let frame = 0; frame < 4800; frame += 13) {
    const expected = pcm16Sample(Math.fround(gainAt(layer, frame / rate) * 2));
    assert.equal(waveSample(view, frame), expected); assert.equal(waveSample(view, frame, 1), expected);
  }
  assert.equal(waveSample(view, 2400), 32767);
  assertReleased(state);
});

test('silent projects skip all assets and decoder and export exact-duration silence', async () => {
  const {state, run} = mocks();
  const result = await run(project([clip({muted: true}), clip({visible: false}), clip({volume: 0}), {type: 'rect'}]));
  const data = new Uint8Array(await result.arrayBuffer());
  assert.ok(data.subarray(44).every(value => value === 0)); assert.equal(data.length, 19244);
  assert.equal(state.opened, 0); assert.equal(state.decoded, 0); assert.deepEqual(state.reads, []);
  assertReleased(state);
});

test('running export snapshots media fields before awaiting the asset store', async () => {
  const layer = clip({volume: .5});
  const {run, store} = mocks({get: () => { layer.volume = 2; layer.start = .05; return {blob: new Blob(['a']), meta: {duration: .1}}; }});
  const result = await run(project([layer]), {assetStore: store});
  assert.equal(waveSample(new DataView(await result.arrayBuffer()), 0), 4096);
});

test('unknown long source is rejected before decode with demand, limit and reason', async () => {
  let fullReads = 0;
  const raw = new Blob(['compressed']);
  const blob = {size: raw.size, slice: (...args) => raw.slice(...args), arrayBuffer: () => { fullReads++; return raw.arrayBuffer(); }};
  const {state, store, run} = mocks({get: () => ({blob, meta: {duration: 169}})});
  await assert.rejects(run(project([clip({mediaDuration: 169})]), {assetStore: store}), error => {
    assert.equal(error.code, 'AUDIO_MEMORY_LIMIT'); assert.match(error.message, /\d+ MiB/);
    assert.match(error.message, /384 MiB/); assert.match(error.message, /32 声道/); assert.match(error.message, /整段素材解码阶段/); return true;
  });
  assert.equal(state.opened, 0); assert.equal(fullReads, 0);
});

test('full 169-second known-stereo export releases sources before readback and emits 8,112,000 WAV frames', async () => {
  const frames = 169 * rate, layout = wavLayout(frames);
  // Synthetic dimension-only encoded source: no private media, no large input file.
  const header = encodePcm16Wav([new Float32Array(1), new Float32Array(1)]).slice(0, 44);
  const headerView = new DataView(header);
  headerView.setUint32(4, layout.totalBytes - 8, true); headerView.setUint32(40, layout.dataBytes, true);
  const blob = {size: layout.totalBytes, slice: () => new Blob([header]), arrayBuffer: async () => header.slice(0)};
  let runtime, readbacks = 0;
  const source = {length: frames, numberOfChannels: 2, sampleRate: rate};
  runtime = mocks({get: () => ({blob, meta: {duration: 169}}), decode: () => source,
    render: () => ({length: frames, numberOfChannels: 2, sampleRate: rate, getChannelData() {
      assertReleased(runtime.state); readbacks++; return new Float32Array(frames);
    }})});
  const p = project([clip({end: 169, mediaDuration: 169})], 169);
  p.assets = [{id: 'asset-a', size: layout.totalBytes}, {id: 'muted-video', size: 20 * 1048576}];
  const result = await runtime.run(p, {assetStore: runtime.store});
  assert.equal(result.size, 32448044); assert.equal(readbacks, 2);
  assert.equal(runtime.state.decoded, 1); assert.deepEqual(runtime.state.reads, ['asset-a']);
  assert.equal(runtime.state.offline[0].frames, 8112000);
  const outputHeader = new DataView(await result.slice(0, 44).arrayBuffer());
  assert.equal(outputHeader.getUint32(40, true), 8112000 * 4);
  assertReleased(runtime.state);
});

test('current-project cached assets are budgeted even if muted or not read by this export', async () => {
  const {state, run} = mocks();
  const p = project([], 300);
  p.assets = [{id: 'cached-video', size: 64 * 1048576}];
  await assert.rejects(run(p), error => error.code === 'AUDIO_MEMORY_LIMIT' && /WAV 编码阶段/.test(error.message));
  assert.deepEqual(state.reads, []); assert.equal(state.offline.length, 0);
});

test('known WAV header uses real channel count while unsupported codecs are never silently skipped', async () => {
  const wav = encodePcm16Wav([new Float32Array(4800)]);
  const {state, store, run} = mocks({get: () => ({blob: new Blob([wav]), meta: {duration: .1}})});
  await run(project(), {assetStore: store}); assert.equal(state.decoded, 1); assertReleased(state);
  const bad = mocks({decode: () => { throw new DOMException('No audio track', 'EncodingError'); }});
  await assert.rejects(bad.run(project([clip({type: 'video'})]), {assetStore: bad.store}), error => error.code === 'AUDIO_DECODE' && /原声静音/.test(error.message));
  assertReleased(bad.state); assert.equal(bad.state.offline.length, 0);
});

test('decode dimensions, source duration and missing/oversized assets fail explicitly', async () => {
  for (const decoded of [buffer(4800, 1), buffer(25000, 1), {...buffer(), numberOfChannels: 33}]) {
    if (decoded.length === 4800 && decoded.numberOfChannels === 1) decoded.sampleRate = 44100;
    const {state, store, run} = mocks({decode: () => decoded});
    await assert.rejects(run(project(), {assetStore: store})); assertReleased(state); assert.equal(state.offline.length, 0);
  }
  for (const entry of [{}, {blob: new Blob(['x']), meta: {duration: 2}}, {blob: {size: 64 * 1024 * 1024 + 1}, meta: {duration: .1}}]) {
    const {state, store, run} = mocks({get: () => entry});
    await assert.rejects(run(project(), {assetStore: store})); assert.equal(state.opened, 0);
  }
});

test('decoded source tail shorter within codec tolerance becomes silence without extending output', async () => {
  const {state, store, run} = mocks({decode: () => buffer(4000)});
  const result = await run(project(), {assetStore: store}), view = new DataView(await result.arrayBuffer());
  assert.equal(waveSample(view, 3999), 8192); assert.equal(waveSample(view, 4000), 0); assert.equal(result.size, 19244);
  assertReleased(state);
});

test('cancellation before start or after asset read creates no decoder', async () => {
  const early = mocks();
  await assert.rejects(early.run(project(), {assetStore: early.store, cancelled: () => true}), {name: 'AbortError'});
  assert.deepEqual(early.state.reads, []); assert.equal(early.state.opened, 0);
  let cancelled = false;
  const late = mocks({get: () => { cancelled = true; return {blob: new Blob(['x']), meta: {duration: .1}}; }});
  await assert.rejects(late.run(project(), {assetStore: late.store, cancelled: () => cancelled}), {name: 'AbortError'});
  assert.equal(late.state.opened, 0);
});

test('cancellation waits for the in-flight native decode then closes and discards result', async () => {
  let release, began, cancelled = false, settled = false;
  const started = new Promise(resolve => began = resolve);
  const {state, store, run} = mocks({decode: () => new Promise(resolve => { release = resolve; began(); })});
  const work = run(project(), {assetStore: store, cancelled: () => cancelled}).finally(() => { settled = true; });
  await started; cancelled = true; await Promise.resolve(); assert.equal(settled, false); assert.equal(state.closed, 0);
  release(buffer()); await assert.rejects(work, {name: 'AbortError'});
  assertReleased(state); assert.equal(state.offline.length, 0);
});

test('cancellation during render waits for completion and disconnects every scheduled node', async () => {
  let release, began, cancelled = false, settled = false;
  const started = new Promise(resolve => began = resolve);
  const {state, store, run} = mocks({render: () => new Promise(resolve => { release = resolve; began(); })});
  const work = run(project(), {assetStore: store, cancelled: () => cancelled}).finally(() => { settled = true; });
  await started; cancelled = true; await Promise.resolve(); assert.equal(settled, false);
  release(buffer(4800, 2)); await assert.rejects(work, {name: 'AbortError'});
  assertReleased(state); assert.equal(state.nodes.length, 3);
});

test('chunked WAV encoding observes cancellation, releases nodes, and emits no success', async () => {
  let cancelled = false;
  const {state, store, run} = mocks({yieldControl: count => { if (count === 2) { assertReleased(state); cancelled = true; } }});
  const values = [];
  await assert.rejects(run(project(), {assetStore: store, cancelled: () => cancelled, progress: value => values.push(value)}), {name: 'AbortError'});
  assertReleased(state); assert.ok(!values.includes(1));
});

test('cancelling immediately after graph release prevents both channel readback and WAV allocation', async () => {
  let cancelled = false, readbacks = 0;
  const {state, store, run} = mocks({render: () => ({length: 4800, numberOfChannels: 2, sampleRate: rate,
    getChannelData() { readbacks++; throw Error('Readback must not occur after cancellation'); }})});
  await assert.rejects(run(project(), {assetStore: store, cancelled: () => cancelled, progress: value => {
    if (value === .78) { assertReleased(state); cancelled = true; }
  }}), {name: 'AbortError'});
  assert.equal(readbacks, 0); assertReleased(state);
});

test('decode, render, progress, and wrong-rate failures clean up and allow another export', async () => {
  const failure = new Error('test failure');
  for (const options of [{decode: () => { throw failure; }}, {render: () => { throw failure; }}, {decoderRate: 44100}]) {
    const {state, store, run} = mocks(options);
    await assert.rejects(run(project(), {assetStore: store})); assertReleased(state);
  }
  const {state, store, run} = mocks();
  await assert.rejects(run(project(), {assetStore: store, progress: value => { if (value === .55) throw failure; }}), /test failure/);
  assertReleased(state);
  const result = await run(project(), {assetStore: store}); assert.equal(result.size, 19244); assertReleased(state);
});

test('second-source failure closes the shared decoder and skips offline render', async () => {
  const {state, store, run} = mocks({decode: (_, count) => { if (count === 2) throw Error('second failed'); return buffer(); }});
  await assert.rejects(run(project([clip(), clip({id: 'b', assetId: 'asset-b'})]), {assetStore: store}), {code: 'AUDIO_DECODE'});
  assert.equal(state.opened, 1); assert.equal(state.decoded, 2); assert.equal(state.offline.length, 0); assertReleased(state);
});

test('API capability and callback validation fail before reading private assets', async () => {
  const run = createOfflineAudioExporter({});
  let reads = 0;
  await assert.rejects(run(project(), {assetStore: {get() { reads++; }}}), {code: 'AUDIO_UNSUPPORTED'});
  await assert.rejects(run(project(), {cancelled: true}), TypeError);
  assert.equal(reads, 0);
});

test('recognized AAC budget uses bounded probe reservation and rejects decoder disagreement',async()=>{
 const probeAudioMetadata=async()=>({channels:2,maxChannels:2,sampleRate:48000,codec:'mp4a.40.2'});
 const ok=mocks({probeAudioMetadata,decode:()=>buffer(4800,2)});await ok.run(project(),{assetStore:ok.store});assert.equal(ok.state.decoded,1);assertReleased(ok.state);
 const bad=mocks({probeAudioMetadata,decode:()=>buffer(4800,6)});await assert.rejects(bad.run(project(),{assetStore:bad.store}),e=>e.code==='AUDIO_METADATA'&&/声道/.test(e.message));assertReleased(bad.state);
});
test('retained non-project assets remain in the offline budget rather than disappearing',async()=>{
 const runtime=mocks();runtime.store.retainedAssets=()=>[{id:'older-unsaved',size:MAX_AUDIO_MEMORY_BYTES}];
 await assert.rejects(runtime.run(project(),{assetStore:runtime.store}),e=>e.code==='AUDIO_MEMORY_LIMIT');assert.equal(runtime.state.opened,0);assert.equal(runtime.state.reads.length,0);
});
