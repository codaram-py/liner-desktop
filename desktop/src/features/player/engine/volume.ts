const VOLUME_CURVE = 2;

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

// maps linear web audio gain to perceptual slider curve
export function toVolumeLevel(gain: number): number {
  return Math.pow(clamp(gain), 1 / VOLUME_CURVE);
}

// converts ui slider curve back to linear gain
export function toVolumeGain(level: number): number {
  return Math.pow(clamp(level), VOLUME_CURVE);
}

// wheel over the volume button: one notch = 5 points on the 0-100 slider, up raises, down lowers
export const VOLUME_WHEEL_STEP = 0.05;

export function stepVolumeLevel(level: number, deltaY: number, step = VOLUME_WHEEL_STEP): number {
  if (!deltaY) return clamp(level);
  const next = level + (deltaY < 0 ? step : -step);
  return clamp(Math.round(next * 100) / 100);
}
