import * as THREE from "three";
import { TILE_SIZE, type ArenaLayout } from "../../shared/arena.js";
import { PIT_DEPTH } from "../../shared/config.js";
import type { Effects } from "./effects.js";
import { SLAB_THICKNESS, type MapScene } from "./maps/common.js";

/** A hexagon with a point at the top, in the flat x-y plane. */
function hexShape(size: number): THREE.Shape {
  const shape = new THREE.Shape();
  for (let k = 0; k < 6; k++) {
    const angle = Math.PI / 2 + (k * Math.PI) / 3;
    const x = Math.cos(angle) * size;
    const y = Math.sin(angle) * size;
    if (k === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  return shape;
}

/** A tile: a chunky slab with a slightly rounded edge, its top at y = 0. */
function tileGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.ExtrudeGeometry(hexShape(TILE_SIZE * 0.96), {
    depth: SLAB_THICKNESS - 0.16,
    bevelEnabled: true,
    bevelThickness: 0.08,
    bevelSize: 0.08,
    bevelSegments: 1,
  });
  // Lay it flat and sink it, so the top surface sits at y = 0.
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, -SLAB_THICKNESS + 0.08, 0);
  return geometry;
}

/** A thin glowing outline for the top of a tile. */
function rimGeometry(): THREE.BufferGeometry {
  const outer = hexShape(TILE_SIZE * 0.96);
  outer.holes.push(hexShape(TILE_SIZE * 0.89));
  const geometry = new THREE.ExtrudeGeometry(outer, { depth: 0.05, bevelEnabled: false });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, 0.0, 0);
  return geometry;
}

