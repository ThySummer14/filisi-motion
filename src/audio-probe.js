// Original MIT-licensed, dependency-free metadata probe. Never reads media data.
const MAX_MOOV_BYTES = 4 * 1024 * 1024;
const MAX_TOP_LEVEL_BOXES = 256;
const MAX_BOXES = 4096;
const MAX_DEPTH = 8;
const MAX_DESCRIPTOR_BYTES = 4096;
const MAX_DESCRIPTORS = 64;
const MAX_ASC_BYTES = 64;
const FREQUENCIES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
const CHANNELS = [0, 1, 2, 3, 4, 5, 6, 8];
const reject = () => { throw new RangeError('Unknown or unsupported MP4 audio metadata'); };
const requireValue = value => { if (!value) reject(); };
const fourcc = (view, offset) => String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + offset, 4));

function boxLength(view, remaining, topLevel) {
  const shortSize = view.getUint32(0);
  const header = shortSize === 1 ? 16 : 8;
  let size = shortSize;
  if (shortSize === 1) {
    requireValue(view.byteLength >= 16);
    size = view.getUint32(8) * 0x100000000 + view.getUint32(12);
  } else if (shortSize === 0) {
    requireValue(topLevel);
    size = remaining;
  }
  requireValue(Number.isSafeInteger(size) && size >= header && size <= remaining);
  return {size, header};
}

