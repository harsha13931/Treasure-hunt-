import { PLAYER_RADIUS, START_RING_RADIUS, WALK_SPEED } from "./config.js";

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

/** Pushes a pose back inside the ring if it has drifted past the edge. Hitting the edge stops the player. */
export function clampToRing(pose: Pose, ringRadius: number): Pose {
  const limit = Math.max(0, ringRadius - PLAYER_RADIUS);
  const distance = Math.hypot(pose.x, pose.z);
  if (distance <= limit) return pose;
  const scale = limit / distance;
  return { ...pose, x: pose.x * scale, z: pose.z * scale, vx: 0, vz: 0 };
}

/**
 * Moves a pose for one simulation step. Used by both the server and the browser's prediction,
 * so they agree. Speed eases toward the wanted speed, which makes starting and stopping feel smooth.
 */
export function stepPose(pose: Pose, input: MoveInput, dt: number, ringRadius: number): Pose {
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
  const vx = (pose.vx ?? 0) + (mx * WALK_SPEED - (pose.vx ?? 0)) * blend;
  const vz = (pose.vz ?? 0) + (mz * WALK_SPEED - (pose.vz ?? 0)) * blend;

  return clampToRing({ x: pose.x + vx * dt, z: pose.z + vz * dt, yaw: input.yaw, vx, vz }, ringRadius);
}

/**
 * Where a player starts: spread around the ring, facing a random direction.
 * Facing is random so nobody is lined up with an opponent at the start.
 */
export function startPoseFor(index: number, count: number): Pose {
  const angle = (index / Math.max(1, count)) * Math.PI * 2;
  const radius = START_RING_RADIUS * 0.6;
  return {
    x: Math.cos(angle) * radius,
    z: Math.sin(angle) * radius,
    yaw: Math.random() * Math.PI * 2 - Math.PI,
    vx: 0,
    vz: 0,
  };
}
