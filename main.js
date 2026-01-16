import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { VRButton } from "three/addons/webxr/VRButton.js";
import { XRControllerModelFactory } from "three/addons/webxr/XRControllerModelFactory.js";

const container = document.getElementById("app");

// HUD
const hud = document.createElement("div");
hud.style.position = "fixed";
hud.style.left = "12px";
hud.style.bottom = "12px";
hud.style.padding = "10px 12px";
hud.style.borderRadius = "12px";
hud.style.background = "rgba(0,0,0,0.45)";
hud.style.color = "white";
hud.style.font = "12px system-ui, -apple-system";
hud.style.zIndex = "9999";
hud.style.maxWidth = "520px";
hud.textContent = "HUD: loading…";
document.body.appendChild(hud);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.xr.enabled = true;
container.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0c10);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 8000);
camera.position.set(0, 280, 520);

// Rig
const player = new THREE.Group();
player.position.set(0, 0, 0);
player.add(camera);
scene.add(player);

// Desktop orbit
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.06;

renderer.xr.addEventListener("sessionstart", () => { controls.enabled = false; });
renderer.xr.addEventListener("sessionend",   () => { controls.enabled = true;  });

// Luci
scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 0.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(300, 400, 200);
scene.add(sun);

// Bounds
const LIMIT_XZ = 2400;

// Assets
const heightUrl = "./assets/height.png";
const colorUrl  = "./assets/texture.png";

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

// Heightmap
async function loadHeightData(url) {
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.crossOrigin = "anonymous";
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = url;
  });

  const w = img.width, h = img.height;
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, w, h);

  const heights = new Float32Array(w * h);
  for (let i = 0, p = 0; i < heights.length; i++, p += 4) heights[i] = data[p] / 255.0;
  return { w, h, heights };
}

function buildTerrain({ w, h, heights }, colorMap, exag = 1.8) {
  const sizeX = 5000, sizeZ = 5000, seg = 256;
  const geo = new THREE.PlaneGeometry(sizeX, sizeZ, seg, seg);
  geo.rotateX(-Math.PI / 2);

  const pos = geo.attributes.position;
  const getH = (u, v) => {
    const x = Math.round(u * (w - 1));
    const y = Math.round(v * (h - 1));
    return heights[y * w + x];
  };

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const u = clamp((x / sizeX) + 0.5, 0, 1);
    const v = clamp((z / sizeZ) + 0.5, 0, 1);
    pos.setY(i, (getH(u, v) - 0.5) * 400 * exag);
  }

  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    map: colorMap,
    roughness: 0.95,
    metalness: 0.0
  });

  const mesh = new THREE.Mesh(geo, mat);
  return mesh;
}

let terrain = null;

// --- Teleport pointer ---
const controllerModelFactory = new XRControllerModelFactory();
const raycaster = new THREE.Raycaster();
const tempMatrix = new THREE.Matrix4();

const ringGeo = new THREE.RingGeometry(0.18, 0.24, 32);
ringGeo.rotateX(-Math.PI / 2);
const ringMat = new THREE.MeshBasicMaterial({ color: 0x66ccff, transparent: true, opacity: 0.9 });
const marker = new THREE.Mesh(ringGeo, ringMat);
marker.visible = false;
scene.add(marker);

function makeLaser(controller) {
  const laserGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, -1)
  ]);
  const laserMat = new THREE.LineBasicMaterial({ color: 0x66ccff });
  const laser = new THREE.Line(laserGeo, laserMat);
  laser.scale.z = 10;
  controller.add(laser);
  return laser;
}

