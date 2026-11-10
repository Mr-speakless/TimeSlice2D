import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// ───────────────────────── config ─────────────────────────
const VOL_W = 480;      // voxel resolution of sampled volume (height follows aspect)
const VOL_D = 120;      // number of sampled frames (time resolution)
let stackN = 26;        // frame planes drawn in the 3D stack (live slider)
const BOX_X = 3.2;      // world width of the volume; height follows aspect
const BOX_T = 2.2;      // world depth of the time axis
const FOCUS_FOV = 30;
const ACCENT = 0x4ade80;

// ───────────────────────── DOM ─────────────────────────
const $ = (id) => document.getElementById(id);
const stage = $('stage');
const canvas = $('gl');
const ui = {
  az: $('az'), el: $('el'), pos: $('pos'), stack: $('stack'), play: $('play'), mode: $('mode'),
  speed: $('speed'), speedOut: $('speedOut'), frames: $('frames'), framesOut: $('framesOut'),
  azNum: $('azNum'), elNum: $('elNum'), posNum: $('posNum'), reset: $('reset'), stackOut: $('stackOut'), nOut: $('nOut'),
  back: $('back'), hudMode: $('hudMode'), hint: $('hint'), info: $('info'),
  loader: $('loader'), loaderText: $('loaderText'), loaderBar: $('loaderBar'), file: $('file'),
};

// ───────────────────────── three setup ─────────────────────────
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x000000);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 100);
camera.position.set(4.6, 3.0, 5.6);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

const size = new THREE.Vector3(BOX_X, BOX_X / 1.98, BOX_T); // world-space box size (x, y, t)

// ───────────────────────── shaders ─────────────────────────
const vert = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;
const frag = /* glsl */ `
  precision highp sampler3D;
  uniform sampler3D uVol;
  uniform vec3 uSize;
  uniform float uOpacity;
  varying vec3 vWorld;
  void main() {
    vec3 uvw = clamp(vWorld / uSize + 0.5, 0.0, 1.0);
    gl_FragColor = vec4(texture(uVol, uvw).rgb, uOpacity);
  }`;

const volumeUniform = { value: null };
const sizeUniform = { value: size };

const sliceMat = new THREE.ShaderMaterial({
  vertexShader: vert, fragmentShader: frag, side: THREE.DoubleSide,
  uniforms: { uVol: volumeUniform, uSize: sizeUniform, uOpacity: { value: 1 } },
  polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
});
const stackMat = new THREE.ShaderMaterial({
  vertexShader: vert, fragmentShader: frag, side: THREE.DoubleSide,
  transparent: true, depthWrite: false,
  uniforms: { uVol: volumeUniform, uSize: sizeUniform, uOpacity: { value: 0.18 } },
});

// ───────────────────────── scene objects ─────────────────────────
const volumeGroup = new THREE.Group(); // box wire + stack + axes (rebuilt per video)
scene.add(volumeGroup);

const sliceGeo = new THREE.BufferGeometry();
sliceGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9 * 3), 3));
sliceGeo.setIndex(new THREE.BufferAttribute(new Uint16Array(8 * 3), 1));
const sliceMesh = new THREE.Mesh(sliceGeo, sliceMat);
sliceMesh.frustumCulled = false;
sliceMesh.renderOrder = 0;
scene.add(sliceMesh);

const outlineGeo = new THREE.BufferGeometry();
outlineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(8 * 3), 3));
const outlineMat = new THREE.LineBasicMaterial({ color: ACCENT, transparent: true });
const outline = new THREE.LineLoop(outlineGeo, outlineMat);
outline.frustumCulled = false;
outline.renderOrder = 3;
scene.add(outline);

const stackEdgeMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.2, depthWrite: false });
const boxMat = new THREE.LineBasicMaterial({ color: 0x8a8a94, transparent: true, opacity: 0.55 });

