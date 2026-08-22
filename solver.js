// ============================================================
// Direct Stiffness Method — 3D pin-jointed truss solver
// Pure JS, no dependencies. Small enough to solve live in-browser
// on every slider change.
//
// SPARSE SOLVE: a truss's global stiffness matrix is almost entirely
// zeros — each node only couples to the handful of struts touching
// it. Dense Gaussian elimination treats it as a full dof x dof
// matrix anyway, which is O(dof^3): at a few thousand DOF (a
// moderately dense lattice) that's tens of billions of operations,
// which is exactly the freeze you get cranking up cell/pore density.
// Instead we assemble K as a sparse adjacency (only nonzero entries),
// drop the fixed DOFs entirely (rather than the identity-row trick),
// and solve the reduced free-DOF system with Jacobi-preconditioned
// Conjugate Gradient — O(nnz) per iteration instead of O(dof^2) per
// elimination step, and nnz here is ~36 * strutCount, not dof^2.
// ============================================================

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function norm(a) {
  return Math.sqrt(dot(a, a));
}

// Solve a sparse SPD system given as per-row (colIndices, values) arrays,
// via Jacobi-preconditioned Conjugate Gradient.
function solveSparseSPD(rowCols, rowVals, b) {
  const n = b.length;
  const x = new Float64Array(n);
  if (n === 0) return x;

  const diag = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const cols = rowCols[i], vals = rowVals[i];
    for (let k = 0; k < cols.length; k++) {
      if (cols[k] === i) diag[i] = vals[k];
    }
    if (Math.abs(diag[i]) < 1e-12) diag[i] = 1; // isolated/near-mechanism DOF guard
  }

  function matVec(v, out) {
    for (let i = 0; i < n; i++) {
      const cols = rowCols[i], vals = rowVals[i];
      let sum = 0;
      for (let k = 0; k < cols.length; k++) sum += vals[k] * v[cols[k]];
      out[i] = sum;
    }
  }

  const r = Float64Array.from(b);
  const z = new Float64Array(n);
  for (let i = 0; i < n; i++) z[i] = r[i] / diag[i];
  const p = Float64Array.from(z);
  const Ap = new Float64Array(n);
  let rz = dot(r, z);

  const bNorm = Math.max(norm(b), 1e-9);
  const tol = 1e-8 * bNorm;
  const maxIter = Math.min(n, 4000);

  for (let iter = 0; iter < maxIter; iter++) {
    matVec(p, Ap);
    const pAp = dot(p, Ap);
    if (Math.abs(pAp) < 1e-14) break;
    const alpha = rz / pAp;
    for (let i = 0; i < n; i++) {
      x[i] += alpha * p[i];
      r[i] -= alpha * Ap[i];
    }
    if (norm(r) < tol) break;
    for (let i = 0; i < n; i++) z[i] = r[i] / diag[i];
    const rzNew = dot(r, z);
    const beta = rzNew / rz;
    for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
    rz = rzNew;
  }

  return x;
}

// ---- truss model ----
//
// nodes: [{x,y,z, fixed:[bool,bool,bool]}, ...]   fixed = constrained DOFs (x,y,z)
// struts: [{a: nodeIndex, b: nodeIndex, E: youngsModulus, A: crossSectionArea}, ...]
// loads: Map(nodeIndex -> [fx, fy, fz])
//
// Returns: { displacements: [[dx,dy,dz],...], strutForces: [force,...] }
// strutForces > 0 = tension, < 0 = compression (sign convention: axial force)