const controllers = [];
function addController(index) {
  const c = renderer.xr.getController(index);
  const g = renderer.xr.getControllerGrip(index);
  player.add(c);
  player.add(g);
  g.add(controllerModelFactory.createControllerModel(g));
  const laser = makeLaser(c);

  const state = { c, g, laser, lastHit: null };
  controllers.push(state);

  c.addEventListener("selectstart", () => {
    if (!state.lastHit) return;
    if (jump.isActive) return;

    const x = THREE.MathUtils.clamp(state.lastHit.x, -LIMIT_XZ, LIMIT_XZ);
    const z = THREE.MathUtils.clamp(state.lastHit.z, -LIMIT_XZ, LIMIT_XZ);
    startMoonJump(new THREE.Vector3(x, state.lastHit.y, z));

    marker.visible = false;
    state.lastHit = null;
  });
}
addController(0);
addController(1);

// --- Lunar jump physics ---
const MOON_G = 1.62;
const EXTRA_APEX = 22.0;
const MIN_FLIGHT_TIME = 0.35;
const MAX_FLIGHT_TIME = 3.0;

const jump = {
  isActive: false,
  t: 0,
  T: 1,
  p0: new THREE.Vector3(),
  v0: new THREE.Vector3(),
  target: new THREE.Vector3()
};

function solveFlightTime(y0, v0y, yTarget, g) {
  const a = 0.5 * g;
  const b = -v0y;
  const c = (yTarget - y0);
  const disc = b*b - 4*a*c;
  if (disc < 0) return null;
  const sqrtD = Math.sqrt(disc);
  const t1 = (-b + sqrtD) / (2*a);
  const t2 = (-b - sqrtD) / (2*a);
  const candidates = [t1, t2].filter(t => t > 1e-4);
  if (!candidates.length) return null;
  return Math.max(...candidates);
}

function startMoonJump(target) {
  const p0 = player.position.clone();
  const p1 = target.clone();

  const apexY = Math.max(p0.y, p1.y) + EXTRA_APEX;
  const dyApex = Math.max(0.1, apexY - p0.y);
  const v0y = Math.sqrt(2 * MOON_G * dyApex);

  let T = solveFlightTime(p0.y, v0y, p1.y, MOON_G);
  if (!T || !isFinite(T)) T = 1.2;
  T = THREE.MathUtils.clamp(T, MIN_FLIGHT_TIME, MAX_FLIGHT_TIME);

  const v0x = (p1.x - p0.x) / T;
  const v0z = (p1.z - p0.z) / T;

  jump.p0.copy(p0);
  jump.target.copy(p1);
  jump.v0.set(v0x, v0y, v0z);
  jump.t = 0;
  jump.T = T;
  jump.isActive = true;

  hud.textContent = `HUD: salto lunare… (T=${T.toFixed(2)}s)`;
}

function updateMoonJump(dt) {
  if (!jump.isActive) return;

  jump.t += dt;
  const t = Math.min(jump.t, jump.T);

  player.position.x = jump.p0.x + jump.v0.x * t;
  player.position.z = jump.p0.z + jump.v0.z * t;
  player.position.y = jump.p0.y + jump.v0.y * t - 0.5 * MOON_G * t * t;

  player.position.x = THREE.MathUtils.clamp(player.position.x, -LIMIT_XZ, LIMIT_XZ);
  player.position.z = THREE.MathUtils.clamp(player.position.z, -LIMIT_XZ, LIMIT_XZ);

  if (jump.t >= jump.T) {
    player.position.copy(jump.target);
    jump.isActive = false;
    // lasciamo l'HUD aggiornato da updateTeleport()
  }
}

// --- TURN: auto-mapping (funziona anche se l'asse non è [2]) ---
const TURN_DEADZONE = 0.18;
const TURN_SPEED = 2.4; // rad/s

