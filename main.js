// ============================================================
// Lattice load demo: honeycomb / trabecular structural analysis
// (solver.js + generators.js) plus a static illustrative
// cross-section view (crosssection.js) of the real specimens
// these lattices are modeled after.
//
// LIVE-UPDATE NOTE: solveTruss() is a dense O(n^3) solve (~30ms
// at this lattice size) and lattice regeneration builds a Voronoi
// diagram — neither is free, so instead of running them directly
// inside each GUI onChange (which fires many times per second
// while dragging and would pile up/stall the main thread), every
// slider just sets a "dirty" flag. The render loop checks the
// flags and does at most ONE regenerate/solve per rendered frame.
// That's what makes every control feel live without freezing.
// ============================================================

// ---------- scene setup ----------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0e0f12);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(14, 12, 18);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
document.body.appendChild(renderer.domElement);

const controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const dirLight = new THREE.DirectionalLight(0xffffff, 0.9);
dirLight.position.set(5, 10, 7);
scene.add(dirLight);
const fillLight = new THREE.DirectionalLight(0xaac4ff, 0.35);
fillLight.position.set(-6, 4, -5);
scene.add(fillLight);

const gridHelper = new THREE.GridHelper(20, 20, 0x333333, 0x1c1c1c);
scene.add(gridHelper);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- lattice params ----------
const LATTICE_BOUNDS_X = 8;
const LATTICE_BOUNDS_Z = 6;
const LAYERS = 4;
const LAYER_HEIGHT = 1;

const LOAD_MAX = 20000; // N — top of the load slider, also the color-scale calibration point

const params = {
  view: 'Structural analysis', // 'Structural analysis' | 'Cross-section reference'
  latticeType: 'Honeycomb',    // 'Honeycomb' | 'Trabecular'
  cellSize: 1,
  poreSize: 1,
  loadMagnitude: 5000, // N, total, distributed across top-layer nodes, -Y
};

let nodes = [];
let struts = [];
let loadNodeIndices = [];

// ---------- HUD wiring ----------
const statTypeEl = document.getElementById('stat-type');
const statCountEl = document.getElementById('stat-count');
const statTensionEl = document.getElementById('stat-tension');
const statCompressionEl = document.getElementById('stat-compression');

const infoEl = document.getElementById('info');
infoEl.querySelector('.close').addEventListener('click', () => {
  infoEl.classList.toggle('collapsed');
});

// ---------- shared geometry/material + instanced meshes ----------
// Unit-length cylinder (along +Y), scaled per-instance to each strut's
// actual length/radius — avoids allocating new GPU geometry per strut.
// Thicker + more segments than a plain "stick": these read as real
// structural members, with smooth round joints via matching node spheres.
const STRUT_RADIUS = 0.075;
const UNIT_CYLINDER = new THREE.CylinderGeometry(1, 1, 1, 12);
const strutMaterial = new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.15 });
let strutMesh = null;

const NODE_RADIUS = STRUT_RADIUS * 1.15;
const NODE_GEO = new THREE.SphereGeometry(1, 16, 16);
const nodeMaterial = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.4, metalness: 0.1 });
let nodeMesh = null;

const dummy = new THREE.Object3D();

function rebuildNodeInstances() {
  if (nodeMesh) scene.remove(nodeMesh);
  nodeMesh = new THREE.InstancedMesh(NODE_GEO, nodeMaterial, nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    dummy.position.set(n.x, n.y, n.z);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(NODE_RADIUS, NODE_RADIUS, NODE_RADIUS);
    dummy.updateMatrix();
    nodeMesh.setMatrixAt(i, dummy.matrix);
  }
  nodeMesh.instanceMatrix.needsUpdate = true;
  scene.add(nodeMesh);
}

function rebuildStrutInstances() {
  if (strutMesh) scene.remove(strutMesh);
  strutMesh = new THREE.InstancedMesh(UNIT_CYLINDER, strutMaterial, struts.length);

  const start = new THREE.Vector3();
  const end = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  struts.forEach((s, i) => {
    const ni = nodes[s.a], nj = nodes[s.b];
    start.set(ni.x, ni.y, ni.z);
    end.set(nj.x, nj.y, nj.z);
    dir.subVectors(end, start);
    const len = Math.max(dir.length(), 1e-6);

    dummy.position.copy(start).addScaledVector(dir, 0.5);
    dummy.quaternion.setFromUnitVectors(up, dir.clone().normalize());
    dummy.scale.set(STRUT_RADIUS, len, STRUT_RADIUS);
    dummy.updateMatrix();
    strutMesh.setMatrixAt(i, dummy.matrix);
  });
  strutMesh.instanceMatrix.needsUpdate = true;
  scene.add(strutMesh);
}

