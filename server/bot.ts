import { tileIndexAt, type Arena } from "../shared/arena.js";
import type { Vec2 } from "../shared/geometry.js";
import { MoveInput, Pose, stepPose } from "../shared/movement.js";

/** What a bot has decided to do this hide phase. */
export interface BotPlan {
  /** The tile centers to walk through, in order. */
  path: Vec2[];
  target: Vec2;
  aimYaw: number;
  /** When the bot locks in, as a timestamp in milliseconds. */
  lockAt: number;
}

const TURN_SPEED = 2.6;
const NEIGHBORS: Array<[number, number]> = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
];

/** Every standing tile a bot could walk to from where it stands, with the way there. */
function reachable(arena: Arena, from: number): Map<number, number> {
  const { layout, standing } = arena;
  const cameFrom = new Map<number, number>([[from, -1]]);
  const queue = [from];
  while (queue.length > 0) {
    const current = queue.shift() as number;
    const tile = layout.tiles[current];
    for (const [dq, dr] of NEIGHBORS) {
      const next = layout.byKey.get(`${tile.q + dq},${tile.r + dr}`);
      if (next === undefined || standing[next] !== 1 || cameFrom.has(next)) continue;
      cameFrom.set(next, current);
      queue.push(next);
    }
  }
  return cameFrom;
}

/**
 * Picks where a bot will walk, which way it will face, and when it will lock in.
 * Bots play fair: they only use positions that were made public at the last reveal.
 * They can see the cracks, like everyone, and the better ones keep off the tiles that are about to fall.
 */
export function planBot(
  arena: Arena,
  from: Vec2,
  cracked: readonly number[],
  publicPositions: Vec2[],
  quick: boolean,
  now: number,
  /** From 0 (easy) to 1 (hard). Better bots aim more carefully at where people were last seen. */
  skill: number,
  random: () => number = Math.random,
): BotPlan {
  const start = Math.max(0, tileIndexAt(arena.layout, from.x, from.z));
  const paths = reachable(arena, start);
  const options = [...paths.keys()];
  const doomed = new Set(cracked);
  const avoids = random() < 0.25 + 0.7 * skill;
  const safe = options.filter((index) => !doomed.has(index));
  const pool = avoids && safe.length > 0 ? safe : options;
  const chosen = pool[Math.floor(random() * pool.length)] ?? start;

  // The way there: tile after tile, from the one the bot stands on.
  const route: number[] = [];
  for (let at = chosen; at !== -1 && at !== undefined; at = paths.get(at) ?? -1) route.push(at);
  route.reverse();
  const tiles = arena.layout.tiles;
  const path = route.slice(1).map((index) => ({ x: tiles[index].x, z: tiles[index].z }));
  const centre = tiles[chosen];
  const target = { x: centre.x + (random() - 0.5) * 1.2, z: centre.z + (random() - 0.5) * 1.2 };
  path.push(target);

  let aimYaw: number;
  // Easy bots often ignore what they saw. Hard bots nearly always use it, and aim more tightly.
  const usesInfo = publicPositions.length > 0 && random() < 0.4 + 0.6 * skill;
  if (usesInfo) {
    // Guess that someone is still near where they were last seen.
    const guess = publicPositions[Math.floor(random() * publicPositions.length)];
    const noise = 0.9 - 0.8 * skill;
    aimYaw = Math.atan2(guess.x - target.x, guess.z - target.z) + (random() - 0.5) * noise;
  } else {
    // No one has been seen yet. Face the middle of the floor, where players tend to gather.
    aimYaw = Math.atan2(-target.x, -target.z) + (random() - 0.5) * 1.2;
  }

  const wait = quick ? 1500 + random() * 1500 : 6000 + random() * 14000;
  return { path, target, aimYaw: wrap(aimYaw), lockAt: now + wait };
}

/** Moves a bot one simulation step toward its plan. */
export function stepBot(pose: Pose, plan: BotPlan, arena: Arena, dt: number): Pose {
  // Turn toward the planned aim by the shortest way, at a limited speed.
  const difference = wrap(plan.aimYaw - pose.yaw);
  const turn = Math.max(-TURN_SPEED * dt, Math.min(TURN_SPEED * dt, difference));
  const yaw = wrap(pose.yaw + turn);

  // Head for the next tile on the way, and drop it from the list once reached.
  while (plan.path.length > 1 && Math.hypot(plan.path[0].x - pose.x, plan.path[0].z - pose.z) < 1.1) plan.path.shift();
  const goal = plan.path[0] ?? plan.target;
  const dx = goal.x - pose.x;
  const dz = goal.z - pose.z;
  const distance = Math.hypot(dx, dz);
  if (distance < 0.4) return { ...pose, yaw, vx: 0, vz: 0 };

  // Walk straight to the goal, whatever way the bot is facing: split the move into forward and sideways.
  const wx = dx / distance;
  const wz = dz / distance;
  const input: MoveInput = {
    seq: 0,
    forward: wx * Math.sin(yaw) + wz * Math.cos(yaw),
    strafe: wx * -Math.cos(yaw) + wz * Math.sin(yaw),
    yaw,
  };
  return stepPose(pose, input, dt, arena);
}

function wrap(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}
