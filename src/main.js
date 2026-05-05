import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import GUI from 'lil-gui';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const canvas       = document.getElementById('canvas');
const resCtrl      = document.getElementById('res-ctrl');
const presetBtns   = document.querySelectorAll('.preset-btn');
const btnReset     = document.getElementById('btn-reset');
const btnDrop      = document.getElementById('btn-drop');
const btnJitter    = document.getElementById('btn-jitter');
const heatmapToggle= document.getElementById('heatmap-toggle');
const openMath       = document.getElementById('open-math');
const closeMath      = document.getElementById('close-math');
const langToggle     = document.getElementById('language-toggle');
const mathModal      = document.getElementById('math-modal');
const mathContent    = document.getElementById('math-content');
const openVerlet      = document.getElementById('open-verlet');
const closeVerlet     = document.getElementById('close-verlet');
const verletPopup     = document.getElementById('verlet-popup');
const verletViewBody  = document.getElementById('verlet-view-body');
const verletPopupMeta = document.getElementById('verlet-popup-meta');
const openEigen      = document.getElementById('open-eigen');
const closeEigen     = document.getElementById('close-eigen');
const eigenPopup     = document.getElementById('eigen-popup');
const eigenViewBody  = document.getElementById('eigen-view-body');
const eigenPopupMeta = document.getElementById('eigen-popup-meta');
const statVerts    = document.getElementById('stat-verts');
const statDim      = document.getElementById('stat-dim');
const statFps      = document.getElementById('stat-fps');
const statState    = document.getElementById('stat-state');
const specChart    = document.getElementById('spectrum-chart');

// ── Renderer / Scene / Camera ─────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = true;

const scene  = new THREE.Scene();
scene.background = new THREE.Color(0x2E3440);
scene.fog = new THREE.Fog(0x2E3440, 18, 35);

const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 100);
camera.position.set(0, 5, 8);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 1, 0);

// ── Lighting ──────────────────────────────────────────────────────────────────
const dirLight = new THREE.DirectionalLight(0xECEFF4, 2.5);
dirLight.position.set(4, 8, 5);
dirLight.castShadow = true;
scene.add(dirLight);
scene.add(new THREE.AmbientLight(0x4C566A, 1.2));

// ── Grid & Ground ─────────────────────────────────────────────────────────────
const gridHelper = new THREE.GridHelper(16, 16, 0x4C566A, 0x3B4252);
gridHelper.position.y = -0.01;
scene.add(gridHelper);

const groundGeo = new THREE.PlaneGeometry(16, 16);
const groundMat = new THREE.MeshStandardMaterial({
  color: 0x2E3440,
  transparent: true,
  opacity: 0.6,
});
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// ── Obstacle sphere ───────────────────────────────────────────────────────────
const SPHERE_RADIUS = 0.9;
const sphereGeo = new THREE.SphereGeometry(SPHERE_RADIUS, 32, 32);
const sphereMat = new THREE.MeshStandardMaterial({
  color: 0xD8DEE9,
  roughness: 0.3,
  metalness: 0.4,
});
const sphere = new THREE.Mesh(sphereGeo, sphereMat);
sphere.position.set(0, SPHERE_RADIUS, 0);
sphere.castShadow = true;
sphere.receiveShadow = true;
scene.add(sphere);

// ── Simulation state ──────────────────────────────────────────────────────────
const CLOTH_SIZE  = 3.0;
const CLOTH_Y0    = 4.0;   // initial hover height
const GRAVITY     = -9.8;
const SUBSTEPS    = 8;

/** Physics presets: [stiffness, damping] */
const PRESETS = {
  soft:   { stiffness: 200,  damping: 0.98 },
  medium: { stiffness: 500,  damping: 0.96 },
  stiff:  { stiffness: 1200, damping: 0.93 },
};

const guiParams = {
  stiffness:     PRESETS.soft.stiffness,
  mass:          1.0,
  damping:       PRESETS.soft.damping,
  shearRatio:    0.6,
  pulse:         0.15,
  showWireframe: true,
  flatShading:   false,
};


let resolution   = 1;        // segments per axis
let preset       = 'soft';
let simState     = 'idle';   // idle | falling | settled
let useHeatmap   = false;
let modalLang    = 'en';
let eigenView    = 'k-matrix';
let eigenVecDir  = 'x';

// Verlet popup state
let verletFrame = 0;
let verletSnap  = null;

// Cloth data arrays (rebuilt on resolution change)
let positions     = null;   // Float32Array [x,y,z, ...]
let prevPos       = null;
let framePrevPos  = null;   // positions captured at frame start (for Verlet display)
let pinned       = null;   // Boolean[]
let clothGeo     = null;
let clothMesh    = null;
let wireLine     = null;   // LineSegments2 fat wireframe
let wireGeo      = null;
let lineMat      = null;
let wireEdges    = null;   // Int32Array of edge index pairs [a,b, a,b, ...]
let wirePos      = null;   // Float32Array fed to LineSegmentsGeometry
let N            = 0;      // (res+1)^2 vertices
let eigenValues  = [];     // synthetic top-10 eigenvalue magnitudes

// ── Cloth builder ─────────────────────────────────────────────────────────────
function buildCloth(res) {
  resolution = res;
  const segs = res;
  N = (segs + 1) * (segs + 1);

  // Remove old mesh
  if (clothMesh) {
    scene.remove(clothMesh);
    clothMesh.geometry.dispose();
    clothMesh.material.dispose();
  }

  positions    = new Float32Array(N * 3);
  prevPos      = new Float32Array(N * 3);
  framePrevPos = new Float32Array(N * 3);
  pinned       = new Array(N).fill(false);

  const step = CLOTH_SIZE / segs;
  const ox   = -CLOTH_SIZE / 2;
  const oz   = -CLOTH_SIZE / 2;

  for (let j = 0; j <= segs; j++) {
    for (let i = 0; i <= segs; i++) {
      const idx = j * (segs + 1) + i;
      const x = ox + i * step;
      const z = oz + j * step;
      positions[idx * 3 + 0] = x;
      positions[idx * 3 + 1] = CLOTH_Y0;
      positions[idx * 3 + 2] = z;
    }
  }
  prevPos.set(positions);

  // Build triangle indices
  const indices = [];
  for (let j = 0; j < segs; j++) {
    for (let i = 0; i < segs; i++) {
      const a = j * (segs + 1) + i;
      const b = a + 1;
      const c = a + (segs + 1);
      const d = c + 1;
      if ((i + j) % 2 === 0) {
        indices.push(a, b, d);
        indices.push(a, d, c);
      } else {
        indices.push(a, b, c);
        indices.push(b, d, c);
      }
    }
  }

  clothGeo = new THREE.BufferGeometry();
  clothGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  clothGeo.setIndex(indices);
  clothGeo.computeVertexNormals();

  const clothMat = new THREE.MeshStandardMaterial({
    color: 0x88C0D0,   // Nord8 ice-blue
    side: THREE.DoubleSide,
    roughness:   0.55,
    metalness:   0.05,
    flatShading: guiParams.flatShading,
  });

  clothMesh = new THREE.Mesh(clothGeo, clothMat);
  clothMesh.castShadow = true;
  scene.add(clothMesh);

  // Fat wireframe via LineSegments2 (WebGL linewidth is capped at 1px otherwise)
  if (wireLine) { scene.remove(wireLine); wireGeo.dispose(); lineMat.dispose(); }

  const edgeSet = new Set();
  const edgePairs = [];
  for (let i = 0; i < indices.length; i += 3) {
    const tri = [indices[i], indices[i+1], indices[i+2]];
    for (let e = 0; e < 3; e++) {
      const u = tri[e], v = tri[(e+1) % 3];
      const key = u < v ? `${u},${v}` : `${v},${u}`;
      if (!edgeSet.has(key)) { edgeSet.add(key); edgePairs.push(u, v); }
    }
  }
  wireEdges = new Int32Array(edgePairs);
  wirePos   = new Float32Array(edgePairs.length * 3);

  wireGeo = new LineSegmentsGeometry();
  lineMat = new LineMaterial({ color: 0xBF616A, linewidth: 2, transparent: true, opacity: 0.5 });
  const vp = document.getElementById('viewport');
  lineMat.resolution.set(vp.clientWidth, vp.clientHeight);

  wireLine = new LineSegments2(wireGeo, lineMat);
  wireLine.visible = guiParams.showWireframe;
  scene.add(wireLine);
  updateWirePositions();

  simState    = 'idle';
  verletFrame = 0;
  verletSnap  = null;
  updateEigenSpectrum();
  updateStats();
  updateStatusBar('Idle');
}

