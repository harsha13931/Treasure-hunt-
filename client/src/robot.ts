import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneRigged } from "three/examples/jsm/utils/SkeletonUtils.js";
import { BEAM_HEIGHT, MUZZLE_FORWARD, PIT_DEPTH, PLAYER_HEIGHT } from "../../shared/config.js";
import type { Actor } from "./actor.js";
import { colorFor, createLaserPistol, GUN_TIP, makeLabel } from "./stickman.js";

/*
 * The character is "RobotExpressive", a rigged, animated robot by Tomas Laulhe (modified by Don McCurdy),
 * released under CC0 1.0 (public domain). See client/public/models/CREDITS.md.
 * It stands about 4.8 meters tall as modelled, which is the height this game uses for players.
 */
const MODEL_URL = "/models/RobotExpressive.glb";
const MODEL_HEIGHT = 4.8;
/** The pistol is modelled small. This scales it up to suit a robot of this size. */
const GUN_SCALE = 4.2;

interface Template {
  scene: THREE.Group;
  clips: THREE.AnimationClip[];
}

let template: Template | null = null;

/** Loads the robot once. Until it has loaded, the world uses stick men instead. */
export async function loadRobot(): Promise<boolean> {
  try {
    const gltf = await new GLTFLoader().loadAsync(MODEL_URL);
    template = { scene: gltf.scene, clips: gltf.animations };
    return true;
  } catch {
    return false;
  }
}

export function robotReady(): boolean {
  return template !== null;
}

// Scratch objects, so solving the arms every frame does not allocate.
const S = new THREE.Vector3();
const E = new THREE.Vector3();
const W = new THREE.Vector3();
const T = new THREE.Vector3();
const dir = new THREE.Vector3();
const pole = new THREE.Vector3();
const want = new THREE.Vector3();
const have = new THREE.Vector3();
const qa = new THREE.Quaternion();
const qb = new THREE.Quaternion();
const qc = new THREE.Quaternion();

interface Arm {
  upper: THREE.Object3D;
  lower: THREE.Object3D;
  palm: THREE.Object3D;
  /** Which way the elbow bends, in the robot's own space. */
  pole: THREE.Vector3;
}

export class Robot implements Actor {
  readonly root = new THREE.Group();
  private model: THREE.Group;
  private mixer: THREE.AnimationMixer;
  private actions: { idle: THREE.AnimationAction; walk: THREE.AnimationAction; death: THREE.AnimationAction };
  private current: THREE.AnimationAction;
  private arms: Arm[] = [];
  private gun: THREE.Group;
  private label: THREE.Sprite | null = null;
  private materials: THREE.Material[] = [];
  private alive = true;
  private moving = false;
  private recoil = 0;
  /** 1 while the arms hold the gun, fading to 0 once the robot is hit. */
  private aim = 1;
  private labelHidden = false;
  private plunging = false;
  private plungeDelay = 0;
  private plungeSpeed = 0;

