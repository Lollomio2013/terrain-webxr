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

// Camera (desktop preview)
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 8000);
camera.position.set(0, 280, 520);

// Player rig (in VR teletrasportiamo questo)
const player = new THREE.Group();
player.position.set(0, 0, 0);
player.add(camera);
scene.add(player);

// Desktop controls (solo desktop)
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.06;

renderer.xr.addEventListener("sessionstart", () => { controls.enabled = false; });
renderer.xr.addEventListener("sessionend", () => { controls.enabled = true;  });

// Lights
scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 0.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(300, 400, 200);
scene.add(sun);

// Bounds del terreno (5000x5000)
const LIMIT_XZ = 2400;

// Assets (se nel repo hai nomi diversi, cambia solo queste)
const heightUrl = "./assets/height.png";
const colorUrl  = "./assets/texture.png";

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

// ----- Load heightmap -----
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
    heights[i] = data[p] / 255.0;
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

let terrain = null;

// ----------------------------
// TELEPORT SETUP
// ----------------------------
const controllerModelFactory = new XRControllerModelFactory();

// Controller (usiamo il destro come “teleport pointer”)
const controller = renderer.xr.getController(0);
player.add(controller);

const grip = renderer.xr.getControllerGrip(0);
grip.add(controllerModelFactory.createControllerModel(grip));
player.add(grip);

// Ray visuale (laser)
const laserGeo = new THREE.BufferGeometry().setFromPoints([
  new THREE.Vector3(0, 0, 0),
  new THREE.Vector3(0, 0, -1)
]);
const laserMat = new THREE.LineBasicMaterial({ color: 0x66ccff });
const laser = new THREE.Line(laserGeo, laserMat);
laser.name = "laser";
laser.scale.z = 10;
controller.add(laser);

// Reticolo di destinazione (anello)
const ringGeo = new THREE.RingGeometry(0.18, 0.24, 32);
ringGeo.rotateX(-Math.PI / 2);
const ringMat = new THREE.MeshBasicMaterial({ color: 0x66ccff, transparent: true, opacity: 0.9 });
const marker = new THREE.Mesh(ringGeo, ringMat);
marker.visible = false;
scene.add(marker);

const raycaster = new THREE.Raycaster();
const tempMatrix = new THREE.Matrix4();
let lastHitPoint = null;

// Trigger = teletrasporta
controller.addEventListener("selectstart", () => {
  if (!lastHitPoint) return;

  // clamp area
  const x = THREE.MathUtils.clamp(lastHitPoint.x, -LIMIT_XZ, LIMIT_XZ);
  const z = THREE.MathUtils.clamp(lastHitPoint.z, -LIMIT_XZ, LIMIT_XZ);

  // Manteniamo la Y del rig sul terreno (teleport “a terra”)
  player.position.set(x, lastHitPoint.y, z);

  // chiudi marker per feedback
  marker.visible = false;
  lastHitPoint = null;
});

// Raycast ogni frame: punta controller -> terreno
function updateTeleportRay() {
  if (!terrain || !renderer.xr.isPresenting) {
    marker.visible = false;
    lastHitPoint = null;
    laser.visible = renderer.xr.isPresenting; // in VR mostra laser, ma senza hit
    laser.scale.z = 10;
    return;
  }

  laser.visible = true;

  tempMatrix.identity().extractRotation(controller.matrixWorld);
  raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
  raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);

  const hit = raycaster.intersectObject(terrain, false)[0];
  if (hit) {
    lastHitPoint = hit.point;

    // marker sul terreno
    marker.position.copy(hit.point);
    marker.visible = true;

    // laser fino al punto
    const dist = raycaster.ray.origin.distanceTo(hit.point);
    laser.scale.z = dist;
  } else {
    marker.visible = false;
    lastHitPoint = null;
    laser.scale.z = 10;
  }
}

// ----------------------------
// INIT LOAD
// ----------------------------
(async function init() {
  const colorMap = await new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(colorUrl, (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(1, 1);
      resolve(t);
    }, undefined, reject);
  });

  const heightData = await loadHeightData(heightUrl);
  terrain = buildTerrain(heightData, colorMap, 1.8);
  scene.add(terrain);

  // piccolo marker orientamento
  const axes = new THREE.AxesHelper(200);
  axes.position.set(-2300, 2, -2300);
  scene.add(axes);
})();

// Render loop (WebXR)
renderer.setAnimationLoop(() => {
  if (controls.enabled) controls.update();
  updateTeleportRay();
  renderer.render(scene, camera);
});

window.addEventListener("resize", () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});