function makeLabel(text) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#c9c9d0';
  g.font = '40px ui-monospace, Menlo, monospace';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 32, 34);
  const tex = new THREE.CanvasTexture(c);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  s.scale.setScalar(0.28);
  s.renderOrder = 5;
  return s;
}

let stackMeshes = [];
function rebuildVolumeObjects() {
  volumeGroup.traverse((o) => { o.geometry?.dispose?.(); });
  volumeGroup.clear();
  stackMeshes = [];

  const hx = size.x / 2, hy = size.y / 2, hz = size.z / 2;

  // box wireframe
  const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(size.x, size.y, size.z)), boxMat);
  volumeGroup.add(box);

  // stacked frames
  const planeGeo = new THREE.PlaneGeometry(size.x, size.y);
  const edgePts = [];
  for (let i = 0; i < stackN; i++) {
    const z = (-0.5 + (i + 0.5) / stackN) * size.z;
    const m = new THREE.Mesh(planeGeo, stackMat);
    m.position.z = z;
    volumeGroup.add(m);
    stackMeshes.push(m);
    const c = [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]];
    for (let k = 0; k < 4; k++) {
      const a = c[k], b = c[(k + 1) % 4];
      edgePts.push(a[0], a[1], z, b[0], b[1], z);
    }
  }
  const eg = new THREE.BufferGeometry();
  eg.setAttribute('position', new THREE.Float32BufferAttribute(edgePts, 3));
  const edges = new THREE.LineSegments(eg, stackEdgeMat);
  edges.renderOrder = 1;
  volumeGroup.add(edges);

  // axes (from the front-bottom-left corner)
  const o = new THREE.Vector3(-hx, -hy, hz);
  const mk = (dir, label) => {
    const end = o.clone().add(dir);
    const g = new THREE.BufferGeometry().setFromPoints([o, end]);
    volumeGroup.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x9a9aa4 })));
    const s = makeLabel(label);
    s.position.copy(end).add(dir.clone().normalize().multiplyScalar(0.2));
    volumeGroup.add(s);
  };
  mk(new THREE.Vector3(0.55, 0, 0), 'x');
  mk(new THREE.Vector3(0, 0.55, 0), 'y');
  mk(new THREE.Vector3(0, 0, -0.55), 't');
}

// ───────────────────────── slice geometry ─────────────────────────
const state = { az: 0, el: 0, pos: 0 };
const normal = new THREE.Vector3(0, 0, 1);
const basisU = new THREE.Vector3(1, 0, 0);
const basisV = new THREE.Vector3(0, 1, 0);
let hasSlice = false;
const focusInfo = { center: new THREE.Vector3(), w: 1, h: 1 };

function computeBasis(n) {
  const up = Math.abs(n.y) > 0.97 ? new THREE.Vector3(0, 0, -Math.sign(n.y)) : new THREE.Vector3(0, 1, 0);
  const v = up.clone().addScaledVector(n, -up.dot(n)).normalize();
  const u = new THREE.Vector3().crossVectors(v, n).normalize();
  basisU.copy(u); basisV.copy(v);
}

