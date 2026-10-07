// Original cubic easing utilities. Public mathematical formulas, no third-party code.
export const DEFAULT_CURVE = [0.33, 0, 0.67, 1];
export function validateCurve(points) {
  if (!Array.isArray(points) || points.length !== 4 || points.some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1)) {
    throw Error('贝塞尔控制点必须是 0–1 之间的四个有限数值');
  }
  return [...points];
}
const component = (u, a, b) => 3 * (1 - u) ** 2 * u * a + 3 * (1 - u) * u ** 2 * b + u ** 3;
export function bezierProgress(time, points = DEFAULT_CURVE) {
  if (time <= 0) return 0;
  if (time >= 1) return 1;
  // Invert the monotone time coordinate before evaluating value. Using time as u
  // directly would produce the wrong motion whenever the X handles are changed.
  let low = 0, high = 1;
  for (let iteration = 0; iteration < 42; iteration++) {
    const middle = (low + high) / 2;
    if (component(middle, points[0], points[2]) < time) low = middle;
    else high = middle;
  }
  return component((low + high) / 2, points[1], points[3]);
}
export function graphBounds(keys, base = 0) {
  const values = keys.length ? keys.map(key => key.value) : [base];
  const low = Math.min(...values), high = Math.max(...values);
  const padding = Math.max((high - low) * 0.18, Math.abs(high) * 0.04, 0.1);
  return {min: low - padding, max: high + padding};
}
export function moveGraphKey(keys, index, seconds, value, fps, duration, minimum, maximum) {
  const key = keys[index];
  if (!key || ![seconds, value, fps, duration].every(Number.isFinite) || fps <= 0) throw Error('无效曲线编辑');
  const lowFrame = index > 0 ? Math.floor(keys[index - 1].time * fps + 1e-8) + 1 : 0;
  const highFrame = index + 1 < keys.length ? Math.ceil(keys[index + 1].time * fps - 1e-8) - 1 : Math.floor(duration * fps);
  if (lowFrame <= highFrame) key.time = Math.min(highFrame, Math.max(lowFrame, Math.round(seconds * fps))) / fps;
  key.value = Math.min(maximum, Math.max(minimum, value));
  return key;
}