// ── Verlet integration step ───────────────────────────────────────────────────
function updateDropBtn() {
  if (simState === 'falling') {
    btnDrop.textContent = 'Pause';
    btnDrop.style.background = 'var(--nord12)';
    btnDrop.style.borderColor = 'var(--nord12)';
  } else if (simState === 'paused') {
    btnDrop.textContent = 'Resume';
    btnDrop.style.background = 'var(--nord9)';
    btnDrop.style.borderColor = 'var(--nord9)';
  } else {
    btnDrop.textContent = 'Drop';
    btnDrop.style.background = 'var(--nord10)';
    btnDrop.style.borderColor = 'var(--nord10)';
  }
}

function stepSimulation(dt) {
  if (simState !== 'falling') return;

  const segs = resolution;
  const { stiffness, damping, shearRatio } = guiParams;
  const restLen = CLOTH_SIZE / segs;
  // Use a fixed physics dt so gravity feels consistent regardless of frame rate
  const subDt = Math.min(dt, 0.025) / SUBSTEPS;

  // Snapshot mean Y before this frame for settled detection
  let meanY0 = 0;
  for (let i = 0; i < N; i++) meanY0 += positions[i * 3 + 1];
  meanY0 /= N;

  for (let sub = 0; sub < SUBSTEPS; sub++) {
    // Apply gravity + verlet
    for (let i = 0; i < N; i++) {
      if (pinned[i]) continue;
      const ix = i * 3, iy = i * 3 + 1, iz = i * 3 + 2;
      const vx = (positions[ix] - prevPos[ix]) * damping;
      const vy = (positions[iy] - prevPos[iy]) * damping;
      const vz = (positions[iz] - prevPos[iz]) * damping;
      prevPos[ix] = positions[ix];
      prevPos[iy] = positions[iy];
      prevPos[iz] = positions[iz];
      positions[ix] += vx;
      // Gravity integrated as velocity increment per subDt (not dt²) for stability
      positions[iy] += vy + GRAVITY * subDt * subDt;
      positions[iz] += vz;
    }

    // Structural constraints (horizontal + vertical springs)
    const iters = Math.max(2, Math.floor(segs / 2));
    for (let iter = 0; iter < iters; iter++) {
      for (let j = 0; j <= segs; j++) {
        for (let i = 0; i <= segs; i++) {
          const idx = j * (segs + 1) + i;
          // Horizontal neighbour
          if (i < segs) solveSpring(idx, idx + 1, restLen, stiffness, subDt);
          // Vertical neighbour
          if (j < segs) solveSpring(idx, idx + (segs + 1), restLen, stiffness, subDt);
          // Diagonal shear
          if (i < segs && j < segs) {
            solveSpring(idx, idx + (segs + 1) + 1, restLen * Math.SQRT2, stiffness * shearRatio, subDt);
            solveSpring(idx + 1, idx + (segs + 1), restLen * Math.SQRT2, stiffness * shearRatio, subDt);
          }
        }
      }

      // Sphere collision
      for (let i = 0; i < N; i++) {
        const ix = i * 3, iy = i * 3 + 1, iz = i * 3 + 2;
        const dx = positions[ix] - sphere.position.x;
        const dy = positions[iy] - sphere.position.y;
        const dz = positions[iz] - sphere.position.z;
        const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
        const minDist = SPHERE_RADIUS + 0.025;
        if (dist < minDist && dist > 0.0001) {
          const s = minDist / dist;
          positions[ix] = sphere.position.x + dx * s;
          positions[iy] = sphere.position.y + dy * s;
          positions[iz] = sphere.position.z + dz * s;
        }
      }

      // Edge sphere collision (catches tunneling on coarse meshes like 1×1)
      for (let j = 0; j <= segs; j++) {
        for (let i = 0; i < segs; i++)
          solveEdgeSphere(j*(segs+1)+i, j*(segs+1)+i+1);
      }
      for (let j = 0; j < segs; j++) {
        for (let i = 0; i <= segs; i++)
          solveEdgeSphere(j*(segs+1)+i, (j+1)*(segs+1)+i);
      }
      for (let j = 0; j < segs; j++) {
        for (let i = 0; i < segs; i++) {
          const base = j*(segs+1)+i;
          solveEdgeSphere(base, base+(segs+1)+1);
          solveEdgeSphere(base+1, base+(segs+1));
        }
      }

      // Ground collision
      for (let i = 0; i < N; i++) {
        if (positions[i * 3 + 1] < 0.01) positions[i * 3 + 1] = 0.01;
      }
    }
  }

  clothGeo.attributes.position.needsUpdate = true;
  clothGeo.computeVertexNormals();
  updateWirePositions();

  if (useHeatmap) updateHeatmap();

  // Settled detection: compare frame mean-Y delta (avoids per-substep threshold trap)
  let meanY1 = 0;
  for (let i = 0; i < N; i++) meanY1 += positions[i * 3 + 1];
  meanY1 /= N;
  if (meanY1 < CLOTH_Y0 - 1.0 && Math.abs(meanY1 - meanY0) < 0.00015) {
    simState = 'settled';
    updateStatusBar('Settled');
  }
}

// Segment-sphere collision: prevents cloth tunneling on coarse meshes.
// Finds the closest point on edge (a,b) to the sphere and pushes both
// endpoints outward if the edge penetrates the sphere.
function solveEdgeSphere(a, b) {
  const ax = a*3, ay = a*3+1, az = a*3+2;
  const bx = b*3, by = b*3+1, bz = b*3+2;
  const sx = sphere.position.x, sy = sphere.position.y, sz = sphere.position.z;
  const pax = positions[ax], pay = positions[ay], paz = positions[az];
  const edx = positions[bx]-pax, edy = positions[by]-pay, edz = positions[bz]-paz;
  const lenSq = edx*edx + edy*edy + edz*edz;
  if (lenSq < 1e-8) return;
  // t in (0.01, 0.99) skips near-vertex region already handled by vertex loop
  const t = Math.max(0.01, Math.min(0.99,
    ((sx-pax)*edx + (sy-pay)*edy + (sz-paz)*edz) / lenSq));
  const cx = pax+t*edx-sx, cy = pay+t*edy-sy, cz = paz+t*edz-sz;
  const dSq = cx*cx + cy*cy + cz*cz;
  const minDist = SPHERE_RADIUS + 0.025;
  if (dSq >= minDist*minDist || dSq < 1e-8) return;
  const d = Math.sqrt(dSq);
  const pen = minDist - d;
  const nx = cx/d*pen, ny = cy/d*pen, nz = cz/d*pen;
  // Pushing both endpoints by the same vector moves the closest point by exactly pen
  if (!pinned[a]) { positions[ax] += nx; positions[ay] += ny; positions[az] += nz; }
  if (!pinned[b]) { positions[bx] += nx; positions[by] += ny; positions[bz] += nz; }
}

function solveSpring(a, b, rest, k, dt) {
  const ax = a*3, ay = a*3+1, az = a*3+2;
  const bx = b*3, by = b*3+1, bz = b*3+2;
  const dx = positions[bx] - positions[ax];
  const dy = positions[by] - positions[ay];
  const dz = positions[bz] - positions[az];
  const dist = Math.sqrt(dx*dx + dy*dy + dz*dz) || 0.0001;
  const invMass = 1 / guiParams.mass;
  const delta = (dist - rest) / dist * 0.5 * Math.min(k * dt * dt * invMass, 0.48);
  const cx = dx * delta, cy = dy * delta, cz = dz * delta;
  if (!pinned[a]) { positions[ax] += cx; positions[ay] += cy; positions[az] += cz; }
  if (!pinned[b]) { positions[bx] -= cx; positions[by] -= cy; positions[bz] -= cz; }
}

// ── Wire positions ────────────────────────────────────────────────────────────
function updateWirePositions() {
  if (!wireEdges || !wireGeo) return;
  const ep = wireEdges, wp = wirePos;
  for (let i = 0, n = ep.length; i < n; i += 2) {
    const a = ep[i] * 3, b = ep[i+1] * 3, j = (i >> 1) * 6;
    wp[j]   = positions[a];   wp[j+1] = positions[a+1]; wp[j+2] = positions[a+2];
    wp[j+3] = positions[b];   wp[j+4] = positions[b+1]; wp[j+5] = positions[b+2];
  }
  wireGeo.setPositions(wp);
}

// ── Heatmap ───────────────────────────────────────────────────────────────────
function updateHeatmap() {
  if (!clothGeo || !clothMesh) return;
  const colors = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const iy = i * 3 + 1;
    const stress = Math.max(0, Math.min(1, 1 - (positions[iy] / CLOTH_Y0)));
    // Blue (relaxed) → Red (stressed): lerp Nord8 → Nord11
    colors[i*3+0] = 0.533 + stress * (0.749 - 0.533);
    colors[i*3+1] = 0.753 - stress * (0.753 - 0.380);
    colors[i*3+2] = 0.816 - stress * (0.816 - 0.416);
  }
  if (!clothGeo.attributes.color) {
    clothGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    clothMesh.material.vertexColors = true;
  } else {
    clothGeo.attributes.color.array.set(colors);
    clothGeo.attributes.color.needsUpdate = true;
  }
  clothMesh.material.needsUpdate = true;
}

