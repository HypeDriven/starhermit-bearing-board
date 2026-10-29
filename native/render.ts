// The travel board on starhermit:scene, ported from the browser build's
// three.js renderer (js/main.js createRenderer before the port): a leather
// field in a walnut frame with brass corner caps on a dark tabletop, lit by a
// warm key light, a cool hemisphere fill, a cool rim and (detailed) a warm
// lantern off the far-left corner; markers, selection rings and target
// discs, slide tweens, strike sparks, the intro swoop and camera shake. It
// consumes rules states plus their events and never mutates rules state.
//
// What changed from three.js, and why:
// - LatheGeometry is lathe() below; Phong brass on Low is a standard material.
// - The EffectComposer chain (GTAO, UnrealBloom, the grade ShaderPass,
//   SMAA / FXAA / MSAA) is renderer.ao / bloom / grade / antialias; the
//   grade is the built-in display-space grade with the same curve, tints and
//   vignette. Particles and selection decals stay out of AO (noAO).
// - Lights, shadows (the fitted shadow.camera box, bias, normalBias, radius,
//   PCF / PCF-soft), RoomEnvironment(renderer) reflections, bump maps and the
//   canvas textures' colour spaces are the page's own (engine minor 23+
//   follows three r155+, minor 28 follows texture.colorSpace). r160 scaled
//   scene.environment by each material's envMapIntensity, so each standard
//   material takes the room as its own envMap (applyEnvMaps).
// - Layers do not exist: picking tests the browser build's hit volumes as
//   boxes along the pointer's ray instead of raycasting invisible meshes.
import {
  ACESFilmicToneMapping, AdditiveBlending, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture,
  Box3, CircleGeometry, Color, CylinderGeometry, DirectionalLight, Fog, Group,
  HemisphereLight, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial,
  MeshPhysicalMaterial, MeshStandardMaterial, NormalBlending, OrthographicCamera, PCFShadowMap, PCFSoftShadowMap, PMREMGenerator, PerspectiveCamera, RoomEnvironment,
  PlaneGeometry, PointLight, Points, PointsMaterial, Quaternion, Raycaster, RepeatWrapping,
  RingGeometry, SRGBColorSpace, TorusGeometry, Vector3, pointerToNdc, renderer, scene,
} from "starhermit:scene";
import type { Material, Texture } from "starhermit:scene";
import { OffscreenCanvas } from "starhermit:canvas";
import * as Rules from "../js/rules.js";
import * as Content from "../js/content.js";
import { PARTICLE_MAX, MOTE_MAX, type Look } from "./quality.ts";

type Theme = (typeof Content.THEMES)[number];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type State = any; // the rules state (untyped js/rules.js)
type Ev = { type: string; player?: number; from?: number | "rail"; to?: number | "off"; point?: number; hit?: boolean };
export type Pick = { kind: "point"; point: number } | { kind: "rail" } | { kind: "off" } | null;
/** The part of the window the board may use, in normalized device coordinates (y up). */
export interface Frame { x0: number; y0: number; x1: number; y1: number }

// --- board layout model (shared with the HUD and the board cursor) -----------------------
export const LAYOUT = { cols: 12, colGap: 0.82, barGap: 0.55, rowZ: 2.35, markR: 0.3, markH: 0.16, stackStep: 0.42, maxStackShown: 5 };
const FRAMING = { tiltDeg: 54, halfW: 7.1, halfH: 3.55, lookX: 0.35, lookZ: 0.1, fov: 42 };
const PI = Math.PI;
const LANTERN = 6;

function pointCol(point: number): number { return point < 12 ? 11 - point : point - 12; }
function pointX(col: number): number {
  const base = (col - 5.5) * LAYOUT.colGap;
  return base + (col >= 6 ? LAYOUT.barGap / 2 : -LAYOUT.barGap / 2);
}
/** The centre of a point's column; `top` is the far row. */
export function pointPos(point: number): { x: number; z: number; top: boolean } {
  return { x: pointX(pointCol(point)), z: point < 12 ? LAYOUT.rowZ : -LAYOUT.rowZ, top: point >= 12 };
}
export function markerPos(point: number, idx: number): { x: number; y: number; z: number } {
  const p = pointPos(point);
  const dir = p.top ? 1 : -1; // stacks grow toward the bar
  const shown = Math.min(idx, LAYOUT.maxStackShown - 1);
  return { x: p.x, y: LAYOUT.markH / 2 + 0.001, z: p.z + dir * (0.34 + shown * LAYOUT.stackStep) };
}
export function railPos(players: number, p: number, idx: number): { x: number; y: number; z: number } {
  const lane = (p - (players - 1) / 2) * 0.34;
  const row = Math.floor(idx / 2);
  return { x: lane + (idx % 2 ? 0.17 : -0.17), y: LAYOUT.markH / 2, z: -1.55 + row * 0.42 };
}
export function offPos(players: number, p: number, idx: number): { x: number; y: number; z: number } {
  const laneZ = players <= 2 ? (p === 0 ? 1.6 : -1.6) : -2.4 + p * 1.6;
  return { x: 6.05, y: LAYOUT.markH / 2 + idx * (LAYOUT.markH + 0.01), z: laneZ };
}

// --- state -----------------------------------------------------------------------------
const camera = new PerspectiveCamera(FRAMING.fov, 16 / 9, 0.1, 100);
let look: Look | null = null;
let theme: Theme = Content.themeByKey("caravan") as Theme;
let reducedMotion = false;
let lastState: State | null = null;
const hex = (c: number | string): Color => new Color(c);

const keyLight = new DirectionalLight(0xfff1d6, 1.8);
keyLight.position.set(4, 9, 5);
keyLight.shadow.bias = -0.0004;
keyLight.shadow.normalBias = 0.02;
keyLight.shadow.radius = 3;
fitShadowFrustum();
const hemiLight = new HemisphereLight(0x8fa3c8, 0x2a1c12, 0.55);
const rim = new DirectionalLight(0xc8d4f0, 0.5);
rim.position.set(-5, 6, -4);
// Lantern off the far-left corner (as in the key art): warm pool of light on the leather.
const lantern = new PointLight(0xffb45e, LANTERN, 16, 2);
lantern.position.set(-6.2, 3.2, -3.6);

/** The key light's orthographic shadow camera fitted tightly around the play area (board,
 * frame, trays and the tallest stacks), measured in light space (the page's fitShadowFrustum). */
function fitShadowFrustum(): void {
  const cam = keyLight.shadow.camera as OrthographicCamera;
  keyLight.target.position.set(0, 0, 0);
  keyLight.updateMatrixWorld();
  keyLight.target.updateMatrixWorld();
  const view = new Matrix4().lookAt(keyLight.position, keyLight.target.position, new Vector3(0, 1, 0));
  view.setPosition(keyLight.position);
  const inv = view.clone().invert();
  const box = new Box3();
  for (const x of [-7.6, 7.6]) for (const y of [-0.45, 1.3]) for (const z of [-4.1, 4.1]) {
    box.expandByPoint(new Vector3(x, y, z).applyMatrix4(inv));
  }
  const pad = 0.3;
  cam.left = box.min.x - pad; cam.right = box.max.x + pad; cam.bottom = box.min.y - pad; cam.top = box.max.y + pad;
  cam.near = Math.max(0.1, -box.max.z - 2); cam.far = -box.min.z + 2;
  cam.updateProjectionMatrix();
}

