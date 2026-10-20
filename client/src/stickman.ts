import * as THREE from "three";
import { GUNS, GunId, GUN_LENGTH } from "../../shared/config.js";

const LIMB_RADIUS = 0.025;
const HAND = new THREE.Vector3(0, 1.25, 0.5);
const PALETTE = ["#f472b6", "#60a5fa", "#34d399", "#fbbf24", "#a78bfa", "#f87171", "#22d3ee", "#fb7185", "#4ade80", "#c084fc", "#fde047", "#2dd4bf"];

export interface Stickman {
  root: THREE.Group;
  body: THREE.Group;
  color: string;
  dispose: () => void;
}

/** A stable color for each player id, so a player keeps their color across rounds. */
export function colorFor(id: string): string {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

/**
 * Builds a stick figure facing +Z in local space, standing on y = 0.
 * `root.rotation.y` turns it to face the aim direction.
 */
export function createStickman(id: string, gun: GunId): Stickman {
  const color = colorFor(id);
  const limbMaterial = new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.1 });
  const headMaterial = new THREE.MeshStandardMaterial({ color: "#f8fafc", roughness: 0.35, emissive: color, emissiveIntensity: 0.15 });

  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const add = (from: THREE.Vector3, to: THREE.Vector3, radius = LIMB_RADIUS) => {
    body.add(limb(from, to, radius, limbMaterial));
  };

  const hipY = 0.85;
  add(new THREE.Vector3(0, hipY, 0), new THREE.Vector3(0, 1.36, 0)); // spine
  add(new THREE.Vector3(-0.09, hipY, 0), new THREE.Vector3(-0.12, 0.02, 0.04)); // left leg
  add(new THREE.Vector3(0.09, hipY, 0), new THREE.Vector3(0.12, 0.02, -0.04)); // right leg
  add(new THREE.Vector3(-0.1, 1.32, 0), new THREE.Vector3(0.0, 1.25, 0.5)); // left arm, to the grip
  add(new THREE.Vector3(0.1, 1.32, 0), HAND); // right arm, to the grip

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 20, 14), headMaterial);
  head.position.set(0, 1.52, 0);
  head.castShadow = true;
  body.add(head);

  const gunMesh = createGun(gun);
  gunMesh.position.copy(HAND);
  body.add(gunMesh);

  // Shadows: every limb casts one, so the figure reads well under the key light.
  body.traverse((child) => {
    if (child instanceof THREE.Mesh) child.castShadow = true;
  });

  const dispose = () => {
    body.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
      }
    });
    limbMaterial.dispose();
    headMaterial.dispose();
  };

  return { root, body, color, dispose };
}

/** A cylinder spanning two points, used for every stick limb. */
function limb(from: THREE.Vector3, to: THREE.Vector3, radius: number, material: THREE.Material): THREE.Mesh {
  const length = from.distanceTo(to);
  const geometry = new THREE.CylinderGeometry(radius, radius, length, 8);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(from).add(to).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize());
  return mesh;
}

/**
 * Gun model with its origin at the grip. The barrel tip sits GUN_LENGTH forward of the body,
 * which is where the laser starts on the server.
 */
function createGun(gun: GunId): THREE.Group {
  const spec = GUNS[gun];
  const metal = new THREE.MeshStandardMaterial({ color: "#1f2937", roughness: 0.35, metalness: 0.8 });
  const accent = new THREE.MeshStandardMaterial({ color: spec.color, emissive: spec.color, emissiveIntensity: 1.2 });
  const group = new THREE.Group();
  const tip = GUN_LENGTH - HAND.z; // distance from the grip to the muzzle

  const box = (w: number, h: number, d: number, z: number, y = 0, mat = metal) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(0, y, z);
    group.add(mesh);
  };
  const barrel = (radius: number, x: number, length: number, mat = metal) => {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 10), mat);
    mesh.rotation.x = Math.PI / 2;
    mesh.position.set(x, 0.02, tip - length / 2);
    group.add(mesh);
  };

  switch (gun) {
    case "pistol":
      box(0.06, 0.08, tip, tip / 2 - 0.05);
      box(0.05, 0.12, 0.06, -0.05, -0.05);
      box(0.065, 0.02, 0.05, tip - 0.1, 0.05, accent);
      break;
    case "sniper":
      barrel(0.025, 0, tip + 0.1);
      box(0.06, 0.06, 0.35, -0.15);
      box(0.03, 0.05, 0.2, -0.05, 0.08);
      box(0.05, 0.12, 0.06, -0.05, -0.05);
      box(0.02, 0.02, 0.2, tip - 0.2, 0.02, accent);
      break;
    case "shotgun":
      barrel(0.03, -0.02, tip);
      barrel(0.03, 0.02, tip);
      box(0.08, 0.12, 0.3, -0.12, -0.02);
      box(0.05, 0.12, 0.06, -0.05, -0.08);
      box(0.1, 0.02, 0.04, tip - 0.1, 0.05, accent);
      break;
    case "twin":
      for (const x of [-0.07, 0.07]) {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.07, tip), metal);
        mesh.position.set(x, 0, tip / 2 - 0.05);
        group.add(mesh);
        const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.015, 0.03), accent);
        stripe.position.set(x, 0.045, tip - 0.1);
        group.add(stripe);
      }
      break;
  }

  return group;
}
