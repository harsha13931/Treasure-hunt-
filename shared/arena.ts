import type { MapId } from "./maps.js";

// The arena floor is a grid of hexagon tiles. Tiles crack and fall away round by round, and a player standing on a
// tile when it falls is out. The server decides which tiles go, and every browser draws and walks on the same grid.
//
// Tiles have a pointy top. A tile's size is the distance from its center to a corner.

export const TILE_SIZE = 2.5;
const SQRT3 = Math.sqrt(3);
/** Distance between the centers of two neighboring tiles. */
export const TILE_SPACING = SQRT3 * TILE_SIZE;
/** When this few tiles are left, the floor stops breaking and the last players settle it. */
export const FINAL_TILES = 7;
/** How much of the standing floor goes in one collapse. */
export const COLLAPSE_SHARE = 0.24;
/** A player's body is about this wide, so the floor under their feet must reach this far around the center. */
export const FOOTING = 0.9;

export interface Tile {
  index: number;
  q: number;
  r: number;
  x: number;
  z: number;
}

export interface ArenaLayout {
  map: MapId;
  tiles: Tile[];
  /** The farthest any tile reaches from the middle of the arena, so scenery and cameras can be sized. */
  extent: number;
  /** Where tile (0, 0) sits. The bridge is shifted so that it is centered. */
  origin: { x: number; z: number };
  byKey: Map<string, number>;
}

/** The state of the floor in a running match: the layout, and which tiles are still there. */
export interface Arena {
  layout: ArenaLayout;
  standing: Uint8Array;
}

const key = (q: number, r: number) => `${q},${r}`;

function build(map: MapId, cells: Array<[number, number]>): ArenaLayout {
  const raw = cells.map(([q, r]) => ({ q, r, x: TILE_SIZE * SQRT3 * (q + r / 2), z: TILE_SIZE * 1.5 * r }));
  // Center the arena on its own middle.
  const cx = raw.reduce((sum, t) => sum + t.x, 0) / raw.length;
  const cz = raw.reduce((sum, t) => sum + t.z, 0) / raw.length;
  const tiles = raw.map((t, index) => ({ index, q: t.q, r: t.r, x: t.x - cx, z: t.z - cz }));
  const byKey = new Map(tiles.map((t) => [key(t.q, t.r), t.index]));
  const extent = Math.max(...tiles.map((t) => Math.hypot(t.x, t.z))) + TILE_SIZE;
  return { map, tiles, extent, origin: { x: -cx, z: -cz }, byKey };
}

function disc(map: MapId, rings: number): ArenaLayout {
  const cells: Array<[number, number]> = [];
  for (let q = -rings; q <= rings; q++) {
    for (let r = -rings; r <= rings; r++) {
      if (Math.abs(q + r) <= rings) cells.push([q, r]);
    }
  }
  return build(map, cells);
}

/** A long, narrow deck: four rows of tiles, each ten tiles long, staggered like bricks. */
function bridge(map: MapId, columns: number, rows: number): ArenaLayout {
  const cells: Array<[number, number]> = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) cells.push([c - Math.floor(r / 2), r]);
  }
  return build(map, cells);
}

const layouts = new Map<MapId, ArenaLayout>();

/** The tiles of an arena. The same on the server and in every browser. */
export function layoutFor(map: MapId): ArenaLayout {
  let layout = layouts.get(map);
  if (!layout) {
    layout = map === "bridge" ? bridge(map, 10, 4) : disc(map, 4);
    layouts.set(map, layout);
  }
  return layout;
}

export function createArena(map: MapId): Arena {
  const layout = layoutFor(map);
  return { layout, standing: new Uint8Array(layout.tiles.length).fill(1) };
}

export function standingCount(arena: Arena): number {
  let count = 0;
  for (const s of arena.standing) count += s;
  return count;
}

/** The tile under a point, whether or not it is still standing. -1 if the point is off the floor altogether. */
export function tileIndexAt(layout: ArenaLayout, x: number, z: number): number {
  const px = x - layout.origin.x;
  const pz = z - layout.origin.z;
  const qf = ((SQRT3 / 3) * px - pz / 3) / TILE_SIZE;
  const rf = ((2 / 3) * pz) / TILE_SIZE;
  const sf = -qf - rf;
  let q = Math.round(qf);
  let r = Math.round(rf);
  const s = Math.round(sf);
  const dq = Math.abs(q - qf);
  const dr = Math.abs(r - rf);
  const ds = Math.abs(s - sf);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return layout.byKey.get(key(q, r)) ?? -1;
}

/** True if the point is over a tile that is still there. */
export function isStanding(arena: Arena, x: number, z: number): boolean {
  const index = tileIndexAt(arena.layout, x, z);
  return index >= 0 && arena.standing[index] === 1;
}

/**
 * True if a player could stand here: the floor under their center and all around their body is still there.
 * This keeps robots from hanging half over a hole.
 */
export function canStand(arena: Arena, x: number, z: number, footing = FOOTING): boolean {
  if (!isStanding(arena, x, z)) return false;
  if (footing <= 0) return true;
  for (let k = 0; k < 6; k++) {
    const angle = (k * Math.PI) / 3;
    if (!isStanding(arena, x + Math.cos(angle) * footing, z + Math.sin(angle) * footing)) return false;
  }
  return true;
}

export function removeTiles(arena: Arena, tiles: readonly number[]): void {
  for (const index of tiles) arena.standing[index] = 0;
}

