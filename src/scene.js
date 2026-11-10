import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// ───────────────────────── config ─────────────────────────
const VOL_W = 480;      // voxel resolution of the sampled volume (height follows aspect)
const VOL_D = 120;      // number of sampled frames (time resolution)
const BOX_X = 3.2;      // world width of the volume; height follows aspect
const BOX_T = 2.2;      // world depth of the time axis
const FOCUS_FOV = 30;
const OVERVIEW_FOV = 35;
const ACCENT = 0x4ade80;
const BG = 0x0a0a0a;    // matches shadcn dark --background
export const POS_LIMIT = 0.99;

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

/**
 * Creates the time-slice scene.
 * handlers: { onSlice(s), onFocus(bool), onProgress(0..1), onLoading(bool), onLoaded(info), onError(msg), onPlaying(bool) }
 */
export function createScene(canvas, stage, handlers = {}) {
  const h = (name, ...a) => handlers[name]?.(...a);

  // ───── renderer / camera ─────
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(BG);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(OVERVIEW_FOV, 1, 0.05, 100);
  camera.position.set(4.6, 3.0, 5.6);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  const size = new THREE.Vector3(BOX_X, BOX_X / 1.98, BOX_T);

  // ───── materials ─────
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
  const stackEdgeMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.2, depthWrite: false });
  const boxMat = new THREE.LineBasicMaterial({ color: 0x8a8a94, transparent: true, opacity: 0.55 });
  const outlineMat = new THREE.LineBasicMaterial({ color: ACCENT, transparent: true });

  // ───── objects ─────
  const volumeGroup = new THREE.Group();
  scene.add(volumeGroup);

  const sliceGeo = new THREE.BufferGeometry();
  sliceGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9 * 3), 3));
  sliceGeo.setIndex(new THREE.BufferAttribute(new Uint16Array(8 * 3), 1));
  const sliceMesh = new THREE.Mesh(sliceGeo, sliceMat);
  sliceMesh.frustumCulled = false;
  scene.add(sliceMesh);

  const outlineGeo = new THREE.BufferGeometry();
  outlineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(8 * 3), 3));
  const outline = new THREE.LineLoop(outlineGeo, outlineMat);
  outline.frustumCulled = false;
  outline.renderOrder = 3;
  scene.add(outline);

  let stackN = 26;
  let stackMeshes = [];
  function rebuildVolumeObjects() {
    volumeGroup.traverse((o) => o.geometry?.dispose?.());
    volumeGroup.clear();
    stackMeshes = [];
    const hx = size.x / 2, hy = size.y / 2, hz = size.z / 2;

    volumeGroup.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(size.x, size.y, size.z)), boxMat));

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

    // axes: three solid lines along the box edges that meet at the front-bottom-left corner
    const o = new THREE.Vector3(-hx, -hy, hz);
    const axisMat = new THREE.LineBasicMaterial({ color: 0xe4e4e7 });
    for (const end of [
      new THREE.Vector3(hx, -hy, hz),   // x
      new THREE.Vector3(-hx, hy, hz),   // y
      new THREE.Vector3(-hx, -hy, -hz), // t
    ]) {
      volumeGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([o, end]), axisMat));
    }
  }

  // ───── slice geometry ─────
  const state = { az: 0, el: 0, pos: 0 };
  const normal = new THREE.Vector3(0, 0, 1);
  const basisU = new THREE.Vector3(1, 0, 0);
  const basisV = new THREE.Vector3(0, 1, 0);
  const focusInfo = { center: new THREE.Vector3(), w: 1, h: 1 };
  let hasSlice = false;

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

    const hv = [size.x / 2, size.y / 2, size.z / 2];
    const nv = [normal.x, normal.y, normal.z];
    const reach = Math.abs(nv[0]) * hv[0] + Math.abs(nv[1]) * hv[1] + Math.abs(nv[2]) * hv[2];
    const d = state.pos * reach;

    const pts = [];
    for (let a = 0; a < 3; a++) {
      if (Math.abs(nv[a]) < 1e-6) continue;
      const b = (a + 1) % 3, c = (a + 2) % 3;
      for (const sb of [-1, 1]) for (const sc of [-1, 1]) {
        const s = (d - nv[b] * sb * hv[b] - nv[c] * sc * hv[c]) / nv[a];
        if (Math.abs(s) <= hv[a] + 1e-6) {
          const arr = [0, 0, 0];
          arr[a] = s; arr[b] = sb * hv[b]; arr[c] = sc * hv[c];
          const p = new THREE.Vector3(arr[0], arr[1], arr[2]);
          if (!pts.some((q) => q.distanceToSquared(p) < 1e-8)) pts.push(p);
        }
      }
    }

    hasSlice = pts.length >= 3;
    sliceMesh.visible = outline.visible = hasSlice;
    h('onSlice', { ...state, normal: [normal.x, normal.y, normal.z] });
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

  // ───── focus mode ─────
  let focused = false;
  let transitioning = false;
  let stackFade = 1;
  const saved = { pos: new THREE.Vector3(), target: new THREE.Vector3() };
  const tmpM = new THREE.Matrix4();
  const goalPos = new THREE.Vector3();
  const goalQuat = new THREE.Quaternion();

  function setFocus(on) {
    if (on === focused || (on && !hasSlice)) return;
    focused = on;
    transitioning = true;
    if (on) {
      saved.pos.copy(camera.position);
      saved.target.copy(controls.target);
      controls.enabled = false;
      camera.fov = FOCUS_FOV;
      camera.updateProjectionMatrix();
    }
    h('onFocus', on);
  }

  function computeFocusGoal() {
    const tanH = Math.tan(THREE.MathUtils.degToRad(FOCUS_FOV) / 2);
    const dist = Math.max(focusInfo.h / 2 / tanH, focusInfo.w / 2 / (tanH * camera.aspect)) * 1.1 + 0.02;
    goalPos.copy(focusInfo.center).addScaledVector(normal, dist);
    tmpM.makeBasis(basisU, basisV, normal);
    goalQuat.setFromRotationMatrix(tmpM);
  }
  function computeExitGoal() {
    goalPos.copy(saved.pos);
    tmpM.lookAt(saved.pos, saved.target, camera.up);
    goalQuat.setFromRotationMatrix(tmpM);
  }

  // ───── volume sampling ─────
  async function load(src, label) {
    h('onLoading', true);
    h('onProgress', 0);
    try {
      const video = document.createElement('video');
      video.muted = true; video.playsInline = true; video.preload = 'auto'; video.src = src;
      await new Promise((res, rej) => {
        video.onloadeddata = res;
        video.onerror = () => rej(new Error('video failed to load'));
      });

      const aspect = video.videoWidth / video.videoHeight;
      const W = VOL_W, H = Math.round(VOL_W / aspect), D = VOL_D;

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
        for (let y = 0; y < H; y++) { // flip: texture row 0 = bottom
          const s0 = (H - 1 - y) * W * 4;
          data.set(px.subarray(s0, s0 + W * 4), (i * H + y) * W * 4);
        }
        h('onProgress', (i + 1) / D);
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

      size.set(BOX_X, BOX_X / aspect, BOX_T);
      rebuildVolumeObjects();
      updateSlice();
      h('onLoaded', `${label} · ${video.videoWidth}×${video.videoHeight} · ${dur.toFixed(1)}s → volume ${W}×${H}×${D}`);
    } catch (e) {
      console.error(e);
      h('onError', e.message);
    } finally {
      h('onLoading', false);
    }
  }

  // ───── playback ─────
  const play = { on: false, dir: 1, speed: 1, mode: 'loop' };
  function setPlaying(on) {
    play.on = on;
    h('onPlaying', on);
  }

  // ───── interaction ─────
  const ray = new THREE.Raycaster();
  function onDblClick(e) {
    if (focused) return setFocus(false);
    const r = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    if (hasSlice && ray.intersectObject(sliceMesh).length) setFocus(true);
  }
  canvas.addEventListener('dblclick', onDblClick);

  function resize() {
    const w = stage.clientWidth, hh = stage.clientHeight;
    if (!w || !hh) return;
    renderer.setSize(w, hh, false);
    camera.aspect = w / hh;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(stage);
  resize();

  // ───── loop ─────
  let stackOpacity = 0.18;
  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.25);

    if (play.on) {
      state.pos += play.dir * dt * play.speed * 0.25; // 1× ≈ 8 s per full pass
      if (state.pos > POS_LIMIT) {
        if (play.mode === 'pingpong') { state.pos = POS_LIMIT; play.dir = -1; } else state.pos = -POS_LIMIT;
      } else if (state.pos < -POS_LIMIT) { state.pos = -POS_LIMIT; play.dir = 1; }
      updateSlice();
    }

    stackFade += ((focused ? 0 : 1) - stackFade) * (1 - Math.exp(-dt * 7));
    stackMat.uniforms.uOpacity.value = stackOpacity * stackFade;
    stackEdgeMat.opacity = 0.2 * stackFade;
    boxMat.opacity = 0.15 + 0.4 * stackFade;
    outlineMat.opacity = 0.2 + 0.8 * stackFade;
    volumeGroup.visible = stackFade > 0.01 || !focused;
    stackMeshes.forEach((m) => (m.visible = stackFade * stackOpacity > 0.005));

    if (focused || transitioning) {
      if (focused && hasSlice) computeFocusGoal();
      else if (!focused) computeExitGoal();
      const k = 1 - Math.exp(-dt * 9);
      camera.position.lerp(goalPos, k);
      camera.quaternion.slerp(goalQuat, k);
      if (!focused && camera.position.distanceTo(goalPos) < 0.01 && camera.quaternion.angleTo(goalQuat) < 0.005) {
        transitioning = false;
        camera.fov = OVERVIEW_FOV; camera.updateProjectionMatrix();
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

  return {
    load,
    setSlice(p) {
      Object.assign(state, p);
      updateSlice();
    },
    reset() {
      play.dir = 1;
      setPlaying(false);
      state.az = 0; state.el = 0; state.pos = 0;
      updateSlice();
    },
    setStackOpacity(v) { stackOpacity = v; },
    setStackCount(n) { stackN = n; rebuildVolumeObjects(); },
    setFocus,
    toggleFocus() { setFocus(!focused); },
    setPlaying,
    togglePlaying() { setPlaying(!play.on); },
    setSpeed(v) { play.speed = v; },
    setMode(m) { play.mode = m; },
    dispose() {
      renderer.setAnimationLoop(null);
      ro.disconnect();
      canvas.removeEventListener('dblclick', onDblClick);
      controls.dispose();
      renderer.dispose();
    },
  };
}
