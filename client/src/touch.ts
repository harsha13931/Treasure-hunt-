/**
 * A joystick that appears wherever the thumb lands inside its zone, so it never sticks to one spot.
 * x is right (+), y is up (+), both from -1 to 1.
 */
export class FloatingJoystick {
  readonly value = { x: 0, y: 0 };
  private knob: HTMLElement;
  private activePointer: number | null = null;
  private originX = 0;
  private originY = 0;

  constructor(
    private zone: HTMLElement,
    private base: HTMLElement,
  ) {
    this.knob = base.querySelector(".knob") as HTMLElement;
    zone.addEventListener("pointerdown", (event) => {
      if (this.activePointer !== null) return;
      this.activePointer = event.pointerId;
      zone.setPointerCapture(event.pointerId);
      this.originX = event.clientX;
      this.originY = event.clientY;
      this.base.style.left = `${this.originX}px`;
      this.base.style.top = `${this.originY}px`;
      this.base.classList.add("active");
      this.update(event);
      event.preventDefault();
    });
    zone.addEventListener("pointermove", (event) => {
      if (event.pointerId === this.activePointer) this.update(event);
    });
    const release = (event: PointerEvent) => {
      if (event.pointerId === this.activePointer) this.reset();
    };
    zone.addEventListener("pointerup", release);
    zone.addEventListener("pointercancel", release);
    zone.addEventListener("lostpointercapture", release);
  }

  /** Puts the stick away. Call when the controls disappear. */
  reset(): void {
    this.activePointer = null;
    this.value.x = 0;
    this.value.y = 0;
    this.base.classList.remove("active");
    this.knob.style.transform = "translate(-50%, -50%)";
  }

  private update(event: PointerEvent): void {
    const radius = this.base.offsetWidth / 2;
    let dx = event.clientX - this.originX;
    let dy = event.clientY - this.originY;
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

/** A button that counts as pressed for as long as a finger is on it. */
export class HoldButton {
  pressed = false;
  private activePointer: number | null = null;

  constructor(private element: HTMLElement) {
    element.addEventListener("pointerdown", (event) => {
      if (this.activePointer !== null) return;
      this.activePointer = event.pointerId;
      element.setPointerCapture(event.pointerId);
      this.pressed = true;
      element.classList.add("down");
      event.preventDefault();
    });
    const release = (event: PointerEvent) => {
      if (event.pointerId === this.activePointer) this.reset();
    };
    element.addEventListener("pointerup", release);
    element.addEventListener("pointercancel", release);
    element.addEventListener("lostpointercapture", release);
  }

  reset(): void {
    this.activePointer = null;
    this.pressed = false;
    this.element.classList.remove("down");
  }
}
