import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FIRE_MS,
  HIDE_MS,
  QUICK_START_DELAY_MS,
  REVEAL_MS,
  RESULT_MS,
  RECONNECT_GRACE_MS,
  RING_SHRINK_STEP,
  SONAR_NOISE,
  ROOM_SIZE,
  START_RING_RADIUS,
  TICK_MS,
  WALK_SPEED,
} from "../shared/config.js";
import { startPoseFor, type Pose } from "../shared/movement.js";
import type { ServerMessage } from "../shared/protocol.js";
import { Room, type MatchSummary } from "./room.js";

interface Client {
  id: string;
  messages: ServerMessage[];
}

const FACE_EAST = Math.PI / 2;
const FACE_WEST = -Math.PI / 2;
const FACE_NORTH = 0;

/** Builds a room where the players start at exactly the poses given. */
function roomWith(poses: Pose[]) {
  return new Room("TEST1", { spawn: (index, count) => poses[index] ?? startPoseFor(index, count) });
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
    expect((self?.x ?? 0) + 5).toBeGreaterThan(WALK_SPEED * 0.75);
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

  it("a player standing on the outer ice when it breaks falls and is out", () => {
    const edge = START_RING_RADIUS - 1; // as far out as the ring lets anyone stand
    const room = roomWith([
      { x: -5, z: 0, yaw: FACE_NORTH },
      { x: 5, z: 0, yaw: FACE_NORTH },
      { x: edge, z: 0, yaw: FACE_EAST },
    ]);
    const a = connect(room, "Ann");
    const b = connect(room, "Ben");
    const c = connect(room, "Cy");
    room.handle(a.id, { type: "start" });
    const volleyLength = REVEAL_MS + FIRE_MS + RESULT_MS;
    const lock = () => lockAll(room, [a, b, c], [FACE_NORTH, FACE_NORTH, FACE_EAST]);

    // Nobody can fall until the ice actually breaks, and nobody is warned ahead of time.
    lock();
    vi.advanceTimersByTime(volleyLength);
    expect(countOf(a, "ring")).toBe(0);
    expect(JSON.stringify(lastOf(a, "hide"))).not.toMatch(/edge|nextRadius/);

    lock();
    vi.advanceTimersByTime(REVEAL_MS + FIRE_MS + RESULT_MS);
    expect(lastOf(a, "ring")?.fallen).toEqual([c.id]);

    // Cy is out for good and the other two carry on.
    expect(lastOf(c, "hide")?.you.alive).toBe(false);
    expect(lastOf(a, "hide")?.players.find((p) => p.id === c.id)?.alive).toBe(false);
    expect(lastOf(a, "hide")?.you.alive).toBe(true);
  });

  it("a player inside the new edge survives the floor breaking", () => {
    const room = roomWith([
      { x: -5, z: 0, yaw: FACE_NORTH },
      { x: START_RING_RADIUS - RING_SHRINK_STEP - 0.5, z: 0, yaw: FACE_EAST },
    ]);
    const a = connect(room, "Ann");
    const b = connect(room, "Ben");
    room.handle(a.id, { type: "start" });
    const volleyLength = REVEAL_MS + FIRE_MS + RESULT_MS;
    for (let i = 0; i < 2; i++) {
      lockAll(room, [a, b], [FACE_NORTH, FACE_EAST]);
      vi.advanceTimersByTime(volleyLength);
    }
    expect(lastOf(a, "ring")?.fallen).toEqual([]);
    expect(lastOf(b, "hide")?.you.alive).toBe(true);
  });

  describe("sonar", () => {
    function duel() {
      const room = roomWith([
        { x: -6, z: 0, yaw: FACE_NORTH },
        { x: 6, z: 0, yaw: FACE_NORTH },
        { x: 6, z: -14, yaw: FACE_NORTH },
      ]);
      const a = connect(room, "Ann");
      const b = connect(room, "Ben");
      const c = connect(room, "Cy");
      room.handle(a.id, { type: "start" });
      return { room, a, b, c };
    }

    it("points roughly at the nearest enemy, says how far, and warns that enemy", () => {
      const { room, a, b, c } = duel();
      room.handle(a.id, { type: "sonar" });
      const result = lastOf(a, "sonar_result");
      expect(result).toBeDefined();
      // Ben is due east of Ann, 12 meters away. East is yaw +90 degrees.
      expect(Math.abs((result?.bearing ?? 0) - Math.PI / 2)).toBeLessThanOrEqual(SONAR_NOISE + 1e-9);
      expect(result?.band).toBe("mid");
      expect(countOf(b, "sonar_alert")).toBe(1);
      expect(countOf(c, "sonar_alert")).toBe(0);
      expect(countOf(a, "sonar_alert")).toBe(0);
    });

    it("works once per match", () => {
      const { room, a } = duel();
      room.handle(a.id, { type: "sonar" });
      room.handle(a.id, { type: "sonar" });
      expect(lastOf(a, "error")?.message).toBe("You already used your sonar ping.");
      expect(countOf(a, "sonar_result")).toBe(1);
    });

    it("does not work after locking in", () => {
      const { room, a } = duel();
      room.handle(a.id, { type: "lock", yaw: FACE_NORTH });
      room.handle(a.id, { type: "sonar" });
      expect(lastOf(a, "error")?.message).toBe("You are locked in.");
      expect(countOf(a, "sonar_result")).toBe(0);
    });
  });

  describe("reconnecting", () => {
    function setup() {
      const room = roomWith([
        { x: -5, z: 0, yaw: FACE_NORTH },
        { x: 5, z: 0, yaw: FACE_NORTH },
      ]);
      const sendA = (m: ServerMessage) => messagesA.push(m);
      const messagesA: ServerMessage[] = [];
      const idA = room.join("Ann", sendA);
      const b = connect(room, "Ben");
      room.handle(idA, { type: "start" });
      const token = (messagesA.find((m) => m.type === "joined") as Extract<ServerMessage, { type: "joined" }>).token;
      return { room, idA, sendA, messagesA, b, token };
    }

    it("holds a dropped player's spot, and the round does not wait for them", () => {
      const { room, idA, sendA, b } = setup();
      room.disconnect(idA, sendA);
      expect(room.currentPhase).toBe("HIDE");
      // Ben locks in; Ann's connection is down, so she counts as locked and the reveal comes at once.
      room.handle(b.id, { type: "lock", yaw: FACE_NORTH });
      expect(room.currentPhase).toBe("REVEAL");
      expect(lastOf(b, "reveal")?.players).toHaveLength(2);
    });

    it("lets the player back in with their token and shows them the current scene", () => {
      const { room, idA, sendA, token, b } = setup();
      room.disconnect(idA, sendA);
      room.handle(b.id, { type: "lock", yaw: FACE_NORTH });

      const back: ServerMessage[] = [];
      room.reconnect(idA, token, (m) => back.push(m));
      expect(back.find((m) => m.type === "joined")).toBeDefined();
      expect(back.find((m) => m.type === "reveal")).toBeDefined();

      vi.advanceTimersByTime(REVEAL_MS + 10);
      expect(back.find((m) => m.type === "fire")).toBeDefined();
    });

    it("sends a returning player the hide screen when they come back mid-round", () => {
      const { room, idA, sendA, token } = setup();
      room.disconnect(idA, sendA);
      const back: ServerMessage[] = [];
      room.reconnect(idA, token, (m) => back.push(m));
      const hide = back.find((m) => m.type === "hide") as Extract<ServerMessage, { type: "hide" }>;
      expect(hide.you.x).toBe(-5);
      expect(hide.you.locked).toBe(true);
    });

    it("refuses the wrong token", () => {
      const { room, idA, sendA } = setup();
      room.disconnect(idA, sendA);
      expect(() => room.reconnect(idA, "nope", () => {})).toThrow();
    });

    it("ignores a late close from an old connection after the player is back", () => {
      const { room, idA, sendA, token } = setup();
      room.disconnect(idA, sendA);
      const back: ServerMessage[] = [];
      const newSend = (m: ServerMessage) => back.push(m);
      room.reconnect(idA, token, newSend);
      room.disconnect(idA, sendA); // the old socket finally reports it closed
      vi.advanceTimersByTime(RECONNECT_GRACE_MS + 1000);
      expect(room.isEmpty).toBe(false);
      // Still connected: a real drop of the new connection is what counts.
      room.disconnect(idA, newSend);
      vi.advanceTimersByTime(RECONNECT_GRACE_MS + 1000);
      expect(room.isEmpty).toBe(false); // Ben is still here
    });

    it("gives up on a player who stays away too long, and tells the room when it empties", () => {
      let emptied = 0;
      const room = new Room("GONE1", { onEmpty: () => emptied++, spawn: (i) => ({ x: i * 10 - 5, z: 0, yaw: 0 }) });
      const sendA = () => {};
      const idA = room.join("Ann", sendA);
      const sendB = () => {};
      const idB = room.join("Ben", sendB);
      room.handle(idA, { type: "start" });
      room.disconnect(idA, sendA);
      room.disconnect(idB, sendB);
      expect(emptied).toBe(0);
      vi.advanceTimersByTime(RECONNECT_GRACE_MS + 1000);
      expect(emptied).toBe(1);
    });
  });

  it("reports a summary of each finished match", () => {
    const summaries: MatchSummary[] = [];
    const room = new Room("LOG01", {
      onMatchEnd: (s) => summaries.push(s),
      spawn: (i) => ({ x: i === 0 ? -5 : 5, z: 0, yaw: i === 0 ? FACE_EAST : FACE_NORTH, vx: 0, vz: 0 }),
    });
    const a = connect(room, "Ann");
    const b = connect(room, "Ben");
    room.handle(a.id, { type: "start" });
    lockAll(room, [a, b], [FACE_EAST, FACE_NORTH]);
    vi.advanceTimersByTime(REVEAL_MS + FIRE_MS + RESULT_MS + 100);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ room: "LOG01", people: 2, bots: 0, shot: 1, fell: 0, winner: "person" });
  });

  it("says who was knocked out and by whom", () => {
    const room = roomWith([
      { x: -5, z: 0, yaw: FACE_EAST },
      { x: 5, z: 0, yaw: FACE_NORTH },
    ]);
    const a = connect(room, "Ann");
    const b = connect(room, "Ben");
    room.handle(a.id, { type: "start" });
    lockAll(room, [a, b], [FACE_EAST, FACE_NORTH]);
    vi.advanceTimersByTime(REVEAL_MS + 10);
    expect(lastOf(a, "fire")?.kills).toEqual([{ victim: b.id, killers: [a.id] }]);
  });

  it("also shrinks the ring every few volleys, even when there are kills", () => {
    // Five players in a row. Player 0 faces east and knocks out one more player each volley,
    // so there is a kill every time and the "nobody was hit" rule never applies.
    const xs = [-8, -4, 0, 4, 8];
    const room = new Room("FORCE", {
      spawn: (index) => ({ x: xs[index], z: 0, yaw: index === 0 ? FACE_EAST : FACE_NORTH, vx: 0, vz: 0 }),
    });
    const clients = ["Ann", "Ben", "Cy", "Di", "Ed"].map((name) => connect(room, name));
    room.handle(clients[0].id, { type: "start" });
    const volleyLength = REVEAL_MS + FIRE_MS + RESULT_MS;

    const lockAlive = () =>
      clients.forEach((client, i) => room.handle(client.id, { type: "lock", yaw: i === 0 ? FACE_EAST : FACE_NORTH }));

    lockAlive();
    vi.advanceTimersByTime(volleyLength);
    expect(lastOf(clients[0], "fire")?.eliminated).toHaveLength(1);
    lockAlive();
    vi.advanceTimersByTime(volleyLength);
    expect(lastOf(clients[0], "fire")?.eliminated).toHaveLength(1);
    expect(countOf(clients[0], "ring")).toBe(0);

    // The third volley also has a kill, and the ring closes in anyway.
    lockAlive();
    vi.advanceTimersByTime(REVEAL_MS + FIRE_MS);
    expect(lastOf(clients[0], "fire")?.eliminated).toHaveLength(1);
    expect(lastOf(clients[0], "ring")?.radius).toBeCloseTo(START_RING_RADIUS - RING_SHRINK_STEP, 6);
  });

  it("ranks the winner first and the first player knocked out last", () => {
    const room = roomWith([
      { x: -5, z: 0, yaw: FACE_EAST },
      { x: 5, z: 0, yaw: FACE_EAST },
    ]);
    const a = connect(room, "Ann");
    const b = connect(room, "Ben");
    room.handle(a.id, { type: "start" });
    lockAll(room, [a, b], [FACE_EAST, FACE_EAST]);
    vi.advanceTimersByTime(REVEAL_MS + FIRE_MS + RESULT_MS);

    expect(lastOf(a, "match_over")?.ranking).toEqual([a.id, b.id]);
  });

  describe("public matches", () => {
    it("start by themselves a little while after a second player joins", () => {
      const room = new Room("PUB01", { isPublic: true });
      const a = connect(room, "Ann");
      expect(lastOf(a, "lobby")?.startsAt).toBeNull();

      connect(room, "Ben");
      const lobby = lastOf(a, "lobby");
      expect(lobby?.isPublic).toBe(true);
      expect(lobby?.startsAt).not.toBeNull();
      expect(lastOf(a, "hide")).toBeUndefined();

      vi.advanceTimersByTime(QUICK_START_DELAY_MS);
      expect(lastOf(a, "hide")).toBeDefined();
    });

    it("stop waiting if the second player leaves before the start", () => {
      const room = new Room("PUB02", { isPublic: true });
      const a = connect(room, "Ann");
      const b = connect(room, "Ben");
      room.leave(b.id);
      expect(lastOf(a, "lobby")?.startsAt).toBeNull();

      vi.advanceTimersByTime(QUICK_START_DELAY_MS * 2);
      expect(lastOf(a, "hide")).toBeUndefined();
    });

    it("are not started automatically when private", () => {
      const room = new Room("PRIV1");
      const a = connect(room, "Ann");
      connect(room, "Ben");
      vi.advanceTimersByTime(QUICK_START_DELAY_MS * 2);
      expect(lastOf(a, "hide")).toBeUndefined();
    });
  });

  describe("bots", () => {
    it("lets one person play against seven bots", () => {
      const room = roomWith([{ x: 0, z: 0, yaw: 0 }]);
      const a = connect(room, "Ann");
      room.handle(a.id, { type: "start", bots: 7 });

      const hide = lastOf(a, "hide");
      expect(hide?.players).toHaveLength(ROOM_SIZE);
      expect(hide?.players.filter((p) => p.bot)).toHaveLength(ROOM_SIZE - 1);
      expect(hide?.players.filter((p) => !p.bot)).toHaveLength(1);
    });

    it("needs at least two players in total, so one person alone cannot start", () => {
      const room = roomWith([{ x: 0, z: 0, yaw: 0 }]);
      const a = connect(room, "Ann");
      room.handle(a.id, { type: "start", bots: 0 });
      expect(lastOf(a, "error")?.message).toContain("at least 2 players");
      expect(lastOf(a, "hide")).toBeUndefined();
    });

    it("lets one person and one bot play, so a full room is never required", () => {
      const room = new Room("BOTS2");
      const a = connect(room, "Ann");
      room.handle(a.id, { type: "start", bots: 1 });
      const hide = lastOf(a, "hide");
      expect(hide?.players).toHaveLength(2);
      expect(hide?.players.filter((p) => p.bot)).toHaveLength(1);
    });

    it("never adds more bots than the room has spots", () => {
      const room = new Room("BOTS9");
      const a = connect(room, "Ann");
      room.handle(a.id, { type: "start", bots: 99, difficulty: "hard" });
      expect(lastOf(a, "hide")?.players).toHaveLength(ROOM_SIZE);
    });

    it("tops up a half-full room: three people get five bots", () => {
      const room = new Room("BOTS3");
      const a = connect(room, "Ann");
      connect(room, "Ben");
      connect(room, "Cy");
      room.handle(a.id, { type: "start", bots: 5 });
      const hide = lastOf(a, "hide");
      expect(hide?.players).toHaveLength(ROOM_SIZE);
      expect(hide?.players.filter((p) => p.bot)).toHaveLength(5);
    });

    it("never reveals a bot's position during the hide phase", () => {
      const room = new Room("BOTS4");
      const a = connect(room, "Ann");
      room.handle(a.id, { type: "start", bots: 7 });
      vi.advanceTimersByTime(TICK_MS * 10);

      expect(countOf(a, "reveal")).toBe(0);
      for (const message of a.messages) {
        if (message.type === "hide") {
          for (const player of message.players) {
            expect(player).not.toHaveProperty("x");
            expect(player).not.toHaveProperty("z");
          }
        }
        // The only position a person ever receives during hide is their own.
        if (message.type === "self") expect(Object.keys(message)).not.toContain("players");
      }
    });

    it("bots lock in as soon as every living person has, so people never wait for them", () => {
      const room = new Room("BOTS5");
      const a = connect(room, "Ann");
      room.handle(a.id, { type: "start", bots: 7 });

      expect(countOf(a, "reveal")).toBe(0);
      room.handle(a.id, { type: "lock", yaw: 0 });
      const reveal = lastOf(a, "reveal");
      expect(reveal?.players).toHaveLength(ROOM_SIZE);
      expect(reveal?.players.filter((p) => p.name.startsWith("Bot "))).toHaveLength(ROOM_SIZE - 1);
    });

    it("bots walk, stay inside the ring, and lock in on their own when the timer ends", () => {
      const room = new Room("BOTS6");
      const a = connect(room, "Ann");
      room.handle(a.id, { type: "start", bots: 7 });

      vi.advanceTimersByTime(HIDE_MS);
      const reveal = lastOf(a, "reveal");
      expect(reveal).toBeDefined();
      for (const player of reveal?.players ?? []) {
        expect(Math.hypot(player.x, player.z)).toBeLessThanOrEqual(START_RING_RADIUS);
      }
    });

    it("removes the bots when the match ends, and does not let bots keep a room alive", () => {
      const room = new Room("BOTS7");
      const a = connect(room, "Ann");
      room.handle(a.id, { type: "start", bots: 7 });
      room.leave(a.id);

      expect(room.isEmpty).toBe(true);
    });

    it("lets bots finish a match on their own after the last person is out", () => {
      const room = new Room("BOTS8");
      const a = connect(room, "Ann");
      room.handle(a.id, { type: "start", bots: 7 });
      room.handle(a.id, { type: "lock", yaw: 0 });

      // Run long enough for several volleys. Quick bots-only volleys must end the match.
      vi.advanceTimersByTime(10 * 60 * 1000);
      const over = lastOf(a, "match_over");
      expect(over).toBeDefined();
      expect(lastOf(a, "lobby")?.players.every((p) => !p.bot)).toBe(true);
    });
  });
});
