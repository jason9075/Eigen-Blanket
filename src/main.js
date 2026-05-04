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
const openMath     = document.getElementById('open-math');
const closeMath    = document.getElementById('close-math');
const langToggle   = document.getElementById('language-toggle');
const mathModal    = document.getElementById('math-modal');
const mathContent  = document.getElementById('math-content');
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
  showWireframe: true,
  flatShading:   false,
};

let resolution   = 1;        // segments per axis
let preset       = 'soft';
let simState     = 'idle';   // idle | falling | settled
let useHeatmap   = false;
let modalLang    = 'en';

// Cloth data arrays (rebuilt on resolution change)
let positions    = null;   // Float32Array [x,y,z, ...]
let prevPos      = null;
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

  positions = new Float32Array(N * 3);
  prevPos   = new Float32Array(N * 3);
  pinned    = new Array(N).fill(false);

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

  simState = 'idle';
  updateEigenSpectrum();
  updateStats();
  updateStatusBar('Idle');
}

// ── Verlet integration step ───────────────────────────────────────────────────
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
  const segs = resolution;
  eigenValues = [];
  for (let k = 1; k <= 10; k++) {
    // Mass-spring eigenvalue approx: λ_k ≈ 4·stiffness·sin²(kπ/2N)
    const stiffness = guiParams.stiffness;
    const lam = 4 * stiffness * Math.pow(Math.sin(k * Math.PI / (2 * (segs + 1))), 2);
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
});

btnDrop.addEventListener('click', () => {
  if (simState === 'idle') {
    simState = 'falling';
    updateStatusBar('Falling…');
  }
});

btnJitter.addEventListener('click', () => {
  if (!positions) return;
  simState = 'falling';
  // Impulse: push sphere up slightly, ripple cloth
  sphere.position.y += 0.35;
  setTimeout(() => { sphere.position.y = SPHERE_RADIUS; }, 120);
  for (let i = 0; i < N; i++) {
    if (!pinned[i]) {
      positions[i*3+1] += (Math.random() - 0.3) * 0.25;
      positions[i*3+0] += (Math.random() - 0.5) * 0.05;
      positions[i*3+2] += (Math.random() - 0.5) * 0.05;
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
    <p>Each particle $i$ at position $\\mathbf{x}_i$ is updated as:</p>
    <p>$$\\mathbf{x}_i^{t+\\Delta t} = 2\\mathbf{x}_i^t - \\mathbf{x}_i^{t-\\Delta t} + \\mathbf{a}_i\\,\\Delta t^2$$</p>
    <p>Spring forces between neighbouring particles enforce structural rigidity. Two particles $i$ and $j$ with rest length $L_0$ have a corrective displacement:</p>
    <p>$$\\Delta\\mathbf{x} = \\frac{\\|\\mathbf{d}\\| - L_0}{\\|\\mathbf{d}\\|}\\,\\mathbf{d}\\cdot k$$</p>
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
  `,
  zhTW: `
    <p>這個模擬使用 <strong>Verlet 積分法</strong> 在重力與彈簧約束下推進布料粒子的位置。</p>
    <p>每個粒子 $i$ 在位置 $\\mathbf{x}_i$ 的更新公式為：</p>
    <p>$$\\mathbf{x}_i^{t+\\Delta t} = 2\\mathbf{x}_i^t - \\mathbf{x}_i^{t-\\Delta t} + \\mathbf{a}_i\\,\\Delta t^2$$</p>
    <p>相鄰粒子之間的彈簧力確保布料結構的剛性。靜止長度為 $L_0$ 的粒子對 $(i,j)$ 的位移修正量為：</p>
    <p>$$\\Delta\\mathbf{x} = \\frac{\\|\\mathbf{d}\\| - L_0}{\\|\\mathbf{d}\\|}\\,\\mathbf{d}\\cdot k$$</p>
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

  stepSimulation(dt);
  updateFps(now);
  controls.update();
  renderer.render(scene, camera);
}

// ── Init ──────────────────────────────────────────────────────────────────────
buildCloth(1);
animate();
