import * as THREE from "three";
import {
  addGrain,
  Bin,
  blotches,
  buildRoundFence,
  CAGE_HEIGHT,
  Drift,
  dotTexture,
  finishTexture,
  makeCanvas,
  makeLights,
  PIT_DEPTH,
  scatter,
  seededRandom,
  skyDome,
  SLAB_THICKNESS,
  WORLD_RADIUS,
  type MapContext,
  type MapScene,
} from "./common.js";

/**
 * Frozen Crevasse: a pale sky, a snowfield with hills, mountains and pines, and the arena as a circle of ice
 * cut into the snow, over a deep crevasse. Snow falls the whole time.
 */
export function buildFrost(context: MapContext): MapScene {
  const bin = new Bin();
  const root = new THREE.Group();
  // The hole in the snow is a little wider than the floor, so the floor hangs in the crack.
  const outer = context.layout.extent + 0.8;
  const random = seededRandom(7);

  root.add(skyDome("#5f88bb", "#b7cde4", "#dfe9f3"));

  // The snowfield, with a hole in the middle for the arena.
  const snowTexture = snowSurfaceTexture();
  snowTexture.repeat.set(70, 70);
  const ground = new THREE.Mesh(
    new THREE.RingGeometry(outer, WORLD_RADIUS, 160, 1).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ map: snowTexture, color: "#f4f8fc", roughness: 1, metalness: 0 }),
  );
  ground.receiveShadow = true;
  root.add(ground);

  // A soft lip of snow around the edge of the hole.
  const lip = new THREE.Mesh(
    new THREE.TorusGeometry(outer + 0.5, 1.1, 10, 128).rotateX(Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: "#f6f9fc", roughness: 1 }),
  );
  lip.scale.y = 0.55;
  lip.position.y = 0.1;
  lip.receiveShadow = true;
  root.add(lip);

  // The crevasse: icy walls going down into the dark, with a column that holds the arena up.
  const iceWall = new THREE.Mesh(
    new THREE.CylinderGeometry(outer, outer, PIT_DEPTH, 96, 1, true),
    new THREE.MeshStandardMaterial({
      map: iceSurfaceTexture(),
      color: "#9ec3dd",
      roughness: 0.35,
      emissive: "#12384f",
      emissiveIntensity: 0.5,
      side: THREE.BackSide,
    }),
  );
  iceWall.position.y = -PIT_DEPTH / 2;
  root.add(iceWall);

  const abyss = new THREE.Mesh(new THREE.CircleGeometry(outer + 1, 64).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: "#04101d" }));
  abyss.position.y = -PIT_DEPTH;
  root.add(abyss);

  const column = new THREE.Mesh(
    new THREE.CylinderGeometry(4.5, 7, PIT_DEPTH - SLAB_THICKNESS, 32),
    new THREE.MeshStandardMaterial({ color: "#86abc6", roughness: 0.4, emissive: "#102c40", emissiveIntensity: 0.4 }),
  );
  column.position.y = -(PIT_DEPTH + SLAB_THICKNESS) / 2;
  root.add(column);

  // Drifts: low, wide mounds of snow on the ground around the arena.
  const drifts = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 24, 12), new THREE.MeshStandardMaterial({ color: "#f1f6fb", roughness: 1 }), 90);
  scatter(drifts, 90, random, (_, d, r) => {
    const angle = r() * Math.PI * 2;
    const distance = 75 + r() * 260;
    const width = 18 + r() * 40;
    d.position.set(Math.cos(angle) * distance, -width * 0.18, Math.sin(angle) * distance);
    d.scale.set(width, width * (0.25 + r() * 0.2), width * (0.7 + r() * 0.5));
    d.rotation.y = r() * Math.PI;
  });
  drifts.receiveShadow = true;
  root.add(drifts);

  // Mountains: tall cones, bluish rock below and white snow on top, in a ring far away.
  const mountainCount = 26;
  const rock = new THREE.InstancedMesh(
    new THREE.ConeGeometry(1, 1, 7),
    new THREE.MeshStandardMaterial({ color: "#8fa5bd", roughness: 1, flatShading: true }),
    mountainCount,
  );
  const caps = new THREE.InstancedMesh(
    new THREE.ConeGeometry(1, 1, 7),
    new THREE.MeshStandardMaterial({ color: "#f5f9fd", roughness: 1, flatShading: true }),
    mountainCount,
  );
  const dummy = new THREE.Object3D();
  for (let i = 0; i < mountainCount; i++) {
    const angle = (i / mountainCount) * Math.PI * 2 + random() * 0.15;
    const distance = 330 + random() * 70;
    const width = 90 + random() * 90;
    const height = 90 + random() * 120;
    dummy.position.set(Math.cos(angle) * distance, height / 2 - 6, Math.sin(angle) * distance);
    dummy.scale.set(width, height, width);
    dummy.rotation.y = random() * Math.PI;
    dummy.updateMatrix();
    rock.setMatrixAt(i, dummy.matrix);
    // The snow cap is the top third of the mountain, sitting on it.
    dummy.position.set(Math.cos(angle) * distance, height * 0.68 - 6, Math.sin(angle) * distance);
    dummy.scale.set(width * 0.36, height * 0.34, width * 0.36);
    dummy.updateMatrix();
    caps.setMatrixAt(i, dummy.matrix);
  }
  root.add(rock, caps);

  // Pine trees: a brown trunk, three stacked layers of dark green, and snow on top.
  const treeCount = 170;
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.45, 0.6, 1, 8), new THREE.MeshStandardMaterial({ color: "#4d3a2c", roughness: 1 }), treeCount);
  const layers = [0, 1, 2].map(
    () => new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1, 9), new THREE.MeshStandardMaterial({ color: "#22463a", roughness: 0.95 }), treeCount),
  );
  const snowTops = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1, 9), new THREE.MeshStandardMaterial({ color: "#f6f9fc", roughness: 1 }), treeCount);
  for (let i = 0; i < treeCount; i++) {
    const angle = random() * Math.PI * 2;
    const distance = 58 + Math.pow(random(), 0.7) * 210;
    const x = Math.cos(angle) * distance;
    const z = Math.sin(angle) * distance;
    const size = 1.8 + random() * 2.4;
    dummy.rotation.set(0, 0, 0);
    dummy.position.set(x, size * 0.9, z);
    dummy.scale.set(size * 0.5, size * 1.8, size * 0.5);
    dummy.updateMatrix();
    trunks.setMatrixAt(i, dummy.matrix);
    layers.forEach((layer, tier) => {
      const radius = size * (2.3 - tier * 0.55);
      const tall = size * (2.6 - tier * 0.3);
      dummy.position.set(x, size * (2.1 + tier * 1.5), z);
      dummy.scale.set(radius, tall, radius);
      dummy.updateMatrix();
      layer.setMatrixAt(i, dummy.matrix);
    });
    dummy.position.set(x, size * 6.1, z);
    dummy.scale.set(size * 0.9, size * 1.3, size * 0.9);
    dummy.updateMatrix();
    snowTops.setMatrixAt(i, dummy.matrix);
  }
  root.add(trunks, ...layers, snowTops);

  // Snowfall: flakes drift down from above, swaying in a light wind, and start over at the top.
  const flake = dotTexture();
  bin.add(flake);
  const snow = new Drift(
    { count: context.touch ? 1400 : 3600, radius: 95, height: 75, fall: [2.2, 5.4], wind: 1.2, sway: 0.9, size: 0.7, color: "#ffffff", opacity: 0.95 },
    flake,
  );
  root.add(snow.points);

  const { hemisphere, sun } = makeLights({
    sky: "#d3e3f4",
    ground: "#9fb2c6",
    skyIntensity: 1.05,
    sun: "#fff1dc",
    sunIntensity: 2.4,
    sunPosition: [-45, 62, 32],
    touch: context.touch,
  });
  root.add(hemisphere, sun);

  // The floor: clear blue ice, tinted in two shades so neighboring tiles are easy to tell apart.
  const iceTexture = iceSurfaceTexture();
  iceTexture.repeat.set(0.12, 0.12); // extruded faces use meters as UVs, so this is one pattern per ~8 m
  const tileMaterial = new THREE.MeshStandardMaterial({ map: iceTexture, color: "#ffffff", roughness: 0.38, metalness: 0.05 });
  const edge = new THREE.MeshStandardMaterial({ color: "#bdeaff", emissive: "#2fa3d6", emissiveIntensity: 0.55, roughness: 0.4 });

  // The fence: steel bars, with a glowing top rail.
  const steel = new THREE.MeshStandardMaterial({ color: "#aab5c1", roughness: 0.45, metalness: 0.3 });
  const topRail = new THREE.MeshStandardMaterial({ color: "#bfe8ff", emissive: "#3aa8d8", emissiveIntensity: 0.85, roughness: 0.4, metalness: 0.5 });
  const fence = buildRoundFence(context.layout.extent + 1.2, {
    post: new THREE.CylinderGeometry(0.11, 0.11, CAGE_HEIGHT, 10).translate(0, CAGE_HEIGHT / 2, 0),
    postMaterial: new THREE.MeshStandardMaterial({ color: "#c3ccd6", roughness: 0.45, metalness: 0.3 }),
    rails: [
      { y: 0.2, tube: 0.14, material: steel },
      { y: CAGE_HEIGHT * 0.5, tube: 0.14, material: steel },
      { y: CAGE_HEIGHT, tube: 0.2, material: topRail },
    ],
  });
  root.add(fence.posts, ...fence.rails);

  return {
    root,
    background: "#b9cfe6",
    fog: new THREE.Fog("#c4d6e8", 90, 480),
    exposure: 0.95,
    sun,
    floor: { material: tileMaterial, edge, tints: ["#e8f3fb", "#b9d3e6"] },
    fence,
    update: (dt, time) => snow.update(dt, time),
    setLowPower: (on) => snow.setFraction(on ? 0.4 : 1),
    dispose: () => {
      bin.add(edge);
      bin.add(tileMaterial);
      bin.add(iceTexture);
      bin.disposeAll(root);
    },
  };
}

