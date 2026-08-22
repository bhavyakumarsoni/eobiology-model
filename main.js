// ============================================================
// Lattice load demo: honeycomb / trabecular structural analysis
// (solver.js + generators.js) plus a static illustrative
// cross-section view (crosssection.js) of the real specimens
// these lattices are modeled after.
//
// LIVE-UPDATE NOTE: lattice regeneration (Voronoi build + one sparse
// solveTruss() call) isn't free, so instead of running it directly inside
// the shape-slider onChange (which fires many times per second while
// dragging and would pile up/stall the main thread), those sliders just
// set a "dirty" flag; the render loop does at most ONE regenerate per
// rendered frame. The load slider doesn't even need that: strut forces
// scale linearly with load for a fixed structure, so it's solved once at
// LOAD_MAX per regeneration and every load-slider tick just rescales that
// cached result — no solve at all, so it's exactly as fast at 20,000 N as
// at 0 N, no matter how dense the lattice is.
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

// ---------- load direction indicator ----------
// A translucent highlight over the loaded face (the top layer, where
// generators.js's loadNodeIndices always sit) plus an arrow showing the
// force direction (-Y, i.e. pushing down into that face) and roughly
// scaling with magnitude, so it's visually obvious where and which way
// the load is applied — not just inferable from the color pattern.
const loadFaceHighlight = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1),
  new THREE.MeshBasicMaterial({ color: 0xffcc33, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false })
);
loadFaceHighlight.rotation.x = -Math.PI / 2;
scene.add(loadFaceHighlight);

const loadArrow = new THREE.ArrowHelper(new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 0), 1, 0xffcc33, 0.4, 0.22);
scene.add(loadArrow);

// Ring marker for 'Point' load mode — shows exactly which node the load
// is pinned to (the face highlight only makes sense for the distributed
// top-face load, so it's swapped out for this in point mode).
const pointMarker = new THREE.Mesh(
  new THREE.RingGeometry(0.14, 0.2, 24),
  new THREE.MeshBasicMaterial({ color: 0xffcc33, side: THREE.DoubleSide, transparent: true, opacity: 0.95, depthWrite: false })
);
pointMarker.rotation.x = -Math.PI / 2;
scene.add(pointMarker);

function updateLoadIndicators() {
  // arrow length reacts to load magnitude (1.2 at 0N up to 3.0 at LOAD_MAX)
  // so the indicator itself gives a rough at-a-glance sense of load level.
  const arrowLen = 1.2 + 1.8 * (params.loadMagnitude / LOAD_MAX);

  if (params.loadMode === 'Point' && pointLoadNodeIndex != null && nodes[pointLoadNodeIndex]) {
    const n = nodes[pointLoadNodeIndex];
    pointMarker.position.set(n.x, n.y + 0.01, n.z);
    loadArrow.position.set(n.x, n.y + arrowLen + 0.25, n.z);
  } else {
    const topY = (LAYERS - 1) * LAYER_HEIGHT;
    loadFaceHighlight.scale.set(LATTICE_BOUNDS_X, LATTICE_BOUNDS_Z, 1);
    loadFaceHighlight.position.set(LATTICE_BOUNDS_X / 2, topY + 0.015, LATTICE_BOUNDS_Z / 2);
    loadArrow.position.set(LATTICE_BOUNDS_X / 2, topY + arrowLen + 0.3, LATTICE_BOUNDS_Z / 2);
  }
  loadArrow.setLength(arrowLen, arrowLen * 0.28, arrowLen * 0.16);
}

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
  renderStyle: 'Rods',         // 'Rods' | 'Solid walls' (honeycomb only)
  loadMode: 'Distributed',     // 'Distributed' (whole top face) | 'Point' (single clicked node)
  cellSize: 1,
  poreSize: 1,
  loadMagnitude: 5000, // N, total, -Y
};

let nodes = [];
let struts = [];
let loadNodeIndices = [];
let nodeIncidentStruts = []; // nodeIncidentStruts[nodeIndex] -> array of strut indices touching it
let pointLoadNodeIndex = null; // selected node for 'Point' load mode

// ---------- HUD wiring ----------
const statTypeEl = document.getElementById('stat-type');
const statCountEl = document.getElementById('stat-count');
const statLoadEl = document.getElementById('stat-load');
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
// Pure white base so per-instance colors (set via setColorAt, which
// multiplies against this) come through undistorted.
const nodeMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, metalness: 0.1 });
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

