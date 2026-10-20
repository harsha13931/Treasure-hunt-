// Game constants shared by the server and the client.
// Units are world units; the ring has radius RING_RADIUS.

export const RING_RADIUS = 10;
export const SEAT_COUNT = 24;
export const PLAYER_RADIUS = 0.45;
export const GUN_LENGTH = 0.9;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 12;
export const ROUNDS_PER_MATCH = 5;
export const HIDE_MS = 20_000;
export const REVEAL_MS = 3_000;
export const FIRE_MS = 1_500;
export const RESULT_MS = 2_500;
export const ROUND_BREAK_MS = 4_000;
export const ROOM_CODE_LENGTH = 5;

export type GunId = "pistol" | "sniper" | "shotgun" | "twin";

export interface GunSpec {
  id: GunId;
  name: string;
  /** Angles (degrees) of each beam relative to the aim direction. */
  spreadDeg: number[];
  /** Half-width of each beam; bigger means easier to hit. */
  beamHalfWidth: number;
  /** Maximum distance a beam travels from the muzzle. */
  range: number;
  /** Accent color used for the gun and its laser. */
  color: string;
  /** One line shown in the gun picker. */
  blurb: string;
}

export const GUNS: Record<GunId, GunSpec> = {
  pistol: {
    id: "pistol",
    name: "Pistol",
    spreadDeg: [0],
    beamHalfWidth: 0.12,
    range: 30,
    color: "#38bdf8",
    blurb: "Balanced. One beam, medium width.",
  },
  sniper: {
    id: "sniper",
    name: "Sniper",
    spreadDeg: [0],
    beamHalfWidth: 0.03,
    range: 30,
    color: "#a3e635",
    blurb: "Pinpoint. A thin beam that is hard to land.",
  },
  shotgun: {
    id: "shotgun",
    name: "Shotgun",
    spreadDeg: [-16, -8, 0, 8, 16],
    beamHalfWidth: 0.2,
    range: 9,
    color: "#fb923c",
    blurb: "Five pellets. Deadly, but only up close.",
  },
  twin: {
    id: "twin",
    name: "Twin",
    spreadDeg: [-3, 3],
    beamHalfWidth: 0.1,
    range: 30,
    color: "#e879f9",
    blurb: "Two beams fanned slightly apart.",
  },
};

export const GUN_IDS = Object.keys(GUNS) as GunId[];
