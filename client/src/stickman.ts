import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { MUZZLE_FORWARD, PLAYER_COLORS, PLAYER_HEIGHT, BEAM_HEIGHT, PIT_DEPTH } from "../../shared/config.js";

// The figure is modelled for a 1.8 m person and scaled up to the game's height.
const K = PLAYER_HEIGHT / 1.8;
export const GUN_TIP = 0.238; // grip to muzzle, in model units
const LIMB = 0.05;
// Strong colors, so every player stands out against white snow.

/** Which color each player wears, as told by the server. Every player in a room has a different one. */
const assigned = new Map<string, number>();

export function assignColors(players: ReadonlyArray<{ id: string; color: number }>): void {
  for (const player of players) assigned.set(player.id, player.color);
}

/** The color a player wears. Unknown ids (the title duel) get a fixed pair. */
export function colorFor(id: string): string {
  const index = assigned.get(id) ?? (id === "title-b" ? 5 : 1);
  return PLAYER_COLORS[index % PLAYER_COLORS.length];
}

interface Leg {
  hip: THREE.Group;
  knee: THREE.Group;
}

/**
 * A stick man: smooth limbs, round joints, a round head, and a laser pistol held in both hands.
 * Drawn entirely in code, so there are no model files and nothing to license.
 * It faces +Z, which is the aim direction in this game.
 */
export class Stickman {
  /** Position and facing on the floor. */
  readonly root = new THREE.Group();
  private tilt = new THREE.Group();
  private body = new THREE.Group();
  private legs: Leg[] = [];
  private label: THREE.Sprite | null = null;
  private materials: THREE.Material[] = [];
  private phase = 0;
  private walk = 0;
  private moving = false;
  private fallen = 0;
  private alive = true;
  private recoil = 0;
  /** Set when the ice under this figure breaks. It waits a moment, then drops into the crevasse. */
  private plunging = false;
  private plungeDelay = 0;
  private plungeSpeed = 0;
  private time = Math.random() * 10;
  /** Which way the body twists as it falls, so no two falls look the same. */
  private fallSide = Math.random() < 0.5 ? -1 : 1;

