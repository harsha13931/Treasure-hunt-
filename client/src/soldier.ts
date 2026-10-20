import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import { BEAM_HEIGHT, MUZZLE_FORWARD, PLAYER_HEIGHT } from "../../shared/config.js";

// A rigged, realistic human model (Mixamo-style skeleton). Swap the file in client/public/models
// to change the character. The bone names below must exist in the new model.
const MODEL_URL = "/models/soldier.glb";

// The pistol is modelled for a 1.8 m person. K scales it, and the hand positions, to the game's height.
const K = PLAYER_HEIGHT / 1.8;
const GUN_TIP = 0.238; // distance from the grip to the muzzle, in the gun's own model units

// Where the gripping hands sit, in the character's own space. +Z is forward, the gun points along +Z.
// The muzzle ends up exactly MUZZLE_FORWARD in front of the body, where the server starts the beam.
const GRIP_Z = MUZZLE_FORWARD - GUN_TIP * K;
const RIGHT_HAND = new THREE.Vector3(-0.1 * K, BEAM_HEIGHT - 0.04 * K, GRIP_Z);
const LEFT_HAND = new THREE.Vector3(0.1 * K, BEAM_HEIGHT - 0.08 * K, GRIP_Z + 0.08 * K);

let loaded: GLTF | null = null;

/** Loads the model once. Every character is cloned from this one copy. */
export async function loadSoldier(): Promise<GLTF> {
  loaded ??= await new GLTFLoader().loadAsync(MODEL_URL);
  return loaded;
}

export function soldierTemplate(): GLTF {
  if (!loaded) throw new Error("loadSoldier() must finish before characters are created.");
  return loaded;
}

interface ArmChain {
  upper: THREE.Bone;
  lower: THREE.Bone;
  hand: THREE.Bone;
  upperAxis: THREE.Vector3;
  lowerAxis: THREE.Vector3;
}

export class Character {
  /** Position and facing on the floor. Its +Z is the way the character faces. */
  readonly root = new THREE.Group();
  readonly gun: THREE.Group;
  private tilt = new THREE.Group();
  private model: THREE.Object3D;
  private mixer: THREE.AnimationMixer;
  private idle: THREE.AnimationAction;
  private walk: THREE.AnimationAction;
  private rightArm: ArmChain;
  private leftArm: ArmChain;
  private moving = false;
  private fallen = 0;
  private alive = true;

  constructor(gltf: GLTF) {
    this.model = SkeletonUtils.clone(gltf.scene);
    // The model is exported facing -Z. Turn it to face +Z, which is the forward direction in this game.
    this.model.rotation.y = Math.PI;

    // Scale to the real height, and stand the feet on the floor.
    // The model's own node transforms (for example a centimeter-to-meter scale) must be applied first.
    this.model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.model);
    const height = box.max.y - box.min.y;
    const scale = PLAYER_HEIGHT / height;
    this.model.scale.setScalar(scale);
    this.model.position.y = -box.min.y * scale;
    this.model.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });

    this.tilt.add(this.model);
    this.root.add(this.tilt);

    this.mixer = new THREE.AnimationMixer(this.model);
    const clip = (name: string) => {
      const found = gltf.animations.find((a) => a.name === name);
      if (!found) throw new Error(`Model is missing the "${name}" animation.`);
      return found;
    };
    this.idle = this.mixer.clipAction(clip("Idle"));
    this.walk = this.mixer.clipAction(clip("Walk"));
    this.idle.play();

    this.rightArm = this.armChain("RightArm", "RightForeArm", "RightHand");
    this.leftArm = this.armChain("LeftArm", "LeftForeArm", "LeftHand");

    this.gun = createLaserPistol();
    this.gun.scale.setScalar(K);
    this.root.add(this.gun);
  }

  setPose(x: number, z: number, yaw: number): void {
    this.root.position.set(x, 0, z);
    this.root.rotation.y = yaw;
  }

  setMoving(moving: boolean): void {
    if (moving === this.moving) return;
    this.moving = moving;
    const from = moving ? this.idle : this.walk;
    const to = moving ? this.walk : this.idle;
    from.fadeOut(0.2);
    to.reset().fadeIn(0.2).play();
  }

  setAlive(alive: boolean): void {
    this.alive = alive;
    this.gun.visible = alive;
  }

  update(dt: number): void {
    this.mixer.update(dt);

    // Fall over when out of the game, and stand back up if the state changes again.
    const target = this.alive ? 0 : 1;
    this.fallen += Math.sign(target - this.fallen) * Math.min(Math.abs(target - this.fallen), dt / 0.8);
    this.tilt.rotation.x = -this.fallen * (Math.PI / 2);

    if (this.alive) {
      this.root.updateMatrixWorld(true);
      // Hands on the gun, in the character's own space.
      this.solveArm(this.rightArm, this.root.localToWorld(RIGHT_HAND.clone()));
      this.solveArm(this.leftArm, this.root.localToWorld(LEFT_HAND.clone()));
      this.gun.position.copy(RIGHT_HAND);
      this.gun.quaternion.identity();
    }
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.model.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
      }
    });
    this.root.removeFromParent();
  }

  private armChain(upperName: string, lowerName: string, handName: string): ArmChain {
    const upper = this.bone(upperName);
    const lower = this.bone(lowerName);
    const hand = this.bone(handName);

    this.root.updateMatrixWorld(true);
    return {
      upper,
      lower,
      hand,
      upperAxis: childAxisLocal(upper, lower),
      lowerAxis: childAxisLocal(lower, hand),
    };
  }

  /**
   * Finds a Mixamo bone by its short name. The loader strips the "mixamorig:" prefix's colon,
   * so the node is named "mixamorigRightArm" in the scene.
   */
  private bone(shortName: string): THREE.Bone {
    const bone = this.model.getObjectByName(`mixamorig${shortName}`) as THREE.Bone | undefined;
    if (!bone) throw new Error(`Model is missing the mixamorig${shortName} bone.`);
    return bone;
  }

  /** Two-bone IK: bends the elbow so the hand reaches the target. */
  private solveArm(arm: ArmChain, target: THREE.Vector3): void {
    const shoulder = arm.upper.getWorldPosition(new THREE.Vector3());
    const elbow0 = arm.lower.getWorldPosition(new THREE.Vector3());
    const hand = arm.hand.getWorldPosition(new THREE.Vector3());
    const upperLength = shoulder.distanceTo(elbow0);
    const lowerLength = elbow0.distanceTo(hand);

    const toTarget = target.clone().sub(shoulder);
    const distance = THREE.MathUtils.clamp(toTarget.length(), 0.001, (upperLength + lowerLength) * 0.999);
    const dir = toTarget.normalize();

    // The elbow bends down and back, like a real shooting stance.
    const back = this.root.localToWorld(new THREE.Vector3(0, 0, -1)).sub(this.root.getWorldPosition(new THREE.Vector3()));
    const bend = new THREE.Vector3(0, -1, 0).addScaledVector(back, 0.8);
    bend.addScaledVector(dir, -bend.dot(dir)).normalize();

    const a = (upperLength * upperLength - lowerLength * lowerLength + distance * distance) / (2 * distance);
    const h = Math.sqrt(Math.max(0, upperLength * upperLength - a * a));
    const elbow = shoulder.clone().addScaledVector(dir, a).addScaledVector(bend, h);

    const upperWorld = new THREE.Quaternion().setFromUnitVectors(arm.upperAxis, elbow.clone().sub(shoulder).normalize());
    setWorldQuaternion(arm.upper, upperWorld);
    const lowerWorld = new THREE.Quaternion().setFromUnitVectors(arm.lowerAxis, target.clone().sub(elbow).normalize());
    setWorldQuaternion(arm.lower, lowerWorld);
  }
}

