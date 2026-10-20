import { PLAYER_RADIUS } from "./config.js";

/** An ice pillar. It blocks walking and it blocks laser beams, so it works as cover. */
export interface Pillar {
  x: number;
  z: number;
  r: number;
}

export const PILLAR_RADIUS = 1.3;
/** How tall the pillars stand. Taller than a player, so someone behind one cannot be seen over it. */
export const PILLAR_HEIGHT = 5.6;

function ring(count: number, radius: number, startDegrees: number): Pillar[] {
  return Array.from({ length: count }, (_, i) => {
    const angle = ((startDegrees + (360 / count) * i) * Math.PI) / 180;
    return { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius, r: PILLAR_RADIUS };
  });
}

/**
 * Where the pillars stand at the start of a match. The layout is fixed so the server and every browser agree
 * without sending it. None of them sit on the row or column through the middle, so a straight shot across
 * the arena is never blocked by accident.
 */
export const PILLARS: readonly Pillar[] = [...ring(4, 11.5, 45), ...ring(3, 6, 90)];

/** The pillars that are still on the floor once the ring has shrunk to `radius`. The rest fall away with the ice. */
export function activePillars(radius: number): Pillar[] {
  return PILLARS.filter((pillar) => Math.hypot(pillar.x, pillar.z) + pillar.r <= radius + 0.01);
}

/**
 * Pushes a position out of any pillar it overlaps. Walking into a pillar slides along it.
 * Returns the new position and, when a push happened, which way it pushed (a unit vector).
 */
export function pushOutOfPillars(
  x: number,
  z: number,
  pillars: readonly Pillar[],
): { x: number; z: number; nx: number; nz: number; pushed: boolean } {
  let px = x;
  let pz = z;
  let nx = 0;
  let nz = 0;
  let pushed = false;
  for (const pillar of pillars) {
    const dx = px - pillar.x;
    const dz = pz - pillar.z;
    const min = pillar.r + PLAYER_RADIUS;
    const distance = Math.hypot(dx, dz);
    if (distance >= min) continue;
    // Standing exactly in the middle of a pillar cannot happen in play, but pick a direction anyway.
    const ux = distance > 1e-6 ? dx / distance : 1;
    const uz = distance > 1e-6 ? dz / distance : 0;
    px = pillar.x + ux * min;
    pz = pillar.z + uz * min;
    nx = ux;
    nz = uz;
    pushed = true;
  }
  return { x: px, z: pz, nx, nz, pushed };
}

/**
 * Distance along a beam to the first pillar it touches, or null if it misses them all.
 * A beam that starts inside a pillar is stopped at once.
 */
export function beamDistanceToPillar(
  origin: { x: number; z: number },
  dir: { x: number; z: number },
  pillars: readonly Pillar[],
  maxDistance: number,
): number | null {
  let best: number | null = null;
  for (const pillar of pillars) {
    const cx = pillar.x - origin.x;
    const cz = pillar.z - origin.z;
    const along = cx * dir.x + cz * dir.z;
    const perpSq = Math.max(0, cx * cx + cz * cz - along * along);
    if (perpSq >= pillar.r * pillar.r) continue;
    const half = Math.sqrt(pillar.r * pillar.r - perpSq);
    // The pillar is behind the muzzle entirely.
    if (along + half < 0) continue;
    const entry = Math.max(0, along - half);
    if (entry > maxDistance) continue;
    if (best === null || entry < best) best = entry;
  }
  return best;
}