const boardGroup = new Group();
const markerGroup = new Group();
const selGroup = new Group();
const fxGroup = new Group();
selGroup.noAO = true;
fxGroup.noAO = true;
let built = false;
function build(): void {
  built = true;
  scene.add(keyLight, keyLight.target, hemiLight, rim, lantern, boardGroup, markerGroup, selGroup, fxGroup);
  renderer.camera = camera;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  buildParticles();
  buildMotes();
  buildSelection();
}

// --- procedural textures (seeded; never touch the rules RNG) ----------------------------------
const textureCache = new Map<string, unknown>();

function makeLeatherTexture(base: string): Texture {
  const key = `speckle:${base}`;
  const hit = textureCache.get(key) as Texture | undefined;
  if (hit) return hit;
  const c = new OffscreenCanvas(128, 128);
  const g = c.getContext("2d");
  g.fillStyle = base;
  g.fillRect(0, 0, 128, 128);
  const rng = Rules.createRng(Rules.hashSeed("leather"));
  for (let i = 0; i < 2600; i++) {
    const v = rng.next();
    g.fillStyle = `rgba(${v > 0.5 ? "255,235,200" : "10,5,0"},${0.03 + rng.next() * 0.05})`;
    g.fillRect(rng.int(128), rng.int(128), 1 + rng.int(2), 1 + rng.int(2));
  }
  const tex = new CanvasTexture(c);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.repeat.set(3, 2);
  tex.colorSpace = SRGBColorSpace;
  textureCache.set(key, tex);
  return tex;
}

/** Detailed tier: seeded leather (mottling, pores, creases) as a colour map
 * plus its relief as a bump map (with `bump`). */
function makeLeatherMaps(base: string, size: number, bump: boolean): { map: Texture; bump: Texture | null } {
  const key = `leather:${base}:${size}:${bump}`;
  const hit = textureCache.get(key) as { map: Texture; bump: Texture | null } | undefined;
  if (hit) return hit;
  const N = size, k = N / 512; // authored at 512 px; pores stay 1–2 px, so larger maps are finer
  const S = 512;
  const c = new OffscreenCanvas(N, N);
  const g = c.getContext("2d");
  const b = bump ? new OffscreenCanvas(N, N) : null;
  const gb = b ? b.getContext("2d") : null;
  // The broad mottling is drawn at the authored 512 px and scaled to the map
  // (large radial gradients at 1024 px pass the engine's canvas work budget).
  const ms = Math.min(N, S), mk = ms / S;
  const mc = new OffscreenCanvas(ms, ms), mg = mc.getContext("2d");
  const mb = bump ? new OffscreenCanvas(ms, ms) : null, mgb = mb ? mb.getContext("2d") : null;
  mg.fillStyle = base; mg.fillRect(0, 0, ms, ms);
  if (mgb) { mgb.fillStyle = "#808080"; mgb.fillRect(0, 0, ms, ms); }
  mg.setTransform(mk, 0, 0, mk, 0, 0); mgb?.setTransform(mk, 0, 0, mk, 0, 0);
  const rng = Rules.createRng(Rules.hashSeed("leather:detail"));
  type Ctx = typeof g;
  const bothM = (fn: (ctx: Ctx, isBump: boolean) => void): void => { fn(mg, false); if (mgb) fn(mgb, true); };
  const both = (fn: (ctx: Ctx, isBump: boolean) => void): void => { fn(g, false); if (gb) fn(gb, true); };
  // Broad mottling (wraps across the tile edges so the repeat is seamless).
  for (let i = 0; i < 70; i++) {
    const x = rng.next() * S, y = rng.next() * S, r = 30 + rng.next() * 90;
    const light = rng.next() > 0.5, a = 0.035 + rng.next() * 0.05;
    for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) {
      if (x + dx + r < 0 || x + dx - r > S || y + dy + r < 0 || y + dy - r > S) continue;
      bothM((ctx, isBump) => {
        const grd = ctx.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
        const col = isBump ? (light ? "255,255,255" : "0,0,0") : (light ? "255,236,200" : "30,14,4");
        grd.addColorStop(0, `rgba(${col},${isBump ? a * 1.5 : a})`);
        grd.addColorStop(1, `rgba(${col},0)`);
        ctx.fillStyle = grd;
        ctx.fillRect(x + dx - r, y + dy - r, r * 2, r * 2);
      });
    }
  }
  g.drawImage(mc, 0, 0, N, N);
  if (gb && mb) gb.drawImage(mb, 0, 0, N, N);
  // Pores (native pixels: the count grows with the texture area), written
  // straight into the pixels: tens of thousands of 1–2 px rectangles.
  g.setTransform(1, 0, 0, 1, 0, 0); gb?.setTransform(1, 0, 0, 1, 0, 0);
  const img = g.getImageData(0, 0, N, N);
  const bimg = gb ? gb.getImageData(0, 0, N, N) : null;
  const blend = (data: Uint8ClampedArray | Uint8Array, x: number, y: number, s: number, r: number, gg: number, bb: number, al: number): void => {
    for (let yy = y; yy < Math.min(N, y + s); yy++) {
      for (let xx = x; xx < Math.min(N, x + s); xx++) {
        const o = (yy * N + xx) * 4;
        data[o] = data[o]! + (r - data[o]!) * al;
        data[o + 1] = data[o + 1]! + (gg - data[o + 1]!) * al;
        data[o + 2] = data[o + 2]! + (bb - data[o + 2]!) * al;
      }
    }
  };
  for (let i = 0, n = Math.round(16000 * k * k); i < n; i++) {
    const x = rng.int(N), y = rng.int(N), s = 1 + rng.int(2), dark = rng.next() > 0.35;
    const a1 = 0.03 + rng.next() * 0.06;
    if (dark) blend(img.data, x, y, s, 20, 10, 2, a1); else blend(img.data, x, y, s, 255, 240, 210, a1);
    const a2 = 0.15 + rng.next() * 0.2;
    if (bimg) { const v = dark ? 0 : 255; blend(bimg.data, x, y, s, v, v, v, a2); }
  }
  g.putImageData(img, 0, 0);
  if (gb && bimg) gb.putImageData(bimg, 0, 0);
  // Fine creases.
  g.setTransform(k, 0, 0, k, 0, 0); gb?.setTransform(k, 0, 0, k, 0, 0);
  for (let i = 0; i < 90; i++) {
    let x = rng.next() * S, y = rng.next() * S, a = rng.next() * PI * 2;
    const len = 8 + rng.int(26);
    both((ctx, isBump) => {
      ctx.strokeStyle = isBump ? "rgba(0,0,0,0.35)" : "rgba(25,12,4,0.08)";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y);
    });
    for (let j = 0; j < len; j++) {
      a += (rng.next() - 0.5) * 0.5; x += Math.cos(a) * 2; y += Math.sin(a) * 2;
      g.lineTo(x, y); gb?.lineTo(x, y);
    }
    g.stroke(); gb?.stroke();
  }
  const map = new CanvasTexture(c);
  map.wrapS = map.wrapT = RepeatWrapping;
  map.anisotropy = 4;
  map.colorSpace = SRGBColorSpace;
  let bumpTex: Texture | null = null;
  if (b) {
    bumpTex = new CanvasTexture(b);
    bumpTex.wrapS = bumpTex.wrapT = RepeatWrapping;
    bumpTex.anisotropy = 4;
  }
  const out = { map, bump: bumpTex };
  textureCache.set(key, out);
  return out;
}

