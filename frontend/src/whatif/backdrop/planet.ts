// Ascend WebGL planet: GLTF Earth with day/night/city-lights/ocean-glint/rim shader, atmosphere
// halo, three cloud shells, ambient motes, twinkling starfield and golden land markers, composited
// through bloom + a corner-flame final pass. Ported from the Ascend spec (three r0.143 API:
// WebGL1Renderer, outputEncoding, sRGBEncoding). Shaders and CONFIG are kept verbatim.
//
// Modes
//   landing  scroll-driven choreography (zoom out, swing left/right, turn) + one-time float-up entrance
//   app      fixed low "horizon" globe behind work pages, slow spin, lower pixel ratio
// Reduced motion: time is frozen (no spin, clouds, twinkle) and there is no entrance.

import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { GammaCorrectionShader } from "three/examples/jsm/shaders/GammaCorrectionShader.js";
import { CopyShader } from "three/examples/jsm/shaders/CopyShader.js";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const ASSET_BASE_URL = "https://api.getlayers.ai/storage/v1/object/public/public/assets/ascend-d9857ad1f2";
const PLANET_GLB = `${ASSET_BASE_URL}/planet.glb`;
const PLANET_LIGHTS_GLB = `${ASSET_BASE_URL}/planet-lights.glb`;
const PLANET_CLOUDS_PNG = `${ASSET_BASE_URL}/planet-clouds.png`;

const CONFIG = {
  rimColor: "#c1faff", rimPower: 2.4, nightLights: 10, terrainDepth: 0.33, terrainShade: 1.3,
  oceanGlint: 0.45, oceanDeep: 0.12, oceanFlow: 3, oceanFlowSpeed: 0.8, oceanFlowScale: 2.1,
  glowColor: "#3a6cff", glowIntensity: 3.35, planetRadius: 1.95, spin: 0.03, initRotation: 2.07,
  tilt: 0.37, autoRotate: 0,
  cloud1Height: 1.005, cloud1Opacity: 0.6, cloud1Spin: 0.06,
  cloud2Height: 1.03, cloud2Opacity: 0.5, cloud2Spin: 0.14,
  cloud3Height: 1.075, cloud3Opacity: 0.5, cloud3Spin: 0.1,
  bgColor: "#040a1e", flameColor: "#3a6cff", flameColor2: "#c1faff", flameAmt: 0.15,
  atmoColor: "#9fc4ff", atmoCount: 320, atmoSize: 22, atmoSpeed: 0.8,
  starColor: "#cfe0ff", starCount: 1400, starSize: 1.6, starFlicker: 1,
  markerColor: "#ffd27a", markerCount: 60, markerSize: 16, markerSpeed: 0.5,
};
const LAYERS = { NONE: 0, TORUS_SCENE: 1, BLOOM_SCENE: 2, ENTIRE_SCENE: 3 };

const STOPS_X = [{ p: 0, v: 0 }, { p: 0.32, v: -3.1 }, { p: 0.64, v: 3.2 }, { p: 1, v: 0 }];
const STOPS_Y = [{ p: 0, v: -4.5 }, { p: 0.32, v: 0.55 }, { p: 0.64, v: 0.45 }, { p: 1, v: 0.15 }];
const STOPS_S = [{ p: 0, v: 2.15 }, { p: 0.32, v: 1.0 }, { p: 0.64, v: 0.92 }, { p: 1, v: 1.12 }];
// App pages: the hero's opening pose (huge, low globe) held still as a horizon, nudged right of the sidebar.
const APP_POSE = { x: 0.9, y: -4.6, s: 2.15 };
const ENTRY_DUR = 1.9;
const ENTRY_START_Y = -6.5;

const Lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
function hexToVec3(hex: string) {
  const c = new THREE.Color(hex);
  return new THREE.Vector3(c.r, c.g, c.b);
}
function sample(stops: { p: number; v: number }[], p: number) {
  if (p <= stops[0].p) return stops[0].v;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i], b = stops[i + 1];
    if (p <= b.p) {
      let t = (p - a.p) / (b.p - a.p);
      t = t * t * (3 - 2 * t);
      return Lerp(a.v, b.v, t);
    }
  }
  return stops[stops.length - 1].v;
}

const SNOISE = /* glsl */ `
vec4 permute(vec4 x){return mod(((x*34.0)+1.0)*x, 289.0);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314 * r;}
float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0); const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy)); vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz); vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy); vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + 1.0 * C.xxx; vec3 x2 = x0 - i2 + 2.0 * C.xxx; vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;
  i = mod(i, 289.0);
  vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 1.0/7.0; vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z *ns.z);
  vec4 x_ = floor(j * ns.z); vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ *ns.x + ns.yyyy; vec4 y = y_ *ns.x + ns.yyyy; vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy); vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0)*2.0 + 1.0; vec4 s1 = floor(b1)*2.0 + 1.0; vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy; vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
  vec3 p0 = vec3(a0.xy,h.x); vec3 p1 = vec3(a0.zw,h.y); vec3 p2 = vec3(a1.xy,h.z); vec3 p3 = vec3(a1.zw,h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2, p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.5 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0); m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
`;

