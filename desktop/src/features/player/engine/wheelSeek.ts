// scrolling over the empty part of the player bar scrubs: wheel up skips ahead, wheel down goes back
export const WHEEL_SEEK_STEP_MS = 10_000;
// a trackpad fires dozens of wheel events per swipe, one step per this many ms keeps it at "10s per scroll"
export const WHEEL_SEEK_MIN_INTERVAL_MS = 120;
export const WHEEL_SEEK_IGNORE = "button, a, input, [role='button'], [role='slider'], .prevent-seek";

// null = nothing to do (no vertical movement, nothing playing)
export function wheelSeekTarget(deltaY: number, positionMs: number, durationMs: number, stepMs = WHEEL_SEEK_STEP_MS): number | null {
  if (!deltaY || !(durationMs > 0)) return null;
  const next = positionMs + (deltaY < 0 ? stepMs : -stepMs);
  return Math.max(0, Math.min(durationMs, next));
}
