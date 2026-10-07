/* Shared number formatting for the UI. Loaded before the tabs that render token counts. */

/** "1.0" -> "1", "1.5" -> "1.5" */
function trimZeros(s) {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/**
 * Snap to the power-of-two label people expect when the number is within 3% of one:
 * 262,144 -> "256K", 131,072 -> "128K". Off-by-a-bit model limits are still that size;
 * rounding to "262K" only invites the reader to wonder what happened to the other 2k.
 */
function snapPow2(value, steps) {
  for (const step of steps) if (Math.abs(value - step) <= step * 0.03) return step;
  return value;
}

/**
 * Token counts, short. A million tokens is "1M" whether the model reports 1,000,000 or
 * 1,048,576 -- rendering the former as "1000K" was the ugly bit that started this.
 */
function fmtTokens(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  if (v >= 1e6) {
    const m = snapPow2(v / 1e6, [1]);
    return `${trimZeros(m.toFixed(m < 10 ? 1 : 0))}M`;
  }
  if (v >= 1e3) {
    const k = snapPow2(v / 1e3, [128, 256, 512]);
    return `${k.toFixed(v >= 1e4 ? 0 : 1)}K`;
  }
  return String(Math.round(v));
}