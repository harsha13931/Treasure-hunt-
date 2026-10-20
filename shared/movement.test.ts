import { describe, expect, it } from "vitest";
import { PLAYER_RADIUS, START_RING_RADIUS, WALK_SPEED } from "./config.js";
import { clampToRing, startPoseFor, stepPose, type MoveInput, type Pose } from "./movement.js";

const still: Pose = { x: 0, z: 0, yaw: 0 };
const dt = 0.05;

/** Holds an input for some seconds and returns where the player ends up. */
function hold(input: Omit<MoveInput, "seq">, seconds: number, from: Pose = still, radius = 1000): Pose {
  let pose = from;
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    pose = stepPose(pose, { seq: i, ...input }, dt, radius);
  }
  return pose;
}

const speedOf = (pose: Pose) => Math.hypot(pose.vx ?? 0, pose.vz ?? 0);

describe("stepPose", () => {
  it("eases up to walking speed instead of jumping to it", () => {
    const first = stepPose(still, { seq: 1, forward: 1, strafe: 0, yaw: 0 }, dt, START_RING_RADIUS);
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
    const next = stepPose(running, { seq: 99, forward: 0, strafe: 0, yaw: 0 }, dt, 1000);
    expect(speedOf(next)).toBeGreaterThan(0);
    expect(speedOf(next)).toBeLessThan(speedOf(running));
    expect(speedOf(hold({ forward: 0, strafe: 0, yaw: 0 }, 2, running))).toBeLessThan(0.01);
  });

  it("cannot leave the ring, and stops when it hits the edge", () => {
    const pose = hold({ forward: 1, strafe: 0, yaw: Math.PI / 2 }, 12, still, START_RING_RADIUS);
    expect(Math.hypot(pose.x, pose.z)).toBeLessThanOrEqual(START_RING_RADIUS - PLAYER_RADIUS + 1e-9);
    expect(speedOf(pose)).toBeLessThan(WALK_SPEED);
  });
});

describe("clampToRing", () => {
  it("pulls a player who is outside a smaller ring back to its edge", () => {
    const clamped = clampToRing({ x: 10, z: 0, yaw: 0 }, 6);
    expect(clamped.x).toBeCloseTo(6 - PLAYER_RADIUS, 6);
  });
});

describe("startPoseFor", () => {
  it("spreads players around the ring, inside it, standing still", () => {
    for (let i = 0; i < 6; i++) {
      const pose = startPoseFor(i, 6);
      expect(Math.hypot(pose.x, pose.z)).toBeLessThan(START_RING_RADIUS);
      expect(pose.yaw).toBeGreaterThanOrEqual(-Math.PI);
      expect(pose.yaw).toBeLessThanOrEqual(Math.PI);
      expect(speedOf(pose)).toBe(0);
    }
  });
});