// ---------- honeycomb "solid walls" render style ----------
// Renders the same physics (same struts, same solve) as actual hex cell
// walls instead of rods: one flat panel per 'wall'-role strut (the real
// hexagon edges — see generators.js), skipping the vertical/diagonal
// bracing rods and node spheres entirely, since those aren't part of a
// real honeycomb's visible structure, just the extra members a 3D
// pin-jointed idealization needs for shear stiffness.
const WALL_THICKNESS = 0.06;
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const wallMaterial = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.08 });
let wallMesh = null;
let wallIndices = [];

function rebuildWallInstances() {
  if (wallMesh) scene.remove(wallMesh);
  wallIndices = [];
  for (let i = 0; i < struts.length; i++) {
    if (struts[i].role === 'wall') wallIndices.push(i);
  }
  if (wallIndices.length === 0) {
    wallMesh = null;
    return;
  }

  wallMesh = new THREE.InstancedMesh(UNIT_BOX, wallMaterial, wallIndices.length);

  wallIndices.forEach((si, i) => {
    const s = struts[si];
    const ni = nodes[s.a], nj = nodes[s.b];
    const dx = nj.x - ni.x, dz = nj.z - ni.z;
    const len = Math.max(Math.hypot(dx, dz), 1e-6);
    const angle = Math.atan2(dz, dx);

    dummy.position.set((ni.x + nj.x) / 2, ni.y, (ni.z + nj.z) / 2);
    dummy.rotation.set(0, -angle, 0);
    dummy.scale.set(len, LAYER_HEIGHT, WALL_THICKNESS);
    dummy.updateMatrix();
    wallMesh.setMatrixAt(i, dummy.matrix);
  });
  wallMesh.instanceMatrix.needsUpdate = true;
  scene.add(wallMesh);
}

function updateWallColors(strutForces) {
  if (!wallMesh) return;
  for (let i = 0; i < wallIndices.length; i++) {
    forceToColor(strutForces[wallIndices[i]], colorScaleMax, _color);
    wallMesh.setColorAt(i, _color);
  }
  wallMesh.instanceColor.needsUpdate = true;
}

function forceToColor(force, maxAbs, target) {
  const t = maxAbs > 1e-9 ? Math.min(Math.abs(force) / maxAbs, 1) : 0;
  if (force >= 0) {
    return target.setRGB(1, 1 - t, 1 - t); // tension -> red
  }
  return target.setRGB(1 - t, 1 - t, 1); // compression -> blue
}

const _color = new THREE.Color();

// PERFORMANCE: the load slider used to trigger a full solveTruss() call
// (sparse assembly + CG solve) on every tick. That's wasted work — moving
// the load slider never changes the structure's stiffness, only the
// *magnitude* of the force vector, and for a linear-elastic truss the
// resulting strut forces scale exactly linearly with load. So we solve
// ONCE per lattice regeneration at a reference load (LOAD_MAX) and cache
// it; every load-slider tick after that is just an O(struts) scalar
// multiply of the cached result — no solve, no lag, no matter how dense
// the lattice is. This also doubles as the color-scale calibration
// (colorScaleMax is just the cached reference's own max), so regenerating
// only needs a single solve total instead of two.
let refStrutForces = null;
let colorScaleMax = 1e-9;

function solveReferenceAtMaxLoad() {
  const idxs = activeLoadNodeIndices();
  const loads = new Map();
  const forcePerNode = -LOAD_MAX / idxs.length;
  for (const idx of idxs) loads.set(idx, [0, forcePerNode, 0]);
  const { strutForces } = solveTruss(nodes, struts, loads);
  refStrutForces = strutForces;

  let maxAbs = 1e-9;
  for (let i = 0; i < refStrutForces.length; i++) {
    const a = Math.abs(refStrutForces[i]);
    if (a > maxAbs) maxAbs = a;
  }
  colorScaleMax = maxAbs;

  refNodeIntensity = new Float64Array(nodes.length);
  for (let ni = 0; ni < nodes.length; ni++) {
    let sum = 0;
    for (const si of nodeIncidentStruts[ni]) sum += Math.abs(refStrutForces[si]);
    refNodeIntensity[ni] = sum;
  }
  let maxNode = 1e-9;
  for (let i = 0; i < refNodeIntensity.length; i++) {
    if (refNodeIntensity[i] > maxNode) maxNode = refNodeIntensity[i];
  }
  nodeColorScaleMax = maxNode;
}