function getRightStickXFromAnySource(session) {
  // Proviamo prima handedness="right", altrimenti prendiamo il primo gamepad
  const sources = session?.inputSources || [];
  let rightSrc = sources.find(s => s.handedness === "right" && s.gamepad);
  if (!rightSrc) rightSrc = sources.find(s => s.gamepad);
  const gp = rightSrc?.gamepad;
  if (!gp) return { rx: 0, info: "no gamepad" };

  const a = gp.axes || [];

  // Strategy:
  // - in tanti casi rx è a[2]
  // - in altri è a[0]
  // - scegliamo l'asse con valore assoluto più alto tra (a0,a2)
  const a0 = a[0] ?? 0;
  const a2 = a[2] ?? 0;
  let rx = Math.abs(a2) > Math.abs(a0) ? a2 : a0;

  // fallback: se entrambi ~0, scegli il max assoluto tra tutti gli axes
  if (Math.abs(rx) < 0.01 && a.length) {
    let best = 0;
    for (let i = 0; i < a.length; i++) {
      if (Math.abs(a[i]) > Math.abs(best)) best = a[i];
    }
    rx = best;
  }

  return { rx, info: `axes=[${a.map(v => (v ?? 0).toFixed(2)).join(", ")}]` };
}

function updateTurn(dt) {
  if (!renderer.xr.isPresenting) return;
  if (jump.isActive) return;

  const session = renderer.xr.getSession?.();
  if (!session) return;

  const { rx, info } = getRightStickXFromAnySource(session);

  // debug HUD: mostra rx e axes
  // (togli questa riga quando funziona e vuoi HUD più pulito)
  hud.textContent = `HUD: Teleport OK. Stick destro per girare. rx=${rx.toFixed(2)} | ${info}`;

  let v = rx;
  if (Math.abs(v) < TURN_DEADZONE) v = 0;
  if (v === 0) return;

  player.rotation.y -= v * TURN_SPEED * dt;
}

// --- Teleport raycast ---
function updateTeleport() {
  if (!renderer.xr.isPresenting) {
    marker.visible = false;
    for (const s of controllers) {
      s.laser.visible = false;
      s.lastHit = null;
    }
    return;
  }

  if (jump.isActive) {
    marker.visible = false;
    for (const s of controllers) {
      s.laser.visible = false;
      s.lastHit = null;
    }
    return;
  }

  for (const s of controllers) {
    s.laser.visible = true;
    s.laser.scale.z = 10;
    s.lastHit = null;
  }

  if (!terrain) {
    hud.textContent = "HUD: VR OK, ma terreno non pronto (loading…).";
    marker.visible = false;
    return;
  }

  let best = null;

  for (const s of controllers) {
    tempMatrix.identity().extractRotation(s.c.matrixWorld);
    raycaster.ray.origin.setFromMatrixPosition(s.c.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);

    const hit = raycaster.intersectObject(terrain, false)[0];
    if (hit) {
      const dist = raycaster.ray.origin.distanceTo(hit.point);
      s.laser.scale.z = dist;
      s.lastHit = hit.point;

      if (!best || dist < best.dist) best = { s, dist, point: hit.point };
    }
  }

  if (best) {
    marker.position.copy(best.point);
    marker.visible = true;
    // l'HUD viene sovrascritto da updateTurn() per debug
  } else {
    marker.visible = false;
    hud.textContent = "HUD: VR OK, ma non colpisci il terreno (punta più in basso).";
  }
}

// init
(async function init() {
  const colorMap = await new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(colorUrl, (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      resolve(t);
    }, undefined, reject);
  });

  const heightData = await loadHeightData(heightUrl);
  terrain = buildTerrain(heightData, colorMap, 1.8);
  scene.add(terrain);

  const axes = new THREE.AxesHelper(200);
  axes.position.set(-2300, 2, -2300);
  scene.add(axes);

  hud.textContent = "HUD: terreno pronto. Entra in VR, punta e premi trigger. Stick destro = gira.";
})();

// loop
const clock = new THREE.Clock();

renderer.setAnimationLoop(() => {
  const dt = Math.min(0.05, clock.getDelta());

  if (controls.enabled) controls.update();

  updateTurn(dt);
  updateMoonJump(dt);
  updateTeleport();

  renderer.render(scene, camera);
});

window.addEventListener("resize", () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});
