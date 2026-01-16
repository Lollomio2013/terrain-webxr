import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { VRButton } from "three/addons/webxr/VRButton.js";
import { XRControllerModelFactory } from "three/addons/webxr/XRControllerModelFactory.js";

const container = document.getElementById("app");

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.xr.enabled = true;
container.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0c10);

// Camera (serve per desktop preview; in VR viene “wrappata” dalla XR camera)
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 8000);
camera.position.set(0, 280, 520);

// Player rig: in VR muoviamo QUESTO gruppo
const player = new THREE.Group();
player.position.set(0, 0, 0);
player.add(camera);
scene.add(player);

// Desktop OrbitControls (solo desktop)
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.06;

// In VR disabilitiamo OrbitControls
renderer.xr.addEventListener("sessionstart", () => { controls.enabled = false; });
renderer.xr.addEventListener("sessionend",   () => { controls.enabled = true;  });

// Luci
const sun = new THREE.DirectionalLight(0xffffff, 1.15);
sun.position.set(300, 380, 150);
scene.add(sun);

const fill = new THREE.HemisphereLight(0xffffff, 0x223344, 0.55);
scene.add(fill);

// Bounds del terreno (5000x5000)
const LIMIT_XZ = 2400;

// Raycaster per “ground follow”
const groundRay = new THREE.Raycaster();
const rayOrigin = new THREE.Vector3();
const rayDown = new THREE.Vector3(0, -1, 0);

// Assets
const heightUrl = "./assets/height.png";
const colorUrl = "./assets/texture.png";

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

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
  for (let i = 0, p = 0; i < heights.length; i++, p += 4) {
    heights[i] = data[p] / 255.0; // grayscale in R
  }
  return { w, h, heights };
}

function buildTerrain({ w, h, heights }, colorMap, exag = 1.8) {
  const sizeX = 5000;
  const sizeZ = 5000;
  const seg = 256;

  const geo = new THREE.PlaneGeometry(sizeX, sizeZ, seg, seg);
  geo.rotateX(-Math.PI / 2);

  const pos = geo.attributes.position;

  const getH = (u, v) => {
    const x = Math.round(u * (w - 1));
    const y = Math.round(v * (h - 1));
    return heights[y * w + x];
  };

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const u = clamp((x / sizeX) + 0.5, 0, 1);
    const v = clamp((z / sizeZ) + 0.5, 0, 1);
    const hh = getH(u, v);
    pos.setY(i, (hh - 0.5) * 400 * exag);
  }

  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    map: colorMap,
    roughness: 0.95,
    metalness: 0.0
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}

let heightData = null;
let colorMap = null;
let terrain = null;

// ---------- CONTROLLERS (solo VR) ----------
const controllerModelFactory = new XRControllerModelFactory();

const controller1 = renderer.xr.getController(0);
const controller2 = renderer.xr.getController(1);
player.add(controller1);
player.add(controller2);

const grip1 = renderer.xr.getControllerGrip(0);
grip1.add(controllerModelFactory.createControllerModel(grip1));
player.add(grip1);

const grip2 = renderer.xr.getControllerGrip(1);
grip2.add(controllerModelFactory.createControllerModel(grip2));
player.add(grip2);

// ---------- LOCOMOTION (smooth) ----------
const clock = new THREE.Clock();

const MOVE_SPEED = 5.0;   // m/s circa (aumenta a 3.0 se vuoi)
const TURN_SPEED = 1.6;   // rad/s (rotazione continua)
const DEADZONE = 0.15;

// Utility: trova gamepad assi
function getGamepadAxes() {
  const s = renderer.xr.getSession?.();
  if (!s) return null;

  // Prendiamo tutti gli inputSources con gamepad e li usiamo
  const sources = s.inputSources || [];
  let left = null;
  let right = null;

  for (const src of sources) {
    if (!src.gamepad) continue;
    // Heuristica: spesso “left” è handedness="left"
    if (src.handedness === "left") left = src.gamepad;
    if (src.handedness === "right") right = src.gamepad;
  }
  return { left, right, sources };
}

