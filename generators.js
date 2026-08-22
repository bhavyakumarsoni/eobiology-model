// ============================================================
// Lattice generators for honeycomb and trabecular structures.
//
// KEY DESIGN NOTE: a flat (single-layer, planar) pin-jointed truss
// has zero stiffness perpendicular to its own plane — it cannot
// carry a load pushing straight down on it, full stop (this is
// exactly the bug we found in the Day 1 test lattice: all strut
// forces came out zero because the whole thing lay in one plane).
//
// Both generators below build a genuine 3D structure: an in-plane
// pattern (regular hexagons, or an irregular Voronoi network)
// repeated at several vertical "layers", connected by:
//   - vertical struts (straight up, floor to floor)
//   - diagonal struts (floor to floor, offset) for shear bracing
// Load is applied at the top layer, the bottom layer is fully
// fixed — like a honeycomb sandwich panel or a chunk of trabecular
// bone bearing weight from above.
// ============================================================

// ---------- shared helper: turn an in-layer 2D node/edge pattern
// into a full layered 3D lattice ----------
function extrudeLayers({ localNodes, localEdges, layers, layerHeight, E, A }) {
  const nodes = [];
  const struts = [];
  const layerNodeIndices = [];

  for (let L = 0; L < layers; L++) {
    const y = L * layerHeight;
    const indices = [];
    for (const ln of localNodes) {
      indices.push(nodes.length);
      nodes.push({ x: ln.x, y, z: ln.z, fixed: [false, false, false] });
    }
    layerNodeIndices.push(indices);

    // in-layer struts (horizontal bracing at this floor) — tagged 'wall'
    // since these are exactly the hexagon-edge members a real honeycomb
    // cell wall sits on; main.js's wall render style uses this tag to
    // pick them out from the vertical/diagonal bracing.
    for (const [i, j] of localEdges) {
      struts.push({ a: indices[i], b: indices[j], E, A, role: 'wall' });
    }

    if (L > 0) {
      const below = layerNodeIndices[L - 1];
      // vertical struts: straight columns floor to floor
      for (let i = 0; i < indices.length; i++) {
        struts.push({ a: below[i], b: indices[i], E, A, role: 'vertical' });
      }
      // diagonal struts: one per in-layer edge, connecting across
      // floors on an angle — this is what actually gives the stack
      // shear stiffness (without this, floors can slide sideways
      // relative to each other for free, i.e. another mechanism)
      for (const [i, j] of localEdges) {
        struts.push({ a: below[i], b: indices[j], E, A, role: 'diagonal' });
      }
    }
  }

  // fix the whole bottom layer (base), load goes on the top layer
  for (const idx of layerNodeIndices[0]) nodes[idx].fixed = [true, true, true];
  const loadNodeIndices = layerNodeIndices[layers - 1];

  return { nodes, struts, loadNodeIndices, layerNodeIndices };
}

// ---------- Honeycomb: regular flat-top hexagonal tiling ----------
function generateHoneycombLattice({
  cellSize = 1,      // hex radius (center to corner)
  boundsX = 8,
  boundsZ = 6,
  layers = 4,
  layerHeight = 1,
  E = 200e9,
  strutRadius = 0.04,
} = {}) {
  const A = Math.PI * strutRadius * strutRadius;

  const nodeMap = new Map();
  const localNodes = [];
  const edgeSet = new Set();
  const localEdges = [];

  const keyFor = (x, z) => `${Math.round(x * 1000)}_${Math.round(z * 1000)}`;
  function getOrAddNode(x, z) {
    const k = keyFor(x, z);
    if (nodeMap.has(k)) return nodeMap.get(k);
    const idx = localNodes.length;
    localNodes.push({ x, z });
    nodeMap.set(k, idx);
    return idx;
  }
  function addEdge(i, j) {
    if (i === j) return;
    const key = i < j ? `${i}_${j}` : `${j}_${i}`;
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    localEdges.push([i, j]);
  }

  const cols = Math.max(2, Math.round(boundsX / (1.5 * cellSize)));
  const rows = Math.max(2, Math.round(boundsZ / (Math.sqrt(3) * cellSize)));

  for (let q = 0; q <= cols; q++) {
    for (let r = 0; r <= rows; r++) {
      const cx = 1.5 * cellSize * q;
      const cz = Math.sqrt(3) * cellSize * (r + 0.5 * (q % 2));
      const corners = [];
      for (let k = 0; k < 6; k++) {
        const angle = (Math.PI / 180) * (60 * k);
        corners.push(getOrAddNode(cx + cellSize * Math.cos(angle), cz + cellSize * Math.sin(angle)));
      }
      for (let k = 0; k < 6; k++) addEdge(corners[k], corners[(k + 1) % 6]);
    }
  }

  return extrudeLayers({ localNodes, localEdges, layers, layerHeight, E, A });
}