function clearHeatmap() {
  if (!clothMesh) return;
  clothMesh.material.vertexColors = false;
  clothMesh.material.color.set(0x88C0D0);
  clothMesh.material.needsUpdate = true;
}

// ── Eigen-spectrum (analytic approximation) ───────────────────────────────────
function updateEigenSpectrum() {
  const segs  = resolution;
  const count = Math.min(N, 25);
  eigenValues = [];
  for (let k = 1; k <= count; k++) {
    const lam = 4 * guiParams.stiffness * Math.pow(Math.sin(k * Math.PI / (2 * (segs + 1))), 2);
    eigenValues.push(lam);
  }
  renderSpectrumChart();
}

function renderSpectrumChart() {
  const max = Math.max(...eigenValues, 1);
  specChart.innerHTML = '';
  eigenValues.forEach(v => {
    const bar = document.createElement('div');
    bar.className = 'eigen-bar';
    bar.style.height = `${Math.max(4, (v / max) * 46)}px`;
    bar.title = `λ ≈ ${v.toFixed(1)}`;
    specChart.appendChild(bar);
  });
  if (!eigenPopup.hidden) renderEigenPopup();
}

// ── Stats ─────────────────────────────────────────────────────────────────────
let lastFpsTime = 0, frameCount = 0, fps = 0;

function updateStats() {
  statVerts.textContent = N;
  statDim.textContent   = `${N}×${N}`;
}

function updateFps(now) {
  frameCount++;
  if (now - lastFpsTime >= 1000) {
    fps = frameCount;
    frameCount = 0;
    lastFpsTime = now;
    statFps.textContent = fps;
  }
}

function updateStatusBar(state) {
  statState.textContent = state;
}

// ── lil-gui ───────────────────────────────────────────────────────────────────
const gui = new GUI({ container: document.getElementById('viewport'), width: 220 });
gui.domElement.style.cssText = 'position:absolute;top:0.5rem;left:0.5rem;';
gui.add(guiParams, 'stiffness', 50, 2000, 10).name('K (Stiffness)').onChange(updateEigenSpectrum);
gui.add(guiParams, 'mass',       0.1, 5,    0.1).name('Mass');
gui.add(guiParams, 'damping',   0.85, 0.999, 0.001).name('Damping');
gui.add(guiParams, 'shearRatio', 0,   1,    0.01).name('Shear Ratio');
gui.add(guiParams, 'pulse',      0,   0.3,  0.01).name('Pulse Amp');
gui.add(guiParams, 'showWireframe').name('Wireframe').onChange(v => {
  if (wireLine) wireLine.visible = v;
});
gui.add(guiParams, 'flatShading').name('Flat Shading').onChange(v => {
  if (!clothMesh) return;
  clothMesh.material.flatShading = v;
  clothMesh.material.needsUpdate = true;
});
gui.add({ reset() {
  guiParams.stiffness  = PRESETS.soft.stiffness;
  guiParams.mass       = 1.0;
  guiParams.damping    = PRESETS.soft.damping;
  guiParams.shearRatio = 0.6;
  guiParams.pulse      = 0.15;
  gui.controllersRecursive().forEach(c => c.updateDisplay());
  updateEigenSpectrum();
}}, 'reset').name('Reset to Default');

// ── Controls ──────────────────────────────────────────────────────────────────
resCtrl.addEventListener('click', e => {
  const btn = e.target.closest('button[data-res]');
  if (!btn) return;
  resCtrl.querySelectorAll('button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  buildCloth(parseInt(btn.dataset.res, 10));
});

presetBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    presetBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    preset = btn.dataset.preset;
    guiParams.stiffness = PRESETS[preset].stiffness;
    guiParams.damping   = PRESETS[preset].damping;
    gui.controllersRecursive().forEach(c => c.updateDisplay());
    updateEigenSpectrum();
  });
});

btnReset.addEventListener('click', () => {
  buildCloth(resolution);
  updateDropBtn();
});

btnDrop.addEventListener('click', () => {
  if (simState === 'idle' || simState === 'settled') {
    simState = 'falling';
    updateStatusBar('Falling…');
  } else if (simState === 'falling') {
    simState = 'paused';
    updateStatusBar('Paused');
  } else if (simState === 'paused') {
    simState = 'falling';
    updateStatusBar('Falling…');
  }
  updateDropBtn();
});

btnJitter.addEventListener('click', () => {
  if (!positions) return;
  simState = 'falling';
  updateDropBtn();
  const amp = guiParams.pulse;
  sphere.position.y += amp * 1.4;
  setTimeout(() => { sphere.position.y = SPHERE_RADIUS; }, 120);
  for (let i = 0; i < N; i++) {
    if (!pinned[i]) {
      positions[i*3+1] += (Math.random() - 0.3) * amp;
      positions[i*3+0] += (Math.random() - 0.5) * amp * 0.2;
      positions[i*3+2] += (Math.random() - 0.5) * amp * 0.2;
    }
  }
  updateStatusBar('Jitter!');
  updateEigenSpectrum();
});

heatmapToggle.addEventListener('change', () => {
  useHeatmap = heatmapToggle.checked;
  if (!useHeatmap) clearHeatmap();
});

