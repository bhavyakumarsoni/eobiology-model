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
  simMode: 'Static Load',      // 'Static Load' | 'Impact Test' (within Structural analysis)
  latticeType: 'Honeycomb',    // 'Honeycomb' | 'Trabecular'
  renderStyle: 'Rods',         // 'Rods' | 'Solid walls' (honeycomb only)
  loadMode: 'Distributed',     // 'Distributed' (whole top face) | 'Point' (single clicked node)
  cellSize: 1,
  poreSize: 1,
  loadMagnitude: 5000, // N, total, -Y
  impactVelocity: 10,          // 0-20, arbitrary units
};

let nodes = [];
let struts = [];
let loadNodeIndices = [];
let nodeIncidentStruts = []; // nodeIncidentStruts[nodeIndex] -> array of strut indices touching it
let pointLoadNodeIndex = null; // selected node for 'Point' load mode
let adjacency = []; // adjacency[nodeIndex] -> array of neighbor node indices (for Impact Test's BFS)

// ---------- HUD wiring ----------
const statTypeEl = document.getElementById('stat-type');
const statCountEl = document.getElementById('stat-count');
const statLoadEl = document.getElementById('stat-load');
const statTensionEl = document.getElementById('stat-tension');
const statCompressionEl = document.getElementById('stat-compression');

const legendEl = document.getElementById('legend');
const impactLegendEl = document.getElementById('impact-legend');
const impactBarEl = document.getElementById('impact-bar');

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

// Each strut's rest transform, captured once here — Impact Test's shake
// effect perturbs a strut's position slightly and needs to know what
// "rest" is in order to spring back to it.
let strutBaseTransforms = [];

function rebuildStrutInstances() {
  if (strutMesh) scene.remove(strutMesh);
  strutMesh = new THREE.InstancedMesh(UNIT_CYLINDER, strutMaterial, struts.length);
  strutBaseTransforms = new Array(struts.length);

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

    strutBaseTransforms[i] = {
      px: dummy.position.x, py: dummy.position.y, pz: dummy.position.z,
      qx: dummy.quaternion.x, qy: dummy.quaternion.y, qz: dummy.quaternion.z, qw: dummy.quaternion.w,
      len,
    };
  });
  strutMesh.instanceMatrix.needsUpdate = true;
  scene.add(strutMesh);
}

// ---------- "solid walls" render style ----------
// Renders the same physics (same struts, same solve) as actual cell
// walls instead of rods: one flat panel per real wall edge, skipping
// the vertical/diagonal bracing rods and node spheres entirely, since
// those aren't part of a real cell's visible structure, just the extra
// members a 3D pin-jointed idealization needs for shear stiffness.
//
// extrudeLayers() tags every in-layer edge 'wall' uniformly — it has no
// per-shape knowledge, so for Square that set also includes the
// diagonal shear-bracing strut (length ~= side*sqrt(2)), and for Circle
// it also includes the inter-ring connector struts. Neither is a real
// wall, and rendering them as solid panels would show a false diagonal
// slicing through every square cell / stray bridge panels between
// circles instead of a clean ring.
//
// For Square, the diagonal is reliably the LONGEST 'wall'-tagged edge
// (side = cellSize, diagonal = cellSize*sqrt(2)), so keeping only the
// shortest-length group works and is shape-agnostic.
//
// Circle needed a real bug fix here: its inter-ring connector edges
// don't have a consistent length (angular discretization from
// ringSegments=12 means the "closest ring node" to a neighbor isn't
// always well-aligned, so connectors range anywhere from ~0.14x to
// ~0.9x cellSize) and can be LONGER than the true ring-segment edges,
// not shorter — so the old "keep the shortest edges" rule actually kept
// the connectors and threw away the real ring walls. Fixed by matching
// against the ring segment's own known chord-length formula instead
// (mirrors how generateTriangleLattice classifies its own edges by
// expected length ± tolerance) — ringSegments/radius here must match
// generateCircleLattice()'s defaults.
const WALL_THICKNESS = 0.06;
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const wallMaterial = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.08 });
let wallMesh = null;
let wallIndices = [];

function circleRingSegmentLength(cellSize) {
  const ringSegments = 12; // must match generateCircleLattice()'s default
  const spacing = cellSize * Math.sqrt(3);
  const radius = spacing * 0.46;
  return 2 * radius * Math.sin(Math.PI / ringSegments);
}

