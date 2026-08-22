// ============================================================
// Illustrative solid 3D cross-sections: an actual honeycomb comb
// block (hexagonal wax cells) and an actual long-bone cross-section
// (dense cortical shell + spongy trabecular interior).
//
// These are literal solid geometry for visual reference, NOT the
// pin-jointed truss idealization used by solver.js — they aren't
// solved or force-colored, they just show what the real structures
// these lattices are modeled after actually look like.
// ============================================================

function buildHoneycombBlock({
  cellSize = 0.45,
  wallThickness = 0.06,
  cellDepth = 1.6,
  cols = 6,
  rows = 5,
} = {}) {
  const group = new THREE.Group();

  function hexPoints(r) {
    const pts = [];
    for (let k = 0; k < 6; k++) {
      const angle = (Math.PI / 180) * (60 * k);
      pts.push(new THREE.Vector2(r * Math.cos(angle), r * Math.sin(angle)));
    }
    return pts;
  }

  const outerShape = new THREE.Shape(hexPoints(cellSize));
  const innerHole = new THREE.Path(hexPoints(cellSize - wallThickness));
  outerShape.holes.push(innerHole);

  const cellGeo = new THREE.ExtrudeGeometry(outerShape, {
    depth: cellDepth,
    bevelEnabled: false,
    curveSegments: 1,
  });
  cellGeo.rotateX(-Math.PI / 2); // stand the cell prism up along +Y

  const material = new THREE.MeshStandardMaterial({
    color: 0xd98e2b,
    roughness: 0.45,
    metalness: 0.12,
  });

  const count = cols * rows;
  const mesh = new THREE.InstancedMesh(cellGeo, material, count);
  const dummy = new THREE.Object3D();

  let i = 0;
  const width = 1.5 * cellSize * (cols - 1);
  const depth = Math.sqrt(3) * cellSize * (rows - 1);
  for (let q = 0; q < cols; q++) {
    for (let r = 0; r < rows; r++) {
      const cx = 1.5 * cellSize * q - width / 2;
      const cz = Math.sqrt(3) * cellSize * (r + 0.5 * (q % 2)) - depth / 2;
      dummy.position.set(cx, 0, cz);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(i++, dummy.matrix);
    }
  }
  mesh.instanceMatrix.needsUpdate = true;
  group.add(mesh);
  group.userData.footprint = { width: width + 2 * cellSize, depth: depth + 2 * cellSize, height: cellDepth };
  return group;
}

function buildBoneCrossSection({
  outerRadius = 1.3,
  innerRadius = 1.0,
  height = 2.6,
  fillLayers = 6,
  pointsPerLayer = 20,
  strutRadius = 0.03,
} = {}) {
  const group = new THREE.Group();
  const boneMat = new THREE.MeshStandardMaterial({ color: 0xede3d0, roughness: 0.8, metalness: 0.02 });

  // dense cortical shell (annulus tube, cut open at both ends so the
  // ring cross-section is visible — the defining look of a bone cut)
  const shellShape = new THREE.Shape();
  shellShape.absarc(0, 0, outerRadius, 0, Math.PI * 2, false);
  const shellHole = new THREE.Path();
  shellHole.absarc(0, 0, innerRadius, 0, Math.PI * 2, true);
  shellShape.holes.push(shellHole);

  const shellGeo = new THREE.ExtrudeGeometry(shellShape, {
    depth: height,
    bevelEnabled: false,
    curveSegments: 40,
  });
  shellGeo.rotateX(-Math.PI / 2);
  group.add(new THREE.Mesh(shellGeo, boneMat));

  // spongy trabecular interior: irregular strut network filling the
  // inner cylinder, layered vertically like real cancellous bone
  const layerPoints = [];
  for (let L = 0; L < fillLayers; L++) {
    const y = (L / (fillLayers - 1)) * height;
    const pts = [];
    for (let i = 0; i < pointsPerLayer; i++) {
      const r = innerRadius * 0.9 * Math.sqrt(Math.random());
      const a = Math.random() * Math.PI * 2;
      pts.push(new THREE.Vector3(r * Math.cos(a), y, r * Math.sin(a)));
    }
    layerPoints.push(pts);
  }

  const segments = [];
  const seen = new Set();
  function addSegment(p1, p2, key) {
    if (seen.has(key)) return;
    seen.add(key);
    segments.push([p1, p2]);
  }

  // in-layer: connect each point to its 2 nearest neighbors
  layerPoints.forEach((pts, L) => {
    pts.forEach((p, i) => {
      const ranked = pts
        .map((q, j) => [j, p.distanceTo(q)])
        .filter(([j]) => j !== i)
        .sort((a, b) => a[1] - b[1]);
      for (let k = 0; k < Math.min(2, ranked.length); k++) {
        const j = ranked[k][0];
        const key = `${L}_${Math.min(i, j)}_${Math.max(i, j)}`;
        addSegment(p, pts[j], key);
      }
    });
  });

  // between layers: connect each point to its nearest neighbor one floor up
  for (let L = 0; L < layerPoints.length - 1; L++) {
    const a = layerPoints[L], b = layerPoints[L + 1];
    a.forEach((p, i) => {
      let best = 0, bestD = Infinity;
      b.forEach((q, j) => {
        const d = p.distanceTo(q);
        if (d < bestD) { bestD = d; best = j; }
      });
      addSegment(p, b[best], `v${L}_${i}_${best}`);
    });
  }

  const unitCyl = new THREE.CylinderGeometry(1, 1, 1, 6);
  const fillMesh = new THREE.InstancedMesh(unitCyl, boneMat, segments.length);
  const dummy = new THREE.Object3D();
  const dir = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  segments.forEach(([p1, p2], i) => {
    dir.subVectors(p2, p1);
    const len = Math.max(dir.length(), 1e-6);
    dummy.position.copy(p1).addScaledVector(dir, 0.5);
    dummy.quaternion.setFromUnitVectors(up, dir.clone().normalize());
    dummy.scale.set(strutRadius, len, strutRadius);
    dummy.updateMatrix();
    fillMesh.setMatrixAt(i, dummy.matrix);
  });
  fillMesh.instanceMatrix.needsUpdate = true;
  group.add(fillMesh);

  group.userData.footprint = { width: outerRadius * 2, depth: outerRadius * 2, height };
  return group;
}

// Assembles both specimens side by side into one group, ready to drop
// into a scene.
function buildCrossSectionDisplay() {
  const display = new THREE.Group();

  const honeycomb = buildHoneycombBlock();
  const bone = buildBoneCrossSection();

  const hcFoot = honeycomb.userData.footprint;
  const boneFoot = bone.userData.footprint;
  const gap = 1.5;

  honeycomb.position.set(-(hcFoot.width / 2 + gap / 2), 0, 0);
  bone.position.set(boneFoot.width / 2 + gap / 2, 0, 0);

  display.add(honeycomb, bone);
  display.userData.bounds = {
    width: hcFoot.width + boneFoot.width + gap,
    height: Math.max(hcFoot.height, boneFoot.height),
  };
  return display;
}