function forceToColor(force, maxAbs, target) {
  const t = maxAbs > 1e-9 ? Math.min(Math.abs(force) / maxAbs, 1) : 0;
  if (force >= 0) {
    return target.setRGB(1, 1 - t, 1 - t); // tension -> red
  }
  return target.setRGB(1 - t, 1 - t, 1); // compression -> blue
}

const _color = new THREE.Color();

// Colour scale is calibrated to LOAD_MAX, not to whatever the current
// solve's own max force happens to be. Forces in a linear-elastic truss
// scale linearly with load, so the *relative* pattern between struts is
// identical at 500N and 20000N — normalizing per-solve always pins the
// worst strut to full saturation and makes the load slider look like it
// does nothing to color. Normalizing against a fixed reference (the
// forces produced at the slider's max load) makes low loads render pale
// and high loads render fully saturated, like the load actually matters.
let colorScaleMax = 1e-9;

function calibrateColorScale() {
  const loads = new Map();
  const forcePerNode = -LOAD_MAX / loadNodeIndices.length;
  for (const idx of loadNodeIndices) loads.set(idx, [0, forcePerNode, 0]);
  const { strutForces } = solveTruss(nodes, struts, loads);
  colorScaleMax = Math.max(...strutForces.map((f) => Math.abs(f)), 1e-9);
}

function updateStrutColors(strutForces) {
  for (let i = 0; i < strutForces.length; i++) {
    forceToColor(strutForces[i], colorScaleMax, _color);
    strutMesh.setColorAt(i, _color);
  }
  strutMesh.instanceColor.needsUpdate = true;
}

// ---------- generation ----------
function regenerateLattice() {
  let result;
  if (params.latticeType === 'Trabecular') {
    result = generateTrabecularLattice({
      boundsX: LATTICE_BOUNDS_X,
      boundsZ: LATTICE_BOUNDS_Z,
      poreSize: params.poreSize,
      layers: LAYERS,
      layerHeight: LAYER_HEIGHT,
      DelaunayLib: { Delaunay: d3.Delaunay },
    });
  } else {
    result = generateHoneycombLattice({
      cellSize: params.cellSize,
      boundsX: LATTICE_BOUNDS_X,
      boundsZ: LATTICE_BOUNDS_Z,
      layers: LAYERS,
      layerHeight: LAYER_HEIGHT,
    });
  }

  nodes = result.nodes;
  struts = result.struts;
  loadNodeIndices = result.loadNodeIndices;

  rebuildNodeInstances();
  rebuildStrutInstances();
  calibrateColorScale();

  statTypeEl.textContent = params.latticeType;
  statCountEl.textContent = `${nodes.length} / ${struts.length}`;
}

// ---------- solve ----------
function resolveAndRender() {
  const loads = new Map();
  const forcePerNode = -params.loadMagnitude / loadNodeIndices.length;
  for (const idx of loadNodeIndices) {
    loads.set(idx, [0, forcePerNode, 0]);
  }

  const { strutForces } = solveTruss(nodes, struts, loads);

  const maxAbs = Math.max(...strutForces.map((f) => Math.abs(f)), 0);
  if (!Number.isFinite(maxAbs) || maxAbs === 0) {
    console.warn(
      'solveTruss returned all-zero or non-finite strut forces — ' +
      'check for a planar/under-braced lattice or NaNs in the stiffness matrix.'
    );
  }

  updateStrutColors(strutForces);

  const maxTension = Math.max(0, ...strutForces);
  const maxCompression = Math.abs(Math.min(0, ...strutForces));
  statTensionEl.textContent = `${maxTension.toFixed(0)} N`;
  statCompressionEl.textContent = `${maxCompression.toFixed(0)} N`;
}

