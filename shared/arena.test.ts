import { describe, expect, it } from "vitest";
import {
  canStand,
  createArena,
  FINAL_TILES,
  isStanding,
  layoutFor,
  pickCollapse,
  removeTiles,
  standingCount,
  startSpots,
  tileIndexAt,
  TILE_SPACING,
} from "./arena.js";
import { MAP_IDS } from "./maps.js";

describe("arena layouts", () => {
  it("are the same every time, so the server and every browser agree", () => {
    for (const map of MAP_IDS) {
      const a = layoutFor(map);
      const b = layoutFor(map);
      expect(a).toBe(b);
      expect(a.tiles.map((t) => t.index)).toEqual(a.tiles.map((_, i) => i));
    }
  });

  it("are centered on the middle, and the long bridge is much longer than it is wide", () => {
    for (const map of MAP_IDS) {
      const { tiles } = layoutFor(map);
      const cx = tiles.reduce((sum, t) => sum + t.x, 0) / tiles.length;
      const cz = tiles.reduce((sum, t) => sum + t.z, 0) / tiles.length;
      expect(Math.abs(cx)).toBeLessThan(1e-6);
      expect(Math.abs(cz)).toBeLessThan(1e-6);
    }
    const bridge = layoutFor("bridge").tiles;
    const width = Math.max(...bridge.map((t) => t.x)) - Math.min(...bridge.map((t) => t.x));
    const depth = Math.max(...bridge.map((t) => t.z)) - Math.min(...bridge.map((t) => t.z));
    expect(width).toBeGreaterThan(depth * 2);
  });

  it("find the tile under any point on a tile, and say so when there is none", () => {
    for (const map of MAP_IDS) {
      const layout = layoutFor(map);
      for (const tile of layout.tiles) {
        expect(tileIndexAt(layout, tile.x, tile.z)).toBe(tile.index);
        // A point a little off center is still on the same tile.
        expect(tileIndexAt(layout, tile.x + 0.7, tile.z - 0.6)).toBe(tile.index);
      }
      expect(tileIndexAt(layout, 500, 500)).toBe(-1);
    }
  });

  it("have neighbors one tile apart", () => {
    const layout = layoutFor("frost");
    const center = layout.tiles[tileIndexAt(layout, 0, 0)];
    const east = layout.tiles[tileIndexAt(layout, TILE_SPACING, 0)];
    expect(Math.hypot(east.x - center.x, east.z - center.z)).toBeCloseTo(TILE_SPACING, 6);
  });
});

describe("standing on the floor", () => {
  it("needs the tile under you, and the floor all round your feet", () => {
    const arena = createArena("frost");
    const layout = layoutFor("frost");
    expect(canStand(arena, 0, 0)).toBe(true);
    // On the very edge of the whole arena there is no floor beyond, so your feet would hang over.
    const corner = layout.tiles.find((t) => t.q === 4 && t.r === 0)!;
    expect(isStanding(arena, corner.x, corner.z)).toBe(true);
    expect(canStand(arena, corner.x + 2.1, corner.z)).toBe(false);
  });

  it("is lost when the tile falls", () => {
    const arena = createArena("frost");
    const index = tileIndexAt(arena.layout, 0, 0);
    removeTiles(arena, [index]);
    expect(isStanding(arena, 0, 0)).toBe(false);
    expect(canStand(arena, 0, 0)).toBe(false);
    expect(standingCount(arena)).toBe(arena.layout.tiles.length - 1);
  });
});

describe("start spots", () => {
  it("are well spread out and on the floor, in every arena", () => {
    for (const map of MAP_IDS) {
      const arena = createArena(map);
      const spots = startSpots(arena, 8, () => 0.37);
      expect(spots).toHaveLength(8);
      for (const spot of spots) expect(canStand(arena, spot.x, spot.z)).toBe(true);
      const gaps = spots.flatMap((a, i) => spots.slice(i + 1).map((b) => Math.hypot(a.x - b.x, a.z - b.z)));
      expect(Math.min(...gaps)).toBeGreaterThan(2.5);
    }
  });
});

describe("collapse patterns", () => {
  it("take only standing tiles, a good share of them, and leave the last few", () => {
    for (const map of MAP_IDS) {
      const arena = createArena(map);
      const total = arena.layout.tiles.length;
      const { tiles } = pickCollapse(arena, Math.random);
      expect(tiles.length).toBeGreaterThanOrEqual(4);
      expect(tiles.length).toBeLessThan(total * 0.4);
      expect(new Set(tiles).size).toBe(tiles.length);
    }
  });

  it("vary from one collapse to the next", () => {
    const seen = new Set<string>();
    let seed = 1;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < 60; i++) seen.add(pickCollapse(createArena("frost"), random).pattern);
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });

  it("keep going until the last tiles remain, and never take those", () => {
    const arena = createArena("forest");
    for (let i = 0; i < 40; i++) {
      const { tiles } = pickCollapse(arena, Math.random);
      for (const t of tiles) expect(arena.standing[t]).toBe(1);
      removeTiles(arena, tiles);
    }
    expect(standingCount(arena)).toBe(FINAL_TILES);
    expect(pickCollapse(arena, Math.random).tiles).toEqual([]);
  });
});
