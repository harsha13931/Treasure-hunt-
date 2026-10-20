import { describe, expect, it } from "vitest";
import { PLAYER_RADIUS, START_RING_RADIUS, WALK_SPEED } from "./config.js";
import { clampToRing, facing, startPoseFor, stepPose, type Pose } from "./movement.js";

const still: Pose = { x: 0, z: 0, yaw: 0 };
const dt = 0.05;

describe("stepPose", () => {
  it("walks forward along the facing direction", () => {
    // yaw 0 faces +Z
    const next = stepPose(still, { seq: 1, forward: 1, strafe: 0, yaw: 0 }, dt, START_RING_RADIUS);
    expect(next.x).toBeCloseTo(0, 6);
    expect(next.z).toBeCloseTo(WALK_SPEED * dt, 6);
  });

  it("strafes right when facing +Z (toward -X)", () => {
    const next = stepPose(still, { seq: 1, forward: 0, strafe: 1, yaw: 0 }, dt, START_RING_RADIUS);
    expect(next.x).toBeCloseTo(-WALK_SPEED * dt, 6);
    expect(next.z).toBeCloseTo(0, 6);
  });

  it("does not move faster diagonally", () => {
    const next = stepPose(still, { seq: 1, forward: 1, strafe: 1, yaw: 0 }, dt, START_RING_RADIUS);
    expect(Math.hypot(next.x, next.z)).toBeCloseTo(WALK_SPEED * dt, 6);
  });

  it("cannot leave the ring", () => {
    const edge: Pose = { x: START_RING_RADIUS - PLAYER_RADIUS, z: 0, yaw: Math.PI / 2 };
    const next = stepPose(edge, { seq: 1, forward: 1, strafe: 0, yaw: Math.PI / 2 }, dt, START_RING_RADIUS);
    expect(Math.hypot(next.x, next.z)).toBeLessThanOrEqual(START_RING_RADIUS - PLAYER_RADIUS + 1e-9);
  });
});

describe("clampToRing", () => {
  it("pulls a player who is outside a smaller ring back to its edge", () => {
    const clamped = clampToRing({ x: 10, z: 0, yaw: 0 }, 6);
    expect(clamped.x).toBeCloseTo(6 - PLAYER_RADIUS, 6);
  });
});

describe("startPoseFor", () => {
  it("spreads players around the ring, inside it, with a valid facing", () => {
    for (let i = 0; i < 6; i++) {
      const pose = startPoseFor(i, 6);
      expect(Math.hypot(pose.x, pose.z)).toBeLessThan(START_RING_RADIUS);
      expect(pose.yaw).toBeGreaterThanOrEqual(-Math.PI);
      expect(pose.yaw).toBeLessThanOrEqual(Math.PI);
    }
  });
});
