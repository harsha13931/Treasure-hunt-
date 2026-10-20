import { PLAYER_RADIUS } from "../shared/config.js";
import { clampToRing, MoveInput, Pose, stepPose } from "../shared/movement.js";
import type { Pillar } from "../shared/obstacles.js";
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
  /** From 0 (easy) to 1 (hard). Better bots aim more carefully at where people were last seen. */
  skill: number,
  random: () => number = Math.random,
  /** Pillars on the floor. Bots stay clear of them, and the better ones like to hide behind one. */
  pillars: readonly Pillar[] = [],
): BotPlan {
  const target = pickSpot(radius, pillars, skill, random);

  let aimYaw: number;
  // Easy bots often ignore what they saw. Hard bots nearly always use it, and aim more tightly.
  const usesInfo = publicPositions.length > 0 && random() < 0.4 + 0.6 * skill;
  if (usesInfo) {
    // Guess that someone is still near where they were last seen.
    const guess = publicPositions[Math.floor(random() * publicPositions.length)];
    const noise = 0.9 - 0.8 * skill;
    aimYaw = Math.atan2(guess.x - target.x, guess.z - target.z) + (random() - 0.5) * noise;
  } else {
    // No one has been seen yet. Face the middle of the ring, where players tend to gather.
    aimYaw = Math.atan2(-target.x, -target.z) + (random() - 0.5) * 1.2;
  }

  const wait = quick ? 1500 + random() * 1500 : 6000 + random() * 14000;
  return { target, aimYaw: wrap(aimYaw), lockAt: now + wait };
}

/**
 * A random spot inside the ring. Some of the time a bot tucks in behind a pillar, on the side away from the
 * middle, where most shots will come from the other way. Spots inside a pillar are never chosen.
 */
function pickSpot(radius: number, pillars: readonly Pillar[], skill: number, random: () => number): Vec2 {
  const usable = pillars.filter((p) => Math.hypot(p.x, p.z) + p.r + PLAYER_RADIUS + 0.4 < radius);
  if (usable.length > 0 && random() < 0.15 + 0.4 * skill) {
    const pillar = usable[Math.floor(random() * usable.length)];
    const length = Math.hypot(pillar.x, pillar.z) || 1;
    const gap = pillar.r + PLAYER_RADIUS + 0.35;
    return { x: pillar.x + (pillar.x / length) * gap, z: pillar.z + (pillar.z / length) * gap };
  }
  for (let attempt = 0; attempt < 10; attempt++) {
    const angle = random() * Math.PI * 2;
    const distance = Math.sqrt(random()) * radius * 0.8;
    const spot = { x: Math.cos(angle) * distance, z: Math.sin(angle) * distance };
    if (pillars.every((p) => Math.hypot(spot.x - p.x, spot.z - p.z) > p.r + PLAYER_RADIUS + 0.4)) return spot;
  }
  return { x: 0, z: 0 };
}

/** Moves a bot one simulation step toward its plan. */
export function stepBot(pose: Pose, plan: BotPlan, radius: number, dt: number, pillars: readonly Pillar[] = []): Pose {
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
  return stepPose(pose, input, dt, radius, pillars);
}

function wrap(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}