// ── Modal ─────────────────────────────────────────────────────────────────────
const MODAL_COPY = {
  en: `
    <p>This simulation uses <strong>Verlet integration</strong> to evolve cloth particle positions over time under gravity and spring constraints.</p>
    <p>In semi-discrete form, the cloth dynamics can be summarized by the second-order equation of motion:</p>
    <p>$$M\\ddot{\\mathbf{x}} + C\\dot{\\mathbf{x}} + K\\mathbf{x} = \\mathbf{f}_{ext}$$</p>
    <p>Here $M$ is the mass matrix, $C$ is the damping matrix, $K$ is the stiffness matrix, and $\\mathbf{f}_{ext}$ contains external forces such as gravity and collision response. This demo approximates that model with Verlet position updates plus iterative spring constraints.</p>
    <p>Each particle $i$ at position $\\mathbf{x}_i$ is updated as:</p>
    <p>$$\\mathbf{x}_i^{t+\\Delta t} = 2\\mathbf{x}_i^t - \\mathbf{x}_i^{t-\\Delta t} + \\mathbf{a}_i\\,\\Delta t^2$$</p>
    <p>Spring forces between neighbouring particles enforce structural rigidity. Two particles $i$ and $j$ with rest length $L_0$ have a corrective displacement:</p>
    <p>$$\\Delta\\mathbf{x} = \\frac{\\|\\mathbf{d}\\| - L_0}{\\|\\mathbf{d}\\|}\\,\\mathbf{d}\\cdot k$$</p>
    <p>where $\\mathbf{d} = \\mathbf{x}_j - \\mathbf{x}_i$ is the displacement vector from particle $i$ to particle $j$, and $\\|\\mathbf{d}\\|$ is its current length.</p>
    <p>The <strong>Eigen-Spectrum</strong> shows the analytic approximation of the $k$-th eigenvalue of the mass-spring stiffness matrix $K$:</p>
    <p>$$\\lambda_k \\approx 4s\\sin^2\\!\\left(\\frac{k\\pi}{2N}\\right)$$</p>
    <p>where $s$ is the spring stiffness constant and $N$ is the number of vertices per axis. Higher-frequency modes (large $k$) correspond to rapid local oscillations visible as fine ripples after a Jitter impulse.</p>
    <pre><code class="language-js">// Verlet step (simplified)
prevPos[i] = positions[i];
positions[i] += velocity[i] * damping;
positions[i].y += gravity * dt²;</code></pre>
    <p><strong>Parameter Guide</strong></p>
    <ul style="padding-left:1.2rem;line-height:2">
      <li><strong>K (Stiffness)</strong> — Spring stiffness constant $s$. Higher values make the cloth resist deformation more strongly and shift all eigenvalues upward ($\\lambda_k \\propto s$). Very high K with coarse topology can cause numerical instability.</li>
      <li><strong>Mass</strong> — Uniform particle mass $m$. Heavier cloth has more inertia: springs correct positions more slowly ($\\Delta\\mathbf{x} \\propto 1/m$), so the cloth drapes with a sluggish, heavy feel. Mass does <em>not</em> affect free-fall speed — gravitational acceleration $g$ is independent of mass.</li>
      <li><strong>Damping</strong> — Velocity retention per step ($0{-}1$). At 1.0 the cloth oscillates indefinitely, exposing individual eigenmodes as standing waves. Lower values dissipate energy faster; below ≈ 0.90 oscillations collapse within a few frames.</li>
      <li><strong>Shear Ratio</strong> — Stiffness multiplier for diagonal springs relative to structural springs. At 0 the cloth has no shear resistance and collapses like a loose net; at 1 diagonal and structural springs are equally stiff. Intermediate values produce anisotropic wrinkling patterns.</li>
    </ul>
    <p><strong>Verlet Data Panel (V button)</strong></p>
    <p>The V panel samples up to 6 vertices each frame and displays the raw Verlet bookkeeping. All values are in world units (metres) along the Y-axis (gravity direction).</p>
    <ul style="padding-left:1.2rem;line-height:2">
      <li><strong>Y<sub>prev</sub></strong> — Vertex Y position at the <em>start</em> of the current frame, before any integration step. This is the "previous frame" snapshot captured by <code>framePrevPos</code>.</li>
      <li><strong>Y<sub>cur</sub></strong> — Vertex Y position at the <em>end</em> of the current frame, after all ${SUBSTEPS} substeps have run. This is the live <code>positions</code> buffer.</li>
      <li><strong>ΔY</strong> — Net displacement this frame: $\\Delta Y = Y_{cur} - Y_{prev}$. Negative (red) means the vertex fell; positive (green) means it bounced upward. The magnitude grows each frame as velocity accumulates under gravity.</li>
      <li><strong>Y<sub>next</sub>~</strong> — Estimated position one frame ahead, computed as: $Y_{next} \\approx Y_{cur} + \\Delta Y \\cdot d + g \\cdot \\delta t^2 \\cdot S$ where $d$ is the damping factor, $\\delta t = \\Delta t / S$ is the per-substep time, and $S = 8$ is the substep count. This is an approximation — spring constraints are not applied here.</li>
    </ul>
    <p>The formula block in the panel expands the per-substep mechanics for vertex 0:</p>
    <pre><code class="language-js">// Per substep (×8 per frame)
vel   = (pos - prevPos) * damping   // implicit velocity
grav  = GRAVITY * subDt * subDt     // position-level gravity term
pos  += vel + grav                  // Verlet update</code></pre>
    <p>Because Verlet stores velocity <em>implicitly</em> as the difference between two consecutive positions (rather than as a separate vector), damping is applied as a simple scale on that difference. The gravity term $g\,\delta t^2$ is added directly to the position — it is tiny per substep but integrates to the familiar $\\frac{1}{2}g t^2$ parabola over time.</p>
    <p><strong>Grid Resolution &amp; Spectrum Size</strong></p>
    <p>The Topology control selects the number of <em>segments</em> per axis. A grid with $n$ segments has $(n+1)^2$ vertices, a $K$ matrix of dimension $(n+1)^2 \\times (n+1)^2$, and the same number of distinct 2-D normal modes — one for each $(k_x, k_y)$ pair.</p>
    <table style="border-collapse:collapse;font-size:0.82rem;width:100%;margin:0.5rem 0">
      <thead><tr style="border-bottom:1px solid #4C566A;color:#81A1C1">
        <th style="text-align:left;padding:4px 8px">Grid</th>
        <th style="text-align:right;padding:4px 8px">Segments</th>
        <th style="text-align:right;padding:4px 8px">Vertices N</th>
        <th style="text-align:right;padding:4px 8px">K dim</th>
        <th style="text-align:right;padding:4px 8px">Modes</th>
        <th style="text-align:right;padding:4px 8px">3-D eigvec dim</th>
      </tr></thead>
      <tbody>
        <tr style="border-bottom:1px solid #3B4252"><td style="padding:3px 8px">1×1</td><td style="text-align:right;padding:3px 8px">1</td><td style="text-align:right;padding:3px 8px">4</td><td style="text-align:right;padding:3px 8px">4×4</td><td style="text-align:right;padding:3px 8px">4</td><td style="text-align:right;padding:3px 8px">12×12</td></tr>
        <tr style="border-bottom:1px solid #3B4252"><td style="padding:3px 8px">2×2</td><td style="text-align:right;padding:3px 8px">2</td><td style="text-align:right;padding:3px 8px">9</td><td style="text-align:right;padding:3px 8px">9×9</td><td style="text-align:right;padding:3px 8px">9</td><td style="text-align:right;padding:3px 8px">27×27</td></tr>
        <tr style="border-bottom:1px solid #3B4252"><td style="padding:3px 8px">4×4</td><td style="text-align:right;padding:3px 8px">4</td><td style="text-align:right;padding:3px 8px">25</td><td style="text-align:right;padding:3px 8px">25×25</td><td style="text-align:right;padding:3px 8px">25</td><td style="text-align:right;padding:3px 8px">75×75</td></tr>
        <tr style="border-bottom:1px solid #3B4252"><td style="padding:3px 8px">9×9</td><td style="text-align:right;padding:3px 8px">9</td><td style="text-align:right;padding:3px 8px">100</td><td style="text-align:right;padding:3px 8px">100×100</td><td style="text-align:right;padding:3px 8px">100</td><td style="text-align:right;padding:3px 8px">300×300</td></tr>
        <tr><td style="padding:3px 8px">19×19</td><td style="text-align:right;padding:3px 8px">19</td><td style="text-align:right;padding:3px 8px">400</td><td style="text-align:right;padding:3px 8px">400×400</td><td style="text-align:right;padding:3px 8px">400</td><td style="text-align:right;padding:3px 8px">1200×1200</td></tr>
      </tbody>
    </table>
    <p>The <strong>3-D eigenvector dimension</strong> is $3N \\times 3N$ because each vertex has three degrees of freedom $(x, y, z)$. The E panel displays the X, Y, Z directions separately as $N \\times N$ sub-matrices. The spectrum shown in the side panel and Spectrum tab is capped at $\\min(N, 25)$ modes for readability.</p>
    <p>The condition number $\\kappa = \\lambda_{max} / \\lambda_{min}$ grows with resolution: finer grids introduce slower low-frequency modes alongside the stiff high-frequency ones. A large $\\kappa$ makes the system harder to integrate stably — this is why very fine grids with high stiffness require more substeps or lower time-steps to remain stable.</p>
  `,
  zhTW: `
    <p>這個模擬使用 <strong>Verlet 積分法</strong> 在重力與彈簧約束下推進布料粒子的位置。</p>
    <p>若以半離散形式描述，布料動力學可總結為以下二階運動方程式：</p>
    <p>$$M\\ddot{\\mathbf{x}} + C\\dot{\\mathbf{x}} + K\\mathbf{x} = \\mathbf{f}_{ext}$$</p>
    <p>其中 $M$ 是質量矩陣（Mass matrix）、$C$ 是阻尼矩陣（Damping matrix）、$K$ 是剛度矩陣（Stiffness matrix），$\\mathbf{f}_{ext}$ 則包含重力與碰撞反應等外力。這個 demo 在實作上以 Verlet 位置更新搭配反覆彈簧約束，近似這個連續模型。</p>
    <p>每個粒子 $i$ 在位置 $\\mathbf{x}_i$ 的更新公式為：</p>
    <p>$$\\mathbf{x}_i^{t+\\Delta t} = 2\\mathbf{x}_i^t - \\mathbf{x}_i^{t-\\Delta t} + \\mathbf{a}_i\\,\\Delta t^2$$</p>
    <p>相鄰粒子之間的彈簧力確保布料結構的剛性。靜止長度為 $L_0$ 的粒子對 $(i,j)$ 的位移修正量為：</p>
    <p>$$\\Delta\\mathbf{x} = \\frac{\\|\\mathbf{d}\\| - L_0}{\\|\\mathbf{d}\\|}\\,\\mathbf{d}\\cdot k$$</p>
    <p>其中 $\\mathbf{d} = \\mathbf{x}_j - \\mathbf{x}_i$ 為從粒子 $i$ 指向粒子 $j$ 的位移向量，$\\|\\mathbf{d}\\|$ 為其當前長度。</p>
    <p><strong>特徵譜圖</strong> 顯示質量-彈簧剛度矩陣 $K$ 的第 $k$ 個特徵值近似值：</p>
    <p>$$\\lambda_k \\approx 4s\\sin^2\\!\\left(\\frac{k\\pi}{2N}\\right)$$</p>
    <p>其中 $s$ 為彈簧剛度常數，$N$ 為每軸頂點數。高頻模式（大 $k$）對應快速的局部振動，即按下 Jitter 後可見的細微漣漪。</p>
    <pre><code class="language-js">// Verlet 積分（簡化）
prevPos[i] = positions[i];
positions[i] += velocity[i] * damping;
positions[i].y += gravity * dt²;</code></pre>
    <p><strong>參數說明</strong></p>
    <ul style="padding-left:1.2rem;line-height:2">
      <li><strong>K（剛度）</strong> — 彈簧剛度常數 $s$。數值越高，布料越抵抗形變，所有特徵值同步上移（$\\lambda_k \\propto s$）。在粗糙網格搭配極高 K 值時可能造成數值不穩定。</li>
      <li><strong>質量（Mass）</strong> — 每個粒子的統一質量 $m$。質量越大，慣性越強，彈簧位移修正量越小（$\\Delta\\mathbf{x} \\propto 1/m$），布料下墜後皺褶展開遲緩、觸感沉重。質量<em>不影響</em>自由落體速度——重力加速度 $g$ 與質量無關。</li>
      <li><strong>阻尼（Damping）</strong> — 每步的速度保留率（$0{-}1$）。設為 1.0 時振動永不衰減，可清楚觀察到各特徵模式以駐波形式存在。數值越低能量耗散越快；低於約 0.90 時振動在數幀內即消失。</li>
      <li><strong>剪力比（Shear Ratio）</strong> — 對角彈簧相對於結構彈簧的剛度倍率。設為 0 時布料無抗剪能力，像鬆散的網；設為 1 時對角與結構彈簧等剛。中間值會產生各向異性的皺褶圖案。</li>
    </ul>
    <p><strong>Verlet 數據面板（V 按鈕）</strong></p>
    <p>V 面板每 frame 取樣最多 6 個頂點，直接顯示 Verlet 積分的原始計算數據。所有數值單位為世界座標（公尺），聚焦於 Y 軸（重力方向）。</p>
    <ul style="padding-left:1.2rem;line-height:2">
      <li><strong>Y<sub>prev</sub></strong> — 頂點在本 frame <em>開始前</em>（積分步驟執行前）的 Y 座標，由 <code>framePrevPos</code> 快照記錄，代表「上一 frame」的位置。</li>
      <li><strong>Y<sub>cur</sub></strong> — 頂點在本 frame <em>結束後</em>（所有 8 個子步驟完成後）的 Y 座標，直接讀取 <code>positions</code> 緩衝區，代表「當前 frame」的位置。</li>
      <li><strong>ΔY</strong> — 本 frame 的淨位移：$\\Delta Y = Y_{cur} - Y_{prev}$。負值（紅色）表示頂點下落，正值（綠色）表示反彈向上。隨著速度在重力下累積，每 frame 的絕對值會持續增大，直到碰到球體或地面為止。</li>
      <li><strong>Y<sub>next</sub>~</strong> — 預估下一 frame 的位置：$Y_{next} \\approx Y_{cur} + \\Delta Y \\cdot d + g \\cdot \\delta t^2 \\cdot S$，其中 $d$ 為阻尼係數，$\\delta t = \\Delta t / S$ 為每子步驟時間，$S = 8$ 為子步驟數。此為近似值，未套用彈簧約束。</li>
    </ul>
    <p>面板下方的公式 block 展開頂點 0 的逐子步驟計算過程：</p>
    <pre><code class="language-js">// 每個子步驟（每 frame 執行 ×8）
vel   = (pos - prevPos) * damping   // 隱式速度
grav  = GRAVITY * subDt * subDt     // 位置層級的重力項
pos  += vel + grav                  // Verlet 更新</code></pre>
    <p>Verlet 積分的核心特性在於速度以<em>隱式</em>方式存在——以兩個連續位置的差值表達，而非獨立的速度向量。阻尼因此只需對這個差值做縮放即可。重力項 $g\,\\delta t^2$ 每子步驟對位置的貢獻極小，但經過多 frame 累積後會重現熟悉的 $\\frac{1}{2}g t^2$ 拋物線軌跡。</p>
    <p><strong>網格解析度與特徵譜大小</strong></p>
    <p>Topology 控制每軸的<em>段數</em>。$n$ 段的網格有 $(n+1)^2$ 個頂點、$(n+1)^2 \\times (n+1)^2$ 的剛度矩陣 $K$，以及相同數量的二維正規模式——對應每個 $(k_x, k_y)$ 組合。</p>
    <table style="border-collapse:collapse;font-size:0.82rem;width:100%;margin:0.5rem 0">
      <thead><tr style="border-bottom:1px solid #4C566A;color:#81A1C1">
        <th style="text-align:left;padding:4px 8px">網格</th>
        <th style="text-align:right;padding:4px 8px">段數</th>
        <th style="text-align:right;padding:4px 8px">頂點 N</th>
        <th style="text-align:right;padding:4px 8px">K 維度</th>
        <th style="text-align:right;padding:4px 8px">模式數</th>
        <th style="text-align:right;padding:4px 8px">3D 特徵向量維度</th>
      </tr></thead>
      <tbody>
        <tr style="border-bottom:1px solid #3B4252"><td style="padding:3px 8px">1×1</td><td style="text-align:right;padding:3px 8px">1</td><td style="text-align:right;padding:3px 8px">4</td><td style="text-align:right;padding:3px 8px">4×4</td><td style="text-align:right;padding:3px 8px">4</td><td style="text-align:right;padding:3px 8px">12×12</td></tr>
        <tr style="border-bottom:1px solid #3B4252"><td style="padding:3px 8px">2×2</td><td style="text-align:right;padding:3px 8px">2</td><td style="text-align:right;padding:3px 8px">9</td><td style="text-align:right;padding:3px 8px">9×9</td><td style="text-align:right;padding:3px 8px">9</td><td style="text-align:right;padding:3px 8px">27×27</td></tr>
        <tr style="border-bottom:1px solid #3B4252"><td style="padding:3px 8px">4×4</td><td style="text-align:right;padding:3px 8px">4</td><td style="text-align:right;padding:3px 8px">25</td><td style="text-align:right;padding:3px 8px">25×25</td><td style="text-align:right;padding:3px 8px">25</td><td style="text-align:right;padding:3px 8px">75×75</td></tr>
        <tr style="border-bottom:1px solid #3B4252"><td style="padding:3px 8px">9×9</td><td style="text-align:right;padding:3px 8px">9</td><td style="text-align:right;padding:3px 8px">100</td><td style="text-align:right;padding:3px 8px">100×100</td><td style="text-align:right;padding:3px 8px">100</td><td style="text-align:right;padding:3px 8px">300×300</td></tr>
        <tr><td style="padding:3px 8px">19×19</td><td style="text-align:right;padding:3px 8px">19</td><td style="text-align:right;padding:3px 8px">400</td><td style="text-align:right;padding:3px 8px">400×400</td><td style="text-align:right;padding:3px 8px">400</td><td style="text-align:right;padding:3px 8px">1200×1200</td></tr>
      </tbody>
    </table>
    <p><strong>3D 特徵向量維度</strong>為 $3N \\times 3N$，因為每個頂點有三個自由度 $(x, y, z)$。E 面板將 X、Y、Z 方向分開，各以 $N \\times N$ 子矩陣呈現。側邊欄與 Spectrum 頁籤的特徵譜最多顯示 $\\min(N, 25)$ 個模式以維持可讀性。</p>
    <p>條件數 $\\kappa = \\lambda_{max} / \\lambda_{min}$ 隨解析度提升而增大：較細的網格在引入高頻剛性模式的同時，也帶入了更慢的低頻模式。$\\kappa$ 越大，系統越難穩定積分——這正是高解析度搭配高剛度時，需要更多子步驟或更小時間步長才能保持穩定的原因。</p>
  `,
};

