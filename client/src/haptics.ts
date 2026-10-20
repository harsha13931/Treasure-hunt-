/** A short buzz on phones that support it. Silent everywhere else. */
export function haptic(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // Vibration is optional.
  }
}
