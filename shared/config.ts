// Game rules and tuning values shared by the server and the browser.
// Units are meters.

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 12;
export const ROOM_CODE_LENGTH = 5;
/** Server simulation step. The browser predicts with the same step. */
export const TICK_MS = 50;

// The circle the players must stay inside. It shrinks in steps.
export const START_RING_RADIUS = 12;
export const RING_SHRINK_STEP = 2;
export const MIN_RING_RADIUS = 3.5;
/** After this many volleys in a row with no kill, the ring shrinks one step. */
export const NO_KILL_VOLLEYS_BEFORE_SHRINK = 2;

// Players and the laser pistol.
export const PLAYER_RADIUS = 0.5;
export const PLAYER_HEIGHT = 2.2;
export const WALK_SPEED = 2.8;
/** Height of the laser beam. Also the height the gun is held at. */
export const BEAM_HEIGHT = 1.7;
/** Distance from the body center to the muzzle, along the aim direction. */
export const MUZZLE_FORWARD = 0.95;
export const BEAM_HALF_WIDTH = 0.04;
export const BEAM_RANGE = 80;

// Phase timings.
export const HIDE_MS = 30_000;
export const REVEAL_MS = 3_000;
export const FIRE_MS = 1_200;
export const RESULT_MS = 2_500;

// The pit the match is played in. The cage (the ring) shrinks inside it.
export const PIT_RADIUS = 26;
export const PIT_WALL_HEIGHT = 18;
