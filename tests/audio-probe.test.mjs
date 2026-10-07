import test from 'node:test';
import assert from 'node:assert/strict';
import {probeMp4Audio} from '../src/audio-probe.js';

// All fixtures are original synthetic headers. They contain no encoded media.
const cat = (...parts) => Buffer.concat(parts.map(part => Buffer.from(part)));
const u32 = value => { const out = Buffer.alloc(4); out.writeUInt32BE(value); return out; };
function box(type, payload = Buffer.alloc(0), extended = false) {
  const header = Buffer.alloc(extended ? 16 : 8);
  header.writeUInt32BE(extended ? 1 : header.length + payload.length);
  header.write(type, 4, 4, 'latin1');
  if (extended) header.writeBigUInt64BE(BigInt(header.length + payload.length), 8);
  return cat(header, payload);
}
function bits(fields) {
  const text = fields.map(([value, width]) => value.toString(2).padStart(width, '0')).join('');
  const padded = text.padEnd(Math.ceil(text.length / 8) * 8, '0');
  return Buffer.from(padded.match(/.{8}/g).map(byte => parseInt(byte, 2)));
}
function asc({aot = 2, frequency = 3, explicit = 48000, config = 2, ga = 0, extra = []} = {}) {
  return bits([[aot, 5], [frequency, 4], ...(frequency === 15 ? [[explicit, 24]] : []), [config, 4], [ga, 3], ...extra]);
}
function descriptor(tag, data, wide = false) {
  let length = data.length, encoded = [length & 127];
  while ((length = Math.floor(length / 128))) encoded.unshift((length & 127) | 128);
  if (wide) while (encoded.length < 4) encoded.unshift(128);
  return cat([tag, ...encoded], data);
}
function esds({config = asc(), oti = 0x40, stream = 0x15, flags = 0, wide = false,
  dsi, decoderExtra = Buffer.alloc(0), esExtra = Buffer.alloc(0), sl = descriptor(6, [2]), raw, version = 0} = {}) {
  const decoder = descriptor(4, cat([oti, stream], Buffer.alloc(11),
    dsi ?? descriptor(5, config, wide), decoderExtra), wide);
  const es = descriptor(3, cat([0, 1, flags], decoder, sl, esExtra), wide);
  return box('esds', cat(u32(version), raw ?? es));
}
function entry({type = 'mp4a', version = 0, channels = 2, sampleRate = 48000,
  extension = esds(), reserved = 0, dataReference = 1, extended = false} = {}) {
  const fields = Buffer.alloc(28);
  fields[0] = reserved;
  fields.writeUInt16BE(dataReference, 6);
  fields.writeUInt16BE(version, 8);
  fields.writeUInt16BE(channels, 16);
  fields.writeUInt16BE(16, 18);
  fields.writeUInt32BE(sampleRate * 65536, 24);
  return box(type, cat(fields, extension), extended);
}
function track({handler = 'soun', entries = [entry()], entryCount = entries.length,
  stsdVersion = 0, stblExtra = Buffer.alloc(0), minfExtra = Buffer.alloc(0),
  mdiaExtra = Buffer.alloc(0), trackExtra = Buffer.alloc(0), omitStsd = false, handlerVersion = 0} = {}) {
  const hdlr = box('hdlr', cat(u32(handlerVersion), u32(0), Buffer.from(handler), Buffer.alloc(12)));
  const stsd = omitStsd ? Buffer.alloc(0) : box('stsd', cat(u32(stsdVersion), u32(entryCount), ...entries));
  return box('trak', cat(box('mdia', cat(hdlr, box('minf', cat(box('stbl', cat(stsd, stblExtra)), minfExtra)), mdiaExtra)), trackExtra));
}
const movie = (tracks = [track()], extra = Buffer.alloc(0), extended = false) => box('moov', cat(...tracks, extra), extended);
const probe = bytes => probeMp4Audio(new Blob([bytes]));
const dimensions = result => result && {channels: result.channels, maxChannels: result.maxChannels, sampleRate: result.sampleRate, codec: result.codec};
const expected = (channels = 2, sampleRate = 48000) => ({channels, maxChannels: Math.max(2, channels), sampleRate, codec: 'mp4a.40.2'});
const configured = options => movie([track({entries: [entry({extension: esds({config: asc(options)})})]})]);
function watched(bytes) {
  const file = new Blob([bytes]), reads = [];
  return {reads, size: file.size, arrayBuffer() { throw Error('Full source read'); },
    slice(start, end) { reads.push([start, end]); return file.slice(start, end); }};
}

