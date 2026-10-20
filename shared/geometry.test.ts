import { describe, expect, it } from "vitest";
import { BEAM_HALF_WIDTH, BEAM_RANGE, MUZZLE_FORWARD, PLAYER_RADIUS } from "./config.js";
import { muzzlePosition, resolveVolley, traceBeam, type Target } from "./geometry.js";

const origin = { x: 0, z: 0 };
const forward = { x: 1, z: 0 };

describe("traceBeam", () => {
  it("hits a target straight ahead and stops at its near edge", () => {
    const targets: Target[] = [{ id: "a", pos: { x: 5, z: 0 } }];
    const beam = traceBeam(origin, forward, targets);
    expect(beam.hit).toBe("a");
    expect(beam.to.x).toBeCloseTo(5 - PLAYER_RADIUS - BEAM_HALF_WIDTH, 5);
  });

  it("misses a target that is off to the side", () => {
    // Clear of the body and the beam width, so it can never touch.
    const targets: Target[] = [{ id: "a", pos: { x: 5, z: PLAYER_RADIUS + BEAM_HALF_WIDTH + 0.5 } }];
    expect(traceBeam(origin, forward, targets).hit).toBeNull();
  });

  it("ignores targets behind the shooter", () => {
    const targets: Target[] = [{ id: "a", pos: { x: -5, z: 0 } }];
    expect(traceBeam(origin, forward, targets).hit).toBeNull();
  });

  it("is stopped by the nearest target when two are in line", () => {
    const targets: Target[] = [
      { id: "far", pos: { x: 8, z: 0 } },
      { id: "near", pos: { x: 4, z: 0 } },
    ];
    expect(traceBeam(origin, forward, targets).hit).toBe("near");
  });

  it("does not reach a target beyond the beam range", () => {
    const targets: Target[] = [{ id: "a", pos: { x: BEAM_RANGE + 5, z: 0 } }];
    expect(traceBeam(origin, forward, targets).hit).toBeNull();
  });
});

describe("resolveVolley", () => {
  it("two players facing each other are both hit", () => {
    const a = { id: "a", pos: { x: -5, z: 0 }, yaw: Math.PI / 2 };
    const b = { id: "b", pos: { x: 5, z: 0 }, yaw: -Math.PI / 2 };
    const { eliminated, beams } = resolveVolley([a, b], [a, b].map((s) => ({ id: s.id, pos: s.pos })));
    expect(eliminated.sort()).toEqual(["a", "b"]);
    expect(beams).toHaveLength(2);
  });

  it("records who hit whom", () => {
    const a = { id: "a", pos: { x: -5, z: 0 }, yaw: Math.PI / 2 };
    const b = { id: "b", pos: { x: 5, z: 0 }, yaw: Math.PI / 2 };
    const c = { id: "c", pos: { x: 5, z: -9 }, yaw: 0 };
    const { kills } = resolveVolley([a, b, c], [a, b, c].map((s) => ({ id: s.id, pos: s.pos })));
    expect(kills).toEqual([{ victim: "b", killers: ["a", "c"] }]);
  });

  it("a player facing away from the other is not hit", () => {
    const a = { id: "a", pos: { x: -5, z: 0 }, yaw: -Math.PI / 2 };
    const b = { id: "b", pos: { x: 5, z: 0 }, yaw: Math.PI / 2 };
    const { eliminated } = resolveVolley([a, b], [a, b].map((s) => ({ id: s.id, pos: s.pos })));
    expect(eliminated).toEqual([]);
  });

  it("the muzzle sits in front of the body along the facing direction", () => {
    const muzzle = muzzlePosition({ x: 0, z: 0 }, 0);
    expect(muzzle.x).toBeCloseTo(0, 6);
    expect(muzzle.z).toBeCloseTo(MUZZLE_FORWARD, 6);
  });
});