const FINAL_FRAG = /* glsl */ `
uniform float iTime; uniform sampler2D tDiffuse; uniform sampler2D bloomTexture; uniform sampler2D torusTexture; uniform sampler2D haloTexture;
uniform vec3 uBg; uniform vec3 uFlameA; uniform vec3 uFlameB; uniform float uFlameAmt;
varying vec2 vUv;
vec3 warp3d(vec3 pos, float t){ float curv=.8,a=1.9,b=0.7; pos*=2.;
  pos.x+=curv*sin(t+a*pos.y)+t*b; pos.y+=curv*cos(t+a*pos.x);
  pos.y+=curv*sin(t+a*pos.z)+t*b; pos.z+=curv*cos(t+a*pos.y);
  pos.z+=curv*sin(t+a*pos.x)+t*b; pos.x+=curv*cos(t+a*pos.z);
  return 0.5+0.5*cos(pos.xyz+vec3(1,2,4)); }
void main(){
  vec2 uv = 2.*vUv - 1.;
  vec3 w = pow(warp3d(vec3(uv.x, sin(uv.y), uv.y), iTime*1.5), vec3(1.5));
  vec3 flame = 1.5*uFlameA*w.x; flame*=w.y; flame += uFlameB*w.z;
  flame *= smoothstep(0.25, 1., abs(uv.y));
  float md = smoothstep(-0.7, 1., -uv.y*uv.x); flame *= md*md;
  vec3 bg = uBg * (1.0 - 0.4 * length(uv));
  vec3 halo = texture2D(haloTexture, vUv).xyz;
  gl_FragColor = vec4(bg + flame*uFlameAmt + texture2D(bloomTexture, vUv).xyz + texture2D(torusTexture, vUv).xyz + texture2D(tDiffuse, vUv).xyz + halo, 1.);
}`;

const PLANET_INJECT = /* glsl */ `
#include <dithering_fragment>
vec3 normalizedNormal = normalize(vNormal);
vec3 viewDir = normalize(vViewPosition);
float rim = 1.0 - max(dot(viewDir, normalizedNormal), 0.0);
rim = pow(rim, rimPower); rim = pow(rim, 1.5); rim *= 0.7;
vec3 currentColor = gl_FragColor.rgb;
float blueDom = currentColor.b - max(currentColor.r, currentColor.g);
float waterMask = clamp(smoothstep(-0.005, 0.03, blueDom), 0.0, 1.0);
float shimmer = snoise(vec3(vCustomUv.x * noiseScale + time * speedX, vCustomUv.y * noiseScale - time * speedY, time * speedZ));
gl_FragColor.rgb += waterMask * shimmer * 0.025;
float fT = time * oceanFlowSpeed * 4.0;
float fS = 4.0 * oceanFlowScale;
float warp = snoise(vec3(vCustomUv.x * fS - fT * 0.5, vCustomUv.y * fS + fT * 0.4, fT * 0.5));
float flow = snoise(vec3(vCustomUv.x * fS * 2.0 + fT * 0.6 + warp, vCustomUv.y * fS * 2.0 - fT * 0.5, fT * 0.7));
flow = warp * 0.6 + flow * 0.4;
gl_FragColor.rgb += waterMask * flow * 0.12 * oceanFlow;
gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.01, 0.06, 0.16), waterMask * oceanDeep);
vec3 finalColor = mix(gl_FragColor.rgb, rimColor, rim);
gl_FragColor = vec4(finalColor, 1.0);
vec3 surfPos = -vViewPosition;
float terrH = dot(texture2D(map, vCustomUv).rgb, vec3(0.299, 0.587, 0.114));
vec3 sigX = dFdx(surfPos), sigY = dFdy(surfPos);
vec3 vR1 = cross(sigY, normalizedNormal), vR2 = cross(normalizedNormal, sigX);
float fDet = dot(sigX, vR1);
vec3 vGrad = sign(fDet) * (dFdx(terrH) * vR1 + dFdy(terrH) * vR2);
vec3 bumpedNormal = normalize(abs(fDet) * normalizedNormal - terrainDepth * vGrad);
vec3 shadeNormal = mix(bumpedNormal, normalizedNormal, waterMask);
vec3 cityLights = texture2D(nightBlendTexture, vCustomUv).rgb * gl_FragColor.rgb * nightLights;
vec3 viewSunDir = normalize(vec3(-0.9, 0.18, 0.4));
float ndl = dot(normalizedNormal, viewSunDir);
float dayAmt = smoothstep(-0.05, 0.35, ndl);
float relief = dot(shadeNormal, viewSunDir) - ndl;
gl_FragColor.rgb *= clamp(1.0 + relief * terrainShade * dayAmt, 0.55, 1.6);
float nightFactor  = smoothstep(0.18, -0.30, ndl);
float lightsFactor = smoothstep(0.30, -0.35, ndl);
gl_FragColor.rgb = mix(gl_FragColor.rgb, gl_FragColor.rgb * 0.08, nightFactor);
gl_FragColor.rgb += cityLights * lightsFactor;
vec3 halfDir = normalize(viewSunDir + viewDir);
float ripple = snoise(vec3(vCustomUv * 240.0, time * 4.0));
float ndh = max(dot(normalizedNormal, halfDir) + ripple * 0.02, 0.0);
float glint = pow(ndh, 140.0);
gl_FragColor.rgb += glint * waterMask * dayAmt * oceanGlint * vec3(1.0, 0.97, 0.88);
`;