  constructor(id: string, name?: string) {
    if (!template) throw new Error("The robot model is not loaded.");
    this.model = cloneRigged(template.scene) as THREE.Group;
    this.model.scale.setScalar(PLAYER_HEIGHT / MODEL_HEIGHT);
    this.root.add(this.model);

    // Each player gets their own copy of the body color, so every robot can wear a different one.
    const color = new THREE.Color(colorFor(id));
    const copies = new Map<THREE.Material, THREE.Material>();
    this.model.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      // Only the big parts cast shadows. Hands, feet and shoulders are too small to show one, and skipping them
      // takes a large share of the work out of the shadow pass.
      child.castShadow = /^(Torso|Head|Leg|LowerLeg|Arm)/.test(child.name);
      child.receiveShadow = false;
      const swap = (material: THREE.Material): THREE.Material => {
        let copy = copies.get(material);
        if (!copy) {
          copy = material.clone();
          if (material.name === "Main") (copy as THREE.MeshStandardMaterial).color.copy(color);
          copies.set(material, copy);
          this.materials.push(copy);
        }
        return copy;
      };
      child.material = Array.isArray(child.material) ? child.material.map(swap) : swap(child.material);
    });

    this.mixer = new THREE.AnimationMixer(this.model);
    const clip = (name: string) => {
      const found = THREE.AnimationClip.findByName(template!.clips, name);
      if (!found) throw new Error(`Missing animation ${name}`);
      return this.mixer.clipAction(found);
    };
    this.actions = { idle: clip("Idle"), walk: clip("Walking"), death: clip("Death") };
    this.actions.death.setLoop(THREE.LoopOnce, 1);
    this.actions.death.clampWhenFinished = true;
    this.actions.walk.timeScale = 1.5;
    this.actions.idle.play();
    this.current = this.actions.idle;
    // Start each robot at a different point in the idle cycle so a crowd does not move in unison.
    this.actions.idle.time = Math.random() * this.actions.idle.getClip().duration;

    const find = (n: string) => this.model.getObjectByName(n) as THREE.Object3D;
    for (const side of ["R", "L"] as const) {
      this.arms.push({
        upper: find(`UpperArm${side}`),
        lower: find(`LowerArm${side}`),
        palm: find(`Palm2${side}`),
        pole: new THREE.Vector3(side === "R" ? -0.55 : 0.55, -1, -0.25).normalize(),
      });
    }

    // The pistol belongs to the robot's body, not to a hand, so the hands go to the gun and it stays steady.
    this.gun = createLaserPistol(this.materials);
    this.gun.scale.setScalar(GUN_SCALE);
    // Light metal with a glowing cyan lens, so the gun stands out against the dark hands and the snow.
    const [steel, polymer, lens] = this.materials.slice(-3) as THREE.MeshStandardMaterial[];
    steel.color.set("#d3dbe4");
    polymer.color.set("#4a5563");
    lens.color.set("#0b3a4a");
    lens.emissive.set("#38d6ff");
    lens.emissiveIntensity = 1.6;
    this.root.add(this.gun);

    if (name) {
      this.label = makeLabel(name, colorFor(id));
      this.label.position.set(0, PLAYER_HEIGHT + 1.0, 0);
      this.root.add(this.label);
    }
    this.update(0);
  }

  setPose(x: number, z: number, yaw: number): void {
    this.root.position.x = x;
    this.root.position.z = z;
    if (!this.plunging) this.root.position.y = 0;
    this.root.rotation.y = yaw;
  }

  setMoving(moving: boolean): void {
    this.moving = moving;
  }

  get isAlive(): boolean {
    return this.alive;
  }

  setAlive(alive: boolean): void {
    if (alive === this.alive) return;
    this.alive = alive;
    if (this.label) this.label.visible = alive && !this.labelHidden;
    if (alive) {
      this.plunging = false;
      this.root.visible = true;
      this.root.position.y = 0;
      this.root.rotation.z = 0;
      this.aim = 1;
      this.actions.death.stop();
      this.fadeTo(this.actions.idle, 0.1);
    } else if (!this.plunging) {
      this.fadeTo(this.actions.death, 0.12);
    }
  }

  setLabelVisible(visible: boolean): void {
    this.labelHidden = !visible;
    if (this.label) this.label.visible = this.alive && visible;
  }

  kick(): void {
    this.recoil = 1;
  }

  reset(): void {
    this.recoil = 0;
    this.alive = false; // so setAlive(true) does the full stand-up
    this.setAlive(true);
  }

  plunge(delay: number): void {
    this.plunging = true;
    this.plungeDelay = delay;
    this.plungeSpeed = 0;
    this.alive = false;
    if (this.label) this.label.visible = false;
  }

  update(dt: number): void {
    this.recoil = Math.max(0, this.recoil - dt * 4.5);

    if (this.plunging) {
      if (this.plungeDelay > 0) {
        this.plungeDelay -= dt;
        if (this.plungeDelay <= 0) this.fadeTo(this.actions.death, 0.1);
      } else {
        this.plungeSpeed += 30 * dt;
        this.root.position.y -= this.plungeSpeed * dt;
        this.root.rotation.z += 1.6 * dt;
        if (this.root.position.y < -PIT_DEPTH) this.root.visible = false;
      }
    }

    // Idle, walk or fall, blended so legs never snap between them.
    if (this.alive) {
      const wanted = this.moving ? this.actions.walk : this.actions.idle;
      if (wanted !== this.current) this.fadeTo(wanted, 0.18);
    }
    this.mixer.update(dt);

    // The arms hold the pistol while the robot is up, and let go when it is hit.
    this.aim += ((this.alive ? 1 : 0) - this.aim) * Math.min(1, dt * 12);
    this.placeGun();
    this.model.updateMatrixWorld(true);
    if (this.aim > 0.02) for (const [index, arm] of this.arms.entries()) this.reach(arm, index === 0);
  }

  dispose(): void {
    // The geometry is shared with every other robot, so only what this one owns is freed.
    this.gun.traverse((child) => {
      if (child instanceof THREE.Mesh) child.geometry.dispose();
    });
    for (const material of this.materials) material.dispose();
    this.label?.material.map?.dispose();
    this.root.removeFromParent();
  }

  private fadeTo(next: THREE.AnimationAction, seconds: number): void {
    if (next === this.current && next.isRunning()) return;
    next.reset().play();
    this.current.crossFadeTo(next, seconds, false);
    this.current = next;
  }

  /** Puts the pistol in front of the chest, pointing the way the robot faces. It jolts back when fired. */
  private placeGun(): void {
    const gripZ = MUZZLE_FORWARD - GUN_TIP * GUN_SCALE - this.recoil * 0.3;
    this.gun.position.set(0, BEAM_HEIGHT - 0.03 * GUN_SCALE, gripZ);
    this.gun.visible = this.root.visible;
    // The gun drops from the hands when the robot is hit.
    if (this.aim < 0.5) this.gun.position.y = Math.max(0.2, this.gun.position.y - (1 - this.aim * 2) * 2.2);
  }

  /**
   * Bends one arm so its hand lands on the pistol. The right hand takes the grip and the left hand the front.
   * Done after the animation each frame, so the walk and idle cycles still move the body and legs.
   */
  private reach(arm: Arm, right: boolean): void {
    const g = this.gun.position;
    T.set(right ? -0.02 : 0.1, g.y - (right ? 0.02 : 0.05) * GUN_SCALE, g.z + (right ? 0.0 : 0.12) * GUN_SCALE);
    this.root.localToWorld(T);

    arm.upper.getWorldPosition(S);
    arm.lower.getWorldPosition(E);
    arm.palm.getWorldPosition(W);
    const l1 = E.distanceTo(S);
    const l2 = W.distanceTo(E);

    dir.copy(T).sub(S);
    const reach = Math.min(dir.length(), (l1 + l2) * 0.995);
    dir.normalize();
    const a = (l1 * l1 - l2 * l2 + reach * reach) / (2 * Math.max(reach, 1e-3));
    const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    pole.copy(arm.pole).transformDirection(this.root.matrixWorld);
    pole.addScaledVector(dir, -pole.dot(dir)).normalize();
    want.copy(S).addScaledVector(dir, a).addScaledVector(pole, h).sub(S).normalize();

    have.copy(E).sub(S).normalize();
    this.swing(arm.upper, have, want);
    arm.upper.updateMatrixWorld(true);

    arm.lower.getWorldPosition(E);
    arm.palm.getWorldPosition(W);
    have.copy(W).sub(E).normalize();
    // Where the hand has to go from the new elbow.
    want.copy(T).sub(E);
    if (want.lengthSq() < 1e-6) return;
    want.normalize();
    this.swing(arm.lower, have, want);
    arm.lower.updateMatrixWorld(true);
  }

  /** Turns a bone by the shortest rotation that takes direction `from` to direction `to` (both in world space). */
  private swing(bone: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3): void {
    qa.setFromUnitVectors(from, to);
    bone.getWorldQuaternion(qb).premultiply(qa);
    bone.parent!.getWorldQuaternion(qc).invert();
    // Blend with the animated pose while letting go, so the arms do not snap.
    qc.multiply(qb);
    bone.quaternion.slerp(qc, this.aim);
  }
}
