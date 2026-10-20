import { PLAYER_RADIUS, START_RING_RADIUS, WALK_SPEED } from "./config.js";

export interface Pose {
  x: number;
  z: number;
  /** Direction the player faces, in radians. 0 faces +Z. */
  yaw: number;
}

export interface MoveInput {
  seq: number;
  /** -1 (back) to 1 (forward). */
  forward: number;
  /** -1 (left) to 1 (right). */
  strafe: number;
  yaw: number;
}

/** Unit vector the player faces on the floor plane. */
export function facing(yaw: number): { x: number; z: number } {
  return { x: Math.sin(yaw), z: Math.cos(yaw) };
}

/** Pushes a pose back inside the ring if it has drifted past the edge. */
export function clampToRing(pose: Pose, ringRadius: number): Pose {
  const limit = Math.max(0, ringRadius - PLAYER_RADIUS);
  const distance = Math.hypot(pose.x, pose.z);
  if (distance <= limit) return pose;
  const scale = limit / distance;
  return { ...pose, x: pose.x * scale, z: pose.z * scale };
}

/** Moves a pose for one simulation step. Used by both the server and the client's prediction. */
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
  const moved = {
    x: pose.x + mx * WALK_SPEED * dt,
    z: pose.z + mz * WALK_SPEED * dt,
    yaw: input.yaw,
  };
  return clampToRing(moved, ringRadius);
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
  };
}