/** Wood grain (walnut frame, centre bar, table): streaky seeded rings along the u axis. */
function makeWoodTexture(seedKey: string, size: number): Texture {
  const W = 512, H = 128, k = size / 512; // authored at 512×128, drawn at the budget's size
  const c = new OffscreenCanvas(Math.round(W * k), Math.round(H * k));
  const g = c.getContext("2d");
  g.setTransform(k, 0, 0, k, 0, 0);
  g.fillStyle = "#d6d6d6"; g.fillRect(0, 0, W, H);
  const rng = Rules.createRng(Rules.hashSeed(`wood:${seedKey}`));
  for (let i = 0; i < 150; i++) {
    const y0 = rng.next() * H, amp = 1 + rng.next() * 5, freq = (1 + rng.int(3)) * PI * 2 / W, ph = rng.next() * 6;
    const light = rng.next() > 0.55;
    g.strokeStyle = `rgba(${light ? "255,255,255" : "0,0,0"},${0.04 + rng.next() * 0.1})`;
    g.lineWidth = 0.6 + rng.next() * 2.2;
    g.beginPath();
    for (let x = 0; x <= W; x += 8) {
      const y = y0 + Math.sin(x * freq + ph) * amp;
      if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
  }
  for (let i = 0; i < 5; i++) { // a few knots
    const x = rng.next() * W, y = rng.next() * H, r = 3 + rng.next() * 6;
    const grd = g.createRadialGradient(x, y, 0, x, y, r * 2.5);
    grd.addColorStop(0, "rgba(0,0,0,0.35)"); grd.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grd; g.beginPath(); g.ellipse(x, y, r * 3, r, 0, 0, PI * 2); g.fill();
  }
  const tex = new CanvasTexture(c);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
function woodTextures(key: string, size: number): { a: Texture; b: Texture; table: Texture } {
  const ck = `wood:${key}:${size}`;
  const hit = textureCache.get(ck) as { a: Texture; b: Texture; table: Texture } | undefined;
  if (hit) return hit;
  const a = makeWoodTexture(key, size);
  const b = makeWoodTexture(key, size);
  b.center.set(0.5, 0.5); b.rotation = PI / 2;
  const table = makeWoodTexture(`${key}:table`, size);
  table.repeat.set(19, 100);
  table.center.set(0.5, 0.5);
  table.rotation = PI / 2;
  const out = { a, b, table };
  textureCache.set(ck, out);
  return out;
}

/** three.js LatheGeometry: a profile (x radius, y height) turned about the y axis. */
function lathe(points: [number, number][], segments: number): BufferGeometry {
  const n = points.length;
  // Profile normals: perpendicular to the averaged tangents, as three.js computes them.
  const pn: [number, number][] = [];
  for (let j = 0; j < n; j++) {
    const prev = points[Math.max(0, j - 1)]!, next = points[Math.min(n - 1, j + 1)]!;
    const dx = next[0] - prev[0], dy = next[1] - prev[1];
    const l = Math.hypot(dx, dy) || 1;
    pn.push([dy / l, -dx / l]);
  }
  const pos: number[] = [], nrm: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const phi = (i / segments) * PI * 2, s = Math.sin(phi), c = Math.cos(phi);
    for (let j = 0; j < n; j++) {
      const [r, y] = points[j]!;
      pos.push(r * s, y, r * c);
      nrm.push(pn[j]![0] * s, pn[j]![1], pn[j]![0] * c);
      uv.push(i / segments, j / (n - 1));
    }
  }
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < n - 1; j++) {
      const a = i * n + j, b = a + n, c2 = b + 1, d = a + 1;
      idx.push(a, b, d, c2, d, b);
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute("normal", new BufferAttribute(new Float32Array(nrm), 3));
  geo.setAttribute("uv", new BufferAttribute(new Float32Array(uv), 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

/** Bevelled marker: rounded rims and a shallow groove inside the brass ring. */
function makeMarkerGeometry(detailed: boolean, segments: number): BufferGeometry {
  const R = LAYOUT.markR, H = LAYOUT.markH;
  if (!detailed) return new CylinderGeometry(R, R, H, Math.min(22, segments));
  const pts: [number, number][] = [];
  const bev = 0.035;
  pts.push([0, -H / 2]);
  for (let i = 0; i <= 4; i++) { // bottom rounded rim
    const a = -PI / 2 + (i / 4) * (PI / 2);
    pts.push([R - bev + Math.cos(a) * bev, -H / 2 + bev + Math.sin(a) * bev]);
  }
  for (let i = 0; i <= 4; i++) { // top rounded rim
    const a = (i / 4) * (PI / 2);
    pts.push([R - bev + Math.cos(a) * bev, H / 2 - bev + Math.sin(a) * bev]);
  }
  pts.push([R * 0.8, H / 2], [R * 0.74, H / 2 - 0.012], [R * 0.5, H / 2 - 0.012], [R * 0.44, H / 2 - 0.004], [0, H / 2 - 0.004]);
  return lathe(pts, segments);
}

const capRingGeo = new TorusGeometry(LAYOUT.markR * 0.62, 0.022, 8, 22);

/** Low/Balanced marker: the brass cap ring merged into the marker geometry,
 * the player colour (body) and the theme accent (ring) as vertex colours. */
function mergeRing(body: BufferGeometry, playerColor: number, accent: number): BufferGeometry {
  const ring = capRingGeo.clone();
  ring.rotateX(PI / 2);
  ring.translate(0, LAYOUT.markH / 2, 0);
  const a = body.getIndex() ? body.toNonIndexed() : body.clone();
  const b = ring.toNonIndexed();
  ring.dispose();
  const pc = hex(playerColor), ac = hex(accent);
  const out = new BufferGeometry();
  for (const name of ["position", "normal", "uv"] as const) {
    const x = a.getAttribute(name), y = b.getAttribute(name);
    if (!x || !y) continue;
    const arr = new Float32Array(x.array.length + y.array.length);
    arr.set(x.array as Float32Array, 0); arr.set(y.array as Float32Array, x.array.length);
    out.setAttribute(name, new BufferAttribute(arr, x.itemSize));
  }
  const na = a.getAttribute("position")!.count, nb = b.getAttribute("position")!.count;
  const col = new Float32Array((na + nb) * 3);
  for (let i = 0; i < na + nb; i++) col.set(i < na ? [pc.r, pc.g, pc.b] : [ac.r, ac.g, ac.b], i * 3);
  out.setAttribute("color", new BufferAttribute(col, 3));
  a.dispose(); b.dispose();
  out.computeBoundingSphere();
  return out;
}

// --- environment: three.js's RoomEnvironment, prefiltered as the browser build did ------------------
let envTex: Texture | null = null;
function buildEnvironment(): Texture | null {
  if (envTex) return envTex;
  try { envTex = new PMREMGenerator(renderer).fromScene(new RoomEnvironment(renderer), 0.04).texture; }
  catch (e) { console.warn("environment:", e instanceof Error ? e.message : String(e)); }
  return envTex;
}
/** r160: scene.environment scaled by each standard material's envMapIntensity —
 * give every standard/physical material the room as its own envMap. */
function applyEnvMaps(): void {
  const env = look?.reflections ? envTex : null;
  scene.traverse((o) => {
    const mat = (o as Mesh).material as Material | Material[] | undefined;
    if (!mat) return;
    for (const m of Array.isArray(mat) ? mat : [mat]) if (m instanceof MeshStandardMaterial) m.envMap = env;
  });
}

// --- the board ---------------------------------------------------------------------------------
let playerMats: Material[] = [];
let ringMat: Material | null = null;
let markerGeo: BufferGeometry | null = null;
let mergedGeos: BufferGeometry[] = [];
let boardKey = "";

function disposeGroup(group: Group): void {
  group.traverse((o) => {
    const m = o as Mesh;
    if (m.geometry && m.geometry !== capRingGeo) m.geometry.dispose();
    if (m.material) m.material.dispose();
  });
  group.clear();
}

function buildMaterials(): void {
  const L = look!, B = L.budget, detailed = L.detailed;
  playerMats.forEach((m) => m.dispose());
  ringMat?.dispose();
  playerMats = theme.players.map((color, i) => (B.material === "lambert" && !detailed
    ? new MeshLambertMaterial({ color })
    : detailed && B.material === "physical"
      ? new MeshPhysicalMaterial({ color, roughness: 0.4, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.22, envMapIntensity: i === 0 ? 0.25 : 0.4 })
      : new MeshStandardMaterial({ color, roughness: detailed ? 0.36 : 0.32, metalness: i === 0 ? 0.05 : 0.12, envMapIntensity: i === 0 ? 0.25 : 0.4 })));
  ringMat = new MeshStandardMaterial({ color: theme.accent, roughness: detailed ? 0.3 : 0.35, metalness: 0.8, envMapIntensity: 0.6 });
  markerGeo?.dispose();
  markerGeo = makeMarkerGeometry(detailed, B.segments);
  mergedGeos.forEach((g) => g.dispose());
  mergedGeos = B.mergedRing ? theme.players.map((color) => mergeRing(markerGeo!, color, theme.accent)) : [];
  // Merged markers carry their body and ring colours per vertex; the material colour goes white.
  if (B.mergedRing) playerMats.forEach((m) => { m.vertexColors = true; m.color.set(0xffffff); });
}

function buildBoard(): void {
  const L = look!, B = L.budget, detailed = L.detailed;
  const W = 14.6, D = 7.6, rimW = 0.55;
  let frameMat: Material, frameMatSide: Material, feltMat: Material, railMat: Material, tableMat: Material;
  let pointTex: { map: Texture; bump: Texture | null } | null = null;
  // The field sits a shade darker than the theme felt so the light points stand out.
  const feltColor = hex(theme.felt).lerp(hex(theme.rail), 0.14);
  const feltHex = `#${feltColor.getHex().toString(16).padStart(6, "0")}`;
  const lite = B.material === "lambert" && !detailed; // Low
  if (detailed) {
    const T = B.texture;
    const leather = makeLeatherMaps(feltHex, T, B.bump);
    const wood = woodTextures(theme.key, T);
    pointTex = makeLeatherMaps("#b0b0b0", T, B.bump);
    const pointMap = pointTex.map;
    pointMap.repeat.set(0.45, 0.45);
    if (pointTex.bump) pointTex.bump.repeat.set(0.45, 0.45);
    leather.map.repeat.set(3, 1.5);
    if (leather.bump) leather.bump.repeat.set(3, 1.5);
    frameMat = B.material === "physical"
      ? new MeshPhysicalMaterial({ color: theme.frame, map: wood.a, roughness: 0.42, metalness: 0, clearcoat: 0.35, clearcoatRoughness: 0.35, envMapIntensity: 0.3 })
      : new MeshStandardMaterial({ color: theme.frame, map: wood.a, roughness: 0.42, metalness: 0, envMapIntensity: 0.3 });
    frameMatSide = frameMat.clone();
    frameMatSide.map = wood.b;
    feltMat = new MeshStandardMaterial({
      color: 0xffffff, map: leather.map, roughness: 0.85, metalness: 0, envMapIntensity: 0.2,
      ...(leather.bump ? { bumpMap: leather.bump, bumpScale: 0.9 } : {}),
    });
    railMat = new MeshStandardMaterial({ color: theme.rail, map: wood.b, roughness: 0.5, envMapIntensity: 0.3 });
    tableMat = new MeshStandardMaterial({ color: hex(theme.rail).multiplyScalar(0.55), map: wood.table, roughness: 0.62, envMapIntensity: 0.2 });
  } else if (lite) {
    frameMat = frameMatSide = new MeshLambertMaterial({ color: theme.frame });
    feltMat = new MeshLambertMaterial({ color: 0xffffff, map: makeLeatherTexture(feltHex) });
    railMat = new MeshLambertMaterial({ color: theme.rail });
    tableMat = new MeshLambertMaterial({ color: hex(theme.rail).multiplyScalar(0.5) });
  } else {
    frameMat = frameMatSide = new MeshStandardMaterial({ color: theme.frame, roughness: 0.55, metalness: 0.08 });
    feltMat = new MeshStandardMaterial({ color: 0xffffff, map: makeLeatherTexture(feltHex), roughness: 0.9, metalness: 0 });
    railMat = new MeshStandardMaterial({ color: theme.rail, roughness: 0.7 });
    tableMat = new MeshStandardMaterial({ color: hex(theme.rail).multiplyScalar(0.5), roughness: 0.8 });
  }
  // Low's Phong brass: a less metallic standard brass (no environment to reflect there).
  const brassMat = lite
    ? new MeshStandardMaterial({ color: theme.accent, roughness: 0.32, metalness: 0.45 })
    : new MeshStandardMaterial({ color: theme.accent, roughness: detailed ? 0.34 : 0.3, metalness: 0.85, envMapIntensity: 0.5 });

  // Tabletop the travel board rests on: grounds the board and catches its shadow.
  const table = new Mesh(new PlaneGeometry(400, 400), tableMat);
  table.rotation.x = -PI / 2;
  table.position.y = -0.43;
  table.receiveShadow = true;
  boardGroup.add(table);

  // Wooden frame (four rails) + leather field.
  const mk = (w: number, d: number, x: number, z: number, mat: Material): void => {
    const m = new Mesh(new BoxGeometry(w, 0.42, d), mat);
    m.position.set(x, -0.21, z);
    m.receiveShadow = true;
    m.castShadow = true;
    boardGroup.add(m);
  };
  mk(W, rimW, 0, -D / 2 + rimW / 2, frameMat);
  mk(W, rimW, 0, D / 2 - rimW / 2, frameMat);
  mk(rimW, D - rimW * 2, -W / 2 + rimW / 2, 0, frameMatSide);
  mk(rimW, D - rimW * 2, W / 2 - rimW / 2, 0, frameMatSide);

  const field = new Mesh(new BoxGeometry(W - rimW * 2, 0.3, D - rimW * 2), feltMat);
  field.position.y = -0.15;
  field.receiveShadow = true;
  boardGroup.add(field);

  // Centre bar (the rail for struck markers).
  const bar = new Mesh(new BoxGeometry(0.5, 0.34, D - rimW * 2), railMat);
  bar.position.y = 0.02;
  bar.receiveShadow = true;
  bar.castShadow = true;
  boardGroup.add(bar);

  // Brass corner caps.
  const capGeo = new CylinderGeometry(0.22, 0.26, 0.1, detailed ? 24 : 12);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const cap = new Mesh(capGeo, brassMat);
    cap.position.set(sx * (W / 2 - 0.3), 0.05, sz * (D / 2 - 0.3));
    cap.castShadow = true;
    boardGroup.add(cap);
  }

  if (detailed) {
    // Brass hinges where the travel board folds, and saddle stitching around the leather.
    const hingeGeo = new CylinderGeometry(0.075, 0.075, 0.7, 16);
    hingeGeo.rotateZ(PI / 2);
    for (const sz of [-1, 1]) {
      const h = new Mesh(hingeGeo, brassMat);
      h.position.set(0, 0.03, sz * (D / 2 - rimW / 2));
      h.castShadow = true;
      boardGroup.add(h);
    }
    const inset = 0.16, fw = W - rimW * 2 - inset * 2, fd = D - rimW * 2 - inset * 2;
    const dash = 0.13, gap = 0.08;
    const spots: [number, number, number][] = [];
    for (const [len, horiz] of [[fw, true], [fd, false]] as const) {
      for (let t = -len / 2 + gap; t + dash <= len / 2; t += dash + gap) {
        for (const side of [-1, 1]) spots.push(horiz ? [t + dash / 2, side * fd / 2, 0] : [side * fw / 2, t + dash / 2, PI / 2]);
      }
    }
    const stitch = new InstancedMesh(
      new BoxGeometry(dash, 0.012, 0.028),
      new MeshStandardMaterial({ color: hex(theme.accent).lerp(hex(0x3a2a1c), 0.25), roughness: 0.8 }),
      spots.length,
    );
    const m4 = new Matrix4(), q = new Quaternion(), one = new Vector3(1, 1, 1), up = new Vector3(0, 1, 0), p = new Vector3();
    spots.forEach(([x, z, rot], i) => {
      q.setFromAxisAngle(up, rot);
      stitch.setMatrixAt(i, m4.compose(p.set(x, 0.004, z), q, one));
    });
    stitch.instanceMatrix.needsUpdate = true;
    stitch.receiveShadow = true;
    boardGroup.add(stitch);
  }

  // Triangular points: flat inlaid leather in two alternating tones, pointing toward
  // the bar, merged into one mesh per tone (plus a dark inlay border).
  const triA: number[] = [], triB: number[] = [], triEdge: number[] = [];
  const baseZ = 3.0, tipZ = 0.42, halfW = 0.36;
  const pushTri = (arr: number[], x: number, zb: number, zt: number, hw: number, y: number): void => {
    const a = [x - hw, y, zb], b = [x + hw, y, zb], c = [x, y, zt];
    // Counter-clockwise seen from above so the faces point up.
    const cross = (b[2]! - a[2]!) * (c[0]! - a[0]!) - (b[0]! - a[0]!) * (c[2]! - a[2]!);
    arr.push(...a, ...(cross > 0 ? b : c), ...(cross > 0 ? c : b));
  };
  for (let point = 0; point < Rules.POINTS; point++) {
    const pos = pointPos(point);
    const s = pos.top ? -1 : 1;
    pushTri(pointCol(point) % 2 ? triA : triB, pos.x, s * baseZ, s * tipZ, halfW, 0.006);
    pushTri(triEdge, pos.x, s * (baseZ + 0.03), s * (tipZ - 0.07), halfW + 0.035, 0.003);
  }
  const triMesh = (arr: number[], mat: Material): void => {
    const geo = new BufferGeometry();
    const n = arr.length / 3;
    const uv = new Float32Array(n * 2), nrm = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { uv[i * 2] = arr[i * 3]!; uv[i * 2 + 1] = arr[i * 3 + 2]!; nrm[i * 3 + 1] = 1; }
    geo.setAttribute("position", new BufferAttribute(new Float32Array(arr), 3));
    geo.setAttribute("uv", new BufferAttribute(uv, 2));
    geo.setAttribute("normal", new BufferAttribute(nrm, 3));
    geo.computeBoundingSphere();
    const m = new Mesh(geo, mat);
    m.receiveShadow = true;
    boardGroup.add(m);
  };
  const pointMat = (color: number): Material => new MeshStandardMaterial({
    color, roughness: 0.8, envMapIntensity: 0.2,
    ...(pointTex ? { map: pointTex.map, ...(pointTex.bump ? { bumpMap: pointTex.bump, bumpScale: 0.6 } : {}) } : {}),
  });
  triMesh(triA, pointMat(theme.board));
  triMesh(triB, pointMat(theme.boardAlt));
  triMesh(triEdge, new MeshStandardMaterial({ color: hex(theme.rail).multiplyScalar(0.8), roughness: 0.6 }));

  // Off trays (one lane per seat, right-hand side).
  const trayGeo = new BoxGeometry(0.85, 0.1, 1.3);
  for (let p = 0; p < 4; p++) {
    const pos = offPos(4, p, 0);
    const tray = new Mesh(trayGeo, railMat);
    tray.position.set(pos.x, 0.0, pos.z);
    boardGroup.add(tray);
  }
}

function rebuildBoard(): void {
  if (!look) return;
  const B = look.budget;
  const key = [theme.key, look.detailed, B.material, B.segments, B.texture, B.bump, B.mergedRing].join("|");
  if (key === boardKey) return;
  boardKey = key;
  disposeGroup(boardGroup);
  buildMaterials();
  buildBoard();
  if (lastState) rebuildMarkers(lastState);
  applyEnvMaps();
}

// --- markers --------------------------------------------------------------------------------
interface Desired { key: string; pos: { x: number; y: number; z: number }; player: number }
function desiredMarkers(state: State): Desired[] {
  const out: Desired[] = [];
  for (let i = 0; i < Rules.POINTS; i++) {
    const cell = state.points[i]!;
    if (cell.owner < 0 || cell.count === 0) continue;
    const shown = Math.min(cell.count, LAYOUT.maxStackShown);
    for (let k = 0; k < shown; k++) {
      const pos = markerPos(i, k);
      if (cell.count > LAYOUT.maxStackShown && k === shown - 1) pos.y += 0.05;
      out.push({ key: `p${i}:${k}`, pos, player: cell.owner });
    }
  }
  state.rail.forEach((n: number, p: number) => {
    for (let k = 0; k < Math.min(n, 10); k++) out.push({ key: `r${p}:${k}`, pos: railPos(state.cfg.players, p, k), player: p });
  });
  state.off.forEach((n: number, p: number) => {
    for (let k = 0; k < n; k++) out.push({ key: `o${p}:${k}`, pos: offPos(state.cfg.players, p, k), player: p });
  });
  return out;
}

const markerPool: Mesh[] = [];
const markerMeshes = new Map<string, Mesh>();
function rebuildMarkers(state: State): void {
  if (!markerGeo) return;
  markerMeshes.clear();
  const want = desiredMarkers(state);
  while (markerPool.length < want.length) {
    const m = new Mesh(markerGeo, playerMats[0]!);
    m.castShadow = m.receiveShadow = true;
    const ring = new Mesh(capRingGeo, ringMat!);
    ring.rotation.x = PI / 2;
    ring.position.y = LAYOUT.markH / 2;
    m.add(ring);
    markerGroup.add(m);
    markerPool.push(m);
  }
  markerPool.forEach((m, i) => {
    const d = want[i];
    if (!d) { m.visible = false; return; }
    const merged = mergedGeos[d.player] ?? mergedGeos[0];
    m.geometry = merged ?? markerGeo!;
    m.material = playerMats[d.player] ?? playerMats[0]!;
    const ring = m.children[0] as Mesh;
    ring.visible = !merged;
    ring.material = ringMat!;
    m.position.set(d.pos.x, d.pos.y, d.pos.z);
    m.visible = true;
    markerMeshes.set(d.key, m);
  });
  applyEnvMaps();
}

// --- tweens, effects, sync -----------------------------------------------------------------------
interface Tween { mesh: Mesh; from: Vector3; to: Vector3; t: number; dur: number }
let tweens: Tween[] = [];
function tweenPosition(mesh: Mesh, from: Vector3, durMs: number): void {
  const to = mesh.position.clone();
  mesh.position.copy(from);
  tweens.push({ mesh, from: from.clone(), to, t: 0, dur: durMs / 1000 });
}

/** Shows a rules state; `events` (from the command that led to it) animate. */
export function sync(state: State, events: Ev[] = []): void {
  lastState = state;
  for (const tw of tweens) tw.mesh.position.copy(tw.to);
  tweens = [];
  rebuildMarkers(state);
  if (!reducedMotion) {
    // 'hit' events describe the struck victim; its striker's 'move' carries the slide.
    for (const ev of events) {
      if (ev.type !== "move" || ev.player == null) continue;
      const toKey = ev.to === "off"
        ? `o${ev.player}:${Math.max(0, state.off[ev.player]! - 1)}`
        : `p${ev.to}:${Math.max(0, Math.min(state.points[ev.to as number]!.count, LAYOUT.maxStackShown) - 1)}`;
      const mesh = markerMeshes.get(toKey);
      if (!mesh) continue;
      let from;
      if (ev.from === "rail") from = railPos(state.cfg.players, ev.player, state.rail[ev.player]!);
      else {
        const cell = state.points[ev.from as number]!;
        from = markerPos(ev.from as number, Math.max(0, Math.min(cell.count, LAYOUT.maxStackShown) - 1));
      }
      tweenPosition(mesh, new Vector3(from.x, from.y + 0.25, from.z), 320);
    }
  }
  // Event-tiered effects: strike and bear-off sparks, the game-over burst.
  for (const ev of events) {
    if (ev.type === "hit" && ev.point != null) {
      const pos = pointPos(ev.point);
      burst(pos.x, 0.35, pos.z, theme.accent, 26);
      shakeCamera(0.06);
    } else if (ev.type === "bearOff") {
      burst(6.05, 0.5, 0, 0xffe9a8, 12);
    } else if (ev.type === "gameOver") {
      burst(0, 1.2, 0, theme.accent, 90);
      burst(2, 1.0, 1.5, 0xffffff, 50);
      shakeCamera(0.1);
    }
  }
}

/** Every animation to its end: the exact rules position (Skip Anim). */
export function settle(): void {
  for (const tw of tweens) tw.mesh.position.copy(tw.to);
  tweens = [];
  camIntro = 0;
}

// --- selection decals and the board cursor --------------------------------------------------------
interface Decal { mesh: Mesh; mat: MeshBasicMaterial; kind: "origin" | "disc" | "ring" | "cursor" }
const decals: Decal[] = [];
function buildSelection(): void {
  const mk = (geo: BufferGeometry, kind: Decal["kind"]): void => {
    // Selection decals keep their exact colours (no tone mapping) so they always read clearly.
    const mat = new MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false });
    const mesh = new Mesh(geo, mat);
    mesh.rotation.x = -PI / 2;
    mesh.visible = false;
    mesh.noAO = true;
    selGroup.add(mesh);
    decals.push({ mesh, mat, kind });
  };
  mk(new RingGeometry(0.36, 0.5, 28), "origin");
  const disc = new CircleGeometry(0.3, 24), ring = new RingGeometry(0.3, 0.42, 24);
  for (let i = 0; i < 6; i++) { mk(disc, "disc"); mk(ring, "ring"); }
  mk(new RingGeometry(0.47, 0.55, 32), "cursor");
}
export interface Spot { x: number; z: number; hit?: boolean }
/** The selected origin's brass ring and its targets (green discs, red for a strike). */
export function setSelection(origin: Spot | null, targets: Spot[]): void {
  let di = 0, ri = 0;
  for (const d of decals) {
    if (d.kind === "cursor") continue;
    d.mesh.visible = false;
    if (d.kind === "origin" && origin) {
      d.mat.color.set(0xffd97a);
      d.mesh.position.set(origin.x, 0.02, origin.z);
      d.mesh.visible = true;
    } else if (d.kind === "disc") {
      const tg = targets[di++];
      if (!tg) continue;
      d.mat.color.set(tg.hit ? 0xe06a4a : 0x7ac86a);
      d.mat.opacity = 0.4;
      d.mesh.position.set(tg.x, 0.02, tg.z);
      d.mesh.visible = true;
    } else if (d.kind === "ring") {
      const tg = targets[ri++];
      if (!tg) continue;
      d.mat.color.set(tg.hit ? 0xe06a4a : 0x9ae08a);
      d.mesh.position.set(tg.x, 0.025, tg.z);
      d.mesh.visible = true;
    }
  }
}
export function clearSelection(): void { setSelection(null, []); }
/** The keyboard / pad board cursor (the browser build's focused mirror button), or null. */
export function setCursor(spot: Spot | null): void {
  const d = decals.find((x) => x.kind === "cursor");
  if (!d) return;
  d.mesh.visible = !!spot;
  if (spot) { d.mat.color.set(0xffd97a); d.mat.opacity = 0.9; d.mesh.position.set(spot.x, 0.03, spot.z); }
}

// --- particles and motes --------------------------------------------------------------------------
interface Particle { life: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; r: number; g: number; b: number }
let particles: { points: Points; mat: PointsMaterial; pos: Float32Array; col: Float32Array; data: Particle[]; cursor: number } | null = null;
function buildParticles(): void {
  const geo = new BufferGeometry();
  const pos = new Float32Array(PARTICLE_MAX * 3), col = new Float32Array(PARTICLE_MAX * 3);
  for (let i = 0; i < PARTICLE_MAX; i++) pos[i * 3 + 1] = -99;
  geo.setAttribute("position", new BufferAttribute(pos, 3));
  geo.setAttribute("color", new BufferAttribute(col, 3));
  const mat = new PointsMaterial({ size: 0.09, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false });
  const points = new Points(geo, mat);
  points.frustumCulled = false;
  fxGroup.add(points);
  particles = { points, mat, pos, col, data: Array.from({ length: PARTICLE_MAX }, () => ({ life: 0, x: 0, y: -99, z: 0, vx: 0, vy: 0, vz: 0, r: 1, g: 1, b: 1 })), cursor: 0 };
}
let fxSeed = 1;
function burst(x: number, y: number, z: number, color: number, n: number): void {
  if (reducedMotion || !particles || !look) return;
  if (look.particles === "low") n = Math.ceil(n / 2);
  const B = look.budget;
  n = Math.max(1, Math.min(B.particles, Math.round(n * B.burst)));
  const c = hex(color);
  const rng = Rules.createRng(Rules.hashSeed(`fx:${x}:${z}:${fxSeed++}`));
  for (let i = 0; i < n; i++) {
    const p = particles.data[particles.cursor]!;
    particles.cursor = (particles.cursor + 1) % Math.min(PARTICLE_MAX, B.particles);
    const a = rng.next() * PI * 2;
    const sp = 1.2 + rng.next() * 2.2;
    p.life = 0.55 + rng.next() * 0.4;
    p.x = x; p.y = y; p.z = z;
    p.vx = Math.cos(a) * sp; p.vz = Math.sin(a) * sp; p.vy = 1.6 + rng.next() * 2.0;
    p.r = c.r; p.g = c.g; p.b = c.b;
  }
}
function updateParticles(dt: number): void {
  if (!particles) return;
  const { pos, col } = particles;
  let any = false;
  particles.data.forEach((p, i) => {
    if (p.life > 0) {
      any = true;
      p.life -= dt;
      p.vy -= 6.5 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.y < 0.03) { p.y = 0.03; p.vy *= -0.35; p.vx *= 0.7; p.vz *= 0.7; }
      const fade = Math.max(0, Math.min(1, p.life * 2));
      pos[i * 3] = p.x; pos[i * 3 + 1] = p.life > 0 ? p.y : -99; pos[i * 3 + 2] = p.z;
      col[i * 3] = p.r * fade; col[i * 3 + 1] = p.g * fade; col[i * 3 + 2] = p.b * fade;
    } else if (pos[i * 3 + 1]! > -50) {
      pos[i * 3 + 1] = -99;
      any = true;
    }
  });
  if (any) {
    const g = particles.points.geometry;
    g.getAttribute("position")!.array = pos;
    g.getAttribute("position")!.needsUpdate = true;
    g.getAttribute("color")!.array = col;
    g.getAttribute("color")!.needsUpdate = true;
  }
}