function rebuildWallInstances() {
  if (wallMesh) scene.remove(wallMesh);
  wallIndices = [];
  for (let i = 0; i < struts.length; i++) {
    if (struts[i].role === 'wall') wallIndices.push(i);
  }

  if (wallIndices.length > 0 && params.latticeType === 'Circle') {
    const target = circleRingSegmentLength(params.cellSize);
    const tol = target * 0.2;
    wallIndices = wallIndices.filter((si) => {
      const s = struts[si];
      const ni = nodes[s.a], nj = nodes[s.b];
      const len = Math.hypot(nj.x - ni.x, nj.z - ni.z);
      return Math.abs(len - target) <= tol;
    });
  } else if (wallIndices.length > 0) {
    let minLen = Infinity;
    for (const si of wallIndices) {
      const s = struts[si];
      const ni = nodes[s.a], nj = nodes[s.b];
      const len = Math.hypot(nj.x - ni.x, nj.z - ni.z);
      if (len < minLen) minLen = len;
    }
    const cutoff = minLen * 1.2;
    wallIndices = wallIndices.filter((si) => {
      const s = struts[si];
      const ni = nodes[s.a], nj = nodes[s.b];
      return Math.hypot(nj.x - ni.x, nj.z - ni.z) <= cutoff;
    });
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

// ---------- Impact Test ----------
// Simplified propagation model based on strut connectivity and
// hop-distance from the impact point, scaled by velocity — not a full
// dynamic/explicit-time-integration simulation. It's a visual "how far
// would a shock plausibly spread through this connectivity" sketch, not
// a physically simulated impact. The "movement" of the rods during the
// strike is a cosmetic per-strut shake as the reveal wavefront passes
// through them, not a physical deformation solve either.
const IMPACT_BASE_COLORS = { Honeycomb: 0xd7a15c, Trabecular: 0xe6dcc6 };
const IMPACTOR_GEOMETRY = new THREE.SphereGeometry(0.35, 16, 16); // always a ball — no shape selection
const IMPACTOR_STANDOFF = 0.9; // resting distance from the impact node, along the strike direction
const IMPACTOR_TOUCH_STANDOFF = 0.15; // distance from the node at moment of contact
const IMPACT_ANIM_DURATION = 300; // ms, cosmetic down/up strike tween
const HOP_DURATION_MS = 90; // ms per hop of the propagating reveal wave
const JITTER_TAIL_HOPS = 1.2; // extra hops the shake gets to settle before the impactor lifts off

const impactorMaterial = new THREE.MeshStandardMaterial({ color: 0x8fd6ff, roughness: 0.3, metalness: 0.25 });
const impactorMesh = new THREE.Mesh(IMPACTOR_GEOMETRY, impactorMaterial);
scene.add(impactorMesh);

// Positions the impactor just outside the given node, offset along the
// direction from the structure's center to that node — click a top node
// and it strikes from above; click a side node and it strikes from the
// side. That radial offset IS the "direction of impact" control.
const impactRestPos = new THREE.Vector3();
const impactTouchPos = new THREE.Vector3();
function positionImpactorAtNode(nodeIndex) {
  const n = nodes[nodeIndex];
  const cx = LATTICE_BOUNDS_X / 2, cz = LATTICE_BOUNDS_Z / 2, cy = ((LAYERS - 1) * LAYER_HEIGHT) / 2;
  const dir = new THREE.Vector3(n.x - cx, n.y - cy, n.z - cz);
  if (dir.lengthSq() < 1e-6) dir.set(0, 1, 0); // dead-center node: fall back to striking from above
  dir.normalize();

  impactRestPos.set(n.x + dir.x * IMPACTOR_STANDOFF, n.y + dir.y * IMPACTOR_STANDOFF, n.z + dir.z * IMPACTOR_STANDOFF);
  impactTouchPos.set(n.x + dir.x * IMPACTOR_TOUCH_STANDOFF, n.y + dir.y * IMPACTOR_TOUCH_STANDOFF, n.z + dir.z * IMPACTOR_TOUCH_STANDOFF);
  impactorMesh.position.copy(impactRestPos);
}

function buildAdjacency() {
  adjacency = Array.from({ length: nodes.length }, () => []);
  for (const s of struts) {
    adjacency[s.a].push(s.b);
    adjacency[s.b].push(s.a);
  }
}

function bfsHopDistances(startNode) {
  const hopDist = new Int32Array(nodes.length).fill(-1);
  hopDist[startNode] = 0;
  const queue = [startNode];
  let qi = 0;
  while (qi < queue.length) {
    const u = queue[qi++];
    for (const v of adjacency[u]) {
      if (hopDist[v] === -1) {
        hopDist[v] = hopDist[u] + 1;
        queue.push(v);
      }
    }
  }
  return hopDist;
}

let impactOriginNode = null; // which node the impactor is currently aimed at
let impactHopDist = null;
let impactRadius = 0;
let impactActive = false;
let strutRevealHop = null; // cached per strike: max(hopDist[a], hopDist[b]) per strut, or -1 if unreached
let pendingImpactHopDist = null;
let pendingImpactRadius = 0;
let impactAnimPhase = null; // 'down' | 'propagate' | 'up' | null
let impactAnimStart = 0;

// t in [0,1]: 0 = base material color (edge of / outside the affected
// radius), 1 = white-hot impact center — a distinct ramp from the
// Static Load mode's red/blue so the two are never ambiguous.
const _impactBase = new THREE.Color();
const _impactOrange = new THREE.Color(0xff6a1a);
const _impactWhite = new THREE.Color(0xffffff);
function impactColorAt(t, target) {
  if (t <= 0) return target.copy(_impactBase);
  if (t < 0.5) return target.copy(_impactBase).lerp(_impactOrange, t / 0.5);
  return target.copy(_impactOrange).lerp(_impactWhite, (t - 0.5) / 0.5);
}

// Builds the legend's gradient directly from the same numeric colors the
// Three.js material uses (not a hand-picked CSS approximation), so it
// can never drift out of sync with what's actually on screen — including
// the base-material end, which depends on the current lattice type.
function hexToCss(hex) {
  return '#' + hex.toString(16).padStart(6, '0');
}
function updateImpactLegend() {
  const baseHex = IMPACT_BASE_COLORS[params.latticeType] ?? 0xffffff;
  impactBarEl.style.background =
    `linear-gradient(to right, ${hexToCss(_impactWhite.getHex())}, ${hexToCss(_impactOrange.getHex())}, ${hexToCss(baseHex)})`;
}

// revealHop caps how far the wavefront has traveled so far (Infinity =
// fully settled/final state); anything beyond it hasn't "arrived" yet.
function impactIntensityAtNode(nodeIndex, revealHop) {
  if (!impactActive || impactRadius <= 0 || !impactHopDist) return 0;
  const h = impactHopDist[nodeIndex];
  if (h === -1 || h > impactRadius || h > revealHop) return 0;
  return 1 - h / impactRadius;
}

function impactStrutColor(strutIndex, target, revealHop) {
  let t = 0;
  if (impactActive && impactRadius > 0 && strutRevealHop) {
    const h = strutRevealHop[strutIndex];
    if (h !== -1 && h <= impactRadius && h <= revealHop) t = 1 - h / impactRadius;
  }
  return impactColorAt(t, target);
}

function updateImpactColors(revealHop = Infinity) {
  _impactBase.set(IMPACT_BASE_COLORS[params.latticeType] || 0xffffff);

  if (strutMesh) {
    for (let i = 0; i < struts.length; i++) {
      impactStrutColor(i, _color, revealHop);
      strutMesh.setColorAt(i, _color);
    }
    strutMesh.instanceColor.needsUpdate = true;
  }
  if (wallMesh) {
    for (let i = 0; i < wallIndices.length; i++) {
      impactStrutColor(wallIndices[i], _color, revealHop);
      wallMesh.setColorAt(i, _color);
    }
    wallMesh.instanceColor.needsUpdate = true;
  }
  if (nodeMesh) {
    for (let i = 0; i < nodes.length; i++) {
      impactColorAt(impactIntensityAtNode(i, revealHop), _color);
      nodeMesh.setColorAt(i, _color);
    }
    nodeMesh.instanceColor.needsUpdate = true;
  }
}

function cacheStrutRevealHops() {
  strutRevealHop = new Int32Array(struts.length);
  for (let i = 0; i < struts.length; i++) {
    const s = struts[i];
    const ha = impactHopDist[s.a], hb = impactHopDist[s.b];
    strutRevealHop[i] = (ha === -1 || hb === -1) ? -1 : Math.max(ha, hb);
  }
}

// "Movement of the rods": a small shake on struts near the wavefront as
// it passes through them, decaying quickly behind the front, springing
// back to their exact rest transform once it's moved on.
const JITTER_AMPLITUDE = 0.035;
const JITTER_BAND = 1.2; // hops of trailing shake behind the front
const _jitterVec = new THREE.Vector3();

function setStrutInstanceTransform(i, jitterOffset) {
  const bt = strutBaseTransforms[i];
  dummy.position.set(bt.px, bt.py, bt.pz);
  if (jitterOffset) dummy.position.add(jitterOffset);
  dummy.quaternion.set(bt.qx, bt.qy, bt.qz, bt.qw);
  dummy.scale.set(STRUT_RADIUS, bt.len, STRUT_RADIUS);
  dummy.updateMatrix();
  strutMesh.setMatrixAt(i, dummy.matrix);
}

function applyStrutJitter(currentHop) {
  if (!strutRevealHop || !strutMesh) return;
  const tSec = performance.now() * 0.02;
  for (let i = 0; i < struts.length; i++) {
    const h = strutRevealHop[i];
    if (h === -1 || h > impactRadius) continue; // never touched by this strike — leave at rest
    const behind = currentHop - h;
    if (behind < 0 || behind > JITTER_BAND) {
      setStrutInstanceTransform(i, null); // not reached yet, or shake has settled — rest transform
    } else {
      const amp = JITTER_AMPLITUDE * (1 - behind / JITTER_BAND);
      const seed = i * 12.9898;
      _jitterVec.set(
        Math.sin(tSec + seed) * amp,
        Math.sin(tSec * 1.3 + seed) * amp * 0.6,
        Math.cos(tSec + seed) * amp
      );
      setStrutInstanceTransform(i, _jitterVec);
    }
  }
  strutMesh.instanceMatrix.needsUpdate = true;
}

function resetStrutJitter() {
  if (!strutMesh || strutBaseTransforms.length !== struts.length) return;
  for (let i = 0; i < struts.length; i++) setStrutInstanceTransform(i, null);
  strutMesh.instanceMatrix.needsUpdate = true;
}

function strikeImpact() {
  if (params.simMode !== 'Impact Test' || impactAnimPhase || impactOriginNode == null) return;

  pendingImpactHopDist = bfsHopDistances(impactOriginNode);
  pendingImpactRadius = Math.ceil(params.impactVelocity / 2); // 0-20 velocity -> 0-10 hops

  impactAnimPhase = 'down';
  impactAnimStart = performance.now();
}

function resetImpact() {
  impactAnimPhase = null;
  impactActive = false;
  impactHopDist = null;
  strutRevealHop = null;
  resetStrutJitter();
  if (impactOriginNode != null) positionImpactorAtNode(impactOriginNode);
  updateImpactColors();
}

// Called whenever Impact Test stops being the active mode (view switch,
// or switching back to Static Load) — a mid-flight strike's jitter is a
// direct matrix/position perturbation, not just a color, so it has to be
// explicitly stopped or it keeps wobbling struts that Static Load is now
// trying to show with force-based coloring.
function cancelImpactAnimation() {
  if (!impactAnimPhase) return;
  resetStrutJitter();
  if (impactOriginNode != null) positionImpactorAtNode(impactOriginNode);
  impactAnimPhase = null;
  if (impactActive) updateImpactColors(); // land on a clean final state, not a half-revealed one
}

function updateImpactAnimation() {
  if (!impactAnimPhase) return;
  const now = performance.now();
  const elapsed = now - impactAnimStart;

  if (impactAnimPhase === 'down') {
    const t = Math.min(elapsed / IMPACT_ANIM_DURATION, 1);
    impactorMesh.position.lerpVectors(impactRestPos, impactTouchPos, t);
    if (t >= 1) {
      impactHopDist = pendingImpactHopDist;
      impactRadius = pendingImpactRadius;
      impactActive = true;
      cacheStrutRevealHops();

      impactAnimPhase = impactRadius > 0 ? 'propagate' : 'up';
      if (impactRadius <= 0) updateImpactColors(); // 0-velocity strike: nothing to reveal
      impactAnimStart = now;
    }
  } else if (impactAnimPhase === 'propagate') {
    const currentHop = elapsed / HOP_DURATION_MS;
    updateImpactColors(currentHop);
    applyStrutJitter(currentHop);
    if (currentHop >= impactRadius + JITTER_TAIL_HOPS) {
      resetStrutJitter();
      updateImpactColors(); // exact final full-reveal state, no float rounding gaps
      impactAnimPhase = 'up';
      impactAnimStart = now;
    }
  } else if (impactAnimPhase === 'up') {
    const t = Math.min(elapsed / IMPACT_ANIM_DURATION, 1);
    impactorMesh.position.lerpVectors(impactTouchPos, impactRestPos, t);
    if (t >= 1) impactAnimPhase = null;
  }
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

// ---------- tiling comparison (Honeycomb / Triangle / Square / Circle) ----------
// Triangle, square, and hexagon can all tile a flat plane with zero
// gaps; circles cannot (packed circles always leave gaps between them).
// Among the three tiling shapes, hexagon is mathematically proven (the
// Honeycomb Conjecture, Thomas Hales, 1999) to need the least total
// wall material to enclose a given area. That's the claim being shown
// here — NOT that hexagon wins every structural metric in isolation.
//
// The "wall material per unit area" numbers are measured directly off
// one real interior cell of each shape's actual generated 2D pattern
// at the current cell size (not a hardcoded formula): a standard
// planar-graph face-tracing walk finds one real polygon, its perimeter
// and area are measured from real node positions, and each wall is
// charged at half its length (since in a real tiling every interior
// wall is shared by the two cells on either side of it).
const tilingPanelEl = document.getElementById('tiling-panel');
const tilingCompareEl = document.getElementById('tiling-compare');
const tilingCircleNoteEl = document.getElementById('tiling-circle-note');

// Traces the small polygon bordering directed edge (startA -> startB) by
// repeatedly taking, at each vertex, the next edge in consistent
// rotational order — the standard technique for extracting one face
// from a planar straight-line graph.
function traceFace(nodes2D, adj, startA, startB) {
  const path = [startA, startB];
  let prev = startA, curr = startB;
  const maxSteps = 12; // generous — real cells here have 3-6 sides
  for (let step = 0; step < maxSteps; step++) {
    const backAngle = Math.atan2(nodes2D[prev].z - nodes2D[curr].z, nodes2D[prev].x - nodes2D[curr].x);
    let best = -1, bestDelta = Infinity;
    for (const w of adj[curr]) {
      if (w === prev) continue;
      const angle = Math.atan2(nodes2D[w].z - nodes2D[curr].z, nodes2D[w].x - nodes2D[curr].x);
      let delta = backAngle - angle;
      delta = ((delta % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      if (delta < bestDelta) { bestDelta = delta; best = w; }
    }
    if (best === -1) return null; // dead end — hit the pattern's boundary
    prev = curr;
    curr = best;
    path.push(curr);
    if (curr === startA) return path; // closed the loop
  }
  return null;
}

function measureFace(faceIndices, nodes2D) {
  const pts = faceIndices[0] === faceIndices[faceIndices.length - 1] ? faceIndices.slice(0, -1) : faceIndices;
  const n = pts.length;
  let perimeter = 0;
  for (let i = 0; i < n; i++) {
    const a = nodes2D[pts[i]], b = nodes2D[pts[(i + 1) % n]];
    perimeter += Math.hypot(a.x - b.x, a.z - b.z);
  }
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const a = nodes2D[pts[i]], b = nodes2D[pts[(i + 1) % n]];
    area2 += a.x * b.z - b.x * a.z;
  }
  const area = Math.abs(area2) / 2;
  if (area < 1e-9) return null;
  return { perimeter, area, materialPerArea: (perimeter / 2) / area, sides: n };
}

// Generates a throwaway single-layer (2D-only) copy of the pattern at
// the given cell size purely to measure it — separate from whichever
// shape is actually selected for 3D display, so all three numbers stay
// live regardless of which one you're currently looking at.
function computeTilingStat(generatorFn, cellSize, excludeDiagonals) {
  const { nodes: n2, struts: s2 } = generatorFn({
    cellSize, boundsX: LATTICE_BOUNDS_X, boundsZ: LATTICE_BOUNDS_Z, layers: 1, layerHeight: LAYER_HEIGHT,
  });
  if (n2.length < 4) return null; // too sparse at this cell size to have an interior cell

  // Square's grid includes one shear-bracing diagonal per cell (see
  // generators.js) — that's a structural member, not a tiling wall, so
  // it has to be excluded here. It's reliably the longer edge (side
  // length vs. side*sqrt(2)), so a length-ratio cutoff separates them
  // regardless of what cellSize the user has dragged to.
  let edges = s2.map((s) => {
    const a = n2[s.a], b = n2[s.b];
    return { a: s.a, b: s.b, len: Math.hypot(a.x - b.x, a.z - b.z) };
  });
  if (excludeDiagonals && edges.length) {
    const minLen = Math.min(...edges.map((e) => e.len));
    edges = edges.filter((e) => e.len <= minLen * 1.2);
  }

  const adj = Array.from({ length: n2.length }, () => []);
  for (const e of edges) { adj[e.a].push(e.b); adj[e.b].push(e.a); }

  let cx = 0, cz = 0;
  for (const n of n2) { cx += n.x; cz += n.z; }
  cx /= n2.length; cz /= n2.length;
  const byDist = n2
    .map((n, i) => ({ i, d: (n.x - cx) ** 2 + (n.z - cz) ** 2 }))
    .sort((a, b) => a.d - b.d);

  // try candidate interior starting points until one traces a clean
  // small closed face (guards against picking a boundary-adjacent node
  // whose trace runs off the edge of the generated patch)
  for (const { i: start } of byDist.slice(0, 15)) {
    for (const nb of adj[start]) {
      const face = traceFace(n2, adj, start, nb);
      if (face && face.length >= 3 && face.length <= 8) {
        const m = measureFace(face, n2);
        if (m) return m;
      }
    }
  }
  return null;
}

function updateTilingPanel() {
  const structural = params.view === 'Structural analysis';
  const staticMode = structural && params.simMode === 'Static Load';
  const isTilingShape = ['Honeycomb', 'Triangle', 'Square'].includes(params.latticeType);
  const isCircle = params.latticeType === 'Circle';

  tilingPanelEl.style.display = staticMode && (isTilingShape || isCircle) ? 'block' : 'none';
  tilingCompareEl.style.display = isTilingShape ? 'block' : 'none';
  tilingCircleNoteEl.style.display = isCircle ? 'block' : 'none';
  if (!staticMode || !(isTilingShape || isCircle)) return;

  if (isTilingShape) {
    const hex = computeTilingStat(generateHoneycombLattice, params.cellSize, false);
    const tri = computeTilingStat(generateTriangleLattice, params.cellSize, false);
    const sq = computeTilingStat(generateSquareLattice, params.cellSize, true);
    document.getElementById('tiling-hex').textContent = hex ? hex.materialPerArea.toFixed(3) : '—';
    document.getElementById('tiling-tri').textContent = tri ? tri.materialPerArea.toFixed(3) : '—';
    document.getElementById('tiling-sq').textContent = sq ? sq.materialPerArea.toFixed(3) : '—';
  }
}

// ---------- Circle "gaps are unavoidable" overlay ----------
// A reddish base plane under solid disks at each circle's center —
// wherever circles don't quite meet, the red shows through, making the
// unavoidable tiling gaps visible rather than just asserted in text.
// Centers use the same grid formula generateCircleLattice() itself
// uses internally (this is a presentation-only overlay, not one of the
// measured comparison numbers, so recomputing that placement is fine).
let circleGapGroup = null;
function ensureCircleGapGroup() {
  if (circleGapGroup) return;
  circleGapGroup = new THREE.Group();
  const gapPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ color: 0xff3b3b, transparent: true, opacity: 0.55, side: THREE.DoubleSide })
  );
  gapPlane.rotation.x = -Math.PI / 2;
  gapPlane.name = 'gapPlane';
  circleGapGroup.add(gapPlane);

  const disksMesh = new THREE.InstancedMesh(
    new THREE.CircleGeometry(1, 24),
    new THREE.MeshStandardMaterial({ color: 0xb8bec7, roughness: 0.6, metalness: 0.05, side: THREE.DoubleSide }),
    1 // resized in updateCircleGapOverlay()
  );
  disksMesh.name = 'disksMesh';
  circleGapGroup.add(disksMesh);
  scene.add(circleGapGroup);
}

function updateCircleGapOverlay() {
  const showCircleOverlay = params.view === 'Structural analysis' && params.simMode === 'Static Load' && params.latticeType === 'Circle';
  if (!showCircleOverlay) {
    if (circleGapGroup) circleGapGroup.visible = false;
    return;
  }
  ensureCircleGapGroup();
  circleGapGroup.visible = true;

  const cellSize = params.cellSize;
  const cols = Math.max(2, Math.round(LATTICE_BOUNDS_X / (1.5 * cellSize)));
  const rows = Math.max(2, Math.round(LATTICE_BOUNDS_Z / (Math.sqrt(3) * cellSize)));
  const centers = [];
  for (let q = 0; q <= cols; q++) {
    for (let r = 0; r <= rows; r++) {
      centers.push({
        x: 1.5 * cellSize * q,
        z: Math.sqrt(3) * cellSize * (r + 0.5 * (q % 2)),
      });
    }
  }
  const spacing = cellSize * Math.sqrt(3);
  const radius = spacing * 0.46; // matches generateCircleLattice()'s own ring radius

  const topY = (LAYERS - 1) * LAYER_HEIGHT;
  const gapPlane = circleGapGroup.getObjectByName('gapPlane');
  const width = 1.5 * cellSize * cols + 2 * radius;
  const depth = Math.sqrt(3) * cellSize * rows + 2 * radius;
  gapPlane.scale.set(width, depth, 1);
  gapPlane.position.set(width / 2 - radius, topY - 0.02, depth / 2 - radius);

  let disksMesh = circleGapGroup.getObjectByName('disksMesh');
  if (disksMesh.count !== centers.length) {
    circleGapGroup.remove(disksMesh);
    disksMesh = new THREE.InstancedMesh(disksMesh.geometry, disksMesh.material, centers.length);
    disksMesh.name = 'disksMesh';
    circleGapGroup.add(disksMesh);
  }
  const dummy2 = new THREE.Object3D();
  centers.forEach((c, i) => {
    dummy2.position.set(c.x, topY - 0.01, c.z);
    dummy2.rotation.set(-Math.PI / 2, 0, 0);
    dummy2.scale.set(radius, radius, radius);
    dummy2.updateMatrix();
    disksMesh.setMatrixAt(i, dummy2.matrix);
  });
  disksMesh.instanceMatrix.needsUpdate = true;
}

// ---------- generation ----------
const SHAPE_GENERATORS = {
  Honeycomb: generateHoneycombLattice,
  Triangle: generateTriangleLattice,
  Square: generateSquareLattice,
  Circle: generateCircleLattice,
};

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
    result = SHAPE_GENERATORS[params.latticeType]({
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
  buildAdjacency();
  solveReferenceAtMaxLoad();
  applyRenderStyle();

  // topology changed — any previous strike's hop-distances/origin no
  // longer correspond to real nodes/struts, and a mid-flight strike
  // animation would be animating toward a lattice that no longer exists
  impactOriginNode = pickDefaultPointLoadNode();
  positionImpactorAtNode(impactOriginNode);
  impactActive = false;
  impactHopDist = null;
  strutRevealHop = null;
  impactAnimPhase = null;

  if (!Number.isFinite(colorScaleMax) || colorScaleMax <= 1e-9) {
    console.warn(
      'solveTruss returned all-zero or non-finite strut forces — ' +
      'check for a planar/under-braced lattice or NaNs in the stiffness matrix.'
    );
  }

  statTypeEl.textContent = params.latticeType;
  statCountEl.textContent = `${nodes.length} / ${struts.length}`;
  updateImpactLegend();
  updateTilingPanel();
  updateCircleGapOverlay();
}

// dispatches to whichever mode's coloring is currently active
function repaint() {
  if (params.simMode === 'Impact Test') {
    updateImpactColors();
  } else {
    resolveAndRender();
  }
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

// 'Solid walls' works for any tiling/packing shape (Honeycomb, Triangle,
// Square, Circle) — same physics, same solve, just draws the in-layer
// ('wall'-role) struts as flat panels and hides the vertical/diagonal
// bracing rods + node spheres, since those aren't part of what a real
// cell wall looks like. Not offered for Trabecular: real spongy bone is
// genuinely strut-like, not walled, so a "solid wall" version of it
// wouldn't represent anything real.
function applyRenderStyle() {
  const structural = params.view === 'Structural analysis';
  const wallsMode = structural && params.latticeType !== 'Trabecular' && params.renderStyle === 'Solid walls';

  if (nodeMesh) nodeMesh.visible = structural && !wallsMode;
  if (strutMesh) strutMesh.visible = structural && !wallsMode;
  if (wallMesh) wallMesh.visible = wallsMode;

  gridHelper.visible = structural;
}

// Static Load and Impact Test share the same rod/wall/node meshes (just
// repainted differently) but have entirely separate controls and 3D
// indicators, so this handles which of those show.
function applySimMode() {
  const structural = params.view === 'Structural analysis';
  const staticMode = structural && params.simMode === 'Static Load';
  const impactMode = structural && params.simMode === 'Impact Test';

  if (!impactMode) cancelImpactAnimation();

  loadFolder.show(staticMode);
  impactFolder.show(impactMode);

  const pointMode = staticMode && params.loadMode === 'Point';
  loadFaceHighlight.visible = staticMode && !pointMode;
  pointMarker.visible = pointMode;
  loadArrow.visible = staticMode;

  impactorMesh.visible = impactMode;
  updatePointHint();

  legendEl.style.display = staticMode ? 'block' : 'none';
  impactLegendEl.style.display = impactMode ? 'block' : 'none';
  if (impactMode) updateImpactLegend();

  updateTilingPanel();
  updateCircleGapOverlay();
}

function applyView() {
  const structural = params.view === 'Structural analysis';

  applyRenderStyle();
  applySimMode();

  structureFolder.show(structural);
  simModeCtrl.show(structural);
  cellSizeCtrl.show(structural && params.latticeType !== 'Trabecular');
  poreSizeCtrl.show(structural && params.latticeType === 'Trabecular');
  renderStyleCtrl.show(structural && params.latticeType !== 'Trabecular');

  if (structural) {
    if (crossSectionGroup) crossSectionGroup.visible = false;
    recenterStructural();
    repaint();
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
const simModeCtrl = viewFolder.add(params, 'simMode', ['Static Load', 'Impact Test'])
  .name('Test type')
  .onChange(() => {
    applySimMode();
    repaint();
  });
viewFolder.add({ reset: () => (params.view === 'Structural analysis' ? recenterStructural() : recenterCrossSection()) }, 'reset')
  .name('Reset camera ⟲');

const structureFolder = gui.addFolder('Structure');
const latticeTypeCtrl = structureFolder.add(params, 'latticeType', ['Honeycomb', 'Triangle', 'Square', 'Circle', 'Trabecular'])
  .name('Shape')
  .onChange(() => {
    cellSizeCtrl.show(params.latticeType !== 'Trabecular');
    poreSizeCtrl.show(params.latticeType === 'Trabecular');
    renderStyleCtrl.show(params.latticeType !== 'Trabecular');
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
    applySimMode();
  });

const loadCtrl = loadFolder.add(params, 'loadMagnitude', 0, LOAD_MAX, 100)
  .name('Load (N)')
  .onChange(() => requestResolve());

const impactFolder = gui.addFolder('Impact Test');
impactFolder.add(params, 'impactVelocity', 0, 20, 0.5)
  .name('Impact velocity');
impactFolder.add({ strike: () => strikeImpact() }, 'strike')
  .name('Strike ⚡');
impactFolder.add({ reset: () => resetImpact() }, 'reset')
  .name('Reset ↺');

viewFolder.open();
structureFolder.open();
loadFolder.open();
impactFolder.open();

// ---------- click-to-place point load / click-to-aim impact ----------
const pointHintEl = document.getElementById('point-hint');
function updatePointHint() {
  const structural = params.view === 'Structural analysis';
  const staticPointMode = structural && params.simMode === 'Static Load' && params.loadMode === 'Point';
  const impactMode = structural && params.simMode === 'Impact Test';

  if (staticPointMode) {
    pointHintEl.textContent = '📍 Click any non-fixed node to move the load point';
    pointHintEl.style.display = 'block';
  } else if (impactMode) {
    pointHintEl.textContent = '🎯 Click any node to aim the impactor from that direction';
    pointHintEl.style.display = 'block';
  } else {
    pointHintEl.style.display = 'none';
  }
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
  if (params.view !== 'Structural analysis' || !nodeMesh) return;

  const staticPointMode = params.simMode === 'Static Load' && params.loadMode === 'Point';
  const impactMode = params.simMode === 'Impact Test';
  if (!staticPointMode && !impactMode) return;

  const rect = renderer.domElement.getBoundingClientRect();
  pointerNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointerNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointerNDC, camera);

  const hits = raycaster.intersectObject(nodeMesh);
  if (hits.length === 0 || hits[0].instanceId == null) return;
  const idx = hits[0].instanceId;

  if (staticPointMode) {
    const fixed = nodes[idx].fixed;
    if (fixed && fixed[0] && fixed[1] && fixed[2]) return; // can't usefully load a fixed support node
    pointLoadNodeIndex = idx;
    solveReferenceAtMaxLoad();
    resolveAndRender();
  } else if (impactMode && !impactAnimPhase) {
    // aiming mid-strike would yank the impactor out from under an
    // in-flight animation, so ignore aim clicks until it settles
    impactOriginNode = idx;
    positionImpactorAtNode(idx);
  }
});

cellSizeCtrl.show(params.latticeType !== 'Trabecular');
poreSizeCtrl.show(params.latticeType === 'Trabecular');
renderStyleCtrl.show(params.latticeType !== 'Trabecular');

// initial build (after GUI controls exist, since applyView()/applySimMode() show/hide them)
regenerateLattice();
repaint();
applyView();

// ---------- render loop ----------
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  if (params.view === 'Structural analysis' && params.simMode === 'Impact Test') {
    updateImpactAnimation();
  }

  if (params.view === 'Structural analysis') {
    if (regenDirty) {
      regenDirty = false;
      regenerateLattice();
      repaint();
    } else if (resolveDirty && params.simMode === 'Static Load') {
      resolveDirty = false;
      resolveAndRender();
    }
  }

  renderer.render(scene, camera);
}
animate();