// Calcola yaw della testa (direzione “front” del giocatore)
const tmpQuat = new THREE.Quaternion();
const tmpEuler = new THREE.Euler(0, 0, 0, "YXZ");
const fwd = new THREE.Vector3();
const rightV = new THREE.Vector3();

function applyLocomotion(dt) {
  if (!renderer.xr.isPresenting) return;

  const gps = getGamepadAxes();
  if (!gps) return;

  // Movimento: stick sinistro (axes[2], axes[3]) oppure (0,1) a seconda del controller
  // Proviamo entrambi: se (2,3) è 0, usiamo (0,1).
  const lgp = gps.left;
  const rgp = gps.right;

  let lx = 0, ly = 0, rx = 0;

  if (lgp) {
    const a = lgp.axes || [];
    const ax = (Math.abs(a[2] || 0) + Math.abs(a[3] || 0)) > 0.001 ? 2 : 0;
    lx = a[ax] || 0;
    ly = a[ax + 1] || 0;
  }

  if (rgp) {
    const a = rgp.axes || [];
    // yaw su stick destro X
    const ax = (Math.abs(a[2] || 0) + Math.abs(a[3] || 0)) > 0.001 ? 2 : 0;
    rx = a[ax] || 0;
  }

  // Deadzone
  if (Math.abs(lx) < DEADZONE) lx = 0;
  if (Math.abs(ly) < DEADZONE) ly = 0;
  if (Math.abs(rx) < DEADZONE) rx = 0;

  // Rotazione (yaw) del player
  if (rx !== 0) {
    player.rotation.y -= rx * TURN_SPEED * dt;
  }

  // Direzione basata su yaw della testa (più naturale): usiamo la camera XR
  // Nota: in VR, renderer crea una XR camera interna; ma la nostra camera “base” resta figlia di player.
  // Quindi prendiamo la rotazione della camera, estraiamo yaw.
  camera.getWorldQuaternion(tmpQuat);
  tmpEuler.setFromQuaternion(tmpQuat);
  const yaw = tmpEuler.y;

  fwd.set(Math.sin(yaw), 0, Math.cos(yaw)).normalize();     // avanti
  rightV.set(Math.cos(yaw), 0, -Math.sin(yaw)).normalize(); // destra

  // Movimento: ly negativo = avanti (standard gamepad)
  const move = new THREE.Vector3();
  move.addScaledVector(fwd, -ly);
  move.addScaledVector(rightV, lx);

  if (move.lengthSq() > 0) {
    move.normalize().multiplyScalar(MOVE_SPEED * dt);
    player.position.add(move);
  }

  // Clamp area
  player.position.x = THREE.MathUtils.clamp(player.position.x, -LIMIT_XZ, LIMIT_XZ);
  player.position.z = THREE.MathUtils.clamp(player.position.z, -LIMIT_XZ, LIMIT_XZ);

  // Ground follow: mettiamo il “pavimento” del player sul terreno
  if (terrain) {
    rayOrigin.set(player.position.x, 5000, player.position.z);
    groundRay.set(rayOrigin, rayDown);
    const hit = groundRay.intersectObject(terrain, false)[0];
    if (hit) {
      // In VR “local-floor”, la camera gestisce l’altezza (1.6m ecc). Qui allineiamo solo il pavimento.
      player.position.y = hit.point.y;
    }
  }
}

(async function init() {
  colorMap = await new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(colorUrl, (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(1, 1);
      resolve(t);
    }, undefined, reject);
  });

  heightData = await loadHeightData(heightUrl);

  terrain = buildTerrain(heightData, colorMap, 1.8);
  scene.add(terrain);

  // marker
  const axes = new THREE.AxesHelper(200);
  axes.position.set(-2300, 2, -2300);
  scene.add(axes);
})();

// Render loop (WebXR)
renderer.setAnimationLoop(() => {
  const dt = Math.min(0.05, clock.getDelta());

  // Desktop orbit (solo desktop)
  if (controls.enabled) controls.update();

  // VR locomotion
  applyLocomotion(dt);

  renderer.render(scene, camera);
});

window.addEventListener("resize", () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