test('ASC stereo identifies AAC-LC independently of type, filename and project assertions', async () => {
  const input = watched(movie());
  input.type = 'application/octet-stream'; input.channels = 32;
  const result = await probeMp4Audio(input);
  assert.deepEqual(dimensions(result), expected());
  assert.equal(result.evidence.source, 'mp4-esds-asc');
  assert.equal(result.evidence.audioObjectType, 2);
  assert.equal(result.evidence.channelConfiguration, 2);
  assert.equal(result.evidence.bytesRead, input.reads.reduce((sum, [a, b]) => sum + b - a, 0));
});

test('all supported ASC channel configurations override misleading legacy stereo entry', async () => {
  for (const [config, channels] of [[1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [7, 8]]) {
    const result = await probe(configured({config}));
    assert.deepEqual(dimensions(result), expected(channels));
    assert.equal(result.evidence.monoExpansionReserved, config === 1);
  }
  const result = await probe(movie([track({entries: [entry({channels: 32, sampleRate: 8000})]})]));
  assert.deepEqual(dimensions(result), expected());
});

test('RFC 3640 AAC examples decode to 22.05 kHz mono and 48 kHz 5.1 declarations', async () => {
  for (const [hex, channels, rate] of [['1388', 1, 22050], ['11b0', 6, 48000]]) {
    const result = await probe(movie([track({entries: [entry({extension: esds({config: Buffer.from(hex, 'hex')})})]})]));
    assert.deepEqual(dimensions(result), expected(channels, rate));
  }
});

test('frequency indexes and explicit 24-bit frequencies are validated', async () => {
  for (const [frequency, rate] of [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350].entries()) {
    assert.deepEqual(dimensions(await probe(configured({frequency}))), expected(2, rate));
  }
  assert.deepEqual(dimensions(await probe(configured({frequency: 15, explicit: 47000}))), expected(2, 47000));
  for (const frequency of [13, 14]) assert.equal(await probe(configured({frequency})), null);
  for (const explicit of [0, 1, 7349, 96001, 0xffffff]) assert.equal(await probe(configured({frequency: 15, explicit})), null);
});

test('disabled SBR sync extension is accepted; active, PS and truncated extensions fall back', async () => {
  const absent = [[0x2b7, 11], [5, 5], [0, 1]];
  const result = await probe(configured({extra: absent}));
  assert.deepEqual(dimensions(result), expected());
  assert.equal(result.evidence.sbrSignaling, 'explicitly-absent');
  for (const extra of [[[0x2b7, 11], [5, 5], [1, 1]], [[0x2b7, 11]], [[0x2b7, 11], [22, 5], [0, 1]],
    [[0, 16]], [...absent, [0x548, 11], [0, 1]], [...absent, [0x548, 11], [1, 1]], [...absent, [7, 3]], [...absent, [0, 16]]]) {
    assert.equal(await probe(configured({extra})), null);
  }
});

test('PCE, unsupported channel configurations, AOTs and GA variants stay unknown', async () => {
  for (const config of [0, 8, 9, 10, 11, 12, 13, 14, 15]) assert.equal(await probe(configured({config})), null);
  for (const aot of [0, 1, 3, 5, 17, 22, 29, 31]) assert.equal(await probe(configured({aot})), null);
  for (const ga of [1, 2, 4, 7]) assert.equal(await probe(configured({ga})), null);
});

test('only the single soun track is used, regardless of video/audio order', async () => {
  const video = track({handler: 'vide', entries: [entry({extension: esds({config: asc({config: 7})})})]});
  for (const tracks of [[video, track()], [track(), video]]) assert.deepEqual(dimensions(await probe(movie(tracks))), expected());
  assert.equal(await probe(movie([video])), null);
  assert.equal(await probe(movie([track(), track()])), null);
  assert.equal(await probe(movie([track(), track({entries: [entry({type: 'enca'})]})])), null);
});

test('missing, duplicate or misplaced critical boxes cannot supply guessed dimensions', async () => {
  for (const bytes of [movie([]), movie([box('trak')]), movie([track({omitStsd: true})]),
    movie([track({mdiaExtra: box('hdlr', Buffer.alloc(24))})]),
    movie([track({stblExtra: box('stsd', cat(u32(0), u32(0)))})]),
    movie([track({entries: [entry({extension: Buffer.alloc(0)})]})], esds()),
    movie([track({entries: [entry({extension: cat(esds(), esds())})]})]),
    movie([track({entries: [entry({extension: box('wave', esds())})]})]),
    movie([track({trackExtra: box('tref')})])]) assert.equal(await probe(bytes), null);
});

test('multiple sample descriptions and mismatched entry counts are rejected', async () => {
  for (const options of [{entries: []}, {entries: [entry(), entry()]}, {entryCount: 2}, {entryCount: 0},
    {entries: [entry(), entry()], entryCount: 1}]) assert.equal(await probe(movie([track(options)])), null);
});

test('protected audio, unrecognized extensions and unsupported versions fall back', async () => {
  for (const options of [{type: 'enca'}, {type: 'ac-3'}, {version: 1}, {version: 2}, {reserved: 1},
    {dataReference: 0}, {dataReference: 2}, {extension: cat(esds(), box('sinf'))}, {extension: cat(esds(), box('zzzz'))}]) {
    assert.equal(await probe(movie([track({entries: [entry(options)]})])), null);
  }
  for (const options of [{stsdVersion: 0x01000000}, {handlerVersion: 0x01000000},
    ...['senc', 'saiz', 'saio'].map(type => ({stblExtra: box(type)}))]) assert.equal(await probe(movie([track(options)])), null);
  assert.equal(await probe(movie([track({entries: [entry({extension: esds({version: 1})})]})])), null);
});

test('valid preroll groups are accepted but encryption/unknown/malformed groups are rejected', async () => {
  const sbgp = box('sbgp', cat(u32(0), Buffer.from('roll'), u32(1), u32(9000), u32(1)));
  for (const version of [0, 1]) {
    const sgpd = box('sgpd', cat(u32(version * 0x1000000), Buffer.from('roll'), ...(version ? [u32(2)] : []), u32(1), [255, 255]));
    assert.deepEqual(dimensions(await probe(movie([track({stblExtra: cat(sgpd, sbgp)})]))), expected());
  }
  for (const extra of [box('sgpd', cat(u32(0), Buffer.from('seig'), u32(0))),
    box('sbgp', cat(u32(0), Buffer.from('seig'), u32(0))),
    box('sgpd', cat(u32(0x01000000), Buffer.from('roll'), u32(4), u32(1), [255, 255])),
    box('sgpd', cat(u32(0), Buffer.from('roll'), u32(1))),
    box('sbgp', cat(u32(0), Buffer.from('roll'), u32(5000))),
    box('sbgp', cat(u32(0x01000000), Buffer.from('roll'), u32(0)))]) {
    assert.equal(await probe(movie([track({stblExtra: extra})])), null);
  }
});

test('local dref is accepted; external or ambiguous data references stay unknown', async () => {
  const dinf = ref => box('dinf', box('dref', cat(u32(0), u32(1), ref)));
  assert.deepEqual(dimensions(await probe(movie([track({minfExtra: dinf(box('url ', u32(1)))})]))), expected());
  for (const ref of [box('url ', cat(u32(0), Buffer.from('https://example.invalid/audio'))),
    box('urn ', u32(1)), cat(box('url ', u32(1)), box('url ', u32(1))), box('url ', cat(u32(1), [0]))]) {
    assert.equal(await probe(movie([track({minfExtra: dinf(ref)})])), null);
  }
});

test('esds accepts four-byte expandable descriptor lengths with leading continuation zeros', async () => {
  assert.deepEqual(dimensions(await probe(movie([track({entries: [entry({extension: esds({wide: true})})]})]))), expected());
});

test('descriptor tags, grammar, flags, lengths, duplicates and truncation are bounded', async () => {
  for (const options of [{oti: 0x67}, {stream: 0x11}, {stream: 0x14}, {stream: 0x17}, {flags: 0x20}, {flags: 0x40}, {flags: 0x80},
    {sl: descriptor(6, [0])}, {sl: Buffer.alloc(0)}, {config: Buffer.alloc(1)}, {config: Buffer.alloc(65)},
    {decoderExtra: descriptor(5, asc())}, {esExtra: descriptor(4, [])}, {dsi: descriptor(3, asc())},
    {raw: Buffer.from([3, 128, 128, 128, 128, 0])}, {raw: Buffer.from([3, 127, 0])},
    {raw: Buffer.from([3, 0x80, 0x80, 0x20, 0])}, {raw: Buffer.from([3, 0xff, 0xff, 0xff, 0x7f])},
    {raw: cat(...Array.from({length: 65}, () => descriptor(3, [])))}, {raw: cat(descriptor(3, []), descriptor(3, []))}]) {
    assert.equal(await probe(movie([track({entries: [entry({extension: esds(options)})]})])), null);
  }
});

test('ordinary and extended-size moov/sample entry headers are supported', async () => {
  const bytes = movie([track({entries: [entry({extended: true})]})], Buffer.alloc(0), true);
  assert.deepEqual(dimensions(await probe(bytes)), expected());
});

test('all truncations of a metadata fixture and malformed box sizes return null', async () => {
  const bytes = movie();
  for (let end = 0; end < bytes.length; end++) assert.equal(await probe(bytes.subarray(0, end)), null, `truncated at ${end}`);
  for (const size of [2, 7, 1, bytes.length + 1, 0xffffffff]) {
    const bad = Buffer.from(bytes); bad.writeUInt32BE(size);
    assert.equal(await probe(bad), null);
  }
  const badChild = Buffer.from(bytes); badChild.writeUInt32BE(0, 8);
  assert.equal(await probe(badChild), null);
  const huge = box('moov', Buffer.alloc(0), true); huge.writeBigUInt64BE(0x20000000000000n, 8);
  assert.equal(await probe(huge), null);
});

test('top-level size-zero extends to EOF; nested size-zero is not reinterpreted', async () => {
  const zeroMovie = movie(); zeroMovie.writeUInt32BE(0);
  assert.deepEqual(dimensions(await probe(zeroMovie)), expected());
  const mdat = box('mdat', Buffer.alloc(32)); mdat.writeUInt32BE(0);
  const input = watched(cat(movie(), mdat));
  assert.deepEqual(dimensions(await probeMp4Audio(input)), expected());
  assert.ok(input.reads.every(([start, end]) => start < movie().length + 8 && end <= movie().length + 8));
  assert.equal(await probe(cat(mdat, movie())), null);
});

test('duplicate movies, fragments, protected headers and trailing garbage cannot give early success', async () => {
  for (const bytes of [cat(movie(), movie()), cat(movie(), [0]), cat(movie(), box('moof')),
    cat(movie(), box('mfra')), cat(movie(), box('pssh')), movie([track()], box('mvex')),
    movie([track()], box('cmov')), movie([track()], box('pssh'))]) assert.equal(await probe(bytes), null);
});

test('large extended mdat is skipped by offset and only moov/headers are sliced', async () => {
  const tail = movie(), mdatSize = 5 * 1024 * 1024 * 1024;
  const header = box('mdat', Buffer.alloc(0), true); header.writeBigUInt64BE(BigInt(mdatSize), 8);
  const reads = [];
  const input = {size: mdatSize + tail.length, arrayBuffer() { throw Error('Full source read'); }, slice(start, end) {
    reads.push([start, end]);
    assert.ok((start >= 0 && end <= 16) || (start >= mdatSize && end <= this.size), 'must not read mdat payload');
    return new Blob([start < 16 ? header.subarray(start, end) : tail.subarray(start - mdatSize, end - mdatSize)]);
  }};
  const result = await probeMp4Audio(input);
  assert.deepEqual(dimensions(result), expected());
  assert.equal(reads.length, 4);
  assert.equal(result.evidence.bytesRead, 16 + tail.length);
});

test('moov before and after media use bounded reads with no mdat payload access', async () => {
  const ftyp = box('ftyp', cat(Buffer.from('isom'), u32(0), Buffer.from('mp42'))), moov = movie();
  const mdat = box('mdat', Buffer.alloc(1024 * 1024));
  for (const parts of [[ftyp, moov, mdat], [ftyp, mdat, moov]]) {
    const input = watched(cat(...parts)), start = parts.slice(0, parts.indexOf(mdat)).reduce((n, p) => n + p.length, 0);
    const result = await probeMp4Audio(input);
    assert.deepEqual(dimensions(result), expected());
    assert.ok(input.reads.every(([a, b]) => b <= start + 8 || a >= start + mdat.length));
    assert.equal(result.evidence.bytesRead, moov.length + 16);
    assert.equal(input.reads.length, 4);
  }
});

test('oversized moov is rejected before payload read; total top-level and nested work is bounded', async () => {
  let reads = 0;
  const header = box('moov'); header.writeUInt32BE(4 * 1024 * 1024 + 1);
  assert.equal(await probeMp4Audio({size: 4 * 1024 * 1024 + 1, slice(start, end) {
    reads++; assert.equal(start, 0); assert.equal(end, 8); return new Blob([header]);
  }}), null);
  assert.equal(reads, 1);
  const input = watched(cat(...Array.from({length: 256}, () => box('free')), movie()));
  assert.equal(await probeMp4Audio(input), null);
  assert.equal(input.reads.length, 256); assert.equal(input.reads.at(-1)[1], 2048);
  assert.equal(await probe(movie([track()], cat(...Array.from({length: 4096}, () => box('free'))))), null);
  let nested = esds();
  for (let i = 0; i < 1000; i++) nested = box('moov', nested);
  assert.equal(await probe(nested), null);
});

test('the exact moov and top-level limits fit within the documented combined read budget', async () => {
  const audio = track(), max = 4 * 1024 * 1024;
  const moov = movie([audio], box('free', Buffer.alloc(max - 16 - audio.length - 8)), true);
  assert.equal(moov.length, max);
  const input = watched(cat(...Array.from({length: 255}, () => box('free', Buffer.alloc(0), true)), moov));
  const result = await probeMp4Audio(input);
  assert.deepEqual(dimensions(result), expected());
  assert.equal(result.evidence.moovBytes, max);
  assert.equal(input.reads.length, 513);
  assert.equal(result.evidence.bytesRead, max + 255 * 16);
  assert.ok(result.evidence.bytesRead <= max + 4096);
  assert.ok(input.reads.every(([start, end]) => end - start <= max));
});

test('unreadable blobs, short slice reads and non-MP4 input safely return null', async () => {
  for (const value of [null, undefined, {}, {size: Infinity}, {size: Number.MAX_SAFE_INTEGER + 1, slice() {}},
    {size: 100, slice() { throw Error('read failed'); }}, {size: 100, slice() { return {arrayBuffer: async () => new ArrayBuffer(7)}; }},
    {size: 100, slice() { return {arrayBuffer: async () => { throw Error('file unavailable'); }}; }}]) {
    assert.equal(await probeMp4Audio(value), null);
  }
  assert.equal(await probe(Buffer.from('RIFFxxxxWAVEfmt ')), null);
  assert.equal(await probe(Buffer.from('not a media file')), null);
});