// ---------- cross-section (static, illustrative) ----------
let crossSectionGroup = null;
function ensureCrossSectionBuilt() {
  if (crossSectionGroup) return;
  crossSectionGroup = buildCrossSectionDisplay();
  crossSectionGroup.visible = false;
  scene.add(crossSectionGroup);
}

// ---------- view switching ----------
function recenterStructural() {
  controls.target.set(LATTICE_BOUNDS_X / 2, ((LAYERS - 1) * LAYER_HEIGHT) / 2, LATTICE_BOUNDS_Z / 2);
  camera.position.set(LATTICE_BOUNDS_X / 2 + 10, 10, LATTICE_BOUNDS_Z / 2 + 12);
}

function recenterCrossSection() {
  const b = crossSectionGroup.userData.bounds;
  controls.target.set(0, b.height / 2, 0);
  camera.position.set(0.5, b.height * 0.8, Math.max(b.width, 6));
}

function applyView() {
  const structural = params.view === 'Structural analysis';

  if (nodeMesh) nodeMesh.visible = structural;
  if (strutMesh) strutMesh.visible = structural;
  gridHelper.visible = structural;

  structureFolder.show(structural);
  loadFolder.show(structural);
  cellSizeCtrl.show(structural && params.latticeType === 'Honeycomb');
  poreSizeCtrl.show(structural && params.latticeType === 'Trabecular');

  if (structural) {
    if (crossSectionGroup) crossSectionGroup.visible = false;
    recenterStructural();
  } else {
    ensureCrossSectionBuilt();
    crossSectionGroup.visible = true;
    recenterCrossSection();
  }
}

// ---------- throttled live-update pipeline ----------
let regenDirty = false;
let resolveDirty = false;
function requestRegenerate() { regenDirty = true; }
function requestResolve() { resolveDirty = true; }

// ---------- GUI ----------
// On narrow/mobile viewports, start with the controls panel collapsed
// (tap the title bar to expand) and the info box collapsed, so the 3D
// view isn't mostly covered by text on first load.
const isMobile = window.innerWidth < 700;

const gui = new lil.GUI({ title: 'Controls', width: isMobile ? Math.min(260, window.innerWidth - 20) : 300 });
if (isMobile) {
  gui.close();
  infoEl.classList.add('collapsed');
}

const viewFolder = gui.addFolder('View');
viewFolder.add(params, 'view', ['Structural analysis', 'Cross-section reference'])
  .name('Mode')
  .onChange(() => applyView());
viewFolder.add({ reset: () => (params.view === 'Structural analysis' ? recenterStructural() : recenterCrossSection()) }, 'reset')
  .name('Reset camera ⟲');

const structureFolder = gui.addFolder('Structure');
const latticeTypeCtrl = structureFolder.add(params, 'latticeType', ['Honeycomb', 'Trabecular'])
  .name('Lattice type')
  .onChange(() => {
    cellSizeCtrl.show(params.latticeType === 'Honeycomb');
    poreSizeCtrl.show(params.latticeType === 'Trabecular');
    requestRegenerate();
  });

const cellSizeCtrl = structureFolder.add(params, 'cellSize', 0.3, 2.5, 0.05)
  .name('Cell size')
  .onChange(() => requestRegenerate());

const poreSizeCtrl = structureFolder.add(params, 'poreSize', 0.3, 2.5, 0.05)
  .name('Pore size')
  .onChange(() => requestRegenerate());

const loadFolder = gui.addFolder('Load');
const loadCtrl = loadFolder.add(params, 'loadMagnitude', 0, LOAD_MAX, 100)
  .name('Load (N)')
  .onChange(() => requestResolve());

viewFolder.open();
structureFolder.open();
loadFolder.open();

cellSizeCtrl.show(params.latticeType === 'Honeycomb');
poreSizeCtrl.show(params.latticeType === 'Trabecular');

// initial build (after GUI controls exist, since applyView() shows/hides them)
regenerateLattice();
resolveAndRender();
applyView();

// ---------- render loop ----------
function animate() {
  requestAnimationFrame(animate);
  controls.update();

  if (params.view === 'Structural analysis') {
    if (regenDirty) {
      regenDirty = false;
      regenerateLattice();
      resolveAndRender();
    } else if (resolveDirty) {
      resolveDirty = false;
      resolveAndRender();
    }
  }

  renderer.render(scene, camera);
}
animate();