function solveTruss(nodes, struts, loads) {
  const n = nodes.length;
  const dof = 3 * n;

  // sparse assembly: one Map<colIndex, value> per row, only touched
  // for DOFs that actually appear in some strut
  const K = new Array(dof);
  for (let i = 0; i < dof; i++) K[i] = new Map();
  function addK(i, j, v) {
    K[i].set(j, (K[i].get(j) || 0) + v);
  }

  const F = new Float64Array(dof);

  for (const s of struts) {
    const ni = nodes[s.a];
    const nj = nodes[s.b];
    const dx = nj.x - ni.x;
    const dy = nj.y - ni.y;
    const dz = nj.z - ni.z;
    const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (L < 1e-9) continue;
    const c = [dx / L, dy / L, dz / L];
    const k = (s.E * s.A) / L; // axial stiffness

    // local stiffness contribution in global coords via direction cosines
    // ke = k * [c c^T, -c c^T; -c c^T, c c^T]  (c = [cx,cy,cz])
    const idx = [3 * s.a, 3 * s.a + 1, 3 * s.a + 2, 3 * s.b, 3 * s.b + 1, 3 * s.b + 2];

    for (let ii = 0; ii < 3; ii++) {
      for (let jj = 0; jj < 3; jj++) {
        const val = k * c[ii] * c[jj];
        addK(idx[ii], idx[jj], val);           // node a - node a
        addK(idx[3 + ii], idx[3 + jj], val);   // node b - node b
        addK(idx[ii], idx[3 + jj], -val);      // node a - node b
        addK(idx[3 + ii], idx[jj], -val);      // node b - node a
      }
    }
  }

  // assemble load vector
  for (const [nodeIdx, f] of loads) {
    F[3 * nodeIdx] += f[0];
    F[3 * nodeIdx + 1] += f[1];
    F[3 * nodeIdx + 2] += f[2];
  }

  // boundary conditions: drop fixed DOFs out of the system entirely
  // (rather than the dense identity-row trick) so the solve only ever
  // deals with the free DOFs
  const fixedMask = new Uint8Array(dof);
  for (let i = 0; i < n; i++) {
    const fixed = nodes[i].fixed || [false, false, false];
    for (let d = 0; d < 3; d++) {
      if (fixed[d]) fixedMask[3 * i + d] = 1;
    }
  }

  const freeIdx = [];
  for (let i = 0; i < dof; i++) if (!fixedMask[i]) freeIdx.push(i);
  const nf = freeIdx.length;
  const freePos = new Int32Array(dof).fill(-1);
  freeIdx.forEach((gi, li) => { freePos[gi] = li; });

  const rowCols = new Array(nf);
  const rowVals = new Array(nf);
  for (let li = 0; li < nf; li++) {
    const gi = freeIdx[li];
    const cols = [];
    const vals = [];
    for (const [gj, v] of K[gi]) {
      if (fixedMask[gj]) continue;
      cols.push(freePos[gj]);
      vals.push(v);
    }
    rowCols[li] = Int32Array.from(cols);
    rowVals[li] = Float64Array.from(vals);
  }

  const bFree = new Float64Array(nf);
  for (let li = 0; li < nf; li++) bFree[li] = F[freeIdx[li]];

  const xFree = solveSparseSPD(rowCols, rowVals, bFree);

  const x = new Float64Array(dof); // fixed DOFs stay 0
  for (let li = 0; li < nf; li++) x[freeIdx[li]] = xFree[li];

  const displacements = [];
  for (let i = 0; i < n; i++) {
    displacements.push([x[3 * i], x[3 * i + 1], x[3 * i + 2]]);
  }

  // recover axial forces per strut
  const strutForces = struts.map((s) => {
    const ni = nodes[s.a];
    const nj = nodes[s.b];
    const dx = nj.x - ni.x, dy = nj.y - ni.y, dz = nj.z - ni.z;
    const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (L < 1e-9) return 0;
    const cx = dx / L, cy = dy / L, cz = dz / L;
    const dax = displacements[s.a][0], day = displacements[s.a][1], daz = displacements[s.a][2];
    const dbx = displacements[s.b][0], dby = displacements[s.b][1], dbz = displacements[s.b][2];
    const elong = (dbx - dax) * cx + (dby - day) * cy + (dbz - daz) * cz;
    const k = (s.E * s.A) / L;
    return k * elong; // + tension, - compression
  });

  return { displacements, strutForces };
}

if (typeof module !== 'undefined') {
  module.exports = { solveTruss };
}