let motes: { points: Points; pos: Float32Array; seeds: { x: number; y: number; z: number; p: number; s: number }[] } | null = null;
function buildMotes(): void {
  const rng = Rules.createRng(Rules.hashSeed("motes"));
  const seeds = Array.from({ length: MOTE_MAX }, () => ({ x: (rng.next() - 0.5) * 12, y: 0.6 + rng.next() * 2.4, z: (rng.next() - 0.5) * 6.5, p: rng.next() * 6.28, s: 0.1 + rng.next() * 0.2 }));
  const pos = new Float32Array(MOTE_MAX * 3);
  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(pos, 3));
  const points = new Points(geo, new PointsMaterial({ color: 0xffd9a0, size: 0.03, transparent: true, opacity: 0.22, depthWrite: false, blending: AdditiveBlending }));
  points.frustumCulled = false;
  points.visible = false;
  fxGroup.add(points);
  motes = { points, pos, seeds };
  updateMotes(0);
}
function updateMotes(t: number): void {
  if (!motes) return;
  const { seeds, pos } = motes;
  seeds.forEach((m, i) => {
    pos[i * 3] = m.x + Math.sin(t * m.s + m.p) * 0.6;
    pos[i * 3 + 1] = m.y + Math.sin(t * m.s * 0.7 + m.p * 2) * 0.35;
    pos[i * 3 + 2] = m.z + Math.cos(t * m.s * 0.8 + m.p) * 0.5;
  });
  const a = motes.points.geometry.getAttribute("position")!;
  a.array = pos;
  a.needsUpdate = true;
}

