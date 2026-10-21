import { describe, expect, it } from "vitest";
import { createArena, isStanding, layoutFor, removeTiles, tileIndexAt, type Arena } from "./arena.js";
import { TWIST_SPEED_SCALE, WALK_SPEED } from "./config.js";
import { stepPose, type MoveInput, type Pose } from "./movement.js";

const still: Pose = { x: 0, z: 0, yaw: 0 };
const dt = 0.05;

/** Holds an input for some seconds and returns where the player ends up. */
function hold(input: Omit<MoveInput, "seq">, seconds: number, from: Pose = still, arena: Arena = createArena("frost"), scale = 1): Pose {
  let pose = from;
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    pose = stepPose(pose, { seq: i, ...input }, dt, arena, scale);
  }
  return pose;
}

const speedOf = (pose: Pose) => Math.hypot(pose.vx ?? 0, pose.vz ?? 0);

describe("stepPose", () => {
  it("eases up to walking speed instead of jumping to it", () => {
    const first = stepPose(still, { seq: 1, forward: 1, strafe: 0, yaw: 0 }, dt, createArena("frost"));
    expect(speedOf(first)).toBeGreaterThan(0);
    expect(speedOf(first)).toBeLessThan(WALK_SPEED * 0.7);

    const later = hold({ forward: 1, strafe: 0, yaw: 0 }, 2);
    expect(speedOf(later)).toBeGreaterThan(WALK_SPEED * 0.99);
    expect(speedOf(later)).toBeLessThanOrEqual(WALK_SPEED + 1e-9);
  });

  it("walks forward along the facing direction", () => {
    // yaw 0 faces +Z
    const pose = hold({ forward: 1, strafe: 0, yaw: 0 }, 1);
    expect(pose.x).toBeCloseTo(0, 6);
    expect(pose.z).toBeGreaterThan(WALK_SPEED * 0.85);
    expect(pose.z).toBeLessThanOrEqual(WALK_SPEED);
  });

  it("strafes right when facing +Z (toward -X)", () => {
    const pose = hold({ forward: 0, strafe: 1, yaw: 0 }, 1);
    expect(pose.x).toBeLessThan(-WALK_SPEED * 0.85);
    expect(pose.z).toBeCloseTo(0, 6);
  });

  it("does not move faster diagonally", () => {
    const pose = hold({ forward: 1, strafe: 1, yaw: 0 }, 2);
    expect(speedOf(pose)).toBeLessThanOrEqual(WALK_SPEED + 1e-9);
  });

  it("slows to a stop gradually when the input is released", () => {
    const running = hold({ forward: 1, strafe: 0, yaw: 0 }, 2);
    const next = stepPose(running, { seq: 99, forward: 0, strafe: 0, yaw: 0 }, dt, createArena("frost"));
    expect(speedOf(next)).toBeGreaterThan(0);
    expect(speedOf(next)).toBeLessThan(speedOf(running));
    expect(speedOf(hold({ forward: 0, strafe: 0, yaw: 0 }, 2, running))).toBeLessThan(0.01);
  });

  it("walks faster in a round with the fast twist", () => {
    const normal = hold({ forward: 1, strafe: 0, yaw: 0 }, 1);
    const fast = hold({ forward: 1, strafe: 0, yaw: 0 }, 1, still, createArena("frost"), TWIST_SPEED_SCALE);
    expect(fast.z).toBeGreaterThan(normal.z * 1.3);
  });

  it("cannot walk off the edge of the floor, and stops there", () => {
    const arena = createArena("frost");
    const pose = hold({ forward: 1, strafe: 0, yaw: Math.PI / 2 }, 12, still, arena);
    expect(isStanding(arena, pose.x, pose.z)).toBe(true);
    expect(pose.x).toBeLessThan(layoutFor("frost").extent);
    expect(speedOf(pose)).toBeLessThan(WALK_SPEED);
  });

  it("cannot walk onto a tile that has fallen", () => {
    const arena = createArena("frost");
    const layout = layoutFor("frost");
    // Remove the whole row of tiles to the east of the middle one.
    removeTiles(
      arena,
      layout.tiles.filter((t) => t.x > 1).map((t) => t.index),
    );
    const pose = hold({ forward: 1, strafe: 0, yaw: Math.PI / 2 }, 6, still, arena);
    expect(isStanding(arena, pose.x, pose.z)).toBe(true);
    expect(tileIndexAt(layout, pose.x, pose.z)).toBe(tileIndexAt(layout, 0, 0));
  });

  it("slides along an edge instead of sticking to it", () => {
    const arena = createArena("frost");
    const layout = layoutFor("frost");
    removeTiles(
      arena,
      layout.tiles.filter((t) => t.x > 1).map((t) => t.index),
    );
    // Walking diagonally into the missing side still carries the player along the edge, instead of stopping dead.
    const pose = hold({ forward: 1, strafe: 0, yaw: Math.PI / 4 }, 2, still, arena);
    expect(pose.z).toBeGreaterThan(0.5);
    expect(pose.x).toBeLessThan(1.4);
    expect(isStanding(arena, pose.x, pose.z)).toBe(true);
  });
});