  constructor(id: string, name?: string) {
    const color = colorFor(id);
    const limb = this.track(new THREE.MeshStandardMaterial({ color, roughness: 0.42, metalness: 0.05 }));
    const head = this.track(new THREE.MeshStandardMaterial({ color: "#f0d5bf", roughness: 0.45, metalness: 0 }));

    this.body.scale.setScalar(K);
    this.tilt.add(this.body);
    this.root.add(this.tilt);

    // Torso and shoulder bar.
    this.body.add(capsule(LIMB * 1.15, new THREE.Vector3(0, 0.92, 0), new THREE.Vector3(0, 1.44, 0), limb));
    this.body.add(capsule(LIMB, new THREE.Vector3(-0.17, 1.44, 0), new THREE.Vector3(0.17, 1.44, 0), limb));
    this.body.add(joint(0.075, new THREE.Vector3(0, 0.92, 0), limb));

    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.14, 32, 20), head);
    skull.position.set(0, 1.64, 0);
    skull.castShadow = true;
    this.body.add(skull);

    // Legs hang from hip and knee pivots, so they can swing when walking.
    for (const side of [-1, 1]) {
      const hip = new THREE.Group();
      hip.userData.pivot = true;
      hip.position.set(side * 0.09, 0.92, 0);
      const knee = new THREE.Group();
      knee.userData.pivot = true;
      knee.position.set(0, -0.44, 0);
      hip.add(capsule(LIMB * 1.1, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -0.44, 0), limb));
      knee.add(capsule(LIMB * 1.1, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -0.44, 0), limb));
      knee.add(joint(LIMB * 1.25, new THREE.Vector3(0, 0, 0), limb));
      const foot = new THREE.Mesh(new THREE.SphereGeometry(0.06, 16, 10), limb);
      foot.scale.set(0.8, 0.6, 1.9);
      foot.position.set(0, -0.46, 0.06);
      foot.castShadow = true;
      knee.add(foot);
      hip.add(knee);
      this.body.add(hip);
      this.legs.push({ hip, knee });
    }

    // Both arms reach forward to the pistol. The muzzle ends up exactly MUZZLE_FORWARD in front of the body.
    const gripZ = MUZZLE_FORWARD / K - GUN_TIP;
    const gripY = BEAM_HEIGHT / K;
    const rightHand = new THREE.Vector3(-0.045, gripY - 0.01, gripZ);
    const leftHand = new THREE.Vector3(0.04, gripY - 0.03, gripZ + 0.07);
    this.arm(new THREE.Vector3(-0.17, 1.44, 0), new THREE.Vector3(-0.2, 1.24, 0.17), rightHand, limb);
    this.arm(new THREE.Vector3(0.17, 1.44, 0), new THREE.Vector3(0.2, 1.24, 0.17), leftHand, limb);

    const gun = createLaserPistol(this.materials);
    gun.position.copy(rightHand);
    this.body.add(gun);

    // Dozens of small meshes would each cost a draw call. Parts that move together become one mesh per material.
    mergeStatic(this.body);
    for (const leg of this.legs) {
      mergeStatic(leg.hip, [leg.knee]);
      mergeStatic(leg.knee);
    }

    this.body.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });

    if (name) {
      this.label = makeLabel(name, color);
      this.label.position.set(0, PLAYER_HEIGHT + 1.0, 0);
      this.root.add(this.label);
    }
  }

  setPose(x: number, z: number, yaw: number): void {
    this.root.position.set(x, 0, z);
    this.root.rotation.y = yaw;
  }

  setMoving(moving: boolean): void {
    this.moving = moving;
  }

  get isAlive(): boolean {
    return this.alive;
  }

  setAlive(alive: boolean): void {
    this.alive = alive;
    if (alive) {
      this.plunging = false;
      this.root.visible = true;
      this.root.position.y = 0;
    }
    if (this.label) this.label.visible = alive;
  }

  /** Kick back from firing: the body jolts away from the muzzle, then settles. */
  kick(): void {
    this.recoil = 1;
  }

  /** The floor gives way under this figure. */
  plunge(delay: number): void {
    this.plunging = true;
    this.plungeDelay = delay;
    this.plungeSpeed = 0;
    this.setAlive(false);
    this.plunging = true;
  }

  /** Stands the figure back up, as if it had never been hit. Used by the title scene loop. */
  reset(): void {
    this.fallen = 0;
    this.recoil = 0;
    this.root.rotation.z = 0;
    this.setAlive(true);
    this.fallSide = Math.random() < 0.5 ? -1 : 1;
  }

  update(dt: number): void {
    this.time += dt;
    this.recoil = Math.max(0, this.recoil - dt * 4.5);

    // Ease the walk cycle in and out, so legs do not snap.
    this.walk += ((this.moving && this.alive ? 1 : 0) - this.walk) * Math.min(1, dt * 9);
    this.phase += dt * 8.5 * (0.35 + this.walk);

    const swing = Math.sin(this.phase) * 0.62 * this.walk;
    this.legs.forEach((leg, index) => {
      const sign = index === 0 ? 1 : -1;
      leg.hip.rotation.x = swing * sign;
      // The knee bends only while the leg swings forward.
      leg.knee.rotation.x = Math.max(0, -Math.sin(this.phase + (sign > 0 ? 0.5 : Math.PI + 0.5))) * 0.8 * this.walk;
    });
    // Bobbing while walking, slow breathing while standing, and a jolt back when firing.
    const breathe = Math.sin(this.time * 2.1) * 0.012 * (1 - this.walk);
    this.body.position.y = (Math.abs(Math.sin(this.phase)) * 0.05 * this.walk + breathe) * K;
    this.body.position.z = -this.recoil * 0.2;
    this.body.rotation.x = -this.recoil * 0.1;

    // When hit, the figure staggers back and falls: slowly at first, then faster, and it lands with a twist.
    if (this.plunging) {
      if (this.plungeDelay > 0) {
        this.plungeDelay -= dt;
      } else {
        // Falling: speeds up like the slabs do, tumbling as it goes.
        this.plungeSpeed += 30 * dt;
        this.root.position.y -= this.plungeSpeed * dt;
        this.root.rotation.z += 1.6 * dt;
        if (this.root.position.y < -PIT_DEPTH) this.root.visible = false;
      }
    }
    // A figure that is about to fall with the ice stays upright until the ice lets go.
    const target = this.alive || (this.plunging && this.plungeDelay > 0) ? 0 : 1;
    this.fallen += Math.sign(target - this.fallen) * Math.min(Math.abs(target - this.fallen), dt / 0.85);
    const eased = this.fallen * this.fallen * (3 - 2 * this.fallen);
    this.tilt.rotation.x = -eased * (Math.PI / 2);
    this.tilt.rotation.z = this.fallSide * eased * 0.28;
    this.tilt.position.z = -eased * 0.8;
  }

  dispose(): void {
    this.root.traverse((child) => {
      if (child instanceof THREE.Mesh) child.geometry.dispose();
      if (child instanceof THREE.Sprite) child.material.map?.dispose();
    });
    for (const material of this.materials) material.dispose();
    this.root.removeFromParent();
  }

  private track<T extends THREE.Material>(material: T): T {
    this.materials.push(material);
    return material;
  }

  /** An arm from the shoulder, bent at the elbow, to the hand. */
  private arm(shoulder: THREE.Vector3, elbow: THREE.Vector3, hand: THREE.Vector3, material: THREE.Material): void {
    this.body.add(capsule(LIMB, shoulder, elbow, material));
    this.body.add(capsule(LIMB, elbow, hand, material));
    this.body.add(joint(LIMB * 1.2, elbow, material));
    this.body.add(joint(LIMB * 1.25, hand, material));
  }
}

/**
 * Replaces the meshes under `parent` with one mesh per material. Groups listed in `keep` (parts that move
 * on their own, like a knee) are left alone, and so are their contents.
 */
