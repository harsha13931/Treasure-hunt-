import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FIRE_MS,
  HIDE_MS,
  REVEAL_MS,
  RESULT_MS,
  RING_SHRINK_STEP,
  START_RING_RADIUS,
  TICK_MS,
  WALK_SPEED,
} from "../shared/config.js";
import type { Pose } from "../shared/movement.js";
import type { ServerMessage } from "../shared/protocol.js";
import { Room } from "./room.js";

interface Client {
  id: string;
  messages: ServerMessage[];
}

const FACE_EAST = Math.PI / 2;
const FACE_WEST = -Math.PI / 2;
const FACE_NORTH = 0;

/** Builds a room where the players start at exactly the poses given. */
function roomWith(poses: Pose[]) {
  return new Room("TEST1", { spawn: (index) => poses[index] });
}

function connect(room: Room, name: string): Client {
  const messages: ServerMessage[] = [];
  const id = room.join(name, (message) => messages.push(message));
  return { id, messages };
}

function lastOf<T extends ServerMessage["type"]>(client: Client, type: T) {
  const found = client.messages.filter((m) => m.type === type);
  return found[found.length - 1] as Extract<ServerMessage, { type: T }> | undefined;
}

function countOf(client: Client, type: ServerMessage["type"]): number {
  return client.messages.filter((m) => m.type === type).length;
}

/** Locks every player in place, facing the yaw they were given at the start of the match. */
function lockAll(room: Room, clients: Client[], yaws: number[]) {
  clients.forEach((client, i) => room.handle(client.id, { type: "lock", yaw: yaws[i] }));
}