const CLOUD_INJECT = /* glsl */ `
#include <dithering_fragment>
gl_FragColor.rgb = vec3(1.0);
float cloudNoise = snoise(vec3(vCloudUv.x * noiseScale + uTime * uSpeedX + uPhase, vCloudUv.y * noiseScale - uTime * uSpeedY + uPhase, uTime * uSpeedZ + uPhase));
float cloudNdv = max(dot(normalize(vNormal), normalize(vViewPosition)), 0.0);
float cloudEdge = pow(1.0 - cloudNdv, 3.0);
float cloudMod = mix(cloudNoise, 1.0, cloudEdge);
float cloudNdl = dot(normalize(vNormal), normalize(vec3(-0.9, 0.18, 0.4)));
float cloudDay = 1.0 - smoothstep(0.30, -0.30, cloudNdl) * 0.9;
gl_FragColor.a *= cloudMod * uOpacity * cloudDay;
`;

// ------------------------------------------------------------------ assets (loaded once, shared)

interface Assets { planet: GLTF; lights: GLTF; clouds: THREE.Texture }
let assetsPromise: Promise<Assets> | null = null;

function loadAssets(): Promise<Assets> {
  if (assetsPromise) return assetsPromise;
  const draco = new DRACOLoader();
  draco.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.5/");
  const gltf = new GLTFLoader();
  gltf.setDRACOLoader(draco);
  const tex = new THREE.TextureLoader();
  assetsPromise = Promise.all([
    gltf.loadAsync(PLANET_LIGHTS_GLB),
    gltf.loadAsync(PLANET_GLB),
    tex.loadAsync(PLANET_CLOUDS_PNG),
  ]).then(([lights, planet, clouds]) => ({ lights, planet, clouds }));
  assetsPromise.catch(() => { assetsPromise = null; }); // allow a retry on the next mount
  return assetsPromise;
}

function firstMesh(root: THREE.Object3D): THREE.Mesh | null {
  let found: THREE.Mesh | null = null;
  root.traverse((o) => { if (!found && (o as THREE.Mesh).isMesh) found = o as THREE.Mesh; });
  return found;
}

// ------------------------------------------------------------------ scene

export type PlanetMode = "landing" | "app";