class MovieReader {
  constructor(buffer) {
    this.view = new DataView(buffer);
    this.boxes = 0;
    this.descriptors = 0;
  }
  need(start, length, end) {
    requireValue(start >= 0 && length >= 0 && start + length <= end && end <= this.view.byteLength);
  }
  children(start, end, depth) {
    requireValue(depth <= MAX_DEPTH);
    const result = [];
    while (start < end) {
      requireValue(++this.boxes <= MAX_BOXES);
      this.need(start, 8, end);
      const headerView = new DataView(this.view.buffer, start, Math.min(16, end - start));
      const {size, header} = boxLength(headerView, end - start, false);
      result.push({type: fourcc(this.view, start + 4), start, body: start + header, end: start + size, depth});
      start += size;
    }
    return result;
  }
  inside(box, skip = 0) {
    this.need(box.body, skip, box.end);
    return this.children(box.body + skip, box.end, box.depth + 1);
  }
  only(boxes, type) {
    const matches = boxes.filter(box => box.type === type);
    requireValue(matches.length === 1);
    return matches[0];
  }
  fullBox(box, minimum) {
    this.need(box.body, minimum, box.end);
    requireValue(this.view.getUint32(box.body) === 0); // Supported version and flags.
  }
  descriptorList(start, end) {
    const result = [];
    while (start < end) {
      requireValue(++this.descriptors <= MAX_DESCRIPTORS);
      this.need(start, 2, end);
      const tag = this.view.getUint8(start++);
      let length = 0, done = false;
      for (let i = 0; i < 4; i++) {
        this.need(start, 1, end);
        const byte = this.view.getUint8(start++);
        length = length * 128 + (byte & 127);
        if (!(byte & 128)) { done = true; break; }
      }
      requireValue(done && length <= MAX_DESCRIPTOR_BYTES);
      this.need(start, length, end);
      result.push({tag, body: start, end: start + length});
      start += length;
    }
    return result;
  }
  ascFromEsds(box) {
    this.fullBox(box, 4);
    requireValue(box.end - box.body <= MAX_DESCRIPTOR_BYTES);
    const roots = this.descriptorList(box.body + 4, box.end);
    requireValue(roots.length === 1 && roots[0].tag === 3);
    const es = roots[0];
    this.need(es.body, 3, es.end);
    // URL, dependency and OCR references are outside this local standalone subset.
    requireValue((this.view.getUint8(es.body + 2) & 0xe0) === 0);
    const parts = this.descriptorList(es.body + 3, es.end);
    requireValue(parts.length === 2 && parts[0].tag === 4 && parts[1].tag === 6);
    const [decoder, sl] = parts;
    requireValue(sl.end - sl.body === 1 && this.view.getUint8(sl.body) === 2);
    this.need(decoder.body, 13, decoder.end);
    requireValue(this.view.getUint8(decoder.body) === 0x40 && this.view.getUint8(decoder.body + 1) === 0x15);
    const configs = this.descriptorList(decoder.body + 13, decoder.end);
    requireValue(configs.length === 1 && configs[0].tag === 5);
    const config = configs[0], length = config.end - config.body;
    requireValue(length >= 2 && length <= MAX_ASC_BYTES);
    return parseAsc(new Uint8Array(this.view.buffer, config.body, length));
  }
  audioEntry(mdiaChildren) {
    const minf = this.only(mdiaChildren, 'minf');
    const minfChildren = this.inside(minf);
    const stbl = this.only(minfChildren, 'stbl');
    const stblChildren = this.inside(stbl);
    // Reject encryption/unknown grouping, but allow AAC preroll descriptions.
    requireValue(!stblChildren.some(box => ['senc', 'saiz', 'saio'].includes(box.type)));
    for (const group of stblChildren.filter(box => ['sgpd', 'sbgp'].includes(box.type))) {
      this.need(group.body, 12, group.end);
      requireValue(fourcc(this.view, group.body + 4) === 'roll');
      const versionFlags = this.view.getUint32(group.body);
      let prefix = 12, recordBytes = 8;
      if (group.type === 'sgpd') {
        requireValue(versionFlags === 0 || versionFlags === 0x01000000);
        recordBytes = 2;
        if (versionFlags !== 0) {
          prefix = 16;
          this.need(group.body, prefix, group.end);
          requireValue(this.view.getUint32(group.body + 8) === 2);
        }
      } else requireValue(versionFlags === 0);
      const count = this.view.getUint32(group.body + prefix - 4);
      requireValue(count <= MAX_BOXES && group.end - group.body === prefix + count * recordBytes);
    }
    const stsd = this.only(stblChildren, 'stsd');
    this.fullBox(stsd, 8);
    requireValue(this.view.getUint32(stsd.body + 4) === 1);
    const entries = this.inside(stsd, 8);
    requireValue(entries.length === 1 && entries[0].type === 'mp4a');
    const entry = entries[0];
    this.need(entry.body, 28, entry.end);
    // The ordinary ISO AudioSampleEntry uses the version-0 sound entry layout.
    requireValue(this.view.getUint16(entry.body + 8) === 0);
    requireValue(this.view.getUint16(entry.body + 10) === 0 && this.view.getUint32(entry.body + 12) === 0);
    requireValue(this.view.getUint16(entry.body + 6) === 1);
    for (let i = 0; i < 6; i++) requireValue(this.view.getUint8(entry.body + i) === 0);
    requireValue(this.view.getUint16(entry.body + 20) === 0 && this.view.getUint16(entry.body + 22) === 0);
    // In MPEG-4 audio, these legacy channelcount/samplerate fields are not ASC.
    // In particular, channelcount=2 must never hide a multichannel ASC.
    const extensions = this.inside(entry, 28);
    requireValue(extensions.every(box => ['esds', 'btrt', 'free', 'skip'].includes(box.type)));
    const result = this.ascFromEsds(this.only(extensions, 'esds'));
    // If present, verify the referenced data is local. Never follow a URL.
    const dinfs = minfChildren.filter(box => box.type === 'dinf');
    requireValue(dinfs.length <= 1);
    if (dinfs.length) {
      const dref = this.only(this.inside(dinfs[0]), 'dref');
      this.fullBox(dref, 8);
      requireValue(this.view.getUint32(dref.body + 4) === 1);
      const references = this.inside(dref, 8);
      requireValue(references.length === 1 && references[0].type === 'url ');
      const reference = references[0];
      this.need(reference.body, 4, reference.end);
      requireValue(reference.end - reference.body === 4 && this.view.getUint32(reference.body) === 1);
    }
    return result;
  }
  audio() {
    const boxes = this.children(0, this.view.byteLength, 1);
    requireValue(!boxes.some(box => ['cmov', 'mvex', 'pssh'].includes(box.type)));
    let result = null, audioTracks = 0;
    for (const track of boxes.filter(box => box.type === 'trak')) {
      const trackChildren = this.inside(track);
      requireValue(!trackChildren.some(box => box.type === 'tref'));
      const mdia = this.only(trackChildren, 'mdia');
      const children = this.inside(mdia);
      const handler = this.only(children, 'hdlr');
      this.fullBox(handler, 24);
      if (fourcc(this.view, handler.body + 8) !== 'soun') continue;
      requireValue(++audioTracks === 1);
      result = this.audioEntry(children);
    }
    requireValue(audioTracks === 1);
    return result;
  }
}

