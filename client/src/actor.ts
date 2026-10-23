import type * as THREE from "three";

/**
 * Anything that can stand in the arena as a player: the robot, or the stick man used as a fallback
 * if the model cannot be loaded. The world only talks to this interface.
 */
export interface Actor {
  /** Position and facing on the floor. */
  readonly root: THREE.Group;
  readonly isAlive: boolean;
  setPose(x: number, z: number, yaw: number): void;
  setMoving(moving: boolean): void;
  setAlive(alive: boolean): void;
  /** Recoil from firing. */
  kick(): void;
  /**
   * A beam is about to hit this figure. `dx` and `dz` are the beam's direction (a unit step) and `distance` is how
   * far it flew, so the fall that follows can depend on where the shot came from and how hard it landed.
   */
  strike(dx: number, dz: number, distance: number): void;
  /** Stands back up, as if never hit. Used by the title scene loop. */
  reset(): void;
  /** The floor gives way under this figure. */
  plunge(delay: number): void;
  update(dt: number): void;
  dispose(): void;
}