// --- theme, look, motion ----------------------------------------------------------------------------
export function setTheme(key: string): void {
  theme = Content.themeByKey(key) as Theme;
  scene.background = hex(theme.sky);
  scene.fog = new Fog(hex(theme.fog), camDist + 7, camDist + 24);
  boardKey = "";
  rebuildBoard();
}
export function themeKey(): string { return theme.key; }
export function setReducedMotion(v: boolean): void {
  reducedMotion = v;
  if (v) { settle(); shakeAmp = 0; }
}

/** The look for the frame's graphics level; cheap when nothing changed. */
export function applyLook(next: Look): void {
  if (look && JSON.stringify(look) === JSON.stringify(next)) return;
  look = next;
  if (!built) build();
  const shadows = next.shadows > 0;
  renderer.shadowMap.enabled = shadows;
  renderer.shadowMap.type = next.budget.softShadows ? PCFSoftShadowMap : PCFShadowMap;
  keyLight.castShadow = shadows;
  if (shadows) keyLight.shadow.mapSize = next.shadows;
  rebuildBoard();
  // The lantern pool is part of the detailed look; Low skips the extra light entirely.
  lantern.visible = next.detailed;
  if (next.reflections) {
    scene.environment = buildEnvironment();
    hemiLight.intensity = 0.22; // image-based light replaces part of the flat fill
  } else {
    scene.environment = null;
    hemiLight.intensity = 0.55;
  }
  applyEnvMaps();
  if (particles) {
    const high = next.particles === "high";
    particles.mat.size = high ? 0.1 : 0.09;
    particles.mat.blending = high ? AdditiveBlending : NormalBlending;
  }
  // The browser build's composer chain per preset.
  renderer.ao = next.ao === "off" ? null : {
    blendIntensity: next.ao === "high" ? 0.85 : 0.7, radius: 0.45, distanceExponent: 1.4, thickness: 1.0, scale: 1.0,
    samples: next.ao === "high" ? 16 : 8,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: next.ao === "high" ? 6 : 4, rings: 2, samples: next.ao === "high" ? 16 : 8, radiusExponent: 2 },
  };
  // High threshold: only brass glints and sparks bloom.
  // The page's r160 UnrealBloomPass strength squared (minor 29 bloom follows r185).
  renderer.bloom = next.bloom ? { strength: 0.09, radius: 0.35, threshold: 0.9, resolution: next.budget.bloomRes } : null;
  // The grade ShaderPass after OutputPass: a gentle S-curve, a touch more
  // saturation, warm highlights and cooler shadows, a soft vignette.
  renderer.grade = next.grade ? {
    space: "display", contrast: 0.09, saturation: 1.07,
    shadows: [0.97, 0.98, 1.04], highlights: [1.04, 1.0, 0.95], split: [0.2, 0.8],
    vignette: { amount: 0.28, inner: 0.38, outer: 0.9, scale: [1.1, 1] },
  } : null;
  renderer.antialias = next.antialias;
}