/**
 * Well-spread starting places. Each new place is the standing tile farthest from all those already chosen, so
 * players begin apart from each other, wherever the arena is wide or long.
 */
export function startSpots(arena: Arena, count: number, random: () => number = Math.random): Array<{ x: number; z: number }> {
  const { tiles } = arena.layout;
  // Start from the outer half of the floor, so nobody begins in the middle.
  const middle = (t: Tile) => Math.hypot(t.x, t.z);
  const sorted = [...tiles].sort((a, b) => middle(b) - middle(a));
  const pool = sorted.slice(0, Math.max(count * 2, Math.ceil(sorted.length * 0.6)));
  const chosen: Tile[] = [pool[Math.floor(random() * pool.length)]];
  while (chosen.length < count && chosen.length < pool.length) {
    let best = pool[0];
    let bestGap = -1;
    for (const tile of pool) {
      if (chosen.includes(tile)) continue;
      const gap = Math.min(...chosen.map((c) => Math.hypot(c.x - tile.x, c.z - tile.z)));
      if (gap > bestGap) {
        bestGap = gap;
        best = tile;
      }
    }
    chosen.push(best);
  }
  // Shuffle, so the first player does not always take the same corner.
  for (let i = chosen.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [chosen[i], chosen[j]] = [chosen[j], chosen[i]];
  }
  return chosen.map((t) => ({ x: t.x + (random() - 0.5) * 1.2, z: t.z + (random() - 0.5) * 1.2 }));
}

type Pattern = { name: string; weight: number; score: (tile: Tile) => number };

/**
 * Chooses which tiles fall in the next collapse. A different shape each time: the outer edge, one whole side,
 * a trench through the middle, scattered holes, a few clusters, or the middle itself. Returns an empty list
 * once only the last few tiles are left.
 */
export function pickCollapse(arena: Arena, random: () => number = Math.random): { tiles: number[]; pattern: string } {
  const standing = arena.layout.tiles.filter((t) => arena.standing[t.index] === 1);
  const target = Math.min(standing.length - FINAL_TILES, Math.max(4, Math.round(standing.length * COLLAPSE_SHARE)));
  if (target < 1) return { tiles: [], pattern: "none" };

  const cx = standing.reduce((sum, t) => sum + t.x, 0) / standing.length;
  const cz = standing.reduce((sum, t) => sum + t.z, 0) / standing.length;
  const angle = random() * Math.PI * 2;
  const dir = { x: Math.cos(angle), z: Math.sin(angle) };
  const seeds = Array.from({ length: 3 }, () => standing[Math.floor(random() * standing.length)]);
  const noise = new Map(standing.map((t) => [t.index, random()]));

  const patterns: Pattern[] = [
    { name: "edge", weight: 2, score: (t) => Math.hypot(t.x - cx, t.z - cz) },
    { name: "side", weight: 2, score: (t) => (t.x - cx) * dir.x + (t.z - cz) * dir.z },
    { name: "trench", weight: 1, score: (t) => -Math.abs(-(t.x - cx) * dir.z + (t.z - cz) * dir.x) },
    { name: "scatter", weight: 2, score: (t) => noise.get(t.index) ?? 0 },
    { name: "clusters", weight: 2, score: (t) => -Math.min(...seeds.map((s) => Math.hypot(s.x - t.x, s.z - t.z))) },
    { name: "middle", weight: 1, score: (t) => -Math.hypot(t.x - cx, t.z - cz) },
  ];
  let pick = random() * patterns.reduce((sum, p) => sum + p.weight, 0);
  const pattern = patterns.find((p) => (pick -= p.weight) < 0) ?? patterns[0];

  const ranked = standing
    .map((t) => ({ index: t.index, score: pattern.score(t) + (noise.get(t.index) ?? 0) * 0.4 }))
    .sort((a, b) => b.score - a.score);

  // The floor that is left must stay in one piece, so nobody is ever cut off from the rest. Tiles are taken in the
  // pattern's order, and one whose loss would split the floor is skipped. Another pass picks up tiles that became
  // safe to take once their neighbours were gone.
  const left = Uint8Array.from(arena.standing);
  const chosen: number[] = [];
  let progress = true;
  while (chosen.length < target && progress) {
    progress = false;
    for (const { index } of ranked) {
      if (chosen.length >= target) break;
      if (left[index] === 0) continue;
      left[index] = 0;
      if (isOnePiece(arena.layout, left)) {
        chosen.push(index);
        progress = true;
      } else {
        left[index] = 1;
      }
    }
  }
  return chosen.length > 0 ? { tiles: chosen, pattern: pattern.name } : { tiles: [], pattern: "none" };
}

const STEPS: Array<[number, number]> = [
  [1, 0],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [0, -1],
  [1, -1],
];

/** True if every tile that is still standing can be reached from every other one by walking over standing tiles. */
export function isOnePiece(layout: ArenaLayout, standing: Uint8Array): boolean {
  const start = standing.indexOf(1);
  if (start < 0) return true;
  const seen = new Uint8Array(standing.length);
  const queue = [start];
  seen[start] = 1;
  let reached = 1;
  while (queue.length > 0) {
    const tile = layout.tiles[queue.pop() as number];
    for (const [dq, dr] of STEPS) {
      const next = layout.byKey.get(key(tile.q + dq, tile.r + dr));
      if (next === undefined || standing[next] === 0 || seen[next] === 1) continue;
      seen[next] = 1;
      reached += 1;
      queue.push(next);
    }
  }
  let total = 0;
  for (const value of standing) total += value;
  return reached === total;
}