function renderModal() {
  mathContent.innerHTML = MODAL_COPY[modalLang];
  if (window.renderMathInElement) {
    window.renderMathInElement(mathContent, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$',  right: '$',  display: false },
      ],
    });
  }
  if (window.Prism) window.Prism.highlightAllUnder(mathContent);
}

openMath.addEventListener('click', () => {
  renderModal();
  mathModal.hidden = false;
});
closeMath.addEventListener('click', () => { mathModal.hidden = true; });
mathModal.addEventListener('click', e => { if (e.target === mathModal) mathModal.hidden = true; });
langToggle.addEventListener('click', () => {
  modalLang = modalLang === 'en' ? 'zhTW' : 'en';
  renderModal();
});

// ── Verlet popup ──────────────────────────────────────────────────────────────
function captureVerletSnapshot(dt) {
  verletFrame++;
  if (!positions || !framePrevPos) return;

  const maxSample = Math.min(N, 6);
  const stride    = Math.max(1, Math.floor(N / maxSample));
  const sampleIdx = [];
  for (let i = 0; i < N && sampleIdx.length < maxSample; i += stride) sampleIdx.push(i);

  const dtClamped = Math.min(dt, 0.025);
  const subDt     = dtClamped / SUBSTEPS;

  verletSnap = {
    frame: verletFrame,
    dt,
    subDt,
    dtClamped,
    state: simState,
    sampleIdx,
    prev: sampleIdx.map(i => [framePrevPos[i*3], framePrevPos[i*3+1], framePrevPos[i*3+2]]),
    cur:  sampleIdx.map(i => [positions[i*3],    positions[i*3+1],    positions[i*3+2]]),
  };
}

