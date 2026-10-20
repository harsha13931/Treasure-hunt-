import { describe, expect, it } from "vitest";
import { directionFromDeg, muzzlePosition, resolveVolley, seatPosition, traceBeam, type Target } from "./geometry.js";

const origin = { x: 0, z: 0 };
const forward = { x: 1, z: 0 };

describe("traceBeam", () => {
  it("hits a target straight ahead and stops at its near edge", () => {
    const targets: Target[] = [{ id: "a", pos: { x: 5, z: 0 } }];
    const beam = traceBeam(origin, forward, 30, 0.1, targets);
    expect(beam.hit).toBe("a");
    expect(beam.to.x).toBeCloseTo(5 - 0.45 - 0.1, 5);
  });

  it("misses a target that is off the beam", () => {
    const targets: Target[] = [{ id: "a", pos: { x: 5, z: 2 } }];
    expect(traceBeam(origin, forward, 30, 0.1, targets).hit).toBeNull();
  });

  it("ignores targets behind the shooter", () => {
    const targets: Target[] = [{ id: "a", pos: { x: -5, z: 0 } }];
    expect(traceBeam(origin, forward, 30, 0.1, targets).hit).toBeNull();
  });

  it("is stopped by the nearest target when two are in line", () => {
    const targets: Target[] = [
      { id: "far", pos: { x: 8, z: 0 } },
      { id: "near", pos: { x: 4, z: 0 } },
    ];
    expect(traceBeam(origin, forward, 30, 0.1, targets).hit).toBe("near");
  });

  it("does not reach targets beyond its range", () => {
    const targets: Target[] = [{ id: "a", pos: { x: 12, z: 0 } }];
    expect(traceBeam(origin, forward, 9, 0.1, targets).hit).toBeNull();
  });

  it("a thin sniper beam misses where a wide pistol beam hits", () => {
    // Off-center by 0.5: inside the pistol's reach (0.45 + 0.12) but outside the sniper's (0.45 + 0.03).
    const targets: Target[] = [{ id: "a", pos: { x: 5, z: 0.5 } }];
    expect(traceBeam(origin, forward, 30, 0.12, targets).hit).toBe("a");
    expect(traceBeam(origin, forward, 30, 0.03, targets).hit).toBeNull();
  });
});

describe("resolveVolley", () => {
  it("two players facing each other: each is hit by the other", () => {
    const shooters = [
      { id: "a", seat: 0, aimDeg: 180, gun: "pistol" as const },
      { id: "b", seat: 12, aimDeg: 0, gun: "pistol" as const },
    ];
    const alive = shooters.map((s) => ({ id: s.id, pos: seatPosition(s.seat) }));
    const { eliminated, beams } = resolveVolley(shooters, alive);
    expect(eliminated.sort()).toEqual(["a", "b"]);
    expect(beams).toHaveLength(2);
  });

  it("a shotgun's side pellets can reach a target that the center beam misses", () => {
    const seat = 0;
    const aimDeg = 180;
    const origin = muzzlePosition(seat, aimDeg);
    // Five units out along the +8 degree pellet. The center beam passes about 0.7 away from it.
    const dir = directionFromDeg(aimDeg + 8);
    const target = { id: "b", pos: { x: origin.x + dir.x * 5, z: origin.z + dir.z * 5 } };

    const shooter = { id: "a", seat, aimDeg, gun: "shotgun" as const };
    expect(resolveVolley([shooter], [target]).eliminated).toEqual(["b"]);
    expect(resolveVolley([{ ...shooter, gun: "pistol" }], [target]).eliminated).toEqual([]);
  });

  it("does not eliminate the shooter", () => {
    const shooter = { id: "a", seat: 0, aimDeg: 0, gun: "pistol" as const };
    const { eliminated } = resolveVolley([shooter], [{ id: "a", pos: seatPosition(0) }]);
    expect(eliminated).toEqual([]);
  });
});
