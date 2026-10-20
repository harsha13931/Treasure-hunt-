/** A circular on-screen joystick driven by a finger. x is right (+), y is up (+), both from -1 to 1. */
export class Joystick {
  readonly value = { x: 0, y: 0 };
  private knob: HTMLElement;
  private activePointer: number | null = null;

  constructor(private base: HTMLElement) {
    this.knob = base.querySelector(".knob") as HTMLElement;
    base.addEventListener("pointerdown", (event) => {
      if (this.activePointer !== null) return;
      this.activePointer = event.pointerId;
      base.setPointerCapture(event.pointerId);
      this.update(event);
      event.preventDefault();
    });
    base.addEventListener("pointermove", (event) => {
      if (event.pointerId === this.activePointer) this.update(event);
    });
    const release = (event: PointerEvent) => {
      if (event.pointerId === this.activePointer) this.reset();
    };
    base.addEventListener("pointerup", release);
    base.addEventListener("pointercancel", release);
    base.addEventListener("lostpointercapture", release);
  }

  /** Puts the stick back in the middle. Call when the controls disappear. */
  reset(): void {
    this.activePointer = null;
    this.value.x = 0;
    this.value.y = 0;
    this.knob.style.transform = "translate(-50%, -50%)";
  }

  private update(event: PointerEvent): void {
    const rect = this.base.getBoundingClientRect();
    const radius = rect.width / 2;
    let dx = event.clientX - (rect.left + radius);
    let dy = event.clientY - (rect.top + radius);
    const distance = Math.hypot(dx, dy);
    if (distance > radius) {
      dx = (dx / distance) * radius;
      dy = (dy / distance) * radius;
    }
    this.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;

    // A small dead zone, so a resting thumb does not drift.
    const x = dx / radius;
    const y = -dy / radius;
    const magnitude = Math.hypot(x, y);
    const scaled = magnitude < 0.12 ? 0 : (magnitude - 0.12) / 0.88;
    this.value.x = magnitude === 0 ? 0 : (x / magnitude) * scaled;
    this.value.y = magnitude === 0 ? 0 : (y / magnitude) * scaled;
  }
}