function mergeStatic(parent: THREE.Group, keep: THREE.Object3D[] = []): void {
  const moving = new Set<THREE.Object3D>([...keep, ...parent.children.filter((child) => child.userData.animated)]);
  const inverse = new THREE.Matrix4();
  parent.updateMatrixWorld(true);
  inverse.copy(parent.matrixWorld).invert();

  const byMaterial = new Map<THREE.Material, { meshes: THREE.Mesh[]; geometries: THREE.BufferGeometry[] }>();
  const visit = (node: THREE.Object3D): void => {
    for (const child of node.children) {
      if (moving.has(child) || (child instanceof THREE.Group && child !== parent && isLimbPivot(child))) continue;
      if (child instanceof THREE.Mesh) {
        const entry = byMaterial.get(child.material as THREE.Material) ?? { meshes: [], geometries: [] };
        const baked = child.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverse, child.matrixWorld));
        entry.meshes.push(child);
        entry.geometries.push(baked);
        byMaterial.set(child.material as THREE.Material, entry);
      } else {
        visit(child);
      }
    }
  };
  visit(parent);

  for (const [material, { meshes, geometries }] of byMaterial) {
    for (const mesh of meshes) {
      mesh.removeFromParent();
      mesh.geometry.dispose();
    }
    const merged = mergeGeometries(geometries, false);
    for (const geometry of geometries) geometry.dispose();
    if (merged) parent.add(new THREE.Mesh(merged, material));
  }
}

/** Hip and knee groups swing while walking, so their contents are merged separately. */
function isLimbPivot(group: THREE.Group): boolean {
  return group.userData.pivot === true;
}

/** A smooth rounded limb between two points. */
function capsule(radius: number, from: THREE.Vector3, to: THREE.Vector3, material: THREE.Material): THREE.Mesh {
  const length = from.distanceTo(to);
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, length, 6, 14), material);
  mesh.position.copy(from).add(to).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize());
  return mesh;
}

function joint(radius: number, at: THREE.Vector3, material: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 20, 14), material);
  mesh.position.copy(at);
  return mesh;
}

/**
 * A name tag that always faces the camera: a dark pill with a dot in the player's color and the name in large,
 * bold letters. It is drawn on top of everything, so a cage bar or another player never hides it.
 */
export function makeLabel(text: string, color: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 768;
  canvas.height = 192;
  const ctx = canvas.getContext("2d")!;
  const label = text.length > 14 ? `${text.slice(0, 13)}…` : text;
  ctx.font = "800 84px Oxanium, system-ui, sans-serif";
  const textWidth = ctx.measureText(label).width;
  const pillWidth = Math.min(740, textWidth + 130);
  const x = (768 - pillWidth) / 2;

  // The pill.
  ctx.fillStyle = "rgba(6, 11, 22, 0.86)";
  roundRect(ctx, x, 24, pillWidth, 144, 72);
  ctx.fill();
  ctx.lineWidth = 7;
  ctx.strokeStyle = color;
  ctx.stroke();

  // The color dot, then the name.
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x + 62, 96, 26, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.stroke();
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillStyle = "#ffffff";
  ctx.fillText(label, x + 104, 100);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false }));
  sprite.scale.set(5.6, 1.4, 1);
  sprite.renderOrder = 10;
  return sprite;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** A laser pistol built from simple parts. Origin is the grip, and the barrel points along +Z. */
export function createLaserPistol(materials: THREE.Material[]): THREE.Group {
  const group = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ color: "#1c2026", roughness: 0.32, metalness: 0.85 });
  const polymer = new THREE.MeshStandardMaterial({ color: "#2b2f36", roughness: 0.7, metalness: 0.05 });
  // A small, dim emitter. The beam itself only appears when the gun fires.
  const emitter = new THREE.MeshStandardMaterial({ color: "#3a1010", emissive: "#a01818", emissiveIntensity: 0.8 });
  materials.push(steel, polymer, emitter);

  const add = (geometry: THREE.BufferGeometry, material: THREE.Material, position: THREE.Vector3, rotationX = 0) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(position);
    mesh.rotation.x = rotationX;
    group.add(mesh);
  };

  add(new THREE.BoxGeometry(0.036, 0.04, 0.2), steel, new THREE.Vector3(0, 0.03, 0.1)); // slide
  add(new THREE.BoxGeometry(0.034, 0.03, 0.13), polymer, new THREE.Vector3(0, 0, 0.07)); // frame
  add(new THREE.BoxGeometry(0.03, 0.11, 0.045), polymer, new THREE.Vector3(0, -0.07, 0), -0.2); // grip
  add(new THREE.TorusGeometry(0.022, 0.004, 6, 14, Math.PI), steel, new THREE.Vector3(0, -0.025, 0.04), Math.PI / 2); // trigger guard
  add(new THREE.CylinderGeometry(0.011, 0.011, 0.03, 10), steel, new THREE.Vector3(0, 0.03, 0.22), Math.PI / 2); // muzzle
  add(new THREE.SphereGeometry(0.008, 8, 6), emitter, new THREE.Vector3(0, 0.03, GUN_TIP)); // emitter lens
  return group;
}
