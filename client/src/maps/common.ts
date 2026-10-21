import * as THREE from "three";
import { PIT_DEPTH, START_RING_RADIUS, WORLD_RADIUS } from "../../../shared/config.js";

export { PIT_DEPTH, START_RING_RADIUS, WORLD_RADIUS };

export const BAR_COUNT = 80;
export const CAGE_HEIGHT = 9;
export const SLAB_THICKNESS = 0.9;

/** What a map gives the world: its scenery, its light, how its floor and cage look, and how it moves. */
export interface MapScene {
  root: THREE.Group;
  background: THREE.ColorRepresentation;
  fog: THREE.Fog;
  exposure: number;
  sun: THREE.DirectionalLight;
  floor: {
    /** The material for one level of the floor, 0 being the outermost. */
    levelMaterial(level: number): THREE.Material;
    /** The glowing line around the edge of each level. */
    edge: THREE.Material;
  };
  cage: { bars: THREE.InstancedMesh; rings: THREE.Mesh[] };
  update(dt: number, time: number): void;
  /** Phones and weak devices ask the scenery to do less. */
  setLowPower(on: boolean): void;
  dispose(): void;
}

export interface MapContext {
  touch: boolean;
  /** Edge radius of each floor level, outermost first. */
  levels: number[];
}

/** Collects everything a map creates, so it can all be freed when the map is thrown away. */
export class Bin {
  private items: Array<{ dispose(): void }> = [];

  add<T extends { dispose(): void }>(item: T): T {
    this.items.push(item);
    return item;
  }

  /** Frees every geometry, material and texture under a root, plus anything added by hand. */
  disposeAll(root: THREE.Object3D): void {
    root.traverse((child) => {
      if (child instanceof THREE.Mesh || child instanceof THREE.Points || child instanceof THREE.InstancedMesh) {
        child.geometry.dispose();
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        for (const material of materials) {
          for (const value of Object.values(material)) {
            if (value instanceof THREE.Texture) value.dispose();
          }
          material.dispose();
        }
      }
    });
    for (const item of this.items) item.dispose();
    this.items = [];
  }
}

/** A small repeatable random generator, so the scenery looks the same on every visit. */
export function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

export function clamp255(value: number): number {
  return Math.min(255, Math.max(0, value));
}

export function finishTexture(canvas: HTMLCanvasElement, repeatX: number, repeatY: number): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeatX, repeatY);
  texture.anisotropy = 8;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function makeCanvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  return { canvas, ctx: canvas.getContext("2d")! };
}

/** Adds fine grain to a canvas, so flat colors do not look like paint. */
export function addGrain(ctx: CanvasRenderingContext2D, size: number, amount: number): void {
  const image = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < image.data.length; i += 4) {
    const noise = (Math.random() - 0.5) * 255 * amount;
    image.data[i] = clamp255(image.data[i] + noise);
    image.data[i + 1] = clamp255(image.data[i + 1] + noise);
    image.data[i + 2] = clamp255(image.data[i + 2] + noise);
  }
  ctx.putImageData(image, 0, 0);
}

/** Soft blotches of color scattered over a canvas. */
export function blotches(
  ctx: CanvasRenderingContext2D,
  size: number,
  count: number,
  minRadius: number,
  maxRadius: number,
  colors: string[],
): void {
  for (let i = 0; i < count; i++) {
    const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    ctx.save();
    ctx.translate(Math.random() * size, Math.random() * size);
    const radius = minRadius + Math.random() * (maxRadius - minRadius);
    ctx.scale(radius, radius);
    const color = colors[Math.floor(Math.random() * colors.length)];
    gradient.addColorStop(0, color);
    gradient.addColorStop(1, color.replace(/[\d.]+\)$/, "0)"));
    ctx.fillStyle = gradient;
    ctx.fillRect(-1, -1, 2, 2);
    ctx.restore();
  }
}

