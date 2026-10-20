import { clampToRing, MoveInput, Pose, stepPose } from "../shared/movement.js";
import type { Vec2 } from "../shared/geometry.js";

/** What a bot has decided to do this hide phase. */
export interface BotPlan {
  target: Vec2;
  aimYaw: number;
  /** When the bot locks in, as a timestamp in milliseconds. */
  lockAt: number;
}

const TURN_SPEED = 2.6;

/**
 * Picks where a bot will walk, which way it will face, and when it will lock in.
 * Bots play fair: they only use positions that were made public at the last reveal.
 */
export function planBot(
  radius: number,
  publicPositions: Vec2[],
  quick: boolean,
  now: number,
  random: () => number = Math.random,
): BotPlan {
  // A random spot inside the ring, spread evenly over the area.
  const angle = random() * Math.PI * 2;
  const distance = Math.sqrt(random()) * radius * 0.8;
  const target = { x: Math.cos(angle) * distance, z: Math.sin(angle) * distance };

  let aimYaw: number;
  if (publicPositions.length > 0) {
    // Guess that someone is still near where they were last seen.
    const guess = publicPositions[Math.floor(random() * publicPositions.length)];
    aimYaw = Math.atan2(guess.x - target.x, guess.z - target.z) + (random() - 0.5) * 0.5;
  } else {
    // No one has been seen yet. Face the middle of the ring, where players tend to gather.
    aimYaw = Math.atan2(-target.x, -target.z) + (random() - 0.5) * 1.2;
  }

  const wait = quick ? 1500 + random() * 1500 : 6000 + random() * 14000;
  return { target, aimYaw: wrap(aimYaw), lockAt: now + wait };
}

/** Moves a bot one simulation step toward its plan. */
export function stepBot(pose: Pose, plan: BotPlan, radius: number, dt: number): Pose {
  // Turn toward the planned aim by the shortest way, at a limited speed.
  const difference = wrap(plan.aimYaw - pose.yaw);
  const turn = Math.max(-TURN_SPEED * dt, Math.min(TURN_SPEED * dt, difference));
  const yaw = wrap(pose.yaw + turn);

  const dx = plan.target.x - pose.x;
  const dz = plan.target.z - pose.z;
  const distance = Math.hypot(dx, dz);
  if (distance < 0.4) {
    return clampToRing({ ...pose, yaw }, radius);
  }

  // Walk straight to the target, whatever way the bot is facing: split the move into forward and sideways.
  const wx = dx / distance;
  const wz = dz / distance;
  const input: MoveInput = {
    seq: 0,
    forward: wx * Math.sin(yaw) + wz * Math.cos(yaw),
    strafe: wx * -Math.cos(yaw) + wz * Math.sin(yaw),
    yaw,
  };
  return stepPose(pose, input, dt, radius);
}

function wrap(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}
