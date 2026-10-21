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
 * Emerald Forest: a stone clearing deep in an old wood. Tall pines and round oaks crowd in on every side, warm light
 * falls through the leaves, fireflies hang in the air and leaves drift down. The clearing floor is mossy ruin stone,
 * ringed by a wooden palisade, and it hangs over a dark ravine.
 */
export function buildForest(context: MapContext): MapScene {
  const bin = new Bin();
  const root = new THREE.Group();
  const outer = context.layout.extent + 0.8;
  const random = seededRandom(23);
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();

  root.add(skyDome("#5aa0d6", "#bfe0c6", "#e8f0d0"));

  // The forest floor: grass, with a hole in the middle for the arena.
  const grass = grassTexture();
  grass.repeat.set(80, 80);
  const ground = new THREE.Mesh(
    new THREE.RingGeometry(outer, WORLD_RADIUS, 160, 1).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ map: grass, color: "#9bc27a", roughness: 1 }),
  );
  ground.receiveShadow = true;
  root.add(ground);

  // A rim of packed earth and stones around the edge of the clearing.
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(outer + 0.6, 1.2, 10, 128).rotateX(Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: "#6e5638", roughness: 1 }),
  );
  rim.scale.y = 0.5;
  rim.position.y = 0.05;
  rim.receiveShadow = true;
  root.add(rim);
  const edgeStones = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ color: "#8c9482", roughness: 1, flatShading: true }), 46);
  scatter(edgeStones, 46, random, (i, d, r) => {
    const angle = (i / 46) * Math.PI * 2 + r() * 0.05;
    const size = 0.8 + r() * 1.1;
    d.position.set(Math.cos(angle) * (outer + 1.8 + r() * 1.2), size * 0.3, Math.sin(angle) * (outer + 1.8 + r() * 1.2));
    d.scale.set(size, size * 0.7, size * (0.8 + r() * 0.5));
    d.rotation.set(r(), r() * 6, r());
  });
  root.add(edgeStones);

  // The ravine under the clearing: layered earth going down into green-black shade.
  const wall = new THREE.Mesh(
    new THREE.CylinderGeometry(outer, outer, PIT_DEPTH, 96, 1, true),
    new THREE.MeshStandardMaterial({ map: earthTexture(), color: "#a58260", roughness: 1, side: THREE.BackSide }),
  );
  wall.position.y = -PIT_DEPTH / 2;
  root.add(wall);
  const abyss = new THREE.Mesh(new THREE.CircleGeometry(outer + 1, 64).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: "#04110a" }));
  abyss.position.y = -PIT_DEPTH;
  root.add(abyss);
  // A faint mist lying low in the ravine.
  const mist = new THREE.Mesh(
    new THREE.CircleGeometry(outer, 48).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: "#8fd1a0", transparent: true, opacity: 0.2, depthWrite: false }),
  );
  mist.position.y = -22;
  root.add(mist);
  const column = new THREE.Mesh(
    new THREE.CylinderGeometry(4.5, 7.5, PIT_DEPTH - SLAB_THICKNESS, 7),
    new THREE.MeshStandardMaterial({ color: "#6a6358", roughness: 1, flatShading: true }),
  );
  column.position.y = -(PIT_DEPTH + SLAB_THICKNESS) / 2;
  root.add(column);

  // Far hills, soft and blue-green with haze.
  const hills = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 20, 10), new THREE.MeshStandardMaterial({ color: "#6f9a6a", roughness: 1 }), 22);
  scatter(hills, 22, random, (i, d, r) => {
    const angle = (i / 22) * Math.PI * 2 + r() * 0.2;
    const distance = 330 + r() * 60;
    const width = 100 + r() * 80;
    d.position.set(Math.cos(angle) * distance, -20, Math.sin(angle) * distance);
    d.scale.set(width, 60 + r() * 70, width);
  });
  root.add(hills);

  // Pines: a trunk and three layers of needles, in slightly different greens.
  const pineCount = 190;
  const pineTrunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.4, 0.6, 1, 8), new THREE.MeshStandardMaterial({ color: "#5b4129", roughness: 1 }), pineCount);
  const pineLayers = [0, 1, 2].map(() => new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1, 9), new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.95 }), pineCount));
  for (let i = 0; i < pineCount; i++) {
    const angle = random() * Math.PI * 2;
    const distance = 38 + Math.pow(random(), 0.8) * 250;
    const x = Math.cos(angle) * distance;
    const z = Math.sin(angle) * distance;
    const size = 2 + random() * 2.6;
    dummy.rotation.set(0, 0, 0);
    dummy.position.set(x, size * 0.9, z);
    dummy.scale.set(size * 0.45, size * 1.8, size * 0.45);
    dummy.updateMatrix();
    pineTrunks.setMatrixAt(i, dummy.matrix);
    color.setHSL(0.33 + random() * 0.05, 0.45 + random() * 0.15, 0.2 + random() * 0.1);
    pineLayers.forEach((layer, tier) => {
      dummy.position.set(x, size * (2.0 + tier * 1.5), z);
      dummy.scale.set(size * (2.2 - tier * 0.5), size * (2.7 - tier * 0.3), size * (2.2 - tier * 0.5));
      dummy.updateMatrix();
      layer.setMatrixAt(i, dummy.matrix);
      layer.setColorAt(i, color);
    });
  }
  root.add(pineTrunks, ...pineLayers);

  // Oaks: a thick trunk under a cluster of round, bright canopies.
  const oakCount = 120;
  const oakTrunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.7, 1.0, 1, 8), new THREE.MeshStandardMaterial({ color: "#6a4b30", roughness: 1 }), oakCount);
  const canopies = [0, 1, 2].map(() => new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 1, flatShading: true }), oakCount));
  for (let i = 0; i < oakCount; i++) {
    const angle = random() * Math.PI * 2;
    const distance = 42 + Math.pow(random(), 0.8) * 230;
    const x = Math.cos(angle) * distance;
    const z = Math.sin(angle) * distance;
    const size = 2.4 + random() * 2.2;
    dummy.rotation.set(0, 0, 0);
    dummy.position.set(x, size * 1.4, z);
    dummy.scale.set(size * 0.55, size * 2.8, size * 0.55);
    dummy.updateMatrix();
    oakTrunks.setMatrixAt(i, dummy.matrix);
    color.setHSL(0.24 + random() * 0.09, 0.5 + random() * 0.15, 0.3 + random() * 0.1);
    canopies.forEach((canopy, k) => {
      dummy.position.set(x + (k - 1) * size * 0.9 * (k === 1 ? 0 : 1), size * (3.4 + (k === 1 ? 1.1 : 0.4)), z + (k === 1 ? 0 : (k - 0.5) * size * 0.6));
      const s = size * (k === 1 ? 2.1 : 1.7);
      dummy.scale.set(s, s * 0.85, s);
      dummy.rotation.y = random() * 3;
      dummy.updateMatrix();
      canopy.setMatrixAt(i, dummy.matrix);
      canopy.setColorAt(i, color);
    });
  }
  root.add(oakTrunks, ...canopies);

  // Bushes and boulders close to the clearing, so the edge of the woods feels lived in.
  const bushes = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 1, flatShading: true }), 130);
  for (let i = 0; i < 130; i++) {
    const angle = random() * Math.PI * 2;
    const distance = 30 + random() * 110;
    const size = 1.2 + random() * 2.2;
    dummy.rotation.set(0, random() * 6, 0);
    dummy.position.set(Math.cos(angle) * distance, size * 0.35, Math.sin(angle) * distance);
    dummy.scale.set(size * 1.2, size * 0.8, size);
    dummy.updateMatrix();
    bushes.setMatrixAt(i, dummy.matrix);
    color.setHSL(0.27 + random() * 0.1, 0.5, 0.22 + random() * 0.12);
    bushes.setColorAt(i, color);
  }
  const boulders = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ color: "#7d8573", roughness: 1, flatShading: true }), 60);
  scatter(boulders, 60, random, (_, d, r) => {
    const angle = r() * Math.PI * 2;
    const distance = 28 + r() * 120;
    const size = 1 + r() * 3.2;
    d.position.set(Math.cos(angle) * distance, size * 0.3, Math.sin(angle) * distance);
    d.scale.set(size * 1.2, size * 0.75, size);
    d.rotation.set(r() * 2, r() * 6, r() * 2);
  });
  root.add(bushes, boulders);

  // Soft shafts of sunlight slanting down through the trees.
  const rayTexture = rayGradient();
  bin.add(rayTexture);
  const rays = new THREE.Group();
  for (let i = 0; i < 7; i++) {
    const ray = new THREE.Mesh(
      new THREE.PlaneGeometry(10 + random() * 14, 150),
      new THREE.MeshBasicMaterial({ map: rayTexture, color: "#fff0b0", transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false }),
    );
    const angle = random() * Math.PI * 2;
    const distance = 55 + random() * 90;
    ray.position.set(Math.cos(angle) * distance, 55, Math.sin(angle) * distance);
    ray.rotation.set(0.25, angle + Math.PI / 2, 0.5);
    rays.add(ray);
  }
  root.add(rays);

  // Fireflies, and leaves falling slowly from the canopy.
  const dot = dotTexture();
  bin.add(dot);
  const fireflies = new Drift(
    { count: context.touch ? 90 : 220, radius: 55, height: 14, fall: [-0.5, -0.1], wind: 0.2, sway: 1.1, size: 0.55, color: "#fff2a0", opacity: 0.95, additive: true },
    dot,
  );
  const leaves = new Drift(
    { count: context.touch ? 70 : 160, radius: 70, height: 38, fall: [0.9, 1.9], wind: 1.0, sway: 1.4, size: 0.5, color: "#d49a3c", opacity: 0.9 },
    dot,
  );
  root.add(fireflies.points, leaves.points);

  const { hemisphere, sun } = makeLights({
    sky: "#d0e8c4",
    ground: "#6f8a55",
    skyIntensity: 1.0,
    sun: "#ffe6b8",
    sunIntensity: 2.6,
    sunPosition: [-38, 56, 30],
    touch: context.touch,
  });
  root.add(hemisphere, sun);

  // The floor: old stone slabs furred with moss, in two shades. The edge glows soft green, like carved runes.
  const stone = mossyStoneTexture();
  stone.repeat.set(0.11, 0.11);
  const tileMaterial = new THREE.MeshStandardMaterial({ map: stone, color: "#ffffff", roughness: 0.9, metalness: 0 });
  const edge = new THREE.MeshStandardMaterial({ color: "#c8ffb8", emissive: "#59d96a", emissiveIntensity: 0.6, roughness: 0.5 });

  // The palisade: sharpened logs bound by rope, with a lantern-lit top rail.
  const rope = new THREE.MeshStandardMaterial({ color: "#b99a6a", roughness: 1 });
  const lantern = new THREE.MeshStandardMaterial({ color: "#ffe2a0", emissive: "#ffb040", emissiveIntensity: 0.9, roughness: 0.6 });
  const fence = buildRoundFence(context.layout.extent + 1.2, {
    post: new THREE.CylinderGeometry(0.1, 0.34, CAGE_HEIGHT, 8).translate(0, CAGE_HEIGHT / 2, 0),
    postMaterial: new THREE.MeshStandardMaterial({ map: barkTexture(), color: "#9a7448", roughness: 1 }),
    rails: [
      { y: 1.4, tube: 0.13, material: rope },
      { y: CAGE_HEIGHT * 0.55, tube: 0.13, material: rope },
      { y: CAGE_HEIGHT * 0.98, tube: 0.16, material: lantern },
    ],
  });
  root.add(fence.posts, ...fence.rails);

  return {
    root,
    background: "#bcd9b4",
    fog: new THREE.Fog("#b4d4ab", 70, 400),
    exposure: 0.95,
    sun,
    floor: { material: tileMaterial, edge, tints: ["#bcc6ab", "#8fa078"] },
    fence,
    update: (dt, time) => {
      fireflies.update(dt, time);
      leaves.update(dt, time);
      // The shafts of light shimmer very slowly.
      rays.children.forEach((child, i) => {
        ((child as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 0.12 + 0.06 * Math.sin(time * 0.5 + i * 1.7);
      });
    },
    setLowPower: (on) => {
      fireflies.setFraction(on ? 0.4 : 1);
      leaves.setFraction(on ? 0.4 : 1);
      rays.visible = !on;
    },
    dispose: () => {
      bin.add(edge);
      bin.add(tileMaterial);
      bin.add(stone);
      bin.disposeAll(root);
    },
  };
}

function grassTexture(): THREE.CanvasTexture {
  const size = 512;
  const { canvas, ctx } = makeCanvas(size);
  ctx.fillStyle = "#6f9f4e";
  ctx.fillRect(0, 0, size, size);
  blotches(ctx, size, 90, 20, 80, ["rgba(60,110,40,0.35)", "rgba(150,190,90,0.3)", "rgba(110,90,50,0.15)"]);
  // Short blades, every direction.
  for (let i = 0; i < 2600; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    ctx.strokeStyle = `rgba(${40 + Math.random() * 60},${100 + Math.random() * 80},${30 + Math.random() * 40},0.5)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (Math.random() - 0.5) * 6, y - 4 - Math.random() * 7);
    ctx.stroke();
  }
  addGrain(ctx, size, 0.05);
  return finishTexture(canvas, 1, 1);
}

function earthTexture(): THREE.CanvasTexture {
  const size = 512;
  const { canvas, ctx } = makeCanvas(size);
  ctx.fillStyle = "#7a5a3a";
  ctx.fillRect(0, 0, size, size);
  // Layers of soil and stone, running level.
  for (let y = 0; y < size; y += 6 + Math.random() * 18) {
    ctx.fillStyle = `rgba(${60 + Math.random() * 70},${40 + Math.random() * 50},${20 + Math.random() * 30},0.5)`;
    ctx.fillRect(0, y, size, 4 + Math.random() * 14);
  }
  blotches(ctx, size, 50, 10, 50, ["rgba(30,20,10,0.3)", "rgba(150,120,80,0.25)"]);
  addGrain(ctx, size, 0.07);
  return finishTexture(canvas, 6, 3);
}

function mossyStoneTexture(): THREE.CanvasTexture {
  const size = 1024;
  const { canvas, ctx } = makeCanvas(size);
  ctx.fillStyle = "#a7ad9a";
  ctx.fillRect(0, 0, size, size);
  blotches(ctx, size, 90, 40, 200, ["rgba(255,255,240,0.14)", "rgba(70,80,60,0.16)"]);
  // Moss gathers in patches.
  blotches(ctx, size, 55, 30, 130, ["rgba(70,130,50,0.38)", "rgba(110,160,60,0.3)"]);
  ctx.lineCap = "round";
  for (let i = 0; i < 12; i++) {
    let x = Math.random() * size;
    let y = Math.random() * size;
    let angle = Math.random() * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let step = 0; step < 12; step++) {
      angle += (Math.random() - 0.5) * 0.9;
      x += Math.cos(angle) * (18 + Math.random() * 36);
      y += Math.sin(angle) * (18 + Math.random() * 36);
      ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "rgba(40,45,35,0.4)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  addGrain(ctx, size, 0.06);
  return finishTexture(canvas, 1, 1);
}

function barkTexture(): THREE.CanvasTexture {
  const size = 256;
  const { canvas, ctx } = makeCanvas(size);
  ctx.fillStyle = "#8a6238";
  ctx.fillRect(0, 0, size, size);
  for (let x = 0; x < size; x += 3 + Math.random() * 8) {
    ctx.fillStyle = `rgba(${40 + Math.random() * 40},${25 + Math.random() * 30},10,${0.25 + Math.random() * 0.3})`;
    ctx.fillRect(x, 0, 2 + Math.random() * 4, size);
  }
  addGrain(ctx, size, 0.08);
  return finishTexture(canvas, 2, 3);
}

/** A vertical fade, bright in the middle and clear at the ends, for the shafts of light. */
function rayGradient(): THREE.CanvasTexture {
  const { canvas, ctx } = makeCanvas(128);
  const g = ctx.createLinearGradient(0, 0, 128, 0);
  g.addColorStop(0, "rgba(255,255,255,0)");
  g.addColorStop(0.5, "rgba(255,255,255,1)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