function parseAsc(bytes) {
  let offset = 0;
  const read = count => {
    requireValue(offset + count <= bytes.length * 8);
    let value = 0;
    for (let i = 0; i < count; i++, offset++) value = value * 2 + ((bytes[offset >> 3] >> (7 - (offset & 7))) & 1);
    return value;
  };
  requireValue(read(5) === 2); // AAC-LC only; no escaped or extension AOT.
  const frequencyIndex = read(4);
  const sampleRate = frequencyIndex === 15 ? read(24) : FREQUENCIES[frequencyIndex];
  // Deliberately support only the ordinary AAC core frequency range.
  requireValue(Number.isInteger(sampleRate) && sampleRate >= 7350 && sampleRate <= 96000);
  const channelConfiguration = read(4), channels = CHANNELS[channelConfiguration];
  requireValue(channels > 0); // A PCE (configuration 0) is deliberately unknown.
  requireValue(read(3) === 0); // Ordinary GASpecificConfig: 1024 samples, no core dependency/extension.
  let sbrSignaling = 'unspecified';
  if (bytes.length * 8 - offset > 7) {
    requireValue(read(11) === 0x2b7 && read(5) === 5 && read(1) === 0);
    sbrSignaling = 'explicitly-absent';
    // Other extensions, including explicit PS signaling, are outside this subset.
  }
  requireValue(bytes.length * 8 - offset <= 7);
  while (offset < bytes.length * 8) requireValue(read(1) === 0);
  return {channels, maxChannels: Math.max(2, channels), sampleRate, codec: 'mp4a.40.2',
    evidence: {source: 'mp4-esds-asc', audioObjectType: 2, channelConfiguration, frequencyIndex,
      sbrSignaling, monoExpansionReserved: channels === 1}};
}

/** Read local MP4 metadata without constructing a decoder or loading mdat.
 * Returns null for unknown, unsupported, malformed, oversized, or unreadable
 * input. channels is the ASC declaration; maxChannels is a budget reservation
 * (mono reserves stereo for implicit PS). sampleRate is the signaled core rate.
 * This is not a guarantee of actual decoder dimensions or native allocation.
 * The caller must retain its unknown-channel fallback and post-decode checks.
 */
export async function probeMp4Audio(blob) {
  try {
    requireValue(blob && Number.isSafeInteger(blob.size) && blob.size >= 8 && typeof blob.slice === 'function');
    let bytesRead = 0;
    const read = async (start, length) => {
      requireValue(Number.isSafeInteger(start) && start >= 0 && length > 0 && start + length <= blob.size);
      requireValue(bytesRead + length <= MAX_MOOV_BYTES + MAX_TOP_LEVEL_BOXES * 16);
      bytesRead += length;
      const buffer = await blob.slice(start, start + length).arrayBuffer();
      requireValue(buffer.byteLength === length);
      return buffer;
    };
    let position = 0, count = 0, movie = null;
    while (position < blob.size) {
      requireValue(++count <= MAX_TOP_LEVEL_BOXES && blob.size - position >= 8);
      let view = new DataView(await read(position, 8));
      if (view.getUint32(0) === 1) {
        const extended = new Uint8Array(16);
        extended.set(new Uint8Array(view.buffer));
        extended.set(new Uint8Array(await read(position + 8, 8)), 8);
        view = new DataView(extended.buffer);
      }
      const {size, header} = boxLength(view, blob.size - position, true);
      const type = fourcc(view, 4);
      requireValue(!['moof', 'mfra', 'pssh'].includes(type));
      if (type === 'moov') {
        requireValue(!movie && size <= MAX_MOOV_BYTES && size > header);
        movie = {start: position + header, length: size - header, size};
      }
      position += size;
    }
    requireValue(movie);
    const result = new MovieReader(await read(movie.start, movie.length)).audio();
    return {...result, evidence: {...result.evidence, moovBytes: movie.size, bytesRead}};
  } catch {
    return null;
  }
}