function updateSlice() {
  const az = THREE.MathUtils.degToRad(state.az);
  const el = THREE.MathUtils.degToRad(state.el);
  normal.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).normalize();
  computeBasis(normal);

  const h = new THREE.Vector3(size.x / 2, size.y / 2, size.z / 2);
  const reach = Math.abs(normal.x) * h.x + Math.abs(normal.y) * h.y + Math.abs(normal.z) * h.z;
  const d = state.pos * reach;

  // plane ∩ box edges
  const pts = [];
  const hv = [h.x, h.y, h.z], nv = [normal.x, normal.y, normal.z];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(nv[a]) < 1e-6) continue;
    const b = (a + 1) % 3, c = (a + 2) % 3;
    for (const sb of [-1, 1]) for (const sc of [-1, 1]) {
      const s = (d - nv[b] * sb * hv[b] - nv[c] * sc * hv[c]) / nv[a];
      if (Math.abs(s) <= hv[a] + 1e-6) {
        const p = new THREE.Vector3();
        const arr = [0, 0, 0];
        arr[a] = s; arr[b] = sb * hv[b]; arr[c] = sc * hv[c];
        p.set(arr[0], arr[1], arr[2]);
        if (!pts.some((q) => q.distanceToSquared(p) < 1e-8)) pts.push(p);
      }
    }
  }

  hasSlice = pts.length >= 3;
  sliceMesh.visible = outline.visible = hasSlice;
  if (!hasSlice) return;

  const origin = normal.clone().multiplyScalar(d);
  let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
  for (const p of pts) {
    const r = p.clone().sub(origin);
    p.userData = { u: r.dot(basisU), v: r.dot(basisV) };
    umin = Math.min(umin, p.userData.u); umax = Math.max(umax, p.userData.u);
    vmin = Math.min(vmin, p.userData.v); vmax = Math.max(vmax, p.userData.v);
  }
  const cu = (umin + umax) / 2, cv = (vmin + vmax) / 2;
  pts.sort((p, q) => Math.atan2(p.userData.v - cv, p.userData.u - cu) - Math.atan2(q.userData.v - cv, q.userData.u - cu));

  const pos = sliceGeo.attributes.position;
  const center = origin.clone().addScaledVector(basisU, cu).addScaledVector(basisV, cv);
  pos.setXYZ(0, center.x, center.y, center.z);
  pts.forEach((p, i) => pos.setXYZ(i + 1, p.x, p.y, p.z));
  pos.needsUpdate = true;

  const idx = sliceGeo.index;
  for (let i = 0; i < pts.length; i++) {
    idx.array[i * 3] = 0;
    idx.array[i * 3 + 1] = i + 1;
    idx.array[i * 3 + 2] = ((i + 1) % pts.length) + 1;
  }
  sliceGeo.setDrawRange(0, pts.length * 3);
  idx.needsUpdate = true;
  sliceGeo.computeBoundingSphere();

  const op = outlineGeo.attributes.position;
  pts.forEach((p, i) => op.setXYZ(i, p.x, p.y, p.z));
  op.needsUpdate = true;
  outlineGeo.setDrawRange(0, pts.length);

  focusInfo.center.copy(center);
  focusInfo.w = umax - umin;
  focusInfo.h = vmax - vmin;
}

// ───────────────────────── focus mode ─────────────────────────
let focused = false;
let transitioning = false;
let stackFade = 1;
const saved = { pos: new THREE.Vector3(), target: new THREE.Vector3(), quat: new THREE.Quaternion() };
const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const goalPos = new THREE.Vector3();
const goalQuat = new THREE.Quaternion();

function setFocus(on) {
  if (on === focused || (on && !hasSlice)) return;
  focused = on;
  transitioning = true;
  if (on) {
    saved.pos.copy(camera.position);
    saved.target.copy(controls.target);
    saved.quat.copy(camera.quaternion);
    controls.enabled = false;
    camera.fov = FOCUS_FOV;
    camera.updateProjectionMatrix();
  }
  ui.back.classList.toggle('hidden', !on);
  ui.hudMode.textContent = on ? 'SLICE VIEW' : 'SOURCE VOLUME';
  ui.hint.textContent = on
    ? 'double-click or esc · back to volume'
    : 'drag · orbit   scroll · zoom   double-click slice · focus';
}

function computeFocusGoal() {
  const aspect = camera.aspect;
  const tanH = Math.tan(THREE.MathUtils.degToRad(FOCUS_FOV) / 2);
  const dist = Math.max(focusInfo.h / 2 / tanH, focusInfo.w / 2 / (tanH * aspect)) * 1.1 + 0.02;
  goalPos.copy(focusInfo.center).addScaledVector(normal, dist);
  tmpM.makeBasis(basisU, basisV, normal);
  goalQuat.setFromRotationMatrix(tmpM);
}