/** Snow: nearly white with very fine blue-grey grain, so it reads as snow up close without looking like noise. */
function snowSurfaceTexture(): THREE.CanvasTexture {
  const size = 512;
  const { canvas, ctx } = makeCanvas(size);
  ctx.fillStyle = "#f2f6fa";
  ctx.fillRect(0, 0, size, size);
  addGrain(ctx, size, 0.045);
  blotches(ctx, size, 60, 20, 90, ["rgba(150,175,205,0.07)"]);
  return finishTexture(canvas, 1, 1);
}

/** Clear blue ice: soft cloudy depth with a few fine cracks. No thin repeating lines, so nothing shimmers. */
function iceSurfaceTexture(): THREE.CanvasTexture {
  const size = 1024;
  const { canvas, ctx } = makeCanvas(size);
  ctx.fillStyle = "#c3dcee";
  ctx.fillRect(0, 0, size, size);
  blotches(ctx, size, 70, 50, 240, ["rgba(255,255,255,0.22)", "rgba(60,110,160,0.14)"]);
  // A few fine cracks that wander across the surface.
  ctx.lineCap = "round";
  for (let i = 0; i < 9; i++) {
    let x = Math.random() * size;
    let y = Math.random() * size;
    let angle = Math.random() * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let step = 0; step < 14; step++) {
      angle += (Math.random() - 0.5) * 0.9;
      x += Math.cos(angle) * (20 + Math.random() * 40);
      y += Math.sin(angle) * (20 + Math.random() * 40);
      ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  addGrain(ctx, size, 0.035);
  return finishTexture(canvas, 1, 1);
}
