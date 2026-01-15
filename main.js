import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { VRButton } from "three/addons/webxr/VRButton.js";

const container = document.getElementById("app");

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.xr.enabled = true;
container.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0c10);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth/window.innerHeight, 0.1, 8000);
camera.position.set(0, 300, 600);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

renderer.xr.addEventListener("sessionstart", () => controls.enabled = false);
renderer.xr.addEventListener("sessionend", () => controls.enabled = true);

// lights
scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 0.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(300,400,200);
scene.add(sun);

// load assets
const heightImg = new Image();
heightImg.src = "assets/height.png";
await heightImg.decode();

const tex = await new THREE.TextureLoader().loadAsync("assets/texture.png");

const w = heightImg.width;
const h = heightImg.height;
const canvas = document.createElement("canvas");
canvas.width = w; canvas.height = h;
const ctx = canvas.getContext("2d");
ctx.drawImage(heightImg,0,0);
const data = ctx.getImageData(0,0,w,h).data;

const heights = new Float32Array(w*h);
for(let i=0;i<w*h;i++) heights[i] = data[i*4]/255;

const size = 5000;
const seg = 256;
const geo = new THREE.PlaneGeometry(size,size,seg,seg);
geo.rotateX(-Math.PI/2);

const pos = geo.attributes.position;
for(let i=0;i<pos.count;i++){
  const x = pos.getX(i);
  const z = pos.getZ(i);
  const u = Math.min(1,Math.max(0,(x/size)+0.5));
  const v = Math.min(1,Math.max(0,(z/size)+0.5));
  const ix = Math.floor(u*(w-1));
  const iz = Math.floor(v*(h-1));
  const y = (heights[iz*w+ix]-0.5)*400;
  pos.setY(i,y);
}
geo.computeVertexNormals();

const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 });
const terrain = new THREE.Mesh(geo,mat);
scene.add(terrain);

renderer.setAnimationLoop(()=>{
  if(controls.enabled) controls.update();
  renderer.render(scene,camera);
});

window.addEventListener("resize",()=>{
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth/window.innerHeight;
  camera.updateProjectionMatrix();
});
