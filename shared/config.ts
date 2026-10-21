// Game rules and tuning values shared by the server and the browser.
// Units are meters.

export const MIN_PLAYERS = 2;
/**
 * One color per seat, all easy to tell apart on white snow. A room never has more players than colors,
 * and the server hands each player a color nobody else in the room has.
 */
export const PLAYER_COLORS = ["#e5484d", "#2f7de1", "#f2c230", "#2fb344", "#8b5cf6", "#ff5fb0", "#19c3d6", "#f26b21"] as const;

/** A full room. Empty spots can be filled with bots up to this number. */
export const ROOM_SIZE = 8;
export const MAX_PLAYERS = ROOM_SIZE;
export const ROOM_CODE_LENGTH = 5;
/** Server simulation step. The browser predicts with the same step. */
export const TICK_MS = 50;

// The floor breaks in pieces. After every second round, and after any round in which nobody was hit, a patch of the
// floor (see shared/arena.ts) falls away, and anyone standing on it falls too. Tiles that will fall are shown
// cracked for the whole round before, so everyone can see them and nobody is caught out by luck alone.
export const COLLAPSE_EVERY_ROUNDS = 2;

// A round can have a twist, announced when it starts.
export type Twist = "none" | "wide" | "fast" | "dark";
/** Wide: every beam is this many times as wide. */
export const TWIST_BEAM_SCALE = 2.4;
/** Fast: everyone walks this many times as fast. */
export const TWIST_SPEED_SCALE = 1.45;
/** From the second round on, this share of rounds has a twist. */
export const TWIST_CHANCE = 0.5;
/** In a public match, how long the lobby waits after the second player joins before it starts. */
export const QUICK_START_DELAY_MS = 15_000;

// Players and the laser pistol.
export const PLAYER_RADIUS = 1;
export const PLAYER_HEIGHT = 4.8;
export const WALK_SPEED = 4.6;
/** Height of the laser beam. Also the height the gun is held at. */
export const BEAM_HEIGHT = 2.75;
/** Distance from the body center to the muzzle, along the aim direction. */
export const MUZZLE_FORWARD = 1.92;
export const BEAM_HALF_WIDTH = 0.09;
export const BEAM_RANGE = 80;

/** Bot skill from 0 (easy) to 1 (hard). */
export const BOT_SKILL = { easy: 0.15, normal: 0.5, hard: 0.9 } as const;
export type BotDifficulty = keyof typeof BOT_SKILL;

/** How long a dropped player's spot is held during a match, so a phone that loses signal can come back. */
export const RECONNECT_GRACE_MS = 45_000;

// Phase timings.
export const HIDE_MS = 30_000;
export const REVEAL_MS = 3_000;
export const FIRE_MS = 1_200;
export const RESULT_MS = 2_500;

// The world around the arena. Every arena hangs over a deep drop.
export const WORLD_RADIUS = 380;
/** How far down the bottom of the drop is. Tiles that break away fall this far. */
export const PIT_DEPTH = 50;