function computeExitGoal() {
  goalPos.copy(saved.pos);
  tmpM.lookAt(saved.pos, saved.target, camera.up);
  goalQuat.setFromRotationMatrix(tmpM);
}

// ───────────────────────── volume sampling ─────────────────────────
async function buildVolume(src, label) {
  ui.loader.classList.remove('done');
  ui.loaderBar.style.width = '0%';
  ui.loaderText.textContent = 'Sampling frames…';

  const video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.preload = 'auto'; video.src = src;
  await new Promise((res, rej) => {
    video.onloadeddata = res;
    video.onerror = () => rej(new Error('video failed to load'));
  });

  const aspect = video.videoWidth / video.videoHeight;
  const W = VOL_W, H = Math.round(VOL_W / aspect), D = VOL_D;
  size.set(BOX_X, BOX_X / aspect, BOX_T);

  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';

  const data = new Uint8Array(W * H * D * 4);
  const dur = video.duration;
  for (let i = 0; i < D; i++) {
    const seeked = new Promise((r) => video.addEventListener('seeked', r, { once: true }));
    video.currentTime = Math.min(dur - 0.001, ((i + 0.5) / D) * dur);
    await seeked;
    ctx.drawImage(video, 0, 0, W, H);
    const px = ctx.getImageData(0, 0, W, H).data;
    // flip vertically: texture row 0 = bottom of the image
    for (let y = 0; y < H; y++) {
      const src0 = (H - 1 - y) * W * 4;
      data.set(px.subarray(src0, src0 + W * 4), (i * H + y) * W * 4);
    }
    ui.loaderBar.style.width = `${((i + 1) / D) * 100}%`;
  }

  const tex = new THREE.Data3DTexture(data, W, H, D);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  volumeUniform.value?.dispose?.();
  volumeUniform.value = tex;

  ui.info.textContent = `${label} · ${video.videoWidth}×${video.videoHeight} · ${dur.toFixed(1)}s → volume ${W}×${H}×${D}`;
  rebuildVolumeObjects();
  updateSlice();
  ui.loader.classList.add('done');
}

// ───────────────────────── UI wiring ─────────────────────────
function syncUI() {
  ui.az.value = state.az; ui.el.value = state.el; ui.pos.value = state.pos;
  const setNum = (el, v, d) => { if (document.activeElement !== el) el.value = (+v).toFixed(d); };
  setNum(ui.azNum, state.az, 1); setNum(ui.elNum, state.el, 1); setNum(ui.posNum, state.pos, 3);
  ui.nOut.textContent = `(${normal.x.toFixed(2)}, ${normal.y.toFixed(2)}, ${normal.z.toFixed(2)})`;
  ui.stackOut.textContent = (+ui.stack.value).toFixed(2);
  ui.speedOut.textContent = `${(+ui.speed.value).toFixed(2)}×`;
  ui.framesOut.textContent = ui.frames.value;
}
function onInput() {
  state.az = +ui.az.value; state.el = +ui.el.value; state.pos = +ui.pos.value;
  updateSlice(); syncUI();
}
['az', 'el', 'pos'].forEach((k) => ui[k].addEventListener('input', onInput));
// typed values: clamp to the slider range, apply live, don't rewrite the field while typing
for (const k of ['az', 'el', 'pos']) {
  const num = ui[k + 'Num'];
  num.addEventListener('input', () => {
    const v = parseFloat(num.value);
    if (Number.isNaN(v)) return;
    state[k] = Math.min(+ui[k].max, Math.max(+ui[k].min, v));
    updateSlice(); syncUI();
  });
  num.addEventListener('blur', syncUI);
  num.addEventListener('keydown', (e) => { if (e.key === 'Enter') num.blur(); e.stopPropagation(); });
}
ui.reset.addEventListener('click', () => {
  document.activeElement?.blur?.();
  state.az = 0; state.el = 0; state.pos = 0; playDir = 1;
  setPlaying(false); updateSlice(); syncUI();
});
ui.stack.addEventListener('input', syncUI);
ui.speed.addEventListener('input', syncUI);
ui.frames.addEventListener('input', () => { stackN = +ui.frames.value; rebuildVolumeObjects(); syncUI(); });

