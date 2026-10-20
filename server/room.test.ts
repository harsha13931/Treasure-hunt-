import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HIDE_MS, REVEAL_MS, FIRE_MS, RESULT_MS } from "../shared/config.js";
import type { ServerMessage } from "../shared/protocol.js";
import { Room } from "./room.js";

interface Client {
  id: string;
  messages: ServerMessage[];
  send: (message: ServerMessage) => void;
}

function connect(room: Room, name: string): Client {
  const messages: ServerMessage[] = [];
  const send = (message: ServerMessage) => messages.push(message);
  const id = room.join(name, "pistol", send);
  return { id, messages, send };
}

function lastOf<T extends ServerMessage["type"]>(client: Client, type: T) {
  const found = client.messages.filter((m) => m.type === type);
  return found[found.length - 1] as Extract<ServerMessage, { type: T }> | undefined;
}

describe("Room", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("never sends another player's seat or aim during the hide phase", () => {
    const room = new Room("TEST1");
    const a = connect(room, "Ann");
    const b = connect(room, "Ben");
    room.handle(a.id, { type: "start" });

    room.handle(a.id, { type: "choose", seat: 0 });
    room.handle(a.id, { type: "aim", aimDeg: 170 });
    room.handle(b.id, { type: "choose", seat: 12 });
    room.handle(b.id, { type: "aim", aimDeg: 10 });

    // Each player's latest hide message, as their browser would see it.
    for (const client of [a, b]) {
      const payloads = client.messages.filter((m) => m.type === "hide");
      for (const message of payloads) {
        if (message.type !== "hide") continue;
        for (const player of message.players) {
          expect(player).not.toHaveProperty("seat");
          expect(player).not.toHaveProperty("aimDeg");
        }
      }
    }

    const lastForB = lastOf(b, "hide");
    expect(lastForB?.you.seat).toBe(12);
    expect(lastForB?.you.aimDeg).toBe(10);
  });

  it("reveals as soon as every living player has locked in", () => {
    const room = new Room("TEST2");
    const a = connect(room, "Ann");
    const b = connect(room, "Ben");
    room.handle(a.id, { type: "start" });

    room.handle(a.id, { type: "choose", seat: 0 });
    room.handle(a.id, { type: "lock" });
    expect(lastOf(a, "reveal")).toBeUndefined();

    room.handle(b.id, { type: "choose", seat: 12 });
    room.handle(b.id, { type: "lock" });
    const reveal = lastOf(a, "reveal");
    expect(reveal?.players.map((p) => p.seat).sort((x, y) => (x ?? 0) - (y ?? 0))).toEqual([0, 12]);
  });

  it("fills in undecided players when the hide timer ends", () => {
    const room = new Room("TEST3");
    const a = connect(room, "Ann");
    connect(room, "Ben");
    room.handle(a.id, { type: "start" });

    vi.advanceTimersByTime(HIDE_MS);
    const reveal = lastOf(a, "reveal");
    expect(reveal).toBeDefined();
    expect(reveal?.players.every((p) => p.seat !== null)).toBe(true);
  });

  it("the facing duel ends with one winner and a point for that player", () => {
    const room = new Room("TEST4");
    const a = connect(room, "Ann");
    const b = connect(room, "Ben");
    room.handle(a.id, { type: "start" });

    room.handle(a.id, { type: "choose", seat: 0 });
    room.handle(a.id, { type: "aim", aimDeg: 180 });
    room.handle(a.id, { type: "lock" });
    room.handle(b.id, { type: "choose", seat: 12 });
    room.handle(b.id, { type: "aim", aimDeg: 0 });
    room.handle(b.id, { type: "lock" });

    vi.advanceTimersByTime(REVEAL_MS + FIRE_MS);
    const fire = lastOf(a, "fire");
    expect(fire?.eliminated.sort()).toEqual([a.id, b.id].sort());

    vi.advanceTimersByTime(RESULT_MS);
    const over = lastOf(a, "round_over");
    expect(over?.winnerId).toBeNull();
  });

  it("a one-sided duel eliminates only the player who was hit and awards the round", () => {
    const room = new Room("TEST5");
    const a = connect(room, "Ann");
    const b = connect(room, "Ben");
    room.handle(a.id, { type: "start" });

    // Ann's gun points at Ben. Ben's gun points away from Ann, so only Ben can be hit.
    room.handle(a.id, { type: "choose", seat: 0 });
    room.handle(a.id, { type: "aim", aimDeg: 180 });
    room.handle(a.id, { type: "lock" });
    room.handle(b.id, { type: "choose", seat: 12 });
    room.handle(b.id, { type: "aim", aimDeg: 180 });
    room.handle(b.id, { type: "lock" });

    vi.advanceTimersByTime(REVEAL_MS + FIRE_MS);
    expect(lastOf(a, "fire")?.eliminated).toEqual([b.id]);

    vi.advanceTimersByTime(RESULT_MS);
    expect(lastOf(a, "round_over")?.winnerId).toBe(a.id);
  });

  it("when nobody is hit, the round continues with another volley", () => {
    const room = new Room("TEST8");
    const a = connect(room, "Ann");
    const b = connect(room, "Ben");
    room.handle(a.id, { type: "start" });

    // Both players aim away from each other.
    room.handle(a.id, { type: "choose", seat: 0 });
    room.handle(a.id, { type: "aim", aimDeg: 0 });
    room.handle(a.id, { type: "lock" });
    room.handle(b.id, { type: "choose", seat: 12 });
    room.handle(b.id, { type: "aim", aimDeg: 180 });
    room.handle(b.id, { type: "lock" });

    vi.advanceTimersByTime(REVEAL_MS + FIRE_MS);
    expect(lastOf(a, "fire")?.eliminated).toEqual([]);

    vi.advanceTimersByTime(RESULT_MS);
    expect(lastOf(a, "hide")?.volley).toBe(2);
  });

  it("rejects seat choices that another living player already holds", () => {
    const room = new Room("TEST6");
    const a = connect(room, "Ann");
    const b = connect(room, "Ben");
    room.handle(a.id, { type: "start" });

    room.handle(a.id, { type: "choose", seat: 5 });
    room.handle(b.id, { type: "choose", seat: 5 });
    expect(lastOf(b, "error")?.message).toBe("That seat is taken.");
  });

  it("only the host can start a match", () => {
    const room = new Room("TEST7");
    const a = connect(room, "Ann");
    const b = connect(room, "Ben");
    room.handle(b.id, { type: "start" });
    expect(lastOf(b, "error")?.message).toBe("Only the host can start the match.");
    expect(lastOf(a, "hide")).toBeUndefined();
  });
});
