import { canStand, isStanding, type Arena } from "./arena.js";
import { WALK_SPEED } from "./config.js";

export interface Pose {
  x: number;
  z: number;
  /** Direction the player faces, in radians. 0 faces +Z. */
  yaw: number;
  /** Current speed on the floor. Players speed up and slow down instead of snapping to full speed. */
  vx?: number;
  vz?: number;
}

export interface MoveInput {
  seq: number;
  /** -1 (back) to 1 (forward). */
  forward: number;
  /** -1 (left) to 1 (right). */
  strafe: number;
  yaw: number;
}

/** How quickly speed catches up with the stick or keys, per second. Higher feels snappier. */
const ACCELERATION = 14;

/** Unit vector the player faces on the floor plane. */
export function facing(yaw: number): { x: number; z: number } {
  return { x: Math.sin(yaw), z: Math.cos(yaw) };
}

/**
 * Moves a pose for one simulation step. Used by both the server and the browser's prediction,
 * so they agree. Speed eases toward the wanted speed, which makes starting and stopping feel smooth.
 * A player cannot walk onto a tile that has fallen, or so close to a hole that their feet would hang over it.
 * Walking into the edge slides along it. `speedScale` is above 1 in a round where everyone is fast.
 */
export function stepPose(pose: Pose, input: MoveInput, dt: number, arena: Arena, speedScale = 1): Pose {
  const f = facing(input.yaw);
  // Right-hand direction: forward crossed with up.
  const r = { x: -f.z, z: f.x };
  let mx = f.x * input.forward + r.x * input.strafe;
  let mz = f.z * input.forward + r.z * input.strafe;
  const length = Math.hypot(mx, mz);
  if (length > 1) {
    mx /= length;
    mz /= length;
  }

  const blend = 1 - Math.exp(-ACCELERATION * dt);
  const speed = WALK_SPEED * speedScale;
  const vx = (pose.vx ?? 0) + (mx * speed - (pose.vx ?? 0)) * blend;
  const vz = (pose.vz ?? 0) + (mz * speed - (pose.vz ?? 0)) * blend;

  // Someone already too near an edge (a tile fell beside them) may still move, but not onto bare air.
  const strict = canStand(arena, pose.x, pose.z);
  const ok = (x: number, z: number) => (strict ? canStand(arena, x, z) : isStanding(arena, x, z));

  const nx = pose.x + vx * dt;
  const nz = pose.z + vz * dt;
  if (ok(nx, nz)) return { x: nx, z: nz, yaw: input.yaw, vx, vz };
  if (ok(nx, pose.z)) return { x: nx, z: pose.z, yaw: input.yaw, vx, vz: 0 };
  if (ok(pose.x, nz)) return { x: pose.x, z: nz, yaw: input.yaw, vx: 0, vz };
  return { x: pose.x, z: pose.z, yaw: input.yaw, vx: 0, vz: 0 };
}