// --- camera ---------------------------------------------------------------------------------------
let camDist = 14;
let fitKey = "";
const camBase = { pos: new Vector3(0, 12, 9), target: new Vector3(FRAMING.lookX, 0, FRAMING.lookZ) };
/** The browser build's framing: the camera's aspect follows the part of the
 * window the HUD leaves (window pixels), a view offset paints the chrome
 * around it, and the distance fits halfW × halfH of the board at the tilt. */
export function frameBoard(r: { x: number; y: number; w: number; h: number }, w: number, h: number): void {
  const key = [r.x, r.y, r.w, r.h, w, h].map((n) => Math.round(n)).join(",");
  if (key === fitKey) return;
  fitKey = key;
  camera.setViewOffset(r.w, r.h, -r.x, -r.y, w, h);
  camera.aspect = r.w / r.h;
  const vfov = (FRAMING.fov * PI) / 180;
  const dist = Math.max(FRAMING.halfH / Math.tan(vfov / 2), FRAMING.halfW / (Math.tan(vfov / 2) * camera.aspect)) + 1.2;
  camDist = dist;
  // Fog follows the framing distance so a far camera (narrow portrait) never hides the board.
  if (scene.fog && "near" in scene.fog) { scene.fog.near = dist + 7; scene.fog.far = dist + 24; }
  const tilt = (FRAMING.tiltDeg * PI) / 180;
  camBase.pos.set(FRAMING.lookX, Math.sin(tilt) * dist, Math.cos(tilt) * dist + FRAMING.lookZ);
  camBase.target.set(FRAMING.lookX, 0, FRAMING.lookZ);
  camera.far = Math.max(100, dist * 4);
}
/** Forget the fit (Reset camera): the next frameBoard refits. */
export function resetCamera(): void { fitKey = ""; shakeAmp = 0; }

