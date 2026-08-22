// ============================================================
// Manufacturing / build-process visualization.
// Reuses generators.js as-is (same geometry as the main sim).
// No solver here — this page isn't about load, it's about HOW
// each structure actually gets built:
//   - Honeycomb: sheet expansion, shown as hex layers unfolding
//   - Trabecular: metal 3D printing, shown as layers fusing
// "Layers built" reveals the structure from the base upward.
// ============================================================

const TOTAL_LAYERS = 6;
const LAYER_HEIGHT = 1;

const COLORS = {
  honeycomb: 0xd7a15c,   // aluminum/Nomex amber
  trabecular: 0xe6dcc6,  // bone / titanium ivory
  active: 0x7fe8f5,      // currently-forming layer highlight
};

// ---------- scene setup ----------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0e0f12);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
document.body.appendChild(renderer.domElement);

const controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(6, 12, 8);
scene.add(dirLight);

const gridHelper = new THREE.GridHelper(12, 12, 0x333333, 0x1c1c1c);
scene.add(gridHelper);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- state ----------
const params = {
  material: 'honeycomb',
  cellSize: 1,       // used as cellSize for honeycomb, poreSize for trabecular
  layersBuilt: TOTAL_LAYERS,
};

let currentLattice = null;   // { nodes, struts, layerNodeIndices }
let nodeLayerMap = null;     // global node index -> layer index

const strutGroup = new THREE.Group();
scene.add(strutGroup);
const nodeGroup = new THREE.Group();
scene.add(nodeGroup);

// ---------- geometry generation (calls generators.js) ----------
function regenerateLattice() {
  const boundsX = 6, boundsZ = 5;

  if (params.material === 'honeycomb') {
    currentLattice = generateHoneycombLattice({
      cellSize: params.cellSize,
      boundsX, boundsZ,
      layers: TOTAL_LAYERS,
      layerHeight: LAYER_HEIGHT,
    });
  } else {
    currentLattice = generateTrabecularLattice({
      boundsX, boundsZ,
      poreSize: params.cellSize,
      loadBias: 1.4,
      layers: TOTAL_LAYERS,
      layerHeight: LAYER_HEIGHT,
      DelaunayLib: { Delaunay: d3.Delaunay },
    });
  }

  nodeLayerMap = new Map();
  currentLattice.layerNodeIndices.forEach((indices, L) => {
    indices.forEach((i) => nodeLayerMap.set(i, L));
  });

  // recenter camera/controls target on this structure
  const cx = boundsX / 2, cz = boundsZ / 2, cy = (TOTAL_LAYERS * LAYER_HEIGHT) / 2;
  controls.target.set(cx, cy, cz);
  camera.position.set(cx + boundsX * 1.3, cy + boundsX * 1.1, cz + boundsZ * 2.0);
}

// ---------- rendering: reveal up to params.layersBuilt ----------
function updateVisualization() {
  strutGroup.clear();
  nodeGroup.clear();
  if (!currentLattice) return;

  const { nodes, struts } = currentLattice;
  const baseColor = new THREE.Color(COLORS[params.material]);
  const activeColor = new THREE.Color(COLORS.active);
  const topVisibleLayer = params.layersBuilt - 1; // currently-forming layer index

  const nodeGeo = new THREE.SphereGeometry(0.07, 10, 10);

  struts.forEach((s) => {
    const la = nodeLayerMap.get(s.a);
    const lb = nodeLayerMap.get(s.b);
    if (la >= params.layersBuilt || lb >= params.layersBuilt) return; // not built yet

    const ni = nodes[s.a], nj = nodes[s.b];
    const start = new THREE.Vector3(ni.x, ni.y, ni.z);
    const end = new THREE.Vector3(nj.x, nj.y, nj.z);
    const dir = new THREE.Vector3().subVectors(end, start);
    const len = dir.length();
    if (len < 1e-6) return;

    const isActive = la === topVisibleLayer || lb === topVisibleLayer;
    const color = isActive ? activeColor : baseColor;

    const geo = new THREE.CylinderGeometry(0.035, 0.035, len, 7);
    const mat = new THREE.MeshStandardMaterial({
      color,
      emissive: isActive ? activeColor : 0x000000,
      emissiveIntensity: isActive ? 0.4 : 0,
    });
    const mesh = new THREE.Mesh(geo, mat);
    const mid = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
    mesh.position.copy(mid);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    strutGroup.add(mesh);
  });

  nodes.forEach((n, i) => {
    const L = nodeLayerMap.get(i);
    if (L >= params.layersBuilt) return;
    const isActive = L === topVisibleLayer;
    const mat = new THREE.MeshStandardMaterial({
      color: isActive ? activeColor : baseColor,
      emissive: isActive ? activeColor : 0x000000,
      emissiveIntensity: isActive ? 0.4 : 0,
    });
    const mesh = new THREE.Mesh(nodeGeo, mat);
    mesh.position.set(n.x, n.y, n.z);
    nodeGroup.add(mesh);
  });
}

function regenerateAndRender() {
  regenerateLattice();
  updateVisualization();
}

regenerateAndRender();

// ---------- GUI ----------
const gui = new lil.GUI({ title: 'Manufacturing controls' });

gui.add(params, 'material', ['honeycomb', 'trabecular'])
  .name('Structure')
  .onChange(() => { params.layersBuilt = TOTAL_LAYERS; layersCtrl.updateDisplay(); regenerateAndRender(); });

gui.add(params, 'cellSize', 0.4, 2, 0.1)
  .name('Cell / pore size')
  .onChange(() => regenerateAndRender());

const layersCtrl = gui.add(params, 'layersBuilt', 0, TOTAL_LAYERS, 1)
  .name('Layers built')
  .onChange(() => updateVisualization());

// ---------- render loop ----------
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();