/** Direction from a bone to its child, expressed in the bone's own space. Fixed for the whole model. */
function childAxisLocal(bone: THREE.Bone, child: THREE.Object3D): THREE.Vector3 {
  const boneWorld = bone.getWorldPosition(new THREE.Vector3());
  const childWorld = child.getWorldPosition(new THREE.Vector3());
  const boneQuat = bone.getWorldQuaternion(new THREE.Quaternion());
  return childWorld.sub(boneWorld).normalize().applyQuaternion(boneQuat.invert());
}

/** Sets a bone's rotation in world space by working out its parent's rotation. */
function setWorldQuaternion(bone: THREE.Bone, world: THREE.Quaternion): void {
  const parent = bone.parent;
  const parentWorld = parent ? parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
  bone.quaternion.copy(parentWorld.invert().multiply(world));
  bone.updateMatrixWorld(true);
}

/** A laser pistol built from simple parts. Origin is the grip, and the barrel points along +Z. */
function createLaserPistol(): THREE.Group {
  const group = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ color: "#1c2026", roughness: 0.32, metalness: 0.85 });
  const polymer = new THREE.MeshStandardMaterial({ color: "#2b2f36", roughness: 0.7, metalness: 0.05 });
  const emitter = new THREE.MeshStandardMaterial({ color: "#ff2b2b", emissive: "#ff2b2b", emissiveIntensity: 3 });

  const add = (geometry: THREE.BufferGeometry, material: THREE.Material, position: THREE.Vector3, rotationX = 0) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(position);
    mesh.rotation.x = rotationX;
    mesh.castShadow = true;
    group.add(mesh);
    return mesh;
  };

  add(new THREE.BoxGeometry(0.036, 0.04, 0.2), steel, new THREE.Vector3(0, 0.03, 0.1)); // slide
  add(new THREE.BoxGeometry(0.034, 0.03, 0.13), polymer, new THREE.Vector3(0, 0.0, 0.07)); // frame
  add(new THREE.BoxGeometry(0.03, 0.11, 0.045), polymer, new THREE.Vector3(0, -0.07, 0.0), -0.2); // grip
  add(new THREE.TorusGeometry(0.022, 0.004, 6, 14, Math.PI), steel, new THREE.Vector3(0, -0.025, 0.04), Math.PI / 2); // trigger guard
  add(new THREE.CylinderGeometry(0.011, 0.011, 0.03, 10), steel, new THREE.Vector3(0, 0.03, 0.22), Math.PI / 2); // muzzle
  add(new THREE.SphereGeometry(0.008, 8, 6), emitter, new THREE.Vector3(0, 0.03, 0.238)); // laser lens
  return group;
}