let camIntro = 0; // seconds left of the intro swoop
export function introCamera(): void {
  if (reducedMotion) return;
  camIntro = 0.9;
}
let shakeAmp = 0;
export function shakeCamera(amp: number): void {
  if (reducedMotion) return;
  shakeAmp = Math.max(shakeAmp, amp);
}

// --- picking --------------------------------------------------------------------------------------
const _ray = new Raycaster();
/** The ray's entry distance into an axis-aligned box, or null. */
function rayBox(o: Vector3, d: Vector3, min: [number, number, number], max: [number, number, number]): number | null {
  let t0 = -Infinity, t1 = Infinity;
  const oo = [o.x, o.y, o.z], dd = [d.x, d.y, d.z];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(dd[i]!) < 1e-9) { if (oo[i]! < min[i]! || oo[i]! > max[i]!) return null; continue; }
    let a = (min[i]! - oo[i]!) / dd[i]!, b = (max[i]! - oo[i]!) / dd[i]!;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
    if (t0 > t1) return null;
  }
  return t1 < 0 ? null : t0;
}
/** What the browser build's hit volumes say is under a window pixel. */
export function pick(x: number, y: number): Pick {
  _ray.setFromCamera(pointerToNdc(x, y), camera);
  const o = _ray.ray.origin, d = _ray.ray.direction;
  let best: Pick = null, bestT = Infinity;
  const test = (p: Pick, min: [number, number, number], max: [number, number, number]): void => {
    const t = rayBox(o, d, min, max);
    if (t != null && t < bestT) { bestT = t; best = p; }
  };
  for (let point = 0; point < Rules.POINTS; point++) {
    const pos = pointPos(point);
    const cz = pos.z + (pos.top ? 1 : -1) * 0.9;
    test({ kind: "point", point }, [pos.x - 0.39, -0.15, cz - 1.3], [pos.x + 0.39, 0.75, cz + 1.3]);
  }
  test({ kind: "rail" }, [-0.45, -0.15, -3.1], [0.45, 0.75, 3.1]);
  for (let p = 0; p < 4; p++) {
    const pos = offPos(4, p, 0);
    test({ kind: "off" }, [pos.x - 0.475, -0.2, pos.z - 0.7], [pos.x + 0.475, 1.2, pos.z + 0.7]);
  }
  return best;
}

