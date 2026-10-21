import { BEAM_HALF_WIDTH, BEAM_RANGE, MUZZLE_FORWARD, PLAYER_RADIUS } from "./config.js";
import { facing } from "./movement.js";

export interface Vec2 {
  x: number;
  z: number;
}

export interface Target {
  id: string;
  pos: Vec2;
}

export interface Beam {
  shooter: string;
  from: Vec2;
  to: Vec2;
  /** Id of the first player the beam touched, or null if it reached its range. */
  hit: string | null;
}

/** Who was knocked out, and whose beams did it. Several shooters can hit the same player. */
export interface Kill {
  victim: string;
  killers: string[];
}

export interface Shooter {
  id: string;
  pos: Vec2;
  yaw: number;
}

export function muzzlePosition(pos: Vec2, yaw: number): Vec2 {
  const f = facing(yaw);
  return { x: pos.x + f.x * MUZZLE_FORWARD, z: pos.z + f.z * MUZZLE_FORWARD };
}

/**
 * Traces one straight beam from `origin` along `dir`.
 * Stops at the first target it touches. The caller leaves the shooter out of `targets`.
 */
export function traceBeam(
  origin: Vec2,
  dir: Vec2,
  targets: Target[],
  halfWidth: number = BEAM_HALF_WIDTH,
): { to: Vec2; hit: string | null } {
  let bestT = BEAM_RANGE;
  let bestId: string | null = null;
  const reach = PLAYER_RADIUS + halfWidth;

  for (const target of targets) {
    const cx = target.pos.x - origin.x;
    const cz = target.pos.z - origin.z;
    const along = cx * dir.x + cz * dir.z;
    if (along < 0) continue;

    const perpSq = Math.max(0, cx * cx + cz * cz - along * along);
    if (perpSq > reach * reach) continue;

    // Distance along the beam where it first touches the target's outer edge.
    const entry = along - Math.sqrt(reach * reach - perpSq);
    if (entry < 0) continue;
    if (entry < bestT) {
      bestT = entry;
      bestId = target.id;
    }
  }

  return {
    to: { x: origin.x + dir.x * bestT, z: origin.z + dir.z * bestT },
    hit: bestId,
  };
}

/**
 * Fires every living player's beam at once against the same snapshot of living players.
 * A player who is hit still gets to fire in this volley.
 */
export function resolveVolley(
  shooters: Shooter[],
  alive: Target[],
  halfWidth: number = BEAM_HALF_WIDTH,
): { beams: Beam[]; eliminated: string[]; kills: Kill[] } {
  const beams: Beam[] = [];
  const eliminated = new Set<string>();
  const killers = new Map<string, string[]>();

  for (const shooter of shooters) {
    const origin = muzzlePosition(shooter.pos, shooter.yaw);
    const dir = facing(shooter.yaw);
    const targets = alive.filter((t) => t.id !== shooter.id);
    const { to, hit } = traceBeam(origin, dir, targets, halfWidth);
    beams.push({ shooter: shooter.id, from: origin, to, hit });
    if (hit) {
      eliminated.add(hit);
      killers.set(hit, [...(killers.get(hit) ?? []), shooter.id]);
    }
  }

  const kills = [...killers].map(([victim, by]) => ({ victim, killers: by }));
  return { beams, eliminated: [...eliminated], kills };
}

