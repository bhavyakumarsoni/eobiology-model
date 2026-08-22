// ============================================================
// Direct Stiffness Method — 3D pin-jointed truss solver
// Pure JS, no dependencies. Small enough to solve live in-browser
// on every slider change.
// ============================================================

// ---- tiny dense linear algebra helpers (no library needed at this scale) ----

function zeros(n, m) {
  const A = new Array(n);
  for (let i = 0; i < n; i++) A[i] = new Float64Array(m);
  return A;
}

// Solve A x = b via Gaussian elimination with partial pivoting.
// A is mutated (copy before calling if you need to keep it).
function solveLinearSystem(A, b) {
  const n = b.length;
  for (let col = 0; col < n; col++) {
    // partial pivot
    let maxRow = col;
    let maxVal = Math.abs(A[col][col]);
    for (let row = col + 1; row < n; row++) {
      const v = Math.abs(A[row][col]);
      if (v > maxVal) { maxVal = v; maxRow = row; }
    }
    if (maxVal < 1e-12) {
      // singular / near-singular — likely an under-constrained structure
      continue;
    }
    if (maxRow !== col) {
      [A[col], A[maxRow]] = [A[maxRow], A[col]];
      [b[col], b[maxRow]] = [b[maxRow], b[col]];
    }
    const pivot = A[col][col];
    for (let row = col + 1; row < n; row++) {
      const factor = A[row][col] / pivot;
      if (factor === 0) continue;
      for (let k = col; k < n; k++) A[row][k] -= factor * A[col][k];
      b[row] -= factor * b[col];
    }
  }
  // back substitution
  const x = new Float64Array(n);
  for (let row = n - 1; row >= 0; row--) {
    let sum = b[row];
    for (let k = row + 1; k < n; k++) sum -= A[row][k] * x[k];
    x[row] = Math.abs(A[row][row]) < 1e-12 ? 0 : sum / A[row][row];
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
  const K = zeros(dof, dof);
  const F = new Float64Array(dof);

  // assemble global stiffness matrix
  for (const s of struts) {
    const ni = nodes[s.a];
    const nj = nodes[s.b];
    const dx = nj.x - ni.x;
    const dy = nj.y - ni.y;
    const dz = nj.z - ni.z;
    const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (L < 1e-9) continue;
    const cx = dx / L, cy = dy / L, cz = dz / L;
    const k = (s.E * s.A) / L; // axial stiffness

    // local stiffness contribution in global coords via direction cosines
    // ke = k * [c c^T, -c c^T; -c c^T, c c^T]  (c = [cx,cy,cz])
    const c = [cx, cy, cz];
    const idx = [3 * s.a, 3 * s.a + 1, 3 * s.a + 2, 3 * s.b, 3 * s.b + 1, 3 * s.b + 2];

    for (let ii = 0; ii < 3; ii++) {
      for (let jj = 0; jj < 3; jj++) {
        const val = k * c[ii] * c[jj];
        // node a - node a
        K[idx[ii]][idx[jj]] += val;
        // node b - node b
        K[idx[3 + ii]][idx[3 + jj]] += val;
        // node a - node b (negative)
        K[idx[ii]][idx[3 + jj]] -= val;
        K[idx[3 + ii]][idx[jj]] -= val;
      }
    }
  }

  // assemble load vector
  for (const [nodeIdx, f] of loads) {
    F[3 * nodeIdx] += f[0];
    F[3 * nodeIdx + 1] += f[1];
    F[3 * nodeIdx + 2] += f[2];
  }

  // apply boundary conditions (penalty-free: zero row/col + identity for fixed DOFs)
  for (let i = 0; i < n; i++) {
    const fixed = nodes[i].fixed || [false, false, false];
    for (let d = 0; d < 3; d++) {
      if (!fixed[d]) continue;
      const gi = 3 * i + d;
      for (let k = 0; k < dof; k++) {
        K[gi][k] = 0;
        K[k][gi] = 0;
      }
      K[gi][gi] = 1;
      F[gi] = 0;
    }
  }

  const x = solveLinearSystem(K, F);

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