function updateStrutColors(strutForces) {
  for (let i = 0; i < strutForces.length; i++) {
    forceToColor(strutForces[i], colorScaleMax, _color);
    strutMesh.setColorAt(i, _color);
  }
  strutMesh.instanceColor.needsUpdate = true;
}

// ---------- node "weight distribution" coloring ----------
// A node doesn't have its own tension/compression the way a strut does —
// it's just a joint. What we can show is how much force is passing
// through that joint: the sum of |force| over every strut incident to
// it. White = ~0 (barely loaded), amber = heavily loaded, on the same
// LOAD_MAX-calibrated + linear-rescale scheme as the struts/walls, so
// dragging the load slider updates node color live with no extra solve.
let refNodeIntensity = null;
let nodeColorScaleMax = 1e-9;

function intensityToColor(intensity, maxIntensity, target) {
  const t = maxIntensity > 1e-9 ? Math.min(intensity / maxIntensity, 1) : 0;
  return target.setRGB(1, 1 - 0.55 * t, 1 - 0.85 * t); // white -> amber
}

function updateNodeColors(nodeIntensity) {
  if (!nodeMesh) return;
  for (let i = 0; i < nodeIntensity.length; i++) {
    intensityToColor(nodeIntensity[i], nodeColorScaleMax, _color);
    nodeMesh.setColorAt(i, _color);
  }
  nodeMesh.instanceColor.needsUpdate = true;
}

function buildIncidence() {
  nodeIncidentStruts = Array.from({ length: nodes.length }, () => []);
  struts.forEach((s, i) => {
    nodeIncidentStruts[s.a].push(i);
    nodeIncidentStruts[s.b].push(i);
  });
}

// which node(s) the load is actually applied to right now
function activeLoadNodeIndices() {
  return params.loadMode === 'Point' && pointLoadNodeIndex != null
    ? [pointLoadNodeIndex]
    : loadNodeIndices;
}

// default point-load target: the top-face node closest to the center,
// so switching into Point mode (or regenerating while in it) never
// leaves pointLoadNodeIndex pointing at a node that no longer exists
function pickDefaultPointLoadNode() {
  const cx = LATTICE_BOUNDS_X / 2, cz = LATTICE_BOUNDS_Z / 2;
  let best = loadNodeIndices[0], bestD = Infinity;
  for (const idx of loadNodeIndices) {
    const n = nodes[idx];
    const d = (n.x - cx) ** 2 + (n.z - cz) ** 2;
    if (d < bestD) { bestD = d; best = idx; }
  }
  return best;
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
  pointLoadNodeIndex = pickDefaultPointLoadNode();

  rebuildNodeInstances();
  rebuildStrutInstances();
  rebuildWallInstances();
  buildIncidence();
  solveReferenceAtMaxLoad();
  applyRenderStyle();

  if (!Number.isFinite(colorScaleMax) || colorScaleMax <= 1e-9) {
    console.warn(
      'solveTruss returned all-zero or non-finite strut forces — ' +
      'check for a planar/under-braced lattice or NaNs in the stiffness matrix.'
    );
  }

  statTypeEl.textContent = params.latticeType;
  statCountEl.textContent = `${nodes.length} / ${struts.length}`;
}