// ---------- Trabecular: irregular Voronoi-based strut network ----------
// Requires d3-delaunay (loaded globally as `d3` via CDN in the browser,
// or via require('d3-delaunay') in this Node test).
function generateTrabecularLattice({
  boundsX = 8,
  boundsZ = 6,
  poreSize = 1,        // ~ minimum spacing between seed points; bigger = fewer/bigger pores
  loadBias = 1.5,       // >1 biases points denser near the central load axis (Wolff's-Law-ish)
  layers = 4,
  layerHeight = 1,
  E = 200e9,
  strutRadius = 0.03,
  DelaunayLib,           // pass in { Delaunay } — d3-delaunay module or global d3
} = {}) {
  const A = Math.PI * strutRadius * strutRadius;
  const { Delaunay } = DelaunayLib;

  // Poisson-disc-ish rejection sampling with spatially varying
  // minimum distance: denser (smaller minDist) near the central
  // X axis (where the load will be applied), sparser toward the edges.
  const centerX = boundsX / 2;
  function minDistAt(x) {
    const t = Math.min(Math.abs(x - centerX) / (boundsX / 2), 1);
    return poreSize * (1 + (loadBias - 1) * t);
  }

  const points = [];
  const maxAttempts = 4000;
  let attempts = 0;
  while (attempts < maxAttempts && points.length < 400) {
    attempts++;
    const x = Math.random() * boundsX;
    const z = Math.random() * boundsZ;
    const md = minDistAt(x);
    let ok = true;
    for (const p of points) {
      const dx = p[0] - x, dz = p[1] - z;
      if (dx * dx + dz * dz < md * md) { ok = false; break; }
    }
    if (ok) points.push([x, z]);
  }
  // guarantee corner coverage so the boundary is reasonably closed
  points.push([0, 0], [boundsX, 0], [0, boundsZ], [boundsX, boundsZ]);

  const delaunay = Delaunay.from(points);
  const voronoi = delaunay.voronoi([-0.5, -0.5, boundsX + 0.5, boundsZ + 0.5]);

  const nodeMap = new Map();
  const localNodes = [];
  const edgeSet = new Set();
  const localEdges = [];
  const keyFor = (x, z) => `${Math.round(x * 1000)}_${Math.round(z * 1000)}`;
  function getOrAddNode(x, z) {
    const k = keyFor(x, z);
    if (nodeMap.has(k)) return nodeMap.get(k);
    const idx = localNodes.length;
    localNodes.push({ x, z });
    nodeMap.set(k, idx);
    return idx;
  }
  function addEdge(i, j) {
    if (i === j) return;
    const key = i < j ? `${i}_${j}` : `${j}_${i}`;
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    localEdges.push([i, j]);
  }

  for (let i = 0; i < points.length; i++) {
    const poly = voronoi.cellPolygon(i);
    if (!poly) continue;
    const idxs = poly.map(([x, z]) => getOrAddNode(x, z));
    for (let k = 0; k < idxs.length - 1; k++) addEdge(idxs[k], idxs[k + 1]);
  }

  return extrudeLayers({ localNodes, localEdges, layers, layerHeight, E, A });
}

if (typeof module !== 'undefined') {
  module.exports = { generateHoneycombLattice, generateTrabecularLattice, extrudeLayers };
}
