import { describe, expect, it } from "vitest";
import { MIN_RING_RADIUS, PLAYER_RADIUS, START_RING_RADIUS } from "./config.js";
import { resolveVolley, traceBeam } from "./geometry.js";
import { stepPose, type Pose } from "./movement.js";
import { activePillars, beamDistanceToPillar, PILLARS, pushOutOfPillars } from "./obstacles.js";

const pillar = { x: 0, z: 5, r: 1.3 };

describe("pillars", () => {
  it("block a beam, and the beam stops at the near face", () => {
    const d = beamDistanceToPillar({ x: 0, z: 0 }, { x: 0, z: 1 }, [pillar], 80);
    expect(d).toBeCloseTo(5 - 1.3, 6);
  });

  it("do not block a beam that passes beside them", () => {
    expect(beamDistanceToPillar({ x: 3, z: 0 }, { x: 0, z: 1 }, [pillar], 80)).toBeNull();
  });

  it("ignore a pillar behind the muzzle", () => {
    expect(beamDistanceToPillar({ x: 0, z: 9 }, { x: 0, z: 1 }, [pillar], 80)).toBeNull();
  });

  it("give cover: a player behind a pillar is not hit, a player in the open is", () => {
    const shooter = { id: "a", pos: { x: 0, z: -3 }, yaw: 0 };
    const hidden = { id: "b", pos: { x: 0, z: 9 }, yaw: Math.PI };
    const open = { id: "c", pos: { x: 0, z: 9 }, yaw: Math.PI };
    const behind = resolveVolley([shooter], [shooter, hidden].map((p) => ({ id: p.id, pos: p.pos })), [pillar]);
    expect(behind.eliminated).toEqual([]);
    const clear = resolveVolley([shooter], [shooter, open].map((p) => ({ id: p.id, pos: p.pos })), []);
    expect(clear.eliminated).toEqual(["c"]);
    // The blocked beam ends at the pillar, not at the player.
    expect(traceBeam({ x: 0, z: -1 }, { x: 0, z: 1 }, [{ id: "b", pos: hidden.pos }], [pillar]).hit).toBeNull();
  });

  it("stop players walking through them, and let them slide along the side", () => {
    let pose: Pose = { x: 0, z: 0, yaw: 0, vx: 0, vz: 0 };
    for (let i = 0; i < 200; i++) {
      pose = stepPose(pose, { seq: i, forward: 1, strafe: 0.3, yaw: 0 }, 0.05, 18, [pillar]);
      expect(Math.hypot(pose.x - pillar.x, pose.z - pillar.z)).toBeGreaterThanOrEqual(pillar.r + PLAYER_RADIUS - 1e-6);
    }
    // Pushing diagonally into it carries the player past instead of pinning them.
    expect(pose.z).toBeGreaterThan(pillar.z);
  });

  it("push a position that is inside one back out", () => {
    const out = pushOutOfPillars(0, 5.5, [pillar]);
    expect(Math.hypot(out.x - pillar.x, out.z - pillar.z)).toBeCloseTo(pillar.r + PLAYER_RADIUS, 6);
    expect(out.pushed).toBe(true);
  });

  it("fall away with the ice as the ring shrinks", () => {
    expect(activePillars(START_RING_RADIUS)).toHaveLength(PILLARS.length);
    expect(activePillars(MIN_RING_RADIUS).length).toBeLessThan(PILLARS.length);
    for (const p of activePillars(10.5)) expect(Math.hypot(p.x, p.z) + p.r).toBeLessThanOrEqual(10.5 + 0.01);
  });

  it("leave the row through the middle clear, so duels along it are not blocked", () => {
    for (const p of PILLARS) expect(Math.abs(p.z)).toBeGreaterThan(p.r + 1);
  });
});