function renderVerletPopup() {
  if (!verletSnap) {
    verletViewBody.innerHTML = '<div style="color:var(--nord4);font-size:0.75rem;padding:0.5rem">Loading…</div>';
    return;
  }

  const { frame, dt, subDt, dtClamped, state, sampleIdx, prev, cur } = verletSnap;
  const damping = guiParams.damping;

  verletViewBody.innerHTML = '';

  // Frame info
  const stateColor = state === 'falling' ? 'var(--nord14)' : state === 'settled' ? 'var(--nord13)' : 'var(--nord3)';
  const info = document.createElement('div');
  info.style.cssText = 'display:flex;gap:0.7rem;flex-wrap:wrap;margin-bottom:0.55rem;font-size:0.65rem';
  info.innerHTML =
    `<span style="color:var(--nord4)">Frame <span style="color:var(--nord8)">${frame}</span></span>` +
    `<span style="color:var(--nord4)">dt <span style="color:var(--nord8)">${(dt*1000).toFixed(1)}ms</span></span>` +
    `<span style="color:var(--nord4)">subDt <span style="color:var(--nord8)">${(subDt*1000).toFixed(2)}ms</span></span>` +
    `<span style="color:${stateColor}">${state}</span>`;
  verletViewBody.appendChild(info);

  if (state === 'idle') {
    const msg = document.createElement('div');
    msg.style.cssText = 'color:var(--nord3);font-size:0.72rem;padding:0.5rem 0';
    msg.textContent = 'Press Drop to start simulation.';
    verletViewBody.appendChild(msg);
    verletPopupMeta.innerHTML =
      `x<sub>t+Δt</sub> = x<sub>t</sub> + (x<sub>t</sub>−x<sub>t-Δt</sub>)·d + g·Δt²`;
    return;
  }

  // Vertex table (Y axis focus)
  const table = document.createElement('table');
  table.style.cssText = 'border-collapse:collapse;width:100%;font-size:0.62rem;margin-bottom:0.6rem';
  table.innerHTML =
    `<thead><tr style="color:var(--nord3);border-bottom:1px solid var(--nord2)">` +
    `<th style="text-align:right;padding:2px 5px">vtx</th>` +
    `<th style="text-align:right;padding:2px 5px">Y<sub>prev</sub></th>` +
    `<th style="text-align:right;padding:2px 5px">Y<sub>cur</sub></th>` +
    `<th style="text-align:right;padding:2px 5px">ΔY</th>` +
    `<th style="text-align:right;padding:2px 5px">Y<sub>next</sub>~</th>` +
    `</tr></thead>`;

  const tbody = document.createElement('tbody');
  sampleIdx.forEach((vi, i) => {
    const py = prev[i][1];
    const cy = cur[i][1];
    const dy = cy - py;
    const vel_y  = dy * damping;
    const grav_y = GRAVITY * subDt * subDt * SUBSTEPS;
    const ny = cy + vel_y + grav_y;
    const dyColor = dy < -0.0005 ? 'var(--nord11)' : dy > 0.0005 ? 'var(--nord14)' : 'var(--nord4)';

    const tr = document.createElement('tr');
    tr.style.cssText = 'border-bottom:1px solid rgba(76,86,106,0.25)';
    tr.title = `vtx ${vi}: prev(${prev[i].map(v=>v.toFixed(3)).join(', ')})  cur(${cur[i].map(v=>v.toFixed(3)).join(', ')})`;
    tr.innerHTML =
      `<td style="text-align:right;padding:2px 5px;color:var(--nord4)">${vi}</td>` +
      `<td style="text-align:right;padding:2px 5px;color:var(--nord9)">${py.toFixed(4)}</td>` +
      `<td style="text-align:right;padding:2px 5px;color:var(--nord8)">${cy.toFixed(4)}</td>` +
      `<td style="text-align:right;padding:2px 5px;color:${dyColor}">${dy >= 0 ? '+' : ''}${dy.toFixed(4)}</td>` +
      `<td style="text-align:right;padding:2px 5px;color:var(--nord13)">${ny.toFixed(4)}</td>`;
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  verletViewBody.appendChild(table);

  // Formula block for first sampled vertex
  if (sampleIdx.length > 0) {
    const py     = prev[0][1];
    const cy     = cur[0][1];
    const vel_y  = (cy - py) * damping;
    const grav_y = GRAVITY * subDt * subDt * SUBSTEPS;
    const ny     = cy + vel_y + grav_y;

    const block = document.createElement('div');
    block.style.cssText =
      'font-size:0.61rem;color:var(--nord4);line-height:1.85;padding:0.4rem 0.55rem;' +
      'background:rgba(46,52,64,0.55);border-radius:6px;margin-bottom:0.3rem';
    block.innerHTML =
      `<span style="color:var(--nord3)">// vtx ${sampleIdx[0]}  Y-axis  ×${SUBSTEPS} substeps</span><br>` +
      `<span style="color:var(--nord9)">Y_prev</span>  = <span style="color:var(--nord13)">${py.toFixed(5)}</span><br>` +
      `<span style="color:var(--nord8)">Y_cur</span>   = <span style="color:var(--nord13)">${cy.toFixed(5)}</span><br>` +
      `vel     = ΔY × d  = ${(cy-py).toFixed(5)} × ${damping.toFixed(3)} = <span style="color:var(--nord11)">${vel_y.toFixed(5)}</span><br>` +
      `grav    = g × subDt² × ${SUBSTEPS} = <span style="color:var(--nord11)">${grav_y.toFixed(5)}</span><br>` +
      `<span style="color:var(--nord14)">Y_next</span>~ = Y_cur + vel + grav = <span style="color:var(--nord13)">${ny.toFixed(5)}</span>`;
    verletViewBody.appendChild(block);
  }

  verletPopupMeta.innerHTML =
    `x<sub>t+Δt</sub> = x<sub>t</sub> + (x<sub>t</sub>−x<sub>t-Δt</sub>)·d + g·Δt² &nbsp;·&nbsp; d=${damping.toFixed(3)}<br>` +
    `${sampleIdx.length} verts sampled &nbsp;·&nbsp; hover row for XYZ detail`;
}

openVerlet.addEventListener('click', () => {
  verletPopup.hidden = !verletPopup.hidden;
  openVerlet.classList.toggle('active', !verletPopup.hidden);
  if (!verletPopup.hidden) {
    if (!verletPopup.dataset.positioned) {
      verletPopup.dataset.positioned = '1';
      const btnRect = openVerlet.getBoundingClientRect();
      const initH = Math.round(Math.min(500, Math.max(320, window.innerHeight * 0.42)));
      verletPopup.style.left = `${Math.max(8, btnRect.left)}px`;
      verletPopup.style.top  = `${Math.max(8, btnRect.top - initH - 12)}px`;
    }
    renderVerletPopup();
  }
});
closeVerlet.addEventListener('click', () => {
  verletPopup.hidden = true;
  openVerlet.classList.remove('active');
});

let verletDrag = null;
verletPopup.querySelector('.verlet-popup-header').addEventListener('mousedown', e => {
  if (e.target.closest('button')) return;
  const rect = verletPopup.getBoundingClientRect();
  verletDrag = { ox: e.clientX - rect.left, oy: e.clientY - rect.top };
  e.preventDefault();
});
document.addEventListener('mousemove', e => {
  if (!verletDrag) return;
  verletPopup.style.left = `${Math.max(0, Math.min(window.innerWidth  - 60, e.clientX - verletDrag.ox))}px`;
  verletPopup.style.top  = `${Math.max(0, Math.min(window.innerHeight - 60, e.clientY - verletDrag.oy))}px`;
});
document.addEventListener('mouseup', () => { verletDrag = null; });

// ── Eigen-spectrum popup ──────────────────────────────────────────────────────
/** nord9 → nord13 → nord11, returns [r,g,b] */
function eigenColorRGB(t) {
  const stops = [[0x81,0xA1,0xC1],[0xEB,0xCB,0x8B],[0xBF,0x61,0x6A]];
  const seg = Math.min(t * 2, 1.9999);
  const i = Math.floor(seg), f = seg - i;
  const [a, b] = [stops[i], stops[i + 1]];
  return [
    Math.round(a[0] + (b[0]-a[0]) * f),
    Math.round(a[1] + (b[1]-a[1]) * f),
    Math.round(a[2] + (b[2]-a[2]) * f),
  ];
}
function eigenColor(t) {
  const [r,g,b] = eigenColorRGB(t);
  return `rgb(${r},${g},${b})`;
}

/** Pick dark or light text for contrast. */
function contrastColor(r, g, b) {
  return (0.299*r + 0.587*g + 0.114*b) / 255 > 0.45 ? '#2E3440' : '#ECEFF4';
}

/** Compact λ value label. */
function fmtLambda(v) {
  if (v >= 10000) return `${Math.round(v / 1000)}k`;
  if (v >= 1000)  return `${(v / 1000).toFixed(1)}k`;
  if (v >= 10)    return Math.round(v).toString();
  return v.toFixed(1);
}

/** Cell px size based on count. */
function cellPx(n) {
  if (n <= 4)  return 52;
  if (n <= 9)  return 40;
  if (n <= 16) return 28;
  return 20;
}

function renderEigenPopup() {
  const titleMap = {
    'k-matrix':    'K-Space Matrix',
    'eigenvectors': 'Eigenvectors',
    'eigenvalue':  'Eigenvalues',
    'spectrum':    'Eigen Spectrum',
  };
  document.getElementById('eigen-popup-title').textContent = titleMap[eigenView];
  eigenViewBody.innerHTML = '';

  if      (eigenView === 'k-matrix')    renderKMatrixView();
  else if (eigenView === 'eigenvectors') renderEigenvectorsView();
  else if (eigenView === 'eigenvalue')  renderEigenvalueView();
  else                                  renderSpectrumView();
}

function renderKMatrixView() {
  const segs = resolution;
  const k  = guiParams.stiffness;
  const ks = k * guiParams.shearRatio;

  const DISP = Math.min(N, 16);
  const stride = Math.ceil(N / DISP);
  const rowIdx = [];
  for (let i = 0; i < N && rowIdx.length < DISP; i += stride) rowIdx.push(i);
  const dn = rowIdx.length;

  const vals = new Float32Array(dn * dn);
  let maxV = 0;

  for (let ri = 0; ri < dn; ri++) {
    const vidx = rowIdx[ri];
    const vj = Math.floor(vidx / (segs + 1));
    const vi = vidx % (segs + 1);

    for (let ci = 0; ci < dn; ci++) {
      const cidx = rowIdx[ci];
      const cj = Math.floor(cidx / (segs + 1));
      const ci_ = cidx % (segs + 1);

      let val = 0;
      if (vidx === cidx) {
        if (vi < segs) val += k;
        if (vi > 0)    val += k;
        if (vj < segs) val += k;
        if (vj > 0)    val += k;
        if (vi < segs && vj < segs) val += ks;
        if (vi > 0    && vj > 0)    val += ks;
        if (vi < segs && vj > 0)    val += ks;
        if (vi > 0    && vj < segs) val += ks;
      } else {
        const dr = Math.abs(vi - ci_), dc = Math.abs(vj - cj);
        if      (dr === 1 && dc === 0) val = -k;
        else if (dr === 0 && dc === 1) val = -k;
        else if (dr === 1 && dc === 1) val = -ks;
      }
      vals[ri * dn + ci] = val;
      maxV = Math.max(maxV, Math.abs(val));
    }
  }

  const cs = cellPx(dn);

  const hint = document.createElement('div');
  hint.className = 'eigen-matrix-hint';
  hint.textContent = N > 16
    ? `K ∈ ℝ^{${N}×${N}} (showing ${dn}×${dn} sample)`
    : `K ∈ ℝ^{${N}×${N}} (stiffness matrix)`;
  eigenViewBody.appendChild(hint);

  const grid = document.createElement('div');
  grid.style.cssText = `display:grid;grid-template-columns:repeat(${dn},${cs}px);gap:3px;margin-bottom:0.55rem`;

  for (let ri = 0; ri < dn; ri++) {
    for (let ci = 0; ci < dn; ci++) {
      const v = vals[ri * dn + ci];
      const cell = document.createElement('div');
      cell.style.cssText = `width:${cs}px;height:${cs}px;border-radius:2px;`;
      cell.title = `K[${rowIdx[ri]},${rowIdx[ci]}] = ${v.toFixed(1)}`;

      if (Math.abs(v) < 0.01) {
        cell.style.background = 'rgba(46,52,64,0.7)';
      } else {
        const t = (v / maxV + 1) / 2;
        const [r,g,b] = eigenColorRGB(t);
        cell.style.background = `rgb(${r},${g},${b})`;
        if (cs >= 28) {
          Object.assign(cell.style, {
            display: 'grid', placeItems: 'center',
            fontSize: `${cs >= 40 ? 9 : 7}px`, fontWeight: '600',
            lineHeight: '1', overflow: 'hidden',
            color: contrastColor(r, g, b),
          });
          if (Math.abs(v) >= 1) cell.textContent = fmtLambda(Math.abs(v));
        }
      }
      grid.appendChild(cell);
    }
  }
  eigenViewBody.appendChild(grid);

  const legDiv = document.createElement('div');
  legDiv.style.cssText = 'display:flex;align-items:center;gap:0.4rem;margin-bottom:0.55rem';
  legDiv.innerHTML =
    `<span style="font-size:0.6rem;color:var(--nord4);white-space:nowrap">−${fmtLambda(maxV)}</span>` +
    `<div style="flex:1;height:6px;border-radius:3px;background:linear-gradient(to right,${eigenColor(0)},${eigenColor(0.5)},${eigenColor(1)})"></div>` +
    `<span style="font-size:0.6rem;color:var(--nord4);white-space:nowrap">+${fmtLambda(maxV)}</span>`;
  eigenViewBody.appendChild(legDiv);

  eigenPopupMeta.innerHTML =
    `K[i,i] = Σ spring stiffnesses &nbsp;·&nbsp; K[i,j] = −k<br>` +
    `structural s=${guiParams.stiffness} &nbsp;·&nbsp; shear s=${Math.round(k * guiParams.shearRatio)}`;
}

function build2DModes(segs, count) {
  const modes = [];
  for (let kx = 1; kx <= segs + 1; kx++) {
    for (let ky = 1; ky <= segs + 1; ky++) {
      const lam = 4 * guiParams.stiffness * (
        Math.pow(Math.sin(kx * Math.PI / (2 * (segs + 2))), 2) +
        Math.pow(Math.sin(ky * Math.PI / (2 * (segs + 2))), 2)
      );
      modes.push({ kx, ky, lam });
    }
  }
  modes.sort((a, b) => a.lam - b.lam);
  return modes.slice(0, count);
}

function renderEigenvectorsView() {
  const segs     = resolution;
  const count    = Math.min(eigenValues.length, 25);
  const topModes = build2DModes(segs, count);

  // ── Direction sub-tabs ──────────────────────────────────────────────────────
  const subTabDiv = document.createElement('div');
  subTabDiv.className = 'eigen-subtab-ctrl';
  ['x', 'y', 'z'].forEach(dir => {
    const btn = document.createElement('button');
    btn.className = 'esubtab' + (eigenVecDir === dir ? ' active' : '');
    btn.dataset.dir = dir;
    btn.textContent = dir.toUpperCase();
    subTabDiv.appendChild(btn);
  });
  subTabDiv.addEventListener('click', e => {
    const btn = e.target.closest('.esubtab[data-dir]');
    if (!btn) return;
    eigenVecDir = btn.dataset.dir;
    renderEigenPopup();
  });
  eigenViewBody.appendChild(subTabDiv);

  // ── Subsample vertices for rows ─────────────────────────────────────────────
  const DISP   = Math.min(N, 20);
  const stride = Math.ceil(N / DISP);
  const vertIdx = [];
  for (let i = 0; i < N && vertIdx.length < DISP; i += stride) vertIdx.push(i);
  const dv = vertIdx.length;

  const cellSz = Math.max(4, Math.min(14, Math.floor(Math.min(300 / count, 260 / dv))));

  // ── Hint ────────────────────────────────────────────────────────────────────
  const hint = document.createElement('div');
  hint.className = 'eigen-matrix-hint';
  if (eigenVecDir === 'y') {
    hint.textContent = `V_y ∈ ℝ^{${N}×${N}} — out-of-plane (bending, λ ≈ 0)`;
  } else {
    hint.textContent = N > DISP || count < N
      ? `V_${eigenVecDir} ∈ ℝ^{${N}×${N}}  (${dv} verts × ${count} modes)`
      : `V_${eigenVecDir} ∈ ℝ^{${N}×${N}}`;
  }
  eigenViewBody.appendChild(hint);

  // ── Matrix grid ─────────────────────────────────────────────────────────────
  const wrap = document.createElement('div');
  wrap.style.cssText = 'overflow:auto;margin-bottom:0.55rem';

  const grid = document.createElement('div');
  grid.style.cssText =
    `display:grid;grid-template-columns:repeat(${count},${cellSz}px);gap:1px;width:fit-content`;

  for (let vi = 0; vi < dv; vi++) {
    const vidx = vertIdx[vi];
    const vj   = Math.floor(vidx / (segs + 1));
    const vi_  = vidx % (segs + 1);

    for (let mi = 0; mi < count; mi++) {
      const { kx, ky } = topModes[mi];
      let v = 0;
      if (eigenVecDir === 'x') {
        // In-plane horizontal: kx drives column oscillation, ky drives row oscillation
        v = Math.sin(kx * Math.PI * (vi_ + 1) / (segs + 2)) *
            Math.sin(ky * Math.PI * (vj  + 1) / (segs + 2));
      } else if (eigenVecDir === 'z') {
        // In-plane depth: axes swapped — ky drives column, kx drives row
        v = Math.sin(ky * Math.PI * (vi_ + 1) / (segs + 2)) *
            Math.sin(kx * Math.PI * (vj  + 1) / (segs + 2));
      }
      // y: v = 0 → neutral mid-colour (bending stiffness not modelled)

      const t = (v + 1) / 2;
      const [r,g,b] = eigenColorRGB(t);
      const cell = document.createElement('div');
      cell.style.cssText =
        `width:${cellSz}px;height:${cellSz}px;background:rgb(${r},${g},${b})`;
      cell.title = `V_${eigenVecDir}[${vidx}, ${mi + 1}] = ${v.toFixed(3)}  (${kx},${ky})`;
      grid.appendChild(cell);
    }
  }

  wrap.appendChild(grid);
  eigenViewBody.appendChild(wrap);

  // ── Legend / note ───────────────────────────────────────────────────────────
  const legDiv = document.createElement('div');
  legDiv.style.cssText = 'display:flex;align-items:center;gap:0.4rem;margin-bottom:0.55rem';
  if (eigenVecDir === 'y') {
    legDiv.innerHTML =
      `<span style="font-size:0.6rem;color:var(--nord4)">` +
      `No bending stiffness — all Y modes degenerate at λ ≈ 0</span>`;
  } else {
    legDiv.innerHTML =
      `<span style="font-size:0.6rem;color:var(--nord4);white-space:nowrap">−1</span>` +
      `<div style="flex:1;height:6px;border-radius:3px;` +
      `background:linear-gradient(to right,${eigenColor(0)},${eigenColor(0.5)},${eigenColor(1)})"></div>` +
      `<span style="font-size:0.6rem;color:var(--nord4);white-space:nowrap">+1</span>`;
  }
  eigenViewBody.appendChild(legDiv);

  const dirDesc = {
    x: 'In-plane horizontal · horizontal + diagonal springs',
    y: 'Out-of-plane (gravity axis) · zero spring stiffness',
    z: 'In-plane depth · vertical + diagonal springs',
  };
  eigenPopupMeta.innerHTML =
    `${dirDesc[eigenVecDir]}<br>` +
    `rows: ${dv} vertices &nbsp;·&nbsp; cols: ${count} modes (↑ λ)`;
}

function renderEigenvalueView() {
  const segs  = resolution;
  const count = eigenValues.length;
  if (!count) return;
  const topModes = build2DModes(segs, count);
  const maxLam   = topModes[topModes.length - 1].lam || 1;

  const hint = document.createElement('div');
  hint.className = 'eigen-matrix-hint';
  hint.textContent = `λ_k ≈ 4s·(sin²(kxπ/2N) + sin²(kyπ/2N))`;
  eigenViewBody.appendChild(hint);

  const list = document.createElement('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:2px;margin-bottom:0.55rem';

  topModes.forEach(({ kx, ky, lam }, i) => {
    const t = lam / maxLam;
    const [r,g,b] = eigenColorRGB(t);
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:5px;font-size:0.65rem';
    row.innerHTML =
      `<span style="color:var(--nord4);min-width:18px;text-align:right;flex-shrink:0">${i + 1}</span>` +
      `<span style="color:var(--nord4);min-width:36px;flex-shrink:0;font-size:0.6rem">(${kx},${ky})</span>` +
      `<div style="flex:1;height:8px;border-radius:2px;background:rgb(${r},${g},${b})"></div>` +
      `<span style="color:var(--nord8);min-width:40px;text-align:right;flex-shrink:0">${fmtLambda(lam)}</span>`;
    list.appendChild(row);
  });
  eigenViewBody.appendChild(list);

  eigenPopupMeta.innerHTML =
    `s=${guiParams.stiffness} &nbsp;·&nbsp; N=${segs + 1} per axis &nbsp;·&nbsp; ${count} modes<br>` +
    `κ = λ<sub>max</sub>/λ<sub>min</sub> = ${(maxLam / (topModes[0].lam || 1)).toFixed(1)}`;
}

function renderSpectrumView() {
  const segs  = resolution;
  const count = eigenValues.length;
  if (!count) return;
  const max = Math.max(...eigenValues, 1);

  const barW = Math.max(14, Math.min(22, Math.floor(260 / count)));

  const hint = document.createElement('div');
  hint.className = 'eigen-matrix-hint';
  hint.textContent = `Λ = diag(λ₁, …, λ${count})`;
  eigenViewBody.appendChild(hint);

  const chart = document.createElement('div');
  chart.style.cssText = 'display:flex;align-items:flex-end;gap:3px;height:80px;margin-bottom:0.35rem';

  eigenValues.forEach((v, i) => {
    const t = v / max;
    const [r,g,b] = eigenColorRGB(t);
    const h = Math.max(3, t * 76);
    const bar = document.createElement('div');
    bar.style.cssText =
      `flex:1;background:rgb(${r},${g},${b});border-radius:2px 2px 0 0;height:${h}px;` +
      `min-height:3px;cursor:default;position:relative;overflow:hidden`;
    bar.title = `λ${i + 1} ≈ ${v.toFixed(1)}`;
    if (barW >= 18 && count <= 14) {
      const lbl = document.createElement('span');
      lbl.style.cssText =
        `position:absolute;top:2px;left:0;right:0;text-align:center;` +
        `font-size:6px;color:${contrastColor(r,g,b)};font-weight:600;line-height:1`;
      lbl.textContent = fmtLambda(v);
      bar.appendChild(lbl);
    }
    chart.appendChild(bar);
  });
  eigenViewBody.appendChild(chart);

  const xAxis = document.createElement('div');
  xAxis.style.cssText = 'display:flex;justify-content:space-between;margin-bottom:0.55rem';
  xAxis.innerHTML =
    `<span style="font-size:0.58rem;color:var(--nord4)">k=1</span>` +
    `<span style="font-size:0.58rem;color:var(--nord4)">k=${count}</span>`;
  eigenViewBody.appendChild(xAxis);

  eigenPopupMeta.innerHTML =
    `λ<sub>k</sub> ≈ 4s·sin²(kπ/2N) &nbsp;·&nbsp; s=${guiParams.stiffness} &nbsp;·&nbsp; N=${segs + 1}<br>` +
    `λ<sub>min</sub>=${fmtLambda(eigenValues[0])} &nbsp;·&nbsp; λ<sub>max</sub>=${fmtLambda(eigenValues[count - 1])}`;
}

openEigen.addEventListener('click', () => {
  eigenPopup.hidden = !eigenPopup.hidden;
  openEigen.classList.toggle('active', !eigenPopup.hidden);
  if (!eigenPopup.hidden) {
    if (!eigenPopup.dataset.positioned) {
      eigenPopup.dataset.positioned = '1';
      const btnRect = openEigen.getBoundingClientRect();
      const initH = Math.round(Math.min(520, Math.max(360, window.innerHeight * 0.45)));
      eigenPopup.style.left = `${Math.max(8, btnRect.left)}px`;
      eigenPopup.style.top  = `${Math.max(8, btnRect.top - initH - 12)}px`;
    }
    renderEigenPopup();
  }
});
closeEigen.addEventListener('click', () => {
  eigenPopup.hidden = true;
  openEigen.classList.remove('active');
});

// Drag-to-move via header
let eigenDrag = null;
eigenPopup.querySelector('.eigen-popup-header').addEventListener('mousedown', e => {
  if (e.target.closest('button')) return;
  const rect = eigenPopup.getBoundingClientRect();
  eigenDrag = { ox: e.clientX - rect.left, oy: e.clientY - rect.top };
  e.preventDefault();
});
document.addEventListener('mousemove', e => {
  if (!eigenDrag) return;
  eigenPopup.style.left = `${Math.max(0, Math.min(window.innerWidth  - 60, e.clientX - eigenDrag.ox))}px`;
  eigenPopup.style.top  = `${Math.max(0, Math.min(window.innerHeight - 60, e.clientY - eigenDrag.oy))}px`;
});
document.addEventListener('mouseup', () => { eigenDrag = null; });

document.getElementById('eigen-tabs').addEventListener('click', e => {
  const tab = e.target.closest('.etab[data-etab]');
  if (!tab) return;
  eigenView = tab.dataset.etab;
  eigenPopup.querySelectorAll('.etab').forEach(t => t.classList.toggle('active', t === tab));
  renderEigenPopup();
});

// ── Resize ────────────────────────────────────────────────────────────────────
function resize() {
  const vp = document.getElementById('viewport');
  const w  = vp.clientWidth;
  const h  = vp.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (lineMat) lineMat.resolution.set(w, h);
}
window.addEventListener('resize', resize);
resize();

// ── Animation loop ────────────────────────────────────────────────────────────
let lastTime = 0;
function animate(now = 0) {
  requestAnimationFrame(animate);
  const dt = Math.min((now - lastTime) / 1000, 0.033);
  lastTime = now;

  if (framePrevPos && simState === 'falling') framePrevPos.set(positions);
  stepSimulation(dt);
  if (simState === 'falling') {
    captureVerletSnapshot(dt);
    if (!verletPopup.hidden) renderVerletPopup();
  }
  updateFps(now);
  controls.update();
  renderer.render(scene, camera);
}

// ── Init ──────────────────────────────────────────────────────────────────────
buildCloth(1);
animate();