/** Jagged glowing cracks, from the middle of a tile out toward its edges. */
function crackTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const random = (() => {
    let state = 99;
    return () => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };
  })();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const [width, color, blur] of [
    [14, "rgba(255,90,30,0.55)", 14],
    [6, "rgba(255,170,60,0.9)", 6],
    [2.5, "rgba(255,245,210,1)", 0],
  ] as const) {
    ctx.save();
    ctx.shadowColor = "rgba(255,110,40,0.9)";
    ctx.shadowBlur = blur;
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    const rng = (() => {
      let state = 7;
      return () => {
        state = (state * 1664525 + 1013904223) % 4294967296;
        return state / 4294967296;
      };
    })();
    for (let branch = 0; branch < 6; branch++) {
      let x = size / 2 + (rng() - 0.5) * 20;
      let y = size / 2 + (rng() - 0.5) * 20;
      let angle = (branch / 6) * Math.PI * 2 + rng() * 0.6;
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (let step = 0; step < 6; step++) {
        angle += (rng() - 0.5) * 1.1;
        x += Math.cos(angle) * (18 + rng() * 14);
        y += Math.sin(angle) * (18 + rng() * 14);
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }
  void random;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

interface Faller {
  index: number;
  delay: number;
  started: boolean;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  spin: THREE.Vector3;
  rotation: THREE.Euler;
}

const HOT = new THREE.Color("#ff7a3a");
const scratchColor = new THREE.Color();
const scratchMatrix = new THREE.Matrix4();
const scratchQuaternion = new THREE.Quaternion();
const scratchPosition = new THREE.Vector3();
const scratchScale = new THREE.Vector3();
const scratchEuler = new THREE.Euler();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * The arena floor: one slab for every tile, drawn together in a few calls. Tiles that are about to fall glow and
 * shudder with cracks in them. When they let go they tumble into the drop, throwing up dust and rubble.
 */
export class Floor {
  readonly group = new THREE.Group();
  private tiles: THREE.InstancedMesh;
  private rims: THREE.InstancedMesh;
  private cracks: THREE.InstancedMesh;
  private crackMaterial: THREE.MeshBasicMaterial;
  private yaw: number[];
  private base: THREE.Color[];
  private gone = new Set<number>();
  private cracked = new Set<number>();
  private fallers = new Map<number, Faller>();
  private dirty = true;
  private ownGeometry: THREE.BufferGeometry[] = [];
  private ownTexture: THREE.Texture;

  constructor(
    private layout: ArenaLayout,
    private map: MapScene,
    private effects: Effects,
    private dust: string,
    private onBreak: () => void,
  ) {
    const count = layout.tiles.length;
    const tileGeo = tileGeometry();
    const rimGeo = rimGeometry();
    const crackGeo = new THREE.ShapeGeometry(hexShape(TILE_SIZE * 0.9)).rotateX(-Math.PI / 2);
    this.ownGeometry.push(tileGeo, rimGeo, crackGeo);

    this.tiles = new THREE.InstancedMesh(tileGeo, map.floor.material, count);
    this.tiles.receiveShadow = true;
    this.tiles.frustumCulled = false;
    this.rims = new THREE.InstancedMesh(rimGeo, map.floor.edge, count);
    this.rims.frustumCulled = false;
    this.ownTexture = crackTexture();
    this.crackMaterial = new THREE.MeshBasicMaterial({
      map: this.ownTexture,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      opacity: 0.9,
    });
    this.cracks = new THREE.InstancedMesh(crackGeo, this.crackMaterial, count);
    this.cracks.frustumCulled = false;
    this.group.add(this.tiles, this.rims, this.cracks);

    // Each tile is turned a random multiple of a sixth of a turn, and tinted a little differently, so no two look alike.
    this.yaw = layout.tiles.map(() => Math.floor(Math.random() * 6) * (Math.PI / 3));
    const [a, b] = map.floor.tints.map((tint) => new THREE.Color(tint));
    this.base = layout.tiles.map((tile) => {
      const mix = ((tile.q * 7 + tile.r * 13) % 5) / 5;
      const color = (tile.q + tile.r) % 2 === 0 ? a.clone() : b.clone();
      return color.lerp(tile.r % 2 === 0 ? b : a, mix * 0.35);
    });
    this.reset();
  }

  /** Puts the floor in the state the server describes. Everything stops moving. */
  setState(gone: readonly number[], cracked: readonly number[]): void {
    this.gone = new Set(gone);
    this.cracked = new Set(cracked);
    this.fallers.clear();
    this.reset();
  }

  /** Starts the cracked tiles falling. Returns how many there are. */
  collapse(tiles: readonly number[]): number {
    let count = 0;
    for (const index of tiles) {
      if (this.gone.has(index)) continue;
      this.cracked.delete(index);
      const tile = this.layout.tiles[index];
      const outward = new THREE.Vector3(tile.x, 0, tile.z);
      if (outward.lengthSq() < 0.01) outward.set(Math.random() - 0.5, 0, Math.random() - 0.5);
      outward.normalize();
      this.fallers.set(index, {
        index,
        delay: Math.random() * 0.7,
        started: false,
        position: new THREE.Vector3(),
        velocity: outward.multiplyScalar(0.6 + Math.random() * 1.6),
        spin: new THREE.Vector3((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 3),
        rotation: new THREE.Euler(),
      });
      count += 1;
    }
    this.dirty = true;
    return count;
  }

  update(dt: number, time: number): void {
    // Cracked tiles shudder, glow and pulse.
    if (this.cracked.size > 0) {
      const pulse = 0.5 + 0.5 * Math.sin(time * 6);
      this.crackMaterial.opacity = 0.55 + 0.4 * pulse;
      for (const index of this.cracked) {
        const tile = this.layout.tiles[index];
        const jolt = Math.sin(time * 41 + index * 1.7) * (0.02 + 0.03 * pulse);
        this.place(index, tile.x, jolt, tile.z, 0, 0, 0, 1);
        this.setColor(this.tiles, index, scratchColor.copy(this.base[index]).lerp(HOT, 0.25 + 0.3 * pulse));
      }
      this.tiles.instanceColor!.needsUpdate = true;
      this.dirty = true;
    }

    for (const faller of this.fallers.values()) {
      const tile = this.layout.tiles[faller.index];
      if (faller.delay > 0) {
        // The slab shudders before it lets go.
        faller.delay -= dt;
        this.place(faller.index, tile.x, Math.sin(time * 55 + faller.index) * 0.05, tile.z, 0, 0, 0, 1);
        this.dirty = true;
        continue;
      }
      if (!faller.started) {
        faller.started = true;
        this.effects.floorBreak(scratchPosition.set(tile.x, 0.4, tile.z), this.dust);
        this.onBreak();
      }
      faller.velocity.y -= 30 * dt;
      faller.position.addScaledVector(faller.velocity, dt);
      faller.rotation.x += faller.spin.x * dt;
      faller.rotation.y += faller.spin.y * dt;
      faller.rotation.z += faller.spin.z * dt;
      if (faller.position.y < -PIT_DEPTH) {
        this.fallers.delete(faller.index);
        this.gone.add(faller.index);
        this.hide(faller.index);
      } else {
        this.place(
          faller.index,
          tile.x + faller.position.x,
          faller.position.y,
          tile.z + faller.position.z,
          faller.rotation.x,
          faller.rotation.y,
          faller.rotation.z,
          1,
        );
      }
      this.dirty = true;
    }

    if (this.dirty) {
      this.tiles.instanceMatrix.needsUpdate = true;
      this.rims.instanceMatrix.needsUpdate = true;
      this.cracks.instanceMatrix.needsUpdate = true;
      this.dirty = false;
    }
  }

  dispose(): void {
    for (const geometry of this.ownGeometry) geometry.dispose();
    this.crackMaterial.dispose();
    this.ownTexture.dispose();
    this.tiles.dispose();
    this.rims.dispose();
    this.cracks.dispose();
  }

  private reset(): void {
    const count = this.layout.tiles.length;
    for (let index = 0; index < count; index++) {
      if (this.gone.has(index)) {
        this.hide(index);
        continue;
      }
      const tile = this.layout.tiles[index];
      this.place(index, tile.x, 0, tile.z, 0, 0, 0, 1);
      this.setColor(this.tiles, index, this.base[index]);
    }
    if (this.tiles.instanceColor) this.tiles.instanceColor.needsUpdate = true;
    this.dirty = true;
  }

  /** Puts one tile (and its rim and cracks) at a position and turn. Cracks only show while the tile is cracked or falling. */
  private place(index: number, x: number, y: number, z: number, rx: number, ry: number, rz: number, scale: number): void {
    scratchEuler.set(rx, this.yaw[index] + ry, rz, "YXZ");
    scratchQuaternion.setFromEuler(scratchEuler);
    scratchMatrix.compose(scratchPosition.set(x, y, z), scratchQuaternion, scratchScale.setScalar(scale));
    this.tiles.setMatrixAt(index, scratchMatrix);
    this.rims.setMatrixAt(index, scratchMatrix);
    if (this.cracked.has(index) || this.fallers.has(index)) {
      scratchPosition.y += 0.07;
      scratchMatrix.compose(scratchPosition, scratchQuaternion, scratchScale.setScalar(scale));
      this.cracks.setMatrixAt(index, scratchMatrix);
    } else {
      this.cracks.setMatrixAt(index, ZERO);
    }
  }

  private hide(index: number): void {
    this.tiles.setMatrixAt(index, ZERO);
    this.rims.setMatrixAt(index, ZERO);
    this.cracks.setMatrixAt(index, ZERO);
  }

  private setColor(mesh: THREE.InstancedMesh, index: number, color: THREE.Color): void {
    mesh.setColorAt(index, color);
  }
}