// ---------- render current load (no solve — scales the cached reference) ----------
function resolveAndRender() {
  const scale = params.loadMagnitude / LOAD_MAX;
  const strutForces = new Float64Array(refStrutForces.length);

  let maxTension = 0;
  let maxCompression = 0;
  for (let i = 0; i < strutForces.length; i++) {
    const f = refStrutForces[i] * scale;
    strutForces[i] = f;
    if (f > maxTension) maxTension = f;
    if (-f > maxCompression) maxCompression = -f;
  }

  const nodeIntensity = new Float64Array(refNodeIntensity.length);
  for (let i = 0; i < nodeIntensity.length; i++) nodeIntensity[i] = refNodeIntensity[i] * scale;

  updateStrutColors(strutForces);
  updateWallColors(strutForces);
  updateNodeColors(nodeIntensity);
  updateLoadIndicators();

  const where = params.loadMode === 'Point' && pointLoadNodeIndex != null
    ? `node #${pointLoadNodeIndex}`
    : 'top face';
  statLoadEl.textContent = `${params.loadMagnitude.toFixed(0)} N ↓ (${where})`;
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

// 'Solid walls' is a honeycomb-only rendering choice: same physics, same
// solve, just draws the hexagon-edge ('wall'-role) struts as flat panels
// and hides the vertical/diagonal bracing rods + node spheres, since
// those aren't part of what a real honeycomb cell looks like.
function applyRenderStyle() {
  const structural = params.view === 'Structural analysis';
  const wallsMode = structural && params.latticeType === 'Honeycomb' && params.renderStyle === 'Solid walls';

  if (nodeMesh) nodeMesh.visible = structural && !wallsMode;
  if (strutMesh) strutMesh.visible = structural && !wallsMode;
  if (wallMesh) wallMesh.visible = wallsMode;

  gridHelper.visible = structural;
  const pointMode = structural && params.loadMode === 'Point';
  loadFaceHighlight.visible = structural && !pointMode;
  pointMarker.visible = pointMode;
  loadArrow.visible = structural;
}

function applyView() {
  const structural = params.view === 'Structural analysis';

  applyRenderStyle();
  updatePointHint();

  structureFolder.show(structural);
  loadFolder.show(structural);
  cellSizeCtrl.show(structural && params.latticeType === 'Honeycomb');
  poreSizeCtrl.show(structural && params.latticeType === 'Trabecular');
  renderStyleCtrl.show(structural && params.latticeType === 'Honeycomb');

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
    renderStyleCtrl.show(params.latticeType === 'Honeycomb');
    requestRegenerate();
  });

const renderStyleCtrl = structureFolder.add(params, 'renderStyle', ['Rods', 'Solid walls'])
  .name('Render style')
  .onChange(() => applyRenderStyle());

const cellSizeCtrl = structureFolder.add(params, 'cellSize', 0.3, 2.5, 0.05)
  .name('Cell size')
  .onChange(() => requestRegenerate());

const poreSizeCtrl = structureFolder.add(params, 'poreSize', 0.3, 2.5, 0.05)
  .name('Pore size')
  .onChange(() => requestRegenerate());

const loadFolder = gui.addFolder('Load');
const loadModeCtrl = loadFolder.add(params, 'loadMode', ['Distributed', 'Point'])
  .name('Load placement')
  .onChange(() => {
    // switching load pattern changes the force vector's shape, not just
    // its magnitude, so this needs a real resolve (still just one solve,
    // not a per-frame cost) rather than the load-slider's free rescale.
    solveReferenceAtMaxLoad();
    resolveAndRender();
    applyRenderStyle();
    updatePointHint();
  });

const loadCtrl = loadFolder.add(params, 'loadMagnitude', 0, LOAD_MAX, 100)
  .name('Load (N)')
  .onChange(() => requestResolve());

viewFolder.open();
structureFolder.open();
loadFolder.open();

// ---------- click-to-place point load ----------
const pointHintEl = document.getElementById('point-hint');
function updatePointHint() {
  const active = params.view === 'Structural analysis' && params.loadMode === 'Point';
  pointHintEl.style.display = active ? 'block' : 'none';
}

const raycaster = new THREE.Raycaster();
const pointerNDC = new THREE.Vector2();
let pointerDownPos = null;

renderer.domElement.addEventListener('pointerdown', (e) => {
  pointerDownPos = { x: e.clientX, y: e.clientY };
});

renderer.domElement.addEventListener('pointerup', (e) => {
  const down = pointerDownPos;
  pointerDownPos = null;
  if (!down) return;
  // ignore drags (orbit/pan) — only treat as a click if the pointer barely moved
  if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return;
  if (params.view !== 'Structural analysis' || params.loadMode !== 'Point' || !nodeMesh) return;

  const rect = renderer.domElement.getBoundingClientRect();
  pointerNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointerNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointerNDC, camera);

  const hits = raycaster.intersectObject(nodeMesh);
  if (hits.length === 0 || hits[0].instanceId == null) return;

  const idx = hits[0].instanceId;
  const fixed = nodes[idx].fixed;
  if (fixed && fixed[0] && fixed[1] && fixed[2]) return; // can't usefully load a fixed support node

  pointLoadNodeIndex = idx;
  solveReferenceAtMaxLoad();
  resolveAndRender();
});

cellSizeCtrl.show(params.latticeType === 'Honeycomb');
poreSizeCtrl.show(params.latticeType === 'Trabecular');
renderStyleCtrl.show(params.latticeType === 'Honeycomb');

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
