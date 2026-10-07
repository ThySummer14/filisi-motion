// Original, dependency-free fixed-rate clip math. Times and fade durations are seconds.
// All edits are immutable. Transform keys stay in composition time, including keys
// outside a clip/project: these keys are necessary to preserve Bezier interpolation.
const EPS = 1e-9;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const copy = value => Array.isArray(value) ? value.map(copy) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k,v]) => [k,copy(v)])) : value;
const finite = (v, name) => { if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`${name} must be finite`); return v; };
export const isMediaLayer = layer => !!layer && (layer.type === 'video' || layer.type === 'audio');

/** Validate media-specific fields; returns the original layer without mutation.
 * fadeOrigin optionally anchors fades to a source interval. It is created by trim
 * and split, retained by move, and must be serialized. To apply fresh fades to an
 * edited clip, delete fadeOrigin. Overlapping fades multiply, never amplify gain.
 */
export function validateMediaLayer(layer) {
  if (!isMediaLayer(layer)) throw new TypeError('Expected a video or audio layer');
  if (typeof layer.assetId !== 'string' || !layer.assetId.trim()) throw new TypeError('assetId is required');
  for (const name of ['start','end','sourceIn','mediaDuration','volume','fadeIn','fadeOut']) finite(layer[name], name);
  if (layer.start < 0 || layer.end <= layer.start || layer.sourceIn < 0 || layer.mediaDuration <= 0 || layer.mediaDuration > 7200 || layer.sourceIn + layer.end - layer.start > layer.mediaDuration + EPS) throw new RangeError('Clip exceeds source or composition bounds');
  if (layer.volume < 0 || layer.volume > 2 || layer.fadeIn < 0 || layer.fadeIn > 300 || layer.fadeOut < 0 || layer.fadeOut > 300 || typeof layer.muted !== 'boolean') throw new RangeError('Invalid audio envelope');
  if (layer.fadeOrigin !== undefined) {
    const f = layer.fadeOrigin;
    if (!f || typeof f !== 'object') throw new TypeError('Invalid fadeOrigin');
    finite(f.sourceIn,'fadeOrigin.sourceIn'); finite(f.duration,'fadeOrigin.duration');
    if (f.sourceIn < 0 || f.duration <= 0 || f.sourceIn + f.duration > layer.mediaDuration + EPS) throw new RangeError('Invalid fadeOrigin bounds');
  }
  if (layer.keys !== undefined) {
    if (!layer.keys || typeof layer.keys !== 'object' || Array.isArray(layer.keys)) throw new TypeError('Invalid keys');
    for (const keys of Object.values(layer.keys)) {
      if (!Array.isArray(keys)) throw new TypeError('Invalid key list');
      let last = -Infinity;
      for (const k of keys) {
        if (!k || typeof k !== 'object') throw new TypeError('Invalid key');
        finite(k.time,'key.time'); finite(k.value,'key.value');
        if (k.time <= last) throw new RangeError('Keys must have strictly increasing times');
        last = k.time;
      }
    }
  }
  return layer;
}

/** Safe visibility predicate for render loops; malformed/non-media layers are inactive. */
export function activeAt(layer, compTime) {
  if (!Number.isFinite(compTime)) return false;
  try { validateMediaLayer(layer); } catch { return false; }
  return layer.visible !== false && compTime >= layer.start && compTime < layer.end;
}
export const active = activeAt;
export const isActive = activeAt;

/** Seeking clamps outside times to the visible source endpoints; end is exclusive
 * for playback, but its source endpoint is returned exactly for edit calculations. */
export function sourceTimeAt(layer, compTime) {
  validateMediaLayer(layer); finite(compTime,'compTime');
  return clamp(layer.sourceIn + clamp(compTime,layer.start,layer.end) - layer.start, 0, layer.mediaDuration);
}
export function gainAt(layer, compTime) {
  if (!activeAt(layer,compTime) || layer.muted) return 0;
  const origin = layer.fadeOrigin ?? {sourceIn:layer.sourceIn,duration:layer.end-layer.start};
  const elapsed = sourceTimeAt(layer,compTime) - origin.sourceIn;
  const incoming = layer.fadeIn === 0 ? 1 : clamp(elapsed/layer.fadeIn,0,1);
  const outgoing = layer.fadeOut === 0 ? 1 : clamp((origin.duration-elapsed)/layer.fadeOut,0,1);
  return layer.volume * incoming * outgoing;
}
const preserveEnvelope = layer => copy(layer.fadeOrigin ?? {sourceIn:layer.sourceIn,duration:layer.end-layer.start});

/** Set absolute composition in/out points, allowing source-backed extensions.
 * Requested bounds are clamped to composition zero and the available source.
 * No-overlap/reversed/empty requests throw instead of inventing a zero-length clip.
 * Transform keys and source-anchored fades do not shift when trimming.
 */
export function trimClip(layer, start, end) {
  validateMediaLayer(layer); finite(start,'start'); finite(end,'end');
  if (end <= start) throw new RangeError('Trim end must follow start');
  const lo = Math.max(0,layer.start-layer.sourceIn);
  const hi = layer.start-layer.sourceIn+layer.mediaDuration;
  start = clamp(start,lo,hi); end = clamp(end,lo,hi);
  if (end <= start) throw new RangeError('Trim does not overlap source');
  const out = copy(layer);
  out.sourceIn = clamp(layer.sourceIn+start-layer.start,0,layer.mediaDuration);
  out.start = start; out.end = end; out.fadeOrigin = preserveEnvelope(layer);
  return validateMediaLayer(out);
}

/** Move without resizing; duration is the project duration, not the clip duration.
 * Every key shifts by the exact same delta. Never clamp individual keys: doing so
 * changes easing and collapses distinct keys. Projects must retain off-range keys.
 */
export function moveClip(layer, newStart, duration) {
  validateMediaLayer(layer); finite(newStart,'newStart'); finite(duration,'duration');
  const length = layer.end-layer.start;
  if (duration <= 0 || duration < length) throw new RangeError('Project is shorter than clip');
  const out = copy(layer), start = clamp(newStart,0,duration-length), delta = start-layer.start;
  out.start = start; out.end = start+length;
  for (const keys of Object.values(out.keys ?? {})) for (const key of keys) key.time += delta;
  return validateMediaLayer(out);
}

/** Split strictly inside a clip. Shared source and identical global transform
 * curves guarantee continuous motion, including custom Bezier/hold segments.
 * Each result owns independent key arrays; neither synthesizes boundary keys.
 */
export function splitClip(layer, time, newId) {
  validateMediaLayer(layer); finite(time,'time');
  if (time <= layer.start || time >= layer.end) throw new RangeError('Split must be inside clip');
  if (typeof newId !== 'string' || !newId.trim() || newId === layer.id) throw new TypeError('Split requires a new distinct id');
  const left = copy(layer), right = copy(layer);
  left.end = time; right.start = time; right.sourceIn = sourceTimeAt(layer,time); right.id = newId;
  left.fadeOrigin = preserveEnvelope(layer); right.fadeOrigin = preserveEnvelope(layer);
  return [validateMediaLayer(left),validateMediaLayer(right)];
}