/** A big inside-out sphere that fades from `top` overhead, through `mid`, to `bottom` at and below the horizon. */
export function skyDome(top: string, mid: string, bottom: string): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.SphereGeometry(1200, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: new THREE.Color(top) },
        mid: { value: new THREE.Color(mid) },
        bottom: { value: new THREE.Color(bottom) },
      },
      vertexShader: `varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `uniform vec3 top; uniform vec3 mid; uniform vec3 bottom; varying vec3 vDir;
        void main() {
          float h = vDir.y;
          vec3 color = h < 0.0 ? bottom : mix(mid, top, pow(h, 0.5));
          gl_FragColor = vec4(color, 1.0);
        }`,
    }),
  );
}

/** A soft round dot, white in the middle and clear at the edge. Tinted by the material's color. */
export function dotTexture(): THREE.CanvasTexture {
  const { canvas, ctx } = makeCanvas(64);
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.45, "rgba(255,255,255,0.85)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export interface DriftOptions {
  count: number;
  /** Half-width of the area the particles fill, around the arena. */
  radius: number;
  height: number;
  /** Meters per second downward. Negative values rise. */
  fall: [number, number];
  /** Sideways drift: a steady wind, and how far each particle sways. */
  wind: number;
  sway: number;
  size: number;
  color: string;
  opacity: number;
  additive?: boolean;
}

/** Particles that drift through the air: snow, leaves, fireflies, embers. Each one wraps around when it leaves. */
export class Drift {
  readonly points: THREE.Points;
  private speed: Float32Array;
  private phase: Float32Array;
  private active: number;

  constructor(
    private options: DriftOptions,
    texture: THREE.Texture,
  ) {
    const { count, radius, height } = options;
    const positions = new Float32Array(count * 3);
    this.speed = new Float32Array(count);
    this.phase = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const distance = Math.sqrt(Math.random()) * radius;
      positions[i * 3] = Math.cos(angle) * distance;
      positions[i * 3 + 1] = Math.random() * height;
      positions[i * 3 + 2] = Math.sin(angle) * distance;
      this.speed[i] = options.fall[0] + Math.random() * (options.fall[1] - options.fall[0]);
      this.phase[i] = Math.random() * Math.PI * 2;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.points = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        map: texture,
        size: options.size,
        sizeAttenuation: true,
        transparent: true,
        opacity: options.opacity,
        depthWrite: false,
        color: options.color,
        blending: options.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      }),
    );
    this.points.frustumCulled = false;
    this.active = count;
  }

  /** Shows only a fraction of the particles, for weak devices. */
  setFraction(fraction: number): void {
    this.active = Math.max(1, Math.floor(this.speed.length * fraction));
    this.points.geometry.setDrawRange(0, this.active);
  }

  update(dt: number, time: number): void {
    const { radius, height, wind, sway } = this.options;
    const positions = this.points.geometry.getAttribute("position") as THREE.BufferAttribute;
    const array = positions.array as Float32Array;
    for (let i = 0; i < this.active; i++) {
      const base = i * 3;
      array[base + 1] -= this.speed[i] * dt;
      array[base] += (Math.sin(time * 0.7 + this.phase[i]) * sway + wind) * dt;
      array[base + 2] += Math.cos(time * 0.5 + this.phase[i]) * sway * 0.65 * dt;
      const rose = this.speed[i] < 0;
      const out = rose ? array[base + 1] > height : array[base + 1] < 0;
      if (out || Math.hypot(array[base], array[base + 2]) > radius) {
        const angle = Math.random() * Math.PI * 2;
        const distance = Math.sqrt(Math.random()) * radius;
        array[base] = Math.cos(angle) * distance;
        array[base + 1] = rose ? 0 : height;
        array[base + 2] = Math.sin(angle) * distance;
      }
    }
    positions.needsUpdate = true;
  }
}

/** The fence around the arena: instanced posts, and rails that scale as the cage closes in. */
export function buildCage(options: {
  bar: THREE.BufferGeometry;
  barMaterial: THREE.Material;
  rails: Array<{ y: number; tube: number; material: THREE.Material }>;
}): { bars: THREE.InstancedMesh; rings: THREE.Mesh[] } {
  const bars = new THREE.InstancedMesh(options.bar, options.barMaterial, BAR_COUNT);
  bars.castShadow = true;
  bars.frustumCulled = false;
  const rings = options.rails.map((rail) => {
    // Built once at the full size. Closing the cage scales it, so no geometry is rebuilt while playing.
    const ring = new THREE.Mesh(new THREE.TorusGeometry(START_RING_RADIUS, rail.tube, 10, 160).rotateX(Math.PI / 2), rail.material);
    ring.position.y = rail.y;
    ring.castShadow = true;
    ring.frustumCulled = false;
    return ring;
  });
  return { bars, rings };
}

/** The lights every map has: a sky light, and a sun that casts the shadows. */
export function makeLights(options: {
  sky: string;
  ground: string;
  skyIntensity: number;
  sun: string;
  sunIntensity: number;
  sunPosition: [number, number, number];
  touch: boolean;
}): { hemisphere: THREE.HemisphereLight; sun: THREE.DirectionalLight } {
  const hemisphere = new THREE.HemisphereLight(options.sky, options.ground, options.skyIntensity);
  const sun = new THREE.DirectionalLight(options.sun, options.sunIntensity);
  sun.position.set(...options.sunPosition);
  sun.castShadow = true;
  const size = options.touch ? 1024 : 2048;
  sun.shadow.mapSize.set(size, size);
  const extent = 30;
  sun.shadow.camera.left = -extent;
  sun.shadow.camera.right = extent;
  sun.shadow.camera.top = extent;
  sun.shadow.camera.bottom = -extent;
  sun.shadow.camera.far = 170;
  sun.shadow.radius = 4;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.05;
  return { hemisphere, sun };
}

/** Places instances scattered around a ring. `place` gets the angle, distance and a random source. */
export function scatter(
  mesh: THREE.InstancedMesh,
  count: number,
  random: () => number,
  place: (i: number, dummy: THREE.Object3D, random: () => number) => void,
): void {
  const dummy = new THREE.Object3D();
  for (let i = 0; i < count; i++) {
    dummy.position.set(0, 0, 0);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, 1, 1);
    place(i, dummy, random);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
}
