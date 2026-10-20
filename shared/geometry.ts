import { GUNS, GunId, GunSpec, PLAYER_RADIUS, RING_RADIUS, SEAT_COUNT, GUN_LENGTH } from "./config.js";

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

export function seatAngle(seat: number): number {
  return (seat / SEAT_COUNT) * Math.PI * 2;
}

export function seatPosition(seat: number): Vec2 {
  const a = seatAngle(seat);
  return { x: Math.cos(a) * RING_RADIUS, z: Math.sin(a) * RING_RADIUS };
}

export function directionFromDeg(deg: number): Vec2 {
  const a = (deg * Math.PI) / 180;
  return { x: Math.cos(a), z: Math.sin(a) };
}

/** The aim that points from a seat toward the center of the ring. */
export function inwardAimDeg(seat: number): number {
  return (seatAngle(seat) * 180) / Math.PI + 180;
}

export function muzzlePosition(seat: number, aimDeg: number): Vec2 {
  const base = seatPosition(seat);
  const dir = directionFromDeg(aimDeg);
  return { x: base.x + dir.x * GUN_LENGTH, z: base.z + dir.z * GUN_LENGTH };
}

/**
 * Traces one straight beam from `origin` along `dir`.
 * Stops at the first target it touches. The caller removes the shooter from `targets` first.
 */
export function traceBeam(
  origin: Vec2,
  dir: Vec2,
  range: number,
  halfWidth: number,
  targets: Target[],
): { to: Vec2; hit: string | null } {
  let bestT = range;
  let bestId: string | null = null;

  for (const target of targets) {
    const cx = target.pos.x - origin.x;
    const cz = target.pos.z - origin.z;
    const along = cx * dir.x + cz * dir.z;
    if (along < 0) continue;

    const perpSq = cx * cx + cz * cz - along * along;
    const reach = PLAYER_RADIUS + halfWidth;
    if (perpSq > reach * reach) continue;

    // Distance along the beam at which it first touches the target's outer edge.
    const entry = along - Math.sqrt(reach * reach - Math.max(perpSq, 0));
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

export interface Shooter {
  id: string;
  seat: number;
  aimDeg: number;
  gun: GunId;
}

/**
 * Resolves every beam of every shooter against the same snapshot of living players.
 * All beams are simultaneous, so a player shot in this volley still fires their own beams.
 */
export function resolveVolley(shooters: Shooter[], alive: Target[]): { beams: Beam[]; eliminated: string[] } {
  const beams: Beam[] = [];
  const eliminated = new Set<string>();

  for (const shooter of shooters) {
    const spec: GunSpec = GUNS[shooter.gun];
    const origin = muzzlePosition(shooter.seat, shooter.aimDeg);
    const targets = alive.filter((t) => t.id !== shooter.id);

    for (const spread of spec.spreadDeg) {
      const dir = directionFromDeg(shooter.aimDeg + spread);
      const { to, hit } = traceBeam(origin, dir, spec.range, spec.beamHalfWidth, targets);
      beams.push({ shooter: shooter.id, from: origin, to, hit });
      if (hit) eliminated.add(hit);
    }
  }

  return { beams, eliminated: [...eliminated] };
}

export function isGunId(value: unknown): value is GunId {
  return typeof value === "string" && value in GUNS;
}