let playing = false, playDir = 1;
function setPlaying(p) {
  playing = p;
  ui.play.textContent = p ? '❚❚ Pause' : '▶ Play';
}
ui.play.addEventListener('click', () => setPlaying(!playing));
addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.target.tagName === 'SELECT') return;
  e.preventDefault();
  setPlaying(!playing);
});
document.querySelectorAll('.presets button').forEach((b) =>
  b.addEventListener('click', () => {
    state.az = +b.dataset.az; state.el = +b.dataset.el; state.pos = 0;
    updateSlice(); syncUI();
  }));
ui.back.addEventListener('click', () => setFocus(false));
addEventListener('keydown', (e) => { if (e.key === 'Escape') setFocus(false); });
ui.file.addEventListener('change', () => {
  const f = ui.file.files[0];
  if (!f) return;
  buildVolume(URL.createObjectURL(f), f.name).catch((e) => {
    console.error(e);
    ui.loaderText.textContent = `Couldn't read this video (${e.message}) — click to dismiss`;
    ui.loader.onclick = () => { ui.loader.classList.add('done'); ui.loader.onclick = null; };
  });
  ui.file.value = '';
});

const ray = new THREE.Raycaster();
canvas.addEventListener('dblclick', (e) => {
  if (focused) return setFocus(false);
  const r = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  if (hasSlice && ray.intersectObject(sliceMesh).length) setFocus(true);
});

// ───────────────────────── loop ─────────────────────────
function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);
resize();

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);

  if (playing) {
    const lim = +ui.pos.max;
    state.pos += playDir * dt * +ui.speed.value * 0.25; // 1× ≈ 8 s per full pass
    if (state.pos > lim) {
      if (ui.mode.value === 'pingpong') { state.pos = lim; playDir = -1; } else state.pos = -lim;
    } else if (state.pos < -lim) { state.pos = -lim; playDir = 1; }
    updateSlice(); syncUI();
  }

  // stack fades out while focused
  stackFade += ((focused ? 0 : 1) - stackFade) * (1 - Math.exp(-dt * 7));
  const so = +ui.stack.value;
  stackMat.uniforms.uOpacity.value = so * stackFade;
  stackEdgeMat.opacity = 0.2 * stackFade;
  boxMat.opacity = 0.15 + 0.4 * stackFade;
  outlineMat.opacity = 0.2 + 0.8 * stackFade;
  volumeGroup.visible = stackFade > 0.01 || !focused;
  stackMeshes.forEach((m) => (m.visible = stackFade * so > 0.005));

  if (focused || transitioning) {
    if (focused && hasSlice) computeFocusGoal();
    else if (!focused) computeExitGoal();
    const k = 1 - Math.exp(-dt * 9);
    camera.position.lerp(goalPos, k);
    camera.quaternion.slerp(goalQuat, k);
    if (!focused && camera.position.distanceTo(goalPos) < 0.01 && camera.quaternion.angleTo(goalQuat) < 0.005) {
      transitioning = false;
      camera.fov = 35; camera.updateProjectionMatrix();
      camera.position.copy(saved.pos);
      controls.target.copy(saved.target);
      controls.enabled = true;
      controls.update();
    }
  } else {
    controls.update();
  }

  renderer.render(scene, camera);
});


syncUI();
buildVolume('/video.mp4', 'video.mp4').catch((e) => {
  ui.loaderText.textContent = `Failed: ${e.message}`;
  console.error(e);
});