describe("Room", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("never sends another player's position during the hide phase", () => {
    const room = roomWith([
      { x: -5, z: 0, yaw: FACE_EAST },
      { x: 5, z: 0, yaw: FACE_WEST },
    ]);
    const a = connect(room, "Ann");
    const b = connect(room, "Ben");
    room.handle(a.id, { type: "start" });
    vi.advanceTimersByTime(TICK_MS * 3);

    expect(countOf(a, "reveal")).toBe(0);
    expect(countOf(b, "reveal")).toBe(0);

    // The hide message lists the players, but never with a position.
    const hide = lastOf(a, "hide");
    expect(hide).toBeDefined();
    for (const player of hide?.players ?? []) {
      expect(player).not.toHaveProperty("x");
      expect(player).not.toHaveProperty("z");
    }
    expect(hide?.you.x).toBe(-5);

    // Each player's own self updates carry only their own position.
    const selfB = lastOf(b, "self");
    expect(selfB?.x).toBe(5);
  });

  it("applies movement input and moves the player in the facing direction", () => {
    const room = roomWith([
      { x: -5, z: 0, yaw: FACE_EAST },
      { x: 5, z: 0, yaw: FACE_WEST },
    ]);
    const a = connect(room, "Ann");
    const b = connect(room, "Ben");
    room.handle(a.id, { type: "start" });

    // Send 20 steps of forward input, one per tick, the way the browser does.
    for (let seq = 1; seq <= 20; seq++) {
      room.handle(a.id, { type: "input", seq, forward: 1, strafe: 0, yaw: FACE_EAST });
      room.handle(b.id, { type: "input", seq, forward: 0, strafe: 0, yaw: FACE_WEST });
      vi.advanceTimersByTime(TICK_MS);
    }
    const self = lastOf(a, "self");
    expect(self).toBeDefined();
    // About one second of walking: close to WALK_SPEED meters, never more.
    expect((self?.x ?? 0) + 5).toBeGreaterThan(WALK_SPEED * 0.85);
    expect((self?.x ?? 0) + 5).toBeLessThanOrEqual(WALK_SPEED + 1e-9);
    expect(self?.ack).toBeGreaterThanOrEqual(18);
  });

  it("keeps a moving player inside the ring", () => {
    const room = roomWith([
      { x: 0, z: 0, yaw: FACE_EAST },
      { x: 0, z: 1, yaw: FACE_NORTH },
    ]);
    const a = connect(room, "Ann");
    const b = connect(room, "Ben");
    room.handle(a.id, { type: "start" });

    for (let seq = 1; seq <= 200; seq++) {
      room.handle(a.id, { type: "input", seq, forward: 1, strafe: 0, yaw: FACE_EAST });
      vi.advanceTimersByTime(TICK_MS);
    }
    const self = lastOf(a, "self");
    expect(Math.hypot(self?.x ?? 0, self?.z ?? 0)).toBeLessThanOrEqual(START_RING_RADIUS);
    expect(b.id).toBeDefined();
  });

  it("reveals as soon as every living player has locked in", () => {
    const room = roomWith([
      { x: -5, z: 0, yaw: FACE_EAST },
      { x: 5, z: 0, yaw: FACE_WEST },
    ]);
    const a = connect(room, "Ann");
    const b = connect(room, "Ben");
    room.handle(a.id, { type: "start" });

    room.handle(a.id, { type: "lock", yaw: FACE_EAST });
    expect(countOf(a, "reveal")).toBe(0);

    room.handle(b.id, { type: "lock", yaw: FACE_WEST });
    const reveal = lastOf(a, "reveal");
    expect(reveal?.players.map((p) => p.x).sort((x, y) => x - y)).toEqual([-5, 5]);
  });

  it("locks in everyone still undecided when the hide timer ends", () => {
    const room = roomWith([
      { x: -5, z: 0, yaw: FACE_EAST },
      { x: 5, z: 0, yaw: FACE_WEST },
    ]);
    const a = connect(room, "Ann");
    connect(room, "Ben");
    room.handle(a.id, { type: "start" });

    vi.advanceTimersByTime(HIDE_MS);
    expect(lastOf(a, "reveal")).toBeDefined();
  });

  it("a duel where both face each other eliminates both, so there is no winner", () => {
    const room = roomWith([
      { x: -5, z: 0, yaw: FACE_EAST },
      { x: 5, z: 0, yaw: FACE_WEST },
    ]);
    const a = connect(room, "Ann");
    const b = connect(room, "Ben");
    room.handle(a.id, { type: "start" });
    lockAll(room, [a, b], [FACE_EAST, FACE_WEST]);

    vi.advanceTimersByTime(REVEAL_MS + FIRE_MS);
    expect(lastOf(a, "fire")?.eliminated.sort()).toEqual([a.id, b.id].sort());

    vi.advanceTimersByTime(RESULT_MS);
    expect(lastOf(a, "match_over")?.winnerId).toBeNull();
  });

  it("the one who is hit is out for good and the other player wins", () => {
    const room = roomWith([
      { x: -5, z: 0, yaw: FACE_EAST },
      { x: 5, z: 0, yaw: FACE_EAST }, // Ben faces away from Ann, so only Ann can be hit
    ]);
    const a = connect(room, "Ann");
    const b = connect(room, "Ben");
    room.handle(a.id, { type: "start" });
    lockAll(room, [a, b], [FACE_EAST, FACE_EAST]);

    vi.advanceTimersByTime(REVEAL_MS + FIRE_MS);
    // Ann fires at Ben, and Ben fires away. Only Ben is hit.
    expect(lastOf(a, "fire")?.eliminated).toEqual([b.id]);

    vi.advanceTimersByTime(RESULT_MS);
    expect(lastOf(a, "match_over")?.winnerId).toBe(a.id);
    expect(countOf(a, "hide")).toBe(1);
  });

  it("when nobody is hit for two volleys in a row, the ring shrinks one step", () => {
    const room = roomWith([
      { x: -5, z: 0, yaw: FACE_WEST },
      { x: 5, z: 0, yaw: FACE_EAST },
    ]);
    const a = connect(room, "Ann");
    const b = connect(room, "Ben");
    room.handle(a.id, { type: "start" });

    const volleyLength = REVEAL_MS + FIRE_MS + RESULT_MS;

    lockAll(room, [a, b], [FACE_WEST, FACE_EAST]);
    vi.advanceTimersByTime(volleyLength);
    expect(countOf(a, "ring")).toBe(0);
    expect(countOf(a, "hide")).toBe(2);

    lockAll(room, [a, b], [FACE_WEST, FACE_EAST]);
    vi.advanceTimersByTime(volleyLength);
    expect(lastOf(a, "ring")?.radius).toBeCloseTo(START_RING_RADIUS - RING_SHRINK_STEP, 6);
    expect(room.ringRadius).toBeCloseTo(START_RING_RADIUS - RING_SHRINK_STEP, 6);
  });

  it("a player who leaves during the hide phase counts as out", () => {
    const room = roomWith([
      { x: -5, z: 0, yaw: FACE_EAST },
      { x: 5, z: 0, yaw: FACE_WEST },
    ]);
    const a = connect(room, "Ann");
    const b = connect(room, "Ben");
    room.handle(a.id, { type: "start" });

    room.leave(b.id);
    expect(lastOf(a, "match_over")?.winnerId).toBe(a.id);
  });

  it("only the host can start, and nobody can lock in outside the hide phase", () => {
    const room = roomWith([
      { x: -5, z: 0, yaw: FACE_EAST },
      { x: 5, z: 0, yaw: FACE_WEST },
    ]);
    const a = connect(room, "Ann");
    const b = connect(room, "Ben");
    room.handle(b.id, { type: "start" });
    expect(lastOf(b, "error")?.message).toBe("Only the host can start the match.");

    room.handle(a.id, { type: "lock", yaw: 0 });
    expect(lastOf(a, "error")?.message).toBe("You can only lock in during the hide phase.");
  });
});
