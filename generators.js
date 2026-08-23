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

    // in-layer struts (horizontal bracing at this floor)
    for (const [i, j] of localEdges) {
      struts.push({ a: indices[i], b: indices[j], E, A });
    }

    if (L > 0) {
      const below = layerNodeIndices[L - 1];
      // vertical struts: straight columns floor to floor
      for (let i = 0; i < indices.length; i++) {
        struts.push({ a: below[i], b: indices[i], E, A });
      }
      // diagonal struts: one per in-layer edge, connecting across
      // floors on an angle — this is what actually gives the stack
      // shear stiffness (without this, floors can slide sideways
      // relative to each other for free, i.e. another mechanism)
      for (const [i, j] of localEdges) {
        struts.push({ a: below[i], b: indices[j], E, A });
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

// ---------- Triangle: triangular lattice ----------
// This is the dual of the hexagon grid: connect hex-CENTER positions
// directly to their nearest neighbors instead of using hex corners.
// Triangles tile the plane with no gaps, same as hexagons and squares.
function generateTriangleLattice({
  cellSize = 1,
  boundsX = 8,
  boundsZ = 6,
  layers = 4,
  layerHeight = 1,
  E = 200e9,
  strutRadius = 0.04,
} = {}) {
  const A = Math.PI * strutRadius * strutRadius;
  const cols = Math.max(2, Math.round(boundsX / (1.5 * cellSize)));
  const rows = Math.max(2, Math.round(boundsZ / (Math.sqrt(3) * cellSize)));

  const localNodes = [];
  for (let q = 0; q <= cols; q++) {
    for (let r = 0; r <= rows; r++) {
      const cx = 1.5 * cellSize * q;
      const cz = Math.sqrt(3) * cellSize * (r + 0.5 * (q % 2));
      localNodes.push({ x: cx, z: cz });
    }
  }

  const targetDist = cellSize * Math.sqrt(3);
  const tol = targetDist * 0.15;
  const localEdges = [];
  for (let i = 0; i < localNodes.length; i++) {
    for (let j = i + 1; j < localNodes.length; j++) {
      const dx = localNodes[i].x - localNodes[j].x;
      const dz = localNodes[i].z - localNodes[j].z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (Math.abs(d - targetDist) < tol) localEdges.push([i, j]);
    }
  }

  return extrudeLayers({ localNodes, localEdges, layers, layerHeight, E, A });
}

// ---------- Square: simple square grid ----------
// NOTE: a square grid without in-layer diagonals is a classic shear
// mechanism (it can rack into a parallelogram for free) — one diagonal
// per cell is added specifically to keep each floor itself rigid,
// separately from the cross-floor bracing extrudeLayers() already adds.
function generateSquareLattice({
  cellSize = 1,
  boundsX = 8,
  boundsZ = 6,
  layers = 4,
  layerHeight = 1,
  E = 200e9,
  strutRadius = 0.04,
} = {}) {
  const A = Math.PI * strutRadius * strutRadius;
  const cols = Math.max(2, Math.round(boundsX / cellSize));
  const rows = Math.max(2, Math.round(boundsZ / cellSize));

  const localNodes = [];
  const idx = (i, j) => i * (rows + 1) + j;
  for (let i = 0; i <= cols; i++) {
    for (let j = 0; j <= rows; j++) {
      localNodes.push({ x: i * cellSize, z: j * cellSize });
    }
  }

  const localEdges = [];
  for (let i = 0; i <= cols; i++) {
    for (let j = 0; j <= rows; j++) {
      if (i < cols) localEdges.push([idx(i, j), idx(i + 1, j)]);
      if (j < rows) localEdges.push([idx(i, j), idx(i, j + 1)]);
      if (i < cols && j < rows) localEdges.push([idx(i, j), idx(i + 1, j + 1)]);
    }
  }

  return extrudeLayers({ localNodes, localEdges, layers, layerHeight, E, A });
}

// ---------- Circle: hex-packed circular cells ----------
// Circles cannot tile the plane without gaps (unlike triangle/square/
// hexagon, the three true regular tessellations) — this is itself part
// of the comparison story. Each circle is approximated as a ring of
// straight struts (a regular polygon), packed hexagonally, connected
// to neighboring rings at their nearest tangent-ish points.
function generateCircleLattice({
  cellSize = 1,
  boundsX = 8,
  boundsZ = 6,
  layers = 4,
  layerHeight = 1,
  E = 200e9,
  strutRadius = 0.04,
  ringSegments = 12,
} = {}) {
  const A = Math.PI * strutRadius * strutRadius;
  const cols = Math.max(2, Math.round(boundsX / (1.5 * cellSize)));
  const rows = Math.max(2, Math.round(boundsZ / (Math.sqrt(3) * cellSize)));

  const centers = [];
  for (let q = 0; q <= cols; q++) {
    for (let r = 0; r <= rows; r++) {
      const cx = 1.5 * cellSize * q;
      const cz = Math.sqrt(3) * cellSize * (r + 0.5 * (q % 2));
      centers.push({ x: cx, z: cz });
    }
  }

  const spacing = cellSize * Math.sqrt(3);
  const radius = spacing * 0.46; // just short of touching, avoids coincident nodes

  const localNodes = [];
  const localEdges = [];
  const ringNodeIndices = [];

  centers.forEach((center) => {
    const ring = [];
    for (let k = 0; k < ringSegments; k++) {
      const angle = (2 * Math.PI * k) / ringSegments;
      const idx = localNodes.length;
      localNodes.push({ x: center.x + radius * Math.cos(angle), z: center.z + radius * Math.sin(angle) });
      ring.push(idx);
    }
    for (let k = 0; k < ringSegments; k++) localEdges.push([ring[k], ring[(k + 1) % ringSegments]]);
    ringNodeIndices.push(ring);
  });

  const targetDist = spacing;
  const tol = targetDist * 0.15;
  function closestRingNode(ring, center, targetAngle) {
    let best = ring[0], bestDiff = Infinity;
    for (const nIdx of ring) {
      const n = localNodes[nIdx];
      const a = Math.atan2(n.z - center.z, n.x - center.x);
      let diff = Math.abs(a - targetAngle);
      if (diff > Math.PI) diff = 2 * Math.PI - diff;
      if (diff < bestDiff) { bestDiff = diff; best = nIdx; }
    }
    return best;
  }

  for (let i = 0; i < centers.length; i++) {
    for (let j = i + 1; j < centers.length; j++) {
      const dx = centers[j].x - centers[i].x;
      const dz = centers[j].z - centers[i].z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (Math.abs(d - targetDist) < tol) {
        const angleToJ = Math.atan2(dz, dx);
        const angleToI = angleToJ + Math.PI;
        const nodeI = closestRingNode(ringNodeIndices[i], centers[i], angleToJ);
        const nodeJ = closestRingNode(ringNodeIndices[j], centers[j], angleToI);
        localEdges.push([nodeI, nodeJ]);
      }
    }
  }

  return extrudeLayers({ localNodes, localEdges, layers, layerHeight, E, A });
}

if (typeof module !== 'undefined') {
  module.exports = {
    generateHoneycombLattice,
    generateTrabecularLattice,
    generateTriangleLattice,
    generateSquareLattice,
    generateCircleLattice,
    extrudeLayers,
  };
}