// --- per frame --------------------------------------------------------------------------------------
let selPulse = 0;
let motionT = 0;
export function update(dtRaw: number): void {
  if (!look) return;
  const dt = Math.min(0.05, dtRaw || 0.016);
  if (tweens.length) {
    for (const tw of tweens) {
      tw.t = Math.min(1, tw.t + dt / tw.dur);
      const e = 1 - Math.pow(1 - tw.t, 3); // easeOutCubic
      tw.mesh.position.copy(tw.from).lerp(tw.to, e);
    }
    tweens = tweens.filter((tw) => tw.t < 1);
  }
  // Selection pulse (time-based, never frame-count based).
  selPulse += dt;
  const pulse = 0.65 + Math.sin(selPulse * 4) * 0.3;
  for (const d of decals) {
    if (d.kind === "ring") d.mat.opacity = pulse;
    else if (d.kind === "origin") d.mat.opacity = 0.6 + pulse * 0.35;
  }
  // Camera: home, the intro swoop from above, then shake.
  camera.position.copy(camBase.pos);
  if (camIntro > 0) {
    camIntro = Math.max(0, camIntro - dt);
    const k = camIntro / 0.9; // 1 → 0
    const e = 1 - Math.pow(1 - (1 - k), 3);
    camera.position.y += 3.5 * (1 - e);
    camera.position.z += 3.5 * (1 - e);
  }
  camera.lookAt(camBase.target);
  if (shakeAmp > 0.001) {
    camera.position.x += (Math.random() - 0.5) * shakeAmp;
    camera.position.y += (Math.random() - 0.5) * shakeAmp * 0.6;
    shakeAmp *= Math.pow(0.001, dt * 2.2);
  } else shakeAmp = 0;
  updateParticles(dt);
  // Ambient motion: lantern flicker and drifting motes; frozen with reduced motion.
  const animated = look.animated && !reducedMotion;
  if (animated) {
    motionT += dt;
    lantern.intensity = LANTERN * (1 + 0.05 * Math.sin(motionT * 7.3) + 0.03 * Math.sin(motionT * 13.1 + 1.7));
    motes!.points.geometry.setDrawRange(0, Math.min(MOTE_MAX, look.budget.motes));
    updateMotes(motionT);
  } else if (lantern.intensity !== LANTERN) lantern.intensity = LANTERN;
  if (motes) motes.points.visible = animated && look.budget.motes > 0;
}