export class PlanetScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private torusComposer: EffectComposer;
  private bloomComposer: EffectComposer;
  private finalComposer: EffectComposer;
  private finalPass: ShaderPass;
  private worldGroup = new THREE.Group();
  private planetGroup = new THREE.Group();
  private cloudGroup = new THREE.Group();
  private glowMesh: THREE.Mesh;
  private clouds: { mesh: THREE.Mesh; spin: number }[] = [];
  private resUniforms: { value: THREE.Vector2 }[] = [];
  private disposables: { dispose: () => void }[] = [];
  private planetTime = { value: 0 };
  private cloudTime = { value: 0 };
  private starTime = { value: 0 };
  private markerTime = { value: 0 };
  private raf = 0;
  private last = 0;
  private curP = 0;
  private curX: number;
  private curY: number;
  private curS: number;
  private spinPhase = 0;
  private entryT = -1;      // <0 until the planet has loaded
  private loaded = false;
  private destroyed = false;
  private torusRendered = false;

  constructor(canvas: HTMLCanvasElement, private mode: PlanetMode, private reduced: boolean, private maxDpr: number) {
    this.renderer = new THREE.WebGL1Renderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxDpr));
    this.renderer.outputEncoding = THREE.sRGBEncoding;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.VSMShadowMap;
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);

    this.scene.background = new THREE.Color(0x000000);
    const w = window.innerWidth, h = window.innerHeight;
    this.camera = new THREE.PerspectiveCamera(40, w / h, 0.1, 200);
    this.camera.position.set(0, 0, 8);
    this.camera.layers.enable(LAYERS.TORUS_SCENE);
    this.camera.layers.enable(LAYERS.BLOOM_SCENE);
    this.camera.layers.enable(LAYERS.ENTIRE_SCENE);
    this.scene.add(this.camera);

    const amb = new THREE.AmbientLight(0xffffff, 1.8);
    amb.layers.set(LAYERS.ENTIRE_SCENE);
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(0, 10, 2);
    dir.layers.set(LAYERS.ENTIRE_SCENE);
    this.scene.add(amb, dir);

    // composers
    const size = new THREE.Vector2(w, h);
    this.torusComposer = new EffectComposer(this.renderer);
    this.torusComposer.renderToScreen = false;
    this.torusComposer.addPass(new RenderPass(this.scene, this.camera));
    this.torusComposer.addPass(new ShaderPass(GammaCorrectionShader));
    this.torusComposer.addPass(new UnrealBloomPass(size, 0.22, 0.2, 0));
    this.torusComposer.addPass(new ShaderPass(CopyShader));

    this.bloomComposer = new EffectComposer(this.renderer);
    this.bloomComposer.renderToScreen = false;
    this.bloomComposer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomComposer.addPass(new UnrealBloomPass(size, 0.5, 0.6, 0));
    this.bloomComposer.addPass(new ShaderPass(GammaCorrectionShader));

    this.finalPass = new ShaderPass({
      uniforms: {
        iTime: { value: 0 }, tDiffuse: { value: null }, torusTexture: { value: null }, bloomTexture: { value: null }, haloTexture: { value: null },
        uBg: { value: hexToVec3(CONFIG.bgColor) }, uFlameA: { value: hexToVec3(CONFIG.flameColor) },
        uFlameB: { value: hexToVec3(CONFIG.flameColor2) }, uFlameAmt: { value: CONFIG.flameAmt },
      },
      vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position, 1.0); }",
      fragmentShader: FINAL_FRAG,
    });
    this.finalPass.uniforms.bloomTexture.value = this.bloomComposer.renderTarget1.texture;
    this.finalPass.uniforms.torusTexture.value = this.torusComposer.renderTarget1.texture;
    this.finalComposer = new EffectComposer(this.renderer);
    this.finalComposer.addPass(new RenderPass(this.scene, this.camera));
    this.finalComposer.addPass(this.finalPass);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.enablePan = false;
    this.controls.enabled = false; // never capture pointer or scroll
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = CONFIG.autoRotate;
    this.controls.minDistance = 3.5;
    this.controls.maxDistance = 16;
    this.controls.target.set(0, 0, 0);

    // hierarchy
    this.planetGroup.rotation.z = CONFIG.tilt;
    this.cloudGroup.rotation.z = CONFIG.tilt;
    this.cloudGroup.visible = false;
    this.worldGroup.add(this.planetGroup, this.cloudGroup);
    this.scene.add(this.worldGroup);
    const start = mode === "landing" ? { x: STOPS_X[0].v, y: STOPS_Y[0].v, s: STOPS_S[0].v } : APP_POSE;
    this.curX = start.x; this.curY = start.y; this.curS = start.s;
    this.worldGroup.position.set(start.x, start.y, 0);
    this.worldGroup.scale.setScalar(start.s);

    this.glowMesh = this.buildGlow();
    this.buildMotes();
    this.buildStars();
    this.setLayers(this.scene);

    loadAssets().then((a) => { if (!this.destroyed) this.attachPlanet(a); }).catch((e) => console.warn("Planet assets could not be loaded; the scene runs without the planet.", e));

    window.addEventListener("resize", this.onResize);
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  private setLayers(root: THREE.Object3D) {
    root.traverse((o) => { if (o !== this.camera) o.layers.enable(LAYERS.ENTIRE_SCENE); });
  }

  private res() {
    const v = { value: new THREE.Vector2(window.innerWidth, window.innerHeight) };
    this.resUniforms.push(v);
    return v;
  }

  private buildGlow() {
    const geo = new THREE.PlaneGeometry(2, 2);
    const mat = new THREE.ShaderMaterial({
      transparent: true, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uGlow: { value: hexToVec3(CONFIG.glowColor) }, uIntensity: { value: CONFIG.glowIntensity } },
      vertexShader: "varying vec2 vUv; void main(){ vUv=uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }",
      fragmentShader: `uniform vec3 uGlow; uniform float uIntensity; varying vec2 vUv;
void main(){
  float d = length(vUv - 0.5) * 2.0;
  float a = pow(clamp(1.0 - d, 0.0, 1.0), 2.2);
  gl_FragColor = vec4(uGlow * a * uIntensity, a);
}`,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.scale.setScalar(CONFIG.planetRadius * 2.3);
    this.worldGroup.add(mesh);
    this.disposables.push(geo, mat);
    return mesh;
  }

  private buildMotes() {
    const n = CONFIG.atmoCount;
    const pos = new Float32Array(n * 3), size = new Float32Array(n), seed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = Math.random() * 2 - 1; pos[i * 3 + 1] = Math.random() * 2 - 1; pos[i * 3 + 2] = Math.random() * 2 - 1;
      size[i] = CONFIG.atmoSize * (0.4 + Math.random());
      seed[i] = Math.random() * 100;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("size", new THREE.BufferAttribute(size, 1));
    geo.setAttribute("seed", new THREE.BufferAttribute(seed, 1));
    const uTime = { value: 0 };
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime, uRes: this.res(), uColor: { value: hexToVec3(CONFIG.atmoColor) } },
      vertexShader: `attribute float size; attribute float seed; uniform float uTime; uniform vec2 uRes;
varying float vA;
vec3 warp(vec3 p, float t){ float c=0.9,a=1.9,b=0.02,s=0.05; p*=2.;
  p.x+=c*sin(s*t+a*p.y)+t*b; p.y+=c*cos(s*t+a*p.x); p.y+=c*sin(s*t+a*p.z)+t*b;
  p.z+=c*cos(s*t+a*p.y); p.z+=c*sin(s*t+a*p.x)+t*b; p.x+=c*cos(s*t+a*p.z);
  return cos(p+vec3(1,2,4)); }
void main(){
  vec3 v = position*4.0 + warp(position, uTime)*1.2;
  vec4 mv = modelViewMatrix * vec4(v, 1.0);
  float r = length(v); float farF = 1.0 - smoothstep(5.0, 6.5, r); float nearF = smoothstep(0.0, 0.5, -mv.z);
  vA = farF * nearF;
  gl_PointSize = size * uRes.y / 900.0 / -mv.z; gl_PointSize = max(gl_PointSize, 1.0);
  gl_Position = projectionMatrix * mv;
}`,
      fragmentShader: `uniform vec3 uColor; varying float vA;
void main(){ vec2 p = gl_PointCoord - 0.5; float l = length(p); if (l > 0.5) discard;
  float tex = smoothstep(0.5, 0.0, l); gl_FragColor = vec4(uColor * tex, tex * vA * 0.55); }`,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.onBeforeRender = () => {
      const now = this.reduced ? 0 : performance.now() / 1000;
      uTime.value = now * CONFIG.atmoSpeed * 8;
      pts.position.copy(this.camera.position);
      this.finalPass.uniforms.iTime.value = uTime.value;
    };
    this.scene.add(pts);
    this.disposables.push(geo, mat);
  }

  private buildStars() {
    const n = CONFIG.starCount;
    const pos = new Float32Array(n * 3), seed = new Float32Array(n), bright = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u);
      pos[i * 3] = 90 * s * Math.cos(th); pos[i * 3 + 1] = 90 * u; pos[i * 3 + 2] = 90 * s * Math.sin(th);
      seed[i] = Math.random() * 100;
      bright[i] = 0.35 + Math.random() * 0.65;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("seed", new THREE.BufferAttribute(seed, 1));
    geo.setAttribute("bright", new THREE.BufferAttribute(bright, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
      uniforms: { uTime: this.starTime, uSize: { value: CONFIG.starSize }, uFlicker: { value: CONFIG.starFlicker }, uColor: { value: hexToVec3(CONFIG.starColor) }, uRes: this.res() },
      vertexShader: `attribute float seed; attribute float bright;
uniform float uTime; uniform float uSize; uniform float uFlicker; uniform vec2 uRes;
varying float vTw;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float tw = 0.6 + 0.4 * sin(uTime * uFlicker + seed);
  vTw = bright * tw;
  gl_PointSize = max(uSize * uRes.y / 900.0 * (90.0 / max(-mv.z, 1.0)), 1.0);
  gl_Position = projectionMatrix * mv;
}`,
      fragmentShader: `uniform vec3 uColor; varying float vTw;
void main(){
  vec2 p = gl_PointCoord - 0.5; float l = length(p); if (l > 0.5) discard;
  float core = smoothstep(0.5, 0.0, l);
  gl_FragColor = vec4(uColor, core * vTw);
}`,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    this.scene.add(pts);
    this.disposables.push(geo, mat);
  }

  private attachPlanet(a: Assets) {
    const nightMesh = firstMesh(a.lights.scene);
    const nightTex = (nightMesh?.material as THREE.MeshStandardMaterial | undefined)?.map ?? null;
    const src = firstMesh(a.planet.scene);
    if (!src) return;
    const mesh = new THREE.Mesh(src.geometry, (src.material as THREE.MeshStandardMaterial).clone());
    src.geometry.computeBoundingSphere();
    const r = src.geometry.boundingSphere?.radius || 1;
    mesh.scale.setScalar(CONFIG.planetRadius / r);
    const mat = mesh.material as THREE.MeshStandardMaterial;
    mat.metalness = 0; mat.roughness = 1; mat.envMapIntensity = 0;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, {
        time: this.planetTime, noiseScale: { value: 30 }, speedX: { value: 1.5 }, speedY: { value: 2.0 }, speedZ: { value: 2.5 },
        rimColor: { value: new THREE.Color(CONFIG.rimColor) }, rimPower: { value: CONFIG.rimPower }, nightBlendTexture: { value: nightTex },
        nightLights: { value: CONFIG.nightLights }, terrainDepth: { value: CONFIG.terrainDepth }, terrainShade: { value: CONFIG.terrainShade },
        oceanGlint: { value: CONFIG.oceanGlint }, oceanDeep: { value: CONFIG.oceanDeep }, oceanFlow: { value: CONFIG.oceanFlow },
        oceanFlowSpeed: { value: CONFIG.oceanFlowSpeed }, oceanFlowScale: { value: CONFIG.oceanFlowScale },
      });
      shader.vertexShader = "varying vec2 vCustomUv;\n" + shader.vertexShader.replace("void main() {", "void main() {\nvCustomUv = uv;");
      shader.fragmentShader = `uniform float time; uniform float noiseScale; uniform float speedX; uniform float speedY; uniform float speedZ;
uniform vec3 rimColor; uniform float rimPower; uniform sampler2D nightBlendTexture; uniform float nightLights;
uniform float terrainDepth; uniform float terrainShade; uniform float oceanGlint; uniform float oceanDeep;
uniform float oceanFlow; uniform float oceanFlowSpeed; uniform float oceanFlowScale;
varying vec2 vCustomUv;
${SNOISE}
` + shader.fragmentShader.replace("#include <dithering_fragment>", PLANET_INJECT);
    };
    this.disposables.push(mat);
    this.planetGroup.add(mesh);

    // cloud shells
    const ctex = a.clouds;
    ctex.wrapS = ctex.wrapT = THREE.RepeatWrapping;
    ctex.repeat.set(5, 5);
    const layers = [
      { h: CONFIG.cloud1Height, o: CONFIG.cloud1Opacity, s: CONFIG.cloud1Spin, ry: 0.0, phase: 0.0 },
      { h: CONFIG.cloud2Height, o: CONFIG.cloud2Opacity, s: CONFIG.cloud2Spin, ry: 2.2, phase: 13.0 },
      { h: CONFIG.cloud3Height, o: CONFIG.cloud3Opacity, s: CONFIG.cloud3Spin, ry: 4.3, phase: 27.0 },
    ];
    for (const L of layers) {
      const geo = new THREE.SphereGeometry(CONFIG.planetRadius * L.h, 64, 64);
      const cmat = new THREE.MeshStandardMaterial({ map: ctex, transparent: true, depthWrite: false });
      cmat.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, {
          uTime: this.cloudTime, noiseScale: { value: 20 }, uSpeedX: { value: 1 }, uSpeedY: { value: 2 }, uSpeedZ: { value: 2 },
          uOpacity: { value: L.o }, uPhase: { value: L.phase },
        });
        shader.vertexShader = "varying vec2 vCloudUv;\n" + shader.vertexShader.replace("void main() {", "void main() {\nvCloudUv = uv;");
        shader.fragmentShader = `uniform float uTime; uniform float noiseScale; uniform float uSpeedX; uniform float uSpeedY; uniform float uSpeedZ;
uniform float uOpacity; uniform float uPhase;
varying vec2 vCloudUv;
${SNOISE}
` + shader.fragmentShader.replace("#include <dithering_fragment>", CLOUD_INJECT);
      };
      const cm = new THREE.Mesh(geo, cmat);
      cm.rotation.y = L.ry;
      cm.renderOrder = 2;
      this.cloudGroup.add(cm);
      this.clouds.push({ mesh: cm, spin: L.s });
      this.disposables.push(geo, cmat);
    }
    this.cloudGroup.visible = true;

    this.buildMarkers(mesh, src);
    this.setLayers(this.worldGroup);
    this.loaded = true;
    this.entryT = this.mode === "landing" && !this.reduced ? 0 : ENTRY_DUR;
  }

  /** Golden radar pings on land: area-weighted triangle sampling, ocean pixels rejected. */
  private buildMarkers(mesh: THREE.Mesh, src: THREE.Mesh) {
    const map = (src.material as THREE.MeshStandardMaterial).map;
    const img = map?.image as (CanvasImageSource & { width: number; height: number }) | undefined;
    const geo = src.geometry;
    const posA = geo.getAttribute("position"), uvA = geo.getAttribute("uv");
    if (!img || !posA || !uvA) return;
    const cw = Math.min(1024, img.width), ch = Math.round(cw * (img.height / img.width));
    const cv = document.createElement("canvas");
    cv.width = cw; cv.height = ch;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(img, 0, 0, cw, ch);
    let data: Uint8ClampedArray;
    try { data = ctx.getImageData(0, 0, cw, ch).data; } catch { return; } // cross-origin texture: skip markers
    const index = geo.index;
    const triCount = index ? index.count / 3 : posA.count / 3;
    const vi = (t: number, k: number) => (index ? index.getX(t * 3 + k) : t * 3 + k);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const cum = new Float32Array(triCount);
    let total = 0;
    for (let t = 0; t < triCount; t++) {
      a.fromBufferAttribute(posA, vi(t, 0)); b.fromBufferAttribute(posA, vi(t, 1)); c.fromBufferAttribute(posA, vi(t, 2));
      total += b.clone().sub(a).cross(c.clone().sub(a)).length() * 0.5;
      cum[t] = total;
    }
    const out: number[] = [], seeds: number[] = [];
    let tries = 0;
    while (out.length / 3 < CONFIG.markerCount && tries++ < CONFIG.markerCount * 400) {
      const r = Math.random() * total;
      let lo = 0, hi = triCount - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < r) lo = mid + 1; else hi = mid; }
      let u = Math.random(), v = Math.random();
      if (u + v > 1) { u = 1 - u; v = 1 - v; }
      const w = 1 - u - v;
      const i0 = vi(lo, 0), i1 = vi(lo, 1), i2 = vi(lo, 2);
      const uvx = uvA.getX(i0) * w + uvA.getX(i1) * u + uvA.getX(i2) * v;
      const uvy = uvA.getY(i0) * w + uvA.getY(i1) * u + uvA.getY(i2) * v;
      const px = Math.min(cw - 1, Math.max(0, Math.floor((uvx % 1 + 1) % 1 * cw)));
      const py = Math.min(ch - 1, Math.max(0, Math.floor((map!.flipY ? 1 - ((uvy % 1 + 1) % 1) : (uvy % 1 + 1) % 1) * ch)));
      const o = (py * cw + px) * 4;
      const cr = data[o], cg = data[o + 1], cb = data[o + 2];
      if (cb > cr + 6 && cb > cg + 6) continue; // ocean
      a.fromBufferAttribute(posA, i0); b.fromBufferAttribute(posA, i1); c.fromBufferAttribute(posA, i2);
      const p = a.multiplyScalar(w).add(b.multiplyScalar(u)).add(c.multiplyScalar(v)).multiplyScalar(1.012);
      out.push(p.x, p.y, p.z);
      seeds.push(Math.random());
    }
    if (!out.length) return;
    const mg = new THREE.BufferGeometry();
    mg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(out), 3));
    mg.setAttribute("seed", new THREE.BufferAttribute(new Float32Array(seeds), 1));
    const mm = new THREE.ShaderMaterial({
      transparent: true, depthTest: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime: this.markerTime, uColor: { value: hexToVec3(CONFIG.markerColor) }, uSize: { value: CONFIG.markerSize }, uSpeed: { value: CONFIG.markerSpeed }, uRes: this.res() },
      vertexShader: `attribute float seed; uniform float uSize; uniform vec2 uRes;
varying float vSeed; varying float vFade;
void main(){
  vSeed = seed;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 vn = normalize(normalMatrix * normalize(position));
  vec3 vd = normalize(-mv.xyz);
  vFade = smoothstep(0.15, 0.5, dot(vn, vd));
  gl_PointSize = max(uSize * uRes.y / 900.0 * (7.0 / max(-mv.z, 1.0)), 2.0);
  gl_Position = projectionMatrix * mv;
}`,
      fragmentShader: `uniform vec3 uColor; uniform float uTime; uniform float uSpeed;
varying float vSeed; varying float vFade;
void main(){
  if (vFade <= 0.001) discard;
  vec2 p = gl_PointCoord - 0.5;
  float d = length(p) * 2.0;
  if (d > 1.0) discard;
  float core = smoothstep(0.30, 0.0, d) * 1.2;
  float ph = fract(uTime * uSpeed + vSeed);
  float ring = smoothstep(0.07, 0.0, abs(d - ph)) * (1.0 - ph);
  gl_FragColor = vec4(uColor, clamp(core + ring, 0.0, 1.0) * vFade);
}`,
    });
    const pts = new THREE.Points(mg, mm);
    pts.frustumCulled = false;
    pts.layers.enable(LAYERS.BLOOM_SCENE); // markers also feed the bloom pass
    mesh.add(pts);
    this.disposables.push(mg, mm);
  }

  setMode(mode: PlanetMode) {
    this.mode = mode;
  }

  start() {
    if (this.raf || this.destroyed) return;
    this.last = performance.now();
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.frame(dt);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private frame(dt: number) {
    const tdt = this.reduced ? 0 : dt;
    this.planetTime.value += tdt / 12;
    this.cloudTime.value += tdt / 20;
    this.starTime.value += tdt;
    this.markerTime.value += tdt;
    this.spinPhase += tdt * CONFIG.spin;

    let tx: number, ty: number, ts: number;
    if (this.mode === "landing") {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const pTarget = clamp(max > 0 ? window.scrollY / max : 0, 0, 1);
      this.curP += (pTarget - this.curP) * Math.min(1, (this.reduced ? 1 : dt * 4.5));
      const sideScale = clamp(window.innerWidth / 1200, 0.5, 1);
      tx = sample(STOPS_X, this.curP) * sideScale; ty = sample(STOPS_Y, this.curP); ts = sample(STOPS_S, this.curP);
    } else {
      this.curP += (0 - this.curP) * Math.min(1, dt * 4.5);
      const sideScale = clamp(window.innerWidth / 1200, 0.5, 1);
      tx = APP_POSE.x * sideScale; ty = APP_POSE.y; ts = APP_POSE.s;
    }
    const k = this.reduced ? 1 : Math.min(1, dt * 3.2);
    this.curX += (tx - this.curX) * k;
    this.curY += (ty - this.curY) * k;
    this.curS += (ts - this.curS) * k;

    let entryY = 0;
    if (this.loaded && this.entryT >= 0 && this.entryT < ENTRY_DUR) {
      this.entryT = Math.min(ENTRY_DUR, this.entryT + dt);
      const t = this.entryT / ENTRY_DUR;
      const e = 1 - Math.pow(1 - t, 3);
      entryY = (ENTRY_START_Y) * (1 - e);
    } else if (!this.loaded && this.mode === "landing" && !this.reduced) {
      entryY = ENTRY_START_Y; // keep the planet below until it can float up
    }
    this.worldGroup.position.set(this.curX, this.curY + entryY, 0);
    this.worldGroup.scale.setScalar(this.curS);
    this.planetGroup.rotation.y = CONFIG.initRotation + this.spinPhase + this.curP * Math.PI * 1.6;
    for (const c of this.clouds) c.mesh.rotation.y += tdt * c.spin;
    this.glowMesh.quaternion.copy(this.camera.quaternion);
    this.controls.update();

    if (!this.torusRendered) { // nothing lives on the torus layer; render it once so its target is defined
      this.camera.layers.set(LAYERS.TORUS_SCENE);
      this.torusComposer.render();
      this.torusRendered = true;
    }
    this.camera.layers.set(LAYERS.BLOOM_SCENE);
    this.bloomComposer.render();
    this.camera.layers.set(LAYERS.ENTIRE_SCENE);
    this.finalComposer.render();
  }

  private onResize = () => {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const pr = Math.min(window.devicePixelRatio || 1, this.maxDpr);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    for (const c of [this.torusComposer, this.bloomComposer, this.finalComposer]) {
      c.setPixelRatio(pr);
      c.setSize(w, h);
    }
    this.torusRendered = false;
    for (const u of this.resUniforms) u.value.set(w, h);
  };

  private onVisibility = () => {
    if (document.hidden) this.stop();
    else this.start();
  };

  dispose() {
    this.destroyed = true;
    this.stop();
    window.removeEventListener("resize", this.onResize);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.controls.dispose();
    for (const d of this.disposables) d.dispose();
    for (const c of [this.torusComposer, this.bloomComposer, this.finalComposer]) {
      c.renderTarget1.dispose();
      c.renderTarget2.dispose();
    }
    this.renderer.dispose();
  }
}

export function webglAvailable() {
  try {
    const c = document.createElement("canvas");
    return !!(window.WebGLRenderingContext && (c.getContext("webgl") || c.getContext("experimental-webgl")));
  } catch {
    return false;
  }
}
