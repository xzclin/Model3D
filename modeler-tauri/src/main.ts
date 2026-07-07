import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

// ============================================================
//  核心状态
// ============================================================
const state = {
  objects: [],        // 场景中的可交互物体
  selected: null,     // 当前选中的物体
  toolMode: 'select', // select | translate | rotate | scale | clay
  isOrtho: false,
  undoStack: [],
  redoStack: [],
  objectIdCounter: 0,
  transformActive: false, // 是否正在拖动transform控件
};

// ============================================================
//  黏土雕刻系统 (Sculpting)
// ============================================================
const clay = {
  active: false,
  target: null,
  brushSize: 0.6,
  brushStrength: 0.25,
  brushType: 'push', // push | smooth | inflate | flatten
  isSculpting: false,
  cursor: null,       // Brush ring cursor
  cursorNormal: null, // Normal helper line
  hitPoint: new THREE.Vector3(),
  hitNormal: new THREE.Vector3(),
  lastPointer: new THREE.Vector2(),
  originalData: null, // For undo
  vertCache: [],      // Cached vertex data for performance
  tempVec: new THREE.Vector3(),
  tempVec2: new THREE.Vector3(),
  raycaster: new THREE.Raycaster(),
  pointer: new THREE.Vector2(),
};

// -------- 初始化黏土系统 ----------
function initClay() {
  // 笔刷光标：半透明环
  const ringGeo = new THREE.RingGeometry(0.45, 0.55, 48);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.6,
    depthWrite: false,
  });
  clay.cursor = new THREE.Mesh(ringGeo, ringMat);
  clay.cursor.visible = false;
  clay.cursor.renderOrder = 999;
  scene.add(clay.cursor);

  // 法线指示线
  const lineMat = new THREE.LineBasicMaterial({ color: 0x0071e3, transparent: true, opacity: 0.5 });
  const lineGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0.5, 0)
  ]);
  clay.cursorNormal = new THREE.Line(lineGeo, lineMat);
  clay.cursorNormal.visible = false;
  scene.add(clay.cursorNormal);
}

// -------- 细分网格 (Loop subdivision style) ----------
function subdivideMeshOnce(geometry) {
  const pos = geometry.attributes.position;
  if (!pos) return geometry;

  // 转为非索引 (每个三角形3个独立顶点)
  const nonIndexed = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  const positions = nonIndexed.attributes.position.array;
  const vertCount = positions.length / 3;
  const faces = vertCount / 3;

  // 每个三角形 -> 4个小三角形
  // 原三角形 ABC, 中点 MAB, MBC, MCA
  const newPositions = [];
  const v = (i) => { const o = i * 3; return [positions[o], positions[o + 1], positions[o + 2]]; };
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

  for (let f = 0; f < faces; f++) {
    const i0 = f * 3, i1 = f * 3 + 1, i2 = f * 3 + 2;
    const a = v(i0), b = v(i1), c = v(i2);
    const mab = mid(a, b), mbc = mid(b, c), mca = mid(c, a);
    // 4个三角形: (A, MAB, MCA), (B, MBC, MAB), (C, MCA, MBC), (MAB, MBC, MCA)
    const triVerts = [a, mab, mca, b, mbc, mab, c, mca, mbc, mab, mbc, mca];
    triVerts.forEach(vv => { newPositions.push(vv[0], vv[1], vv[2]); });
  }

  const newGeo = new THREE.BufferGeometry();
  newGeo.setAttribute('position', new THREE.Float32BufferAttribute(newPositions, 3));
  newGeo.computeVertexNormals();
  return newGeo;
}

function subdivideTargetMesh(levels = 1) {
  if (!clay.target) return;
  let geo = clay.target.geometry;
  const name = clay.target.userData.name;
  for (let i = 0; i < levels; i++) {
    geo = subdivideMeshOnce(geo);
  }
  clay.target.geometry = geo;
  updateClayInfo();
  showToast(`${name} 细分完成 · ${(geo.attributes.position.count / 3).toFixed(0)} 顶点`);
}

// -------- 黏土模式进入/退出 ----------
function enterClayMode() {
  if (!state.selected) {
    showToast('请先选择一个物体');
    setToolMode('select');
    return;
  }
  const obj = state.selected;
  // 只对 Mesh 有效
  if (!obj.isMesh) {
    showToast('只能雕刻网格物体');
    setToolMode('select');
    return;
  }

  clay.active = true;
  clay.target = obj;
  clay.cursor.visible = true;
  clay.cursorNormal.visible = true;

  // 如果顶点太少，自动细分
  const count = obj.geometry.attributes.position.count;
  if (count < 200) {
    subdivideTargetMesh(2);
  } else if (count < 800) {
    subdivideTargetMesh(1);
  }

  // 保存初始状态用于撤销
  saveClayUndo();

  // 显示黏土面板
  document.getElementById('clay-panel').style.display = '';
  document.getElementById('clay-info').style.display = '';
  updateClayInfo();

  // 隐藏transform控件
  transformControls.detach();

  // 绑定事件
  renderer.domElement.addEventListener('pointerdown', onClayPointerDown);
  renderer.domElement.addEventListener('pointermove', onClayPointerMove);
  renderer.domElement.addEventListener('pointerup', onClayPointerUp);
  renderer.domElement.addEventListener('pointerleave', onClayPointerUp);
  renderer.domElement.style.cursor = 'none';

  showToast('进入黏土模式 · 拖拽雕刻');
  updateClayInfo();
}

function exitClayMode() {
  // 保存最终状态
  if (clay.isSculpting) {
    clay.isSculpting = false;
    saveClayUndo();
  }

  clay.active = false;
  clay.target = null;
  clay.cursor.visible = false;
  clay.cursorNormal.visible = false;

  document.getElementById('clay-panel').style.display = 'none';
  document.getElementById('clay-info').style.display = 'none';

  renderer.domElement.removeEventListener('pointerdown', onClayPointerDown);
  renderer.domElement.removeEventListener('pointermove', onClayPointerMove);
  renderer.domElement.removeEventListener('pointerup', onClayPointerUp);
  renderer.domElement.removeEventListener('pointerleave', onClayPointerUp);
  renderer.domElement.style.cursor = '';

  showToast('退出黏土模式');
}

function saveClayUndo() {
  if (!clay.target) return;
  const obj = clay.target;
  const pos = obj.geometry.attributes.position.array.slice();
  state.undoStack.push(JSON.stringify({
    type: 'clay',
    objectId: obj.userData.id,
    positions: Array.from(pos),
  }));
  if (state.undoStack.length > 50) state.undoStack.shift();
  state.redoStack = [];
}

function updateClayInfo() {
  if (!clay.target) return;
  const count = clay.target.geometry.attributes.position.count / 3;
  document.getElementById('clay-vert-count').textContent = Math.round(count);
}

// -------- 雕刻事件处理 ----------
function getClayHit(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  clay.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  clay.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  clay.raycaster.setFromCamera(clay.pointer, camera);

  // 只检测雕刻目标
  const intersects = clay.raycaster.intersectObject(clay.target, false);
  if (intersects.length > 0) {
    const hit = intersects[0];
    clay.hitPoint.copy(hit.point);
    clay.hitNormal.copy(hit.face.normal).transformDirection(clay.target.matrixWorld);
    return true;
  }
  return false;
}

function onClayPointerDown(event) {
  if (!clay.active || !clay.target) return;
  // 只响应左键
  if (event.button !== 0) return;

  if (!getClayHit(event)) return;

  clay.isSculpting = true;
  clay.lastPointer.set(event.clientX, event.clientY);
  orbitControls.enabled = false;

  // 缓存顶点数据提高性能
  cacheClayVertices();

  // 应用一次
  applyClayBrush(event);
}

function onClayPointerMove(event) {
  // 更新光标位置
  if (!clay.active || !clay.target) return;

  if (getClayHit(event)) {
    clay.cursor.position.copy(clay.hitPoint);
    // 让环朝向法线方向
    const up = new THREE.Vector3(0, 1, 0);
    const quat = new THREE.Quaternion().setFromUnitVectors(up, clay.hitNormal);
    clay.cursor.quaternion.copy(quat);
    // 缩放环到笔刷大小
    clay.cursor.scale.set(clay.brushSize, clay.brushSize, clay.brushSize);

    // 法线指示线
    clay.cursorNormal.position.copy(clay.hitPoint);
    const dir = clay.hitNormal.clone().multiplyScalar(clay.brushSize * 0.5);
    const pts = [new THREE.Vector3(0, 0, 0), dir];
    clay.cursorNormal.geometry.dispose();
    clay.cursorNormal.geometry = new THREE.BufferGeometry().setFromPoints(pts);

    clay.cursor.visible = true;
    clay.cursorNormal.visible = true;
  } else {
    clay.cursor.visible = false;
    clay.cursorNormal.visible = false;
  }

  if (!clay.isSculpting) return;

  // 检测Shift=凹陷, Ctrl=平滑
  applyClayBrush(event);
  clay.lastPointer.set(event.clientX, event.clientY);
}

function onClayPointerUp(event) {
  if (!clay.isSculpting) return;
  clay.isSculpting = false;
  orbitControls.enabled = true;
  saveClayUndo();

  // 更新法线
  if (clay.target) {
    clay.target.geometry.computeVertexNormals();
    clay.target.geometry.attributes.position.needsUpdate = true;
  }
}

// -------- 缓存顶点数据 ----------
function cacheClayVertices() {
  if (!clay.target) return;
  const geo = clay.target.geometry;
  const pos = geo.attributes.position;
  const vertCount = pos.count;

  // 确保是非索引几何体
  if (geo.index) {
    const newGeo = geo.toNonIndexed();
    clay.target.geometry = newGeo;
    geo.dispose();
  }

  const newGeo = clay.target.geometry;
  const newPos = newGeo.attributes.position;
  clay.vertCache = [];
  for (let i = 0; i < newPos.count; i++) {
    const idx = i * 3;
    clay.vertCache.push({
      index: i,
      orig: new THREE.Vector3(newPos.array[idx], newPos.array[idx + 1], newPos.array[idx + 2]),
      normal: new THREE.Vector3(0, 0, 0),
    });
  }

  // 计算顶点法线 (简单平均面法线)
  computeClayVertexNormals();
}

function computeClayVertexNormals() {
  const geo = clay.target.geometry;
  const pos = geo.attributes.position;
  const vertCount = pos.count;
  const faceCount = vertCount / 3;

  // 重置法线
  for (let i = 0; i < vertCount; i++) {
    clay.vertCache[i].normal.set(0, 0, 0);
  }

  // 计算每个面的法线，累加到顶点
  const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  for (let f = 0; f < faceCount; f++) {
    const i0 = f * 3, i1 = f * 3 + 1, i2 = f * 3 + 2;
    const p = pos.array;
    v1.set(p[i0 * 3], p[i0 * 3 + 1], p[i0 * 3 + 2]);
    v2.set(p[i1 * 3], p[i1 * 3 + 1], p[i1 * 3 + 2]);
    v3.set(p[i2 * 3], p[i2 * 3 + 1], p[i2 * 3 + 2]);
    e1.subVectors(v2, v1);
    e2.subVectors(v3, v1);
    const fn = new THREE.Vector3().crossVectors(e1, e2).normalize();
    clay.vertCache[i0].normal.add(fn);
    clay.vertCache[i1].normal.add(fn);
    clay.vertCache[i2].normal.add(fn);
  }

  // 归一化
  for (let i = 0; i < vertCount; i++) {
    clay.vertCache[i].normal.normalize();
  }
}

// -------- 应用笔刷 ----------
function applyClayBrush(event) {
  if (!clay.target || !clay.isSculpting) return;

  const shift = event.shiftKey;
  const ctrl = event.ctrlKey || event.metaKey;
  const brushType = ctrl ? 'smooth' : (shift ? 'push' : clay.brushType);

  const geo = clay.target.geometry;
  const pos = geo.attributes.position;
  const radius = clay.brushSize;
  const strength = clay.brushStrength * 0.05;

  // 将hitPoint转换到局部空间
  const localHit = clay.hitPoint.clone();
  clay.target.worldToLocal(localHit);

  // 找到半径内的所有顶点
  const sqRadius = radius * radius;
  const affectedVerts = [];

  for (let i = 0; i < clay.vertCache.length; i++) {
    const vc = clay.vertCache[i];
    const dx = vc.orig.x - localHit.x;
    const dy = vc.orig.y - localHit.y;
    const dz = vc.orig.z - localHit.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq < sqRadius) {
      const dist = Math.sqrt(distSq);
      const influence = 1 - (dist / radius);
      affectedVerts.push({ index: i, dist, influence: Math.max(0, influence * influence) });
    }
  }

  if (affectedVerts.length === 0) return;

  // 根据笔刷类型处理顶点
  const vWorld = new THREE.Vector3();
  const nWorld = new THREE.Vector3();

  switch (brushType) {
    case 'push': {
      // 沿法线方向推拉
      const dragDir = new THREE.Vector3(
        event.clientX - clay.lastPointer.x,
        event.clientY - clay.lastPointer.y,
        0
      );
      const pushSign = dragDir.length() > 1 ? Math.sign(dragDir.y) : 1;
      affectedVerts.forEach(({ index, influence }) => {
        const vc = clay.vertCache[index];
        const offset = strength * influence * pushSign;
        vc.orig.x += vc.normal.x * offset;
        vc.orig.y += vc.normal.y * offset;
        vc.orig.z += vc.normal.z * offset;
      });
      break;
    }
    case 'smooth': {
      // 拉普拉斯平滑
      const smoothFactor = strength * 2;
      const avgPositions = [];
      affectedVerts.forEach(({ index }) => {
        let avgX = 0, avgY = 0, avgZ = 0, count = 0;
        // 找相邻顶点（共享面的顶点）
        const vc = clay.vertCache[index];
        // 简单近似：平均附近顶点
        affectedVerts.forEach(({ index: j }) => {
          if (j === index) return;
          const vj = clay.vertCache[j];
          const d = vc.orig.distanceTo(vj.orig);
          if (d < radius * 0.4) {
            avgX += vj.orig.x; avgY += vj.orig.y; avgZ += vj.orig.z;
            count++;
          }
        });
        if (count > 0) {
          avgPositions.push({
            index,
            x: avgX / count,
            y: avgY / count,
            z: avgZ / count,
          });
        }
      });
      avgPositions.forEach(({ index, x, y, z }) => {
        const vc = clay.vertCache[index];
        vc.orig.x += (x - vc.orig.x) * smoothFactor;
        vc.orig.y += (y - vc.orig.y) * smoothFactor;
        vc.orig.z += (z - vc.orig.z) * smoothFactor;
      });
      break;
    }
    case 'inflate': {
      // 沿法线膨胀
      affectedVerts.forEach(({ index, influence }) => {
        const vc = clay.vertCache[index];
        const offset = strength * influence;
        vc.orig.x += vc.normal.x * offset;
        vc.orig.y += vc.normal.y * offset;
        vc.orig.z += vc.normal.z * offset;
      });
      break;
    }
    case 'flatten': {
      // 压平到接触平面
      const planeNormal = clay.hitNormal.clone();
      clay.target.worldToLocal(planeNormal);
      const planePoint = localHit.clone();
      affectedVerts.forEach(({ index, influence }) => {
        const vc = clay.vertCache[index];
        const toPoint = clay.tempVec.copy(vc.orig).sub(planePoint);
        const dist = toPoint.dot(planeNormal);
        const offset = dist * influence * strength * 5;
        vc.orig.x -= planeNormal.x * offset;
        vc.orig.y -= planeNormal.y * offset;
        vc.orig.z -= planeNormal.z * offset;
      });
      break;
    }
  }

  // 更新几何体
  affectedVerts.forEach(({ index }) => {
    const vc = clay.vertCache[index];
    const i3 = index * 3;
    pos.array[i3] = vc.orig.x;
    pos.array[i3 + 1] = vc.orig.y;
    pos.array[i3 + 2] = vc.orig.z;
  });
  pos.needsUpdate = true;
  geo.computeVertexNormals();
}
const viewport = document.getElementById('viewport');
const scene = new THREE.Scene();
// 渐变天空盒 — 明亮蓝白
const canvas = document.createElement('canvas');
canvas.width = 2; canvas.height = 256;
const ctx = canvas.getContext('2d');
const grad = ctx.createLinearGradient(0, 0, 0, 256);
grad.addColorStop(0, '#e8f0fe');
grad.addColorStop(0.4, '#f0f4f8');
grad.addColorStop(1, '#f5f5f7');
ctx.fillStyle = grad;
ctx.fillRect(0, 0, 2, 256);
const bgTexture = new THREE.CanvasTexture(canvas);
scene.background = bgTexture;

const camera = new THREE.PerspectiveCamera(45, viewport.clientWidth / viewport.clientHeight, 0.1, 1000);
camera.position.set(6, 4, 8);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(viewport.clientWidth, viewport.clientHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.NoToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
viewport.insertBefore(renderer.domElement, viewport.firstChild);

// ===== 光照（中性白光，确保颜色准确） =====
const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
scene.add(ambientLight);

const mainLight = new THREE.DirectionalLight(0xffffff, 1.8);
mainLight.position.set(8, 12, 6);
mainLight.castShadow = true;
mainLight.shadow.mapSize.width = 1024;
mainLight.shadow.mapSize.height = 1024;
scene.add(mainLight);

const fillLight = new THREE.DirectionalLight(0xffffff, 0.6);
fillLight.position.set(-4, 2, -6);
scene.add(fillLight);

const rimLight = new THREE.DirectionalLight(0xffffff, 0.35);
rimLight.position.set(-2, -1, 8);
scene.add(rimLight);

// ===== 网格 =====
const gridHelper = new THREE.Group();

const grid = new THREE.GridHelper(20, 20, 0x0071e3, 0xbbbbcc);
grid.material.transparent = true;
grid.material.opacity = 0.35;
gridHelper.add(grid);

const gridFine = new THREE.GridHelper(20, 100, 0x0071e3, 0xd0d0dd);
gridFine.material.transparent = true;
gridFine.material.opacity = 0.15;
gridHelper.add(gridFine);

scene.add(gridHelper);

// ===== 坐标轴 =====
const axesHelper = new THREE.AxesHelper(3);
scene.add(axesHelper);

// ===== 地面 (阴影接收) =====
const groundGeo = new THREE.PlaneGeometry(20, 20);
const groundMat = new THREE.ShadowMaterial({ opacity: 0.3 });
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.01;
ground.receiveShadow = true;
scene.add(ground);

// ============================================================
//  控制器
// ============================================================
const orbitControls = new OrbitControls(camera, renderer.domElement);
orbitControls.enableDamping = true;
orbitControls.dampingFactor = 0.1;
orbitControls.minDistance = 0.5;
orbitControls.maxDistance = 50;
orbitControls.target.set(0, 0, 0);

const transformControls = new TransformControls(camera, renderer.domElement);
transformControls.setSize(0.8);
scene.add(transformControls);

// 当transform控件激活时禁用orbit
transformControls.addEventListener('dragging-changed', (event) => {
  orbitControls.enabled = !event.value;
  state.transformActive = event.value;
  if (!event.value) {
    updatePropertyPanel();
    saveUndoState();
  }
});

// ============================================================
//  工具函数
// ============================================================
function generateId() {
  return `obj_${++state.objectIdCounter}`;
}

function getObjectById(id) {
  return state.objects.find(o => o.userData.id === id) || null;
}

function getObjectIndex(id) {
  return state.objects.findIndex(o => o.userData.id === id);
}

// ============================================================
//  序列化 / 反序列化 (用于Undo)
// ============================================================
function serializeObject(obj) {
  const m = obj.userData.material;
  const isGroup = !(obj as any).isMesh;
  const data: any = {
    id: obj.userData.id,
    name: obj.userData.name,
    type: obj.userData.type || 'group',
    geometry: isGroup ? 'Group' : obj.geometry.type,
    geometryParams: obj.userData.geometryParams || {},
    position: obj.position.toArray(),
    rotation: [obj.rotation.x, obj.rotation.y, obj.rotation.z, obj.rotation.order],
    scale: obj.scale.toArray(),
    color: m ? m.color.getHex() : 0x4fc3f7,
    metalness: m ? m.metalness : 0.1,
    roughness: m ? m.roughness : 0.6,
    wireframe: m ? m.wireframe : false,
    flatShading: m ? m.flatShading : false,
    isGroup,
  };
  if (!isGroup) {
    if (obj.userData.type === 'library' || obj.userData.type === 'ai-generated') {
      const pos = obj.geometry.attributes.position;
      data._vertices = Array.from(pos.array);
      const norm = obj.geometry.attributes.normal;
      data._normals = norm ? Array.from(norm.array) : null;
      const uv = obj.geometry.attributes.uv;
      data._uvs = uv ? Array.from(uv.array) : null;
    }
  } else {
    const children: any[] = [];
    obj.children.forEach((child: any) => {
      if (child.isMesh) children.push(serializeObject(child));
    });
    data._children = children;
  }
  return data;
}

function deserializeObject(data) {
  if (data.isGroup && data._children) {
    const group = new THREE.Group();
    group.userData.id = data.id;
    group.userData.name = data.name;
    group.userData.type = data.type;
    group.userData.geometryParams = data.geometryParams;
    group.position.fromArray(data.position);
    group.rotation.set(data.rotation[0], data.rotation[1], data.rotation[2]);
    if (data.rotation[3]) group.rotation.order = data.rotation[3];
    group.scale.fromArray(data.scale);
    group.castShadow = true;
    group.receiveShadow = true;
    data._children.forEach((cd: any) => {
      const child = deserializeObject(cd);
      group.add(child);
    });
    return group;
  }
  let geo;
  if ((data.type === 'library' || data.type === 'ai-generated') && data._vertices) {
    geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(data._vertices), 3));
    if (data._normals) geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(data._normals), 3));
    if (data._uvs) geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(data._uvs), 2));
    if (!data._normals) geo.computeVertexNormals();
  } else {
    geo = createGeometry(data.type, data.geometryParams);
  }
  const mat = new THREE.MeshStandardMaterial({
    color: data.color,
    metalness: data.metalness,
    roughness: data.roughness,
    wireframe: data.wireframe,
    flatShading: data.flatShading || false,
    envMapIntensity: 0.4,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData.id = data.id;
  mesh.userData.name = data.name;
  mesh.userData.type = data.type;
  mesh.userData.geometryParams = data.geometryParams;
  mesh.userData.material = mat;
  mesh.position.fromArray(data.position);
  mesh.rotation.set(data.rotation[0], data.rotation[1], data.rotation[2]);
  if (data.rotation[3]) mesh.rotation.order = data.rotation[3];
  mesh.scale.fromArray(data.scale);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function saveUndoState() {
  const snap = state.objects.map(o => serializeObject(o));
  state.undoStack.push(JSON.stringify(snap));
  if (state.undoStack.length > 50) state.undoStack.shift();
  state.redoStack = [];
}

function undo() {
  if (state.undoStack.length === 0) return;
  const currentSnap = state.objects.map(o => serializeObject(o));
  state.redoStack.push(JSON.stringify(currentSnap));
  const prev = JSON.parse(state.undoStack.pop());
  restoreScene(prev);
  showToast('撤销');
}

function redo() {
  if (state.redoStack.length === 0) return;
  const currentSnap = state.objects.map(o => serializeObject(o));
  state.undoStack.push(JSON.stringify(currentSnap));
  const next = JSON.parse(state.redoStack.pop());
  restoreScene(next);
  showToast('重做');
}

function restoreScene(dataArray) {
  // 清除当前物体
  state.objects.forEach(o => {
    scene.remove(o);
    o.geometry.dispose();
    o.material.dispose();
  });
  state.objects = [];
  state.selected = null;
  transformControls.detach();

  // 重建
  dataArray.forEach(d => {
    const mesh = deserializeObject(d);
    scene.add(mesh);
    state.objects.push(mesh);
  });

  updateOutliner();
  updatePropertyPanel();
  updateSceneInfo();
}

// ============================================================
//  图形定义数据
// ============================================================
const SHAPES = [
  { type: 'box', label: '立方体', svg: '<svg viewBox="0 0 24 24"><path d="M21 16.5v-9L12 2 3 7.5v9L12 22l9-5.5zM12 4.33l6 3.5v5.34l-6 3.5-6-3.5V7.83l6-3.5z"/></svg>' },
  { type: 'sphere', label: '球体', svg: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.5"/><ellipse cx="12" cy="12" rx="10" ry="4" fill="none" stroke="currentColor" stroke-width="1" opacity="0.5"/></svg>' },
  { type: 'cylinder', label: '圆柱', svg: '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="6" rx="8" ry="3" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="4" y1="6" x2="4" y2="18" stroke="currentColor" stroke-width="1.5"/><line x1="20" y1="6" x2="20" y2="18" stroke="currentColor" stroke-width="1.5"/><ellipse cx="12" cy="18" rx="8" ry="3" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>' },
  { type: 'cone', label: '圆锥', svg: '<svg viewBox="0 0 24 24"><polygon points="12,2 4,18 20,18" fill="none" stroke="currentColor" stroke-width="1.5"/><ellipse cx="12" cy="18" rx="8" ry="3" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>' },
  { type: 'capsule', label: '胶囊', svg: '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>' },
  { type: 'torus', label: '圆环', svg: '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="12" rx="9" ry="6" fill="none" stroke="currentColor" stroke-width="1.5"/><ellipse cx="12" cy="12" rx="9" ry="3" fill="none" stroke="currentColor" stroke-width="0.8"/></svg>' },
  { type: 'torusKnot', label: '环面结', svg: '<svg viewBox="0 0 24 24"><path d="M12 4c-4.42 0-8 3.58-8 8s3.58 8 8 8 8-3.58 8-8-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6s2.69-6 6-6 6 2.69 6 6-2.69 6-6 6z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M12 6c-3.31 0-6 2.69-6 6" fill="none" stroke="currentColor" stroke-width="0.8"/></svg>' },
  { type: 'plane', label: '平面', svg: '<svg viewBox="0 0 24 24"><rect x="4" y="6" width="16" height="12" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="4" y1="10" x2="20" y2="10" stroke="currentColor" stroke-width="0.8"/><line x1="8" y1="6" x2="8" y2="18" stroke="currentColor" stroke-width="0.8"/></svg>' },
  { type: 'ring', label: '圆片', svg: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>' },
  { type: 'tetrahedron', label: '四面体', svg: '<svg viewBox="0 0 24 24"><polygon points="12,2 4,18 20,18" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="12" y1="2" x2="12" y2="18" stroke="currentColor" stroke-width="0.8" opacity="0.4"/><line x1="4" y1="18" x2="20" y2="18" stroke="currentColor" stroke-width="0.8" opacity="0.4"/></svg>' },
  { type: 'octahedron', label: '八面体', svg: '<svg viewBox="0 0 24 24"><polygon points="12,2 20,12 12,22 4,12" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="4" y1="12" x2="20" y2="12" stroke="currentColor" stroke-width="0.8" opacity="0.4"/></svg>' },
  { type: 'dodecahedron', label: '十二面体', svg: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><polygon points="12,3 18,7 18,17 12,21 6,17 6,7" fill="none" stroke="currentColor" stroke-width="0.8" opacity="0.4"/></svg>' },
  { type: 'icosahedron', label: '二十面体', svg: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.5"/><polygon points="12,3 20,9 17,19 7,19 4,9" fill="none" stroke="currentColor" stroke-width="0.8" opacity="0.4"/></svg>' },
  { type: 'lathe', label: '花瓶', svg: '<svg viewBox="0 0 24 24"><path d="M8 2c0 0-2 4-2 8s2 8 2 8h4c0 0 2-4 2-8s-2-8-2-8H8z" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="8" y1="2" x2="12" y2="2" stroke="currentColor" stroke-width="1.5"/></svg>' },
  { type: 'helix', label: '弹簧', svg: '<svg viewBox="0 0 24 24"><path d="M4 6c0 0 4-2 8 0s8 0 8 0" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M4 12c0 0 4 2 8 0s8 0 8 0" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M4 18c0 0 4-2 8 0s8 0 8 0" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>' },
  { type: 'star', label: '星形', svg: '<svg viewBox="0 0 24 24"><polygon points="12,2 15,9 22,9 16,14 18,21 12,17 6,21 8,14 2,9 9,9" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>' },
  { type: 'gear', label: '齿轮', svg: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="12" y1="5" x2="12" y2="3" stroke="currentColor" stroke-width="1.5"/><line x1="17" y1="7" x2="18.5" y2="5.5" stroke="currentColor" stroke-width="1.5"/><line x1="19" y1="12" x2="21" y2="12" stroke="currentColor" stroke-width="1.5"/><line x1="17" y1="17" x2="18.5" y2="18.5" stroke="currentColor" stroke-width="1.5"/><line x1="12" y1="19" x2="12" y2="21" stroke="currentColor" stroke-width="1.5"/><line x1="7" y1="17" x2="5.5" y2="18.5" stroke="currentColor" stroke-width="1.5"/><line x1="5" y1="12" x2="3" y2="12" stroke="currentColor" stroke-width="1.5"/><line x1="7" y1="7" x2="5.5" y2="5.5" stroke="currentColor" stroke-width="1.5"/></svg>' },
  { type: 'heart', label: '心形', svg: '<svg viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>' },
  { type: 'pyramid', label: '金字塔', svg: '<svg viewBox="0 0 24 24"><polygon points="12,2 22,20 2,20" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="12" y1="2" x2="12" y2="20" stroke="currentColor" stroke-width="0.8" opacity="0.4"/></svg>' },
  { type: 'donut', label: '甜甜圈', svg: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>' },
  { type: 'cross', label: '十字', svg: '<svg viewBox="0 0 24 24"><path d="M9 2h6v7h7v6h-7v7H9v-7H2v-6h7V2z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>' },
  { type: 'pipe', label: '弯管', svg: '<svg viewBox="0 0 24 24"><path d="M4 20v-8c0-4.42 3.58-8 8-8h8" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="4" cy="20" r="4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>' },
];

// ============================================================
//  几何体工厂
// ============================================================
function createGeometry(type, params = {}) {
  const p = params || {};
  switch (type) {
    case 'box': return new THREE.BoxGeometry(p.w || 1, p.h || 1, p.d || 1);
    case 'sphere': return new THREE.SphereGeometry(p.r || 0.6, p.segW || 32, p.segH || 24);
    case 'cylinder': return new THREE.CylinderGeometry(p.rT || 0.6, p.rB || 0.6, p.h || 1.2, p.seg || 32);
    case 'cone': return new THREE.ConeGeometry(p.r || 0.6, p.h || 1.2, p.seg || 32);
    case 'capsule': return new THREE.CapsuleGeometry(p.r || 0.4, p.len || 0.8, p.capSeg || 8, p.radSeg || 16);
    case 'torus': return new THREE.TorusGeometry(p.r || 0.6, p.t || 0.2, p.segR || 16, p.segT || 32);
    case 'torusKnot': return new THREE.TorusKnotGeometry(p.r || 0.5, p.t || 0.2, p.seg || 64, p.segT || 16);
    case 'plane': return new THREE.PlaneGeometry(p.w || 1.2, p.h || 1.2);
    case 'ring': return new THREE.RingGeometry(p.iR || 0.2, p.oR || 0.6, p.seg || 32);
    case 'tetrahedron': return new THREE.TetrahedronGeometry(p.r || 0.7);
    case 'octahedron': return new THREE.OctahedronGeometry(p.r || 0.7);
    case 'dodecahedron': return new THREE.DodecahedronGeometry(p.r || 0.7);
    case 'icosahedron': return new THREE.IcosahedronGeometry(p.r || 0.7);
    case 'lathe': return createLatheGeometry();
    case 'helix': return createHelixGeometry();
    case 'star': return createStarGeometry();
    case 'gear': return createGearGeometry();
    case 'heart': return createHeartGeometry();
    case 'pyramid': return new THREE.ConeGeometry(p.r || 0.6, p.h || 1.2, 4, 1);
    case 'donut': return new THREE.TorusGeometry(p.r || 0.6, p.t || 0.3, p.segR || 24, p.segT || 48);
    case 'cross': return createCrossGeometry();
    case 'pipe': return createPipeGeometry();
    default: return new THREE.BoxGeometry(1, 1, 1);
  }
}

function createLatheGeometry() {
  const points = [];
  points.push(new THREE.Vector2(0.05, 0));
  points.push(new THREE.Vector2(0.4, 0.3));
  points.push(new THREE.Vector2(0.5, 0.5));
  points.push(new THREE.Vector2(0.45, 0.7));
  points.push(new THREE.Vector2(0.25, 0.85));
  points.push(new THREE.Vector2(0.2, 1.0));
  points.push(new THREE.Vector2(0.35, 1.15));
  points.push(new THREE.Vector2(0.38, 1.25));
  points.push(new THREE.Vector2(0.3, 1.35));
  points.push(new THREE.Vector2(0.05, 1.4));
  return new THREE.LatheGeometry(points, 24);
}

function createHelixGeometry() {
  const pts = [];
  const turns = 3;
  const height = 1.8;
  const radius = 0.5;
  const segments = turns * 30;
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const angle = t * turns * Math.PI * 2;
    const x = radius * Math.cos(angle);
    const z = radius * Math.sin(angle);
    const y = t * height - height / 2;
    pts.push(new THREE.Vector3(x, y, z));
  }
  const curve = new THREE.CatmullRomCurve3(pts);
  return new THREE.TubeGeometry(curve, segments, 0.12, 8, false);
}

function createStarGeometry() {
  const shape = new THREE.Shape();
  const outerR = 0.55, innerR = 0.25, spikes = 5;
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const angle = (i / (spikes * 2)) * Math.PI * 2 - Math.PI / 2;
    const x = Math.cos(angle) * r, y = Math.sin(angle) * r;
    if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
  }
  shape.closePath();
  const ext = new THREE.ExtrudeGeometry(shape, { depth: 0.12, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 2 });
  ext.translate(0, 0, -0.06);
  return ext;
}

function createGearGeometry() {
  const shape = new THREE.Shape();
  const outerR = 0.55, innerR = 0.35, teeth = 8, toothW = 0.06, toothH = 0.12;
  const arcPerTooth = (Math.PI * 2) / teeth;
  for (let i = 0; i < teeth; i++) {
    const a1 = i * arcPerTooth - arcPerTooth * 0.15;
    const a2 = i * arcPerTooth + arcPerTooth * 0.15;
    const a3 = i * arcPerTooth + arcPerTooth * 0.35;
    const a4 = (i + 1) * arcPerTooth - arcPerTooth * 0.35;
    const x1 = Math.cos(a1) * outerR, y1 = Math.sin(a1) * outerR;
    const x2 = Math.cos(a2) * outerR, y2 = Math.sin(a2) * outerR;
    const x3 = Math.cos(a3) * (outerR + toothH), y3 = Math.sin(a3) * (outerR + toothH);
    const x4 = Math.cos(a4) * (outerR + toothH), y4 = Math.sin(a4) * (outerR + toothH);
    if (i === 0) shape.moveTo(x1, y1);
    shape.lineTo(x1, y1);
    shape.lineTo(x2, y2);
    shape.lineTo(x3, y3);
    shape.lineTo(x4, y4);
  }
  shape.closePath();
  const hole = new THREE.Path();
  hole.absarc(0, 0, innerR, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  const ext = new THREE.ExtrudeGeometry(shape, { depth: 0.12, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 2 });
  ext.translate(0, 0, -0.06);
  return ext;
}

function createHeartGeometry() {
  const shape = new THREE.Shape();
  const scale = 0.45;
  shape.moveTo(0 * scale, 0 * scale);
  shape.bezierCurveTo(0 * scale, -0.3 * scale, -1 * scale, -0.6 * scale, -1 * scale, -1 * scale);
  shape.bezierCurveTo(-1 * scale, -1.6 * scale, 0 * scale, -1.6 * scale, 0 * scale, -1.4 * scale);
  shape.bezierCurveTo(0 * scale, -1.6 * scale, 1 * scale, -1.6 * scale, 1 * scale, -1 * scale);
  shape.bezierCurveTo(1 * scale, -0.6 * scale, 0 * scale, -0.3 * scale, 0 * scale, 0 * scale);
  const ext = new THREE.ExtrudeGeometry(shape, { depth: 0.1, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 3 });
  ext.translate(0, 0.1, -0.05);
  return ext;
}

function createCrossGeometry() {
  const shape = new THREE.Shape();
  const s = 0.4;
  shape.moveTo(-0.15, -s); shape.lineTo(0.15, -s);
  shape.lineTo(0.15, -0.15); shape.lineTo(s, -0.15);
  shape.lineTo(s, 0.15); shape.lineTo(0.15, 0.15);
  shape.lineTo(0.15, s); shape.lineTo(-0.15, s);
  shape.lineTo(-0.15, 0.15); shape.lineTo(-s, 0.15);
  shape.lineTo(-s, -0.15); shape.lineTo(-0.15, -0.15);
  shape.closePath();
  const ext = new THREE.ExtrudeGeometry(shape, { depth: 0.1, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 2 });
  ext.translate(0, 0, -0.05);
  return ext;
}

function createPipeGeometry() {
  const pts = [
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0.3, 0.3, 0),
    new THREE.Vector3(0.8, 0.3, 0),
    new THREE.Vector3(1.0, 0.3, -0.2),
    new THREE.Vector3(1.0, 0.3, -0.8),
  ];
  const curve = new THREE.CatmullRomCurve3(pts);
  return new THREE.TubeGeometry(curve, 40, 0.08, 8, false);
}

function getDefaultParams(type) {
  switch (type) {
    case 'box': return { w: 1, h: 1, d: 1 };
    case 'sphere': return { r: 0.6, segW: 32, segH: 24 };
    case 'cylinder': return { rT: 0.6, rB: 0.6, h: 1.2, seg: 32 };
    case 'cone': return { r: 0.6, h: 1.2, seg: 32 };
    case 'capsule': return { r: 0.4, len: 0.8, capSeg: 8, radSeg: 16 };
    case 'plane': return { w: 1.2, h: 1.2 };
    case 'torus': return { r: 0.6, t: 0.2, segR: 16, segT: 32 };
    case 'torusKnot': return { r: 0.5, t: 0.2, seg: 64, segT: 16 };
    case 'ring': return { iR: 0.2, oR: 0.6, seg: 32 };
    case 'tetrahedron': return { r: 0.7 };
    case 'octahedron': return { r: 0.7 };
    case 'dodecahedron': return { r: 0.7 };
    case 'icosahedron': return { r: 0.7 };
    case 'lathe': return {};
    case 'helix': return {};
    case 'star': return {};
    case 'gear': return {};
    case 'heart': return {};
    case 'pyramid': return { r: 0.6, h: 1.2 };
    case 'donut': return { r: 0.6, t: 0.3, segR: 24, segT: 48 };
    case 'cross': return {};
    case 'pipe': return {};
    default: return {};
  }
}

function getTypeLabel(type) {
  const map: Record<string, string> = {};
  SHAPES.forEach(s => { map[s.type] = s.label; });
  map['library'] = '素材';
  map['ai-generated'] = '🤖 AI';
  return map[type] || type;
}

// ============================================================
//  材质预设 — 自然界材质
// ============================================================
const MATERIAL_PRESETS = [
  { name: '草地', icon: '🌿', color: '#4caf50', metalness: 0.0, roughness: 0.85, flatShading: false },
  { name: '水', icon: '💧', color: '#2196f3', metalness: 0.6, roughness: 0.1, flatShading: false },
  { name: '沙子', icon: '🏖', color: '#f4d03f', metalness: 0.0, roughness: 0.9, flatShading: false },
  { name: '岩石', icon: '🪨', color: '#8d8d8d', metalness: 0.05, roughness: 0.7, flatShading: false },
  { name: '木材', icon: '🪵', color: '#8b5e3c', metalness: 0.0, roughness: 0.8, flatShading: false },
  { name: '金属', icon: '🔩', color: '#c0c0c0', metalness: 0.95, roughness: 0.2, flatShading: false },
  { name: '冰', icon: '🧊', color: '#b3e5fc', metalness: 0.3, roughness: 0.05, flatShading: false },
  { name: '泥土', icon: '🟤', color: '#6d4c41', metalness: 0.0, roughness: 0.95, flatShading: false },
  { name: '雪', icon: '❄️', color: '#fafafa', metalness: 0.0, roughness: 0.4, flatShading: false },
  { name: '岩浆', icon: '🌋', color: '#ff5722', metalness: 0.1, roughness: 0.3, flatShading: false },
  { name: '翡翠', icon: '💎', color: '#00bcd4', metalness: 0.4, roughness: 0.15, flatShading: false },
  { name: '红砖', icon: '🧱', color: '#c0392b', metalness: 0.0, roughness: 0.75, flatShading: false },
  { name: '黄金', icon: '🥇', color: '#ffd700', metalness: 1.0, roughness: 0.1, flatShading: false },
  { name: '皮革', icon: '👜', color: '#5d4037', metalness: 0.0, roughness: 0.7, flatShading: false },
  { name: '云', icon: '☁️', color: '#eceff1', metalness: 0.0, roughness: 0.95, flatShading: false },
  { name: '陶瓷', icon: '🏺', color: '#f5f5f5', metalness: 0.1, roughness: 0.3, flatShading: false },
];

function applyMaterialPreset(presetName) {
  if (!state.selected) {
    showToast('请先选择物体');
    return;
  }
  const preset = MATERIAL_PRESETS.find(p => p.name === presetName);
  if (!preset) return;
  const mat = state.selected.userData.material;
  mat.color.set(preset.color);
  mat.metalness = preset.metalness;
  mat.roughness = preset.roughness;
  if (preset.flatShading !== undefined) mat.flatShading = preset.flatShading;
  mat.needsUpdate = true;
  updatePropertyPanel();
  updateOutliner();
  saveUndoState();
  showToast(`材质 → ${preset.name}`);
}

function renderMaterialPresets(container) {
  container.innerHTML = '';
  MATERIAL_PRESETS.forEach(preset => {
    const btn = document.createElement('button');
    btn.className = 'material-preset-btn';
    btn.innerHTML = `<span class="mp-icon">${preset.icon}</span><span class="mp-name">${preset.name}</span>`;
    btn.title = `${preset.name} — 颜色:${preset.color} 金属:${preset.metalness} 粗糙:${preset.roughness}`;
    btn.addEventListener('click', () => applyMaterialPreset(preset.name));
    container.appendChild(btn);
  });
}

// ============================================================
//  物体管理
// ============================================================
function addObject(type) {
  const params = getDefaultParams(type);
  const geo = createGeometry(type, params);
  const mat = new THREE.MeshStandardMaterial({
    color: randomColor(),
    metalness: 0.1,
    roughness: 0.6,
    envMapIntensity: 0.4,
  });
  const mesh = new THREE.Mesh(geo, mat);
  const id = generateId();
  mesh.userData.id = id;
  mesh.userData.name = `${getTypeLabel(type)} ${state.objectIdCounter}`;
  mesh.userData.type = type;
  mesh.userData.geometryParams = params;
  mesh.userData.material = mat;
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  // 随机偏移位置避免重叠
  mesh.position.set(
    (Math.random() - 0.5) * 3,
    0.5,
    (Math.random() - 0.5) * 3
  );

  scene.add(mesh);
  state.objects.push(mesh);
  saveUndoState();
  selectObject(mesh);
  updateOutliner();
  updateSceneInfo();
  showToast(`添加 ${mesh.userData.name}`);
  return mesh;
}

function randomColor() {
  const colors = [0x0071e3, 0x34c759, 0xff9f0a, 0xff3b30, 0xaf52de, 0x5ac8fa, 0xaed581, 0xff8a65];
  return colors[Math.floor(Math.random() * colors.length)];
}

function deleteSelected() {
  if (!state.selected) return;
  // 如果在黏土模式且正在雕刻目标，先退出黏土模式
  if (clay.active && clay.target === state.selected) {
    exitClayMode();
    state.toolMode = 'select';
    document.querySelectorAll('.tool-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tool === 'select');
    });
  }
  const obj = state.selected;
  saveUndoState();
  const name = obj.userData.name;
  scene.remove(obj);
  const idx = getObjectIndex(obj.userData.id);
  if (idx !== -1) state.objects.splice(idx, 1);
  obj.geometry.dispose();
  obj.material.dispose();
  state.selected = null;
  transformControls.detach();
  updateOutliner();
  updatePropertyPanel();
  updateSceneInfo();
  showToast(`删除 ${name}`);
}

function duplicateSelected() {
  if (!state.selected) return;
  saveUndoState();
  const data = serializeObject(state.selected);
  data.id = generateId();
  data.name = `${state.selected.userData.name} (副本)`;
  // 偏移位置
  data.position[0] += 0.8;
  data.position[2] += 0.8;
  const mesh = deserializeObject(data);
  scene.add(mesh);
  state.objects.push(mesh);
  selectObject(mesh);
  updateOutliner();
  updateSceneInfo();
  showToast(`复制 ${mesh.userData.name}`);
}

// ============================================================
//  选择系统
// ============================================================
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

function selectObject(obj) {
  state.selected = obj;
  if (obj && state.toolMode !== 'select') {
    transformControls.attach(obj);
  } else if (obj && state.toolMode === 'select') {
    transformControls.detach();
  } else {
    transformControls.detach();
  }
  updatePropertyPanel();
  updateOutliner();
  updateGizmoIndicator();
}

function onPointerDown(event) {
  if (state.transformActive) return;
  if (clay.active) return; // 黏土模式自行处理
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(pointer, camera);
  const intersects = raycaster.intersectObjects(state.objects, false);

  if (intersects.length > 0) {
    const obj = intersects[0].object;
    selectObject(obj);
  } else {
    // 点击空白取消选择
    state.selected = null;
    transformControls.detach();
    updatePropertyPanel();
    updateOutliner();
    updateGizmoIndicator();
  }
}

renderer.domElement.addEventListener('pointerdown', onPointerDown);

function selectAll() {
  if (state.objects.length === 0) return;
  // 选中第一个物体（简单多选暂未实现）
  selectObject(state.objects[0]);
  showToast(`选中 ${state.objects[0].userData.name}（Tab 切换）`);
}

function selectNext() {
  if (state.objects.length === 0) return;
  const idx = state.selected ? getObjectIndex(state.selected.userData.id) : -1;
  const nextIdx = (idx + 1) % state.objects.length;
  selectObject(state.objects[nextIdx]);
}

// ============================================================
//  UI 更新
// ============================================================
function updatePropertyPanel() {
  const obj = state.selected;
  const nameInput = document.getElementById('obj-name');
  const typeSpan = document.getElementById('obj-type');

  if (!obj) {
    nameInput.value = '未选择';
    nameInput.disabled = true;
    typeSpan.textContent = '-';
    document.getElementById('pos-x').value = 0;
    document.getElementById('pos-y').value = 0;
    document.getElementById('pos-z').value = 0;
    document.getElementById('rot-x').value = 0;
    document.getElementById('rot-y').value = 0;
    document.getElementById('rot-z').value = 0;
    document.getElementById('scl-x').value = 1;
    document.getElementById('scl-y').value = 1;
    document.getElementById('scl-z').value = 1;
    return;
  }

  nameInput.value = obj.userData.name;
  nameInput.disabled = false;
  typeSpan.textContent = getTypeLabel(obj.userData.type);

  document.getElementById('pos-x').value = obj.position.x.toFixed(2);
  document.getElementById('pos-y').value = obj.position.y.toFixed(2);
  document.getElementById('pos-z').value = obj.position.z.toFixed(2);

  const deg = (v) => THREE.MathUtils.radToDeg(v).toFixed(1);
  document.getElementById('rot-x').value = deg(obj.rotation.x);
  document.getElementById('rot-y').value = deg(obj.rotation.y);
  document.getElementById('rot-z').value = deg(obj.rotation.z);

  document.getElementById('scl-x').value = obj.scale.x.toFixed(2);
  document.getElementById('scl-y').value = obj.scale.y.toFixed(2);
  document.getElementById('scl-z').value = obj.scale.z.toFixed(2);

  const mat = obj.userData.material;
  if (mat) {
    document.getElementById('mat-color').value = '#' + mat.color.getHexString();
    document.getElementById('mat-metal').value = mat.metalness;
    document.getElementById('mat-rough').value = mat.roughness;
    document.getElementById('mat-wireframe').checked = mat.wireframe;
    document.getElementById('mat-shading').value = mat.flatShading ? 'flat' : 'smooth';
  }
}

function updateOutliner() {
  const list = document.getElementById('outliner-list');
  list.innerHTML = '';
  state.objects.forEach(obj => {
    const li = document.createElement('li');
    li.dataset.id = obj.userData.id;
    if (state.selected && state.selected.userData.id === obj.userData.id) {
      li.classList.add('selected');
    }
    if (!obj.visible) li.style.opacity = '0.4';

    // 颜色图标
    const icon = document.createElement('span');
    icon.className = 'obj-icon';
    const matColor = obj.userData.material ? obj.userData.material.color : null;
    icon.style.background = matColor ? '#' + matColor.getHexString() : '#888';
    icon.textContent = (obj as any).isMesh ? '◇' : '▦';

    // 名称（双击重命名）
    const name = document.createElement('span');
    name.className = 'obj-name';
    name.textContent = obj.userData.name;
    name.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      renameObject(obj);
    });

    // 可见性按钮（眼睛）
    const visBtn = document.createElement('button');
    visBtn.className = 'ol-action-btn';
    visBtn.textContent = obj.visible !== false ? '👁' : '—';
    visBtn.title = obj.visible !== false ? '隐藏' : '显示';
    visBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      obj.visible = obj.visible !== false ? false : true;
      updateOutliner();
    });

    // 锁定按钮
    const lockBtn = document.createElement('button');
    lockBtn.className = 'ol-action-btn';
    lockBtn.textContent = obj.userData.locked ? '🔒' : '🔓';
    lockBtn.title = obj.userData.locked ? '解锁' : '锁定';
    lockBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      obj.userData.locked = !obj.userData.locked;
      updateOutliner();
    });

    li.appendChild(icon);
    li.appendChild(name);
    li.appendChild(visBtn);
    li.appendChild(lockBtn);
    li.addEventListener('click', () => {
      if (!obj.userData.locked) selectObject(obj);
    });
    list.appendChild(li);
  });
}

// 3D 光标
const cursor3D = new THREE.Mesh(
  new THREE.SphereGeometry(0.08, 16, 16),
  new THREE.MeshBasicMaterial({ color: 0xff0000, depthTest: false, depthWrite: false })
);
cursor3D.renderOrder = 999;
cursor3D.position.set(0, 0, 0);
scene.add(cursor3D);
const cursorRing = new THREE.Mesh(
  new THREE.TorusGeometry(0.12, 0.02, 8, 24),
  new THREE.MeshBasicMaterial({ color: 0xff0000, depthTest: false, depthWrite: false, transparent: true, opacity: 0.5 })
);
cursorRing.renderOrder = 999;
cursorRing.rotation.x = -Math.PI / 2;
cursor3D.add(cursorRing);

// 吸附状态
let snapEnabled = false;
let snapIncrement = 0.5;
const pivotModes = ['各自原点', '3D光标'];
let pivotMode = 0; // 0=各自原点, 1=3D光标

function toggleSnap() {
  snapEnabled = !snapEnabled;
  document.getElementById('snap-indicator').textContent = snapEnabled ? `吸附: ${snapIncrement}` : '吸附: 关';
  showToast(snapEnabled ? `吸附开启 (增量: ${snapIncrement})` : '吸附关闭');
}

function togglePivotMode() {
  pivotMode = (pivotMode + 1) % pivotModes.length;
  if (pivotMode === 1 && state.selected) {
    const obj = state.selected;
    transformControls.detach();
    const worldPos = new THREE.Vector3();
    obj.getWorldPosition(worldPos);
    cursor3D.position.copy(worldPos);
    transformControls.attach(obj);
  }
  showToast(`轴心: ${pivotModes[pivotMode]}`);
}

function snapValue(val) {
  if (!snapEnabled) return val;
  return Math.round(val / snapIncrement) * snapIncrement;
}

function mirrorSelected(axis) {
  if (!state.selected) { showToast('请先选择物体'); return; }
  saveUndoState();
  const data = serializeObject(state.selected);
  data.id = generateId();
  data.name = `${state.selected.userData.name} (镜像${axis.toUpperCase()})`;
  if (axis === 'x') { data.position[0] *= -1; data.rotation[1] *= -1; }
  else if (axis === 'y') { data.position[1] *= -1; data.rotation[0] *= -1; }
  else if (axis === 'z') { data.position[2] *= -1; data.rotation[2] *= -1; }
  const mesh = deserializeObject(data);
  scene.add(mesh);
  state.objects.push(mesh);
  selectObject(mesh);
  updateOutliner();
  updateSceneInfo();
  showToast(`镜像复制 (${axis.toUpperCase()})`);
}

function toggleWireframe() {
  if (!state.selected) { showToast('请先选择物体'); return; }
  const mat = state.selected.userData.material;
  mat.wireframe = !mat.wireframe;
  mat.needsUpdate = true;
  saveUndoState();
  updatePropertyPanel();
  showToast(mat.wireframe ? '线框: 开' : '线框: 关');
}

function showShortcutsHelp() {
  const help = document.getElementById('shortcuts-modal');
  if (!help) return;
  help.classList.toggle('open');
}

function renderShortcutsHelp() {
  const container = document.getElementById('shortcuts-list');
  if (!container) return;
  container.innerHTML = '';
  SHORTCUTS_DATA.forEach(([key, desc]) => {
    const k = document.createElement('span');
    k.style.cssText = 'background:var(--gray-100);padding:1px 6px;border-radius:3px;font-family:monospace;font-weight:600;color:var(--blue);';
    k.textContent = key;
    const d = document.createElement('span');
    d.style.color = 'var(--gray-600)';
    d.textContent = desc;
    container.appendChild(k);
    container.appendChild(d);
  });
  // Close on click outside
  document.getElementById('shortcuts-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.classList.remove('open');
  });
}

// 快捷键帮助面板内容
const SHORTCUTS_DATA = [
  ['Q', '选择工具'], ['W', '移动'], ['E', '旋转'], ['R', '缩放'],
  ['T', '黏土雕刻'], ['G', '浮灵模式'], ['F', '聚焦选中'],
  ['Shift+D', '复制'], ['Del', '删除'], ['Ctrl+Z', '撤销'],
  ['Ctrl+Y', '重做'], ['Tab', '切换选择'], ['Home', '重置视角'],
  ['Shift+M', '镜像复制'], ['Ctrl+W', '切换线框'], ['F1', '快捷键帮助'],
  ['Numpad 1', '前视图'], ['Numpad 7', '顶视图'], ['Numpad 3', '右视图'],
];
function updateSceneInfo() {
  document.getElementById('scene-info').textContent = `物体数: ${state.objects.length}`;
}

function updateGizmoIndicator() {
  const el = document.getElementById('gizmo-indicator');
  if (ghost.active) {
    el.textContent = '🌊 浮灵模式';
    el.classList.add('show');
  } else if (state.toolMode === 'clay' && clay.target) {
    el.textContent = `✋ 黏土: ${clay.target.userData.name}`;
    el.classList.add('show');
  } else if (state.selected && state.toolMode !== 'select') {
    const modeMap = { translate: '移动', rotate: '旋转', scale: '缩放' };
    el.textContent = `${modeMap[state.toolMode]}: ${state.selected.userData.name}`;
    el.classList.add('show');
  } else if (state.selected) {
    el.textContent = `选择: ${state.selected.userData.name}`;
    el.classList.add('show');
  } else {
    el.classList.remove('show');
    el.textContent = '';
  }
}

// ============================================================
//  属性面板双向绑定
// ============================================================
function setupPropertyBindings() {
  const bindings = [
    { id: 'pos-x', fn: (v) => { if (state.selected) { state.selected.position.x = parseFloat(v); } } },
    { id: 'pos-y', fn: (v) => { if (state.selected) { state.selected.position.y = parseFloat(v); } } },
    { id: 'pos-z', fn: (v) => { if (state.selected) { state.selected.position.z = parseFloat(v); } } },
    { id: 'rot-x', fn: (v) => { if (state.selected) { state.selected.rotation.x = THREE.MathUtils.degToRad(parseFloat(v)); } } },
    { id: 'rot-y', fn: (v) => { if (state.selected) { state.selected.rotation.y = THREE.MathUtils.degToRad(parseFloat(v)); } } },
    { id: 'rot-z', fn: (v) => { if (state.selected) { state.selected.rotation.z = THREE.MathUtils.degToRad(parseFloat(v)); } } },
    { id: 'scl-x', fn: (v) => { if (state.selected) { state.selected.scale.x = Math.max(0.01, parseFloat(v)); } } },
    { id: 'scl-y', fn: (v) => { if (state.selected) { state.selected.scale.y = Math.max(0.01, parseFloat(v)); } } },
    { id: 'scl-z', fn: (v) => { if (state.selected) { state.selected.scale.z = Math.max(0.01, parseFloat(v)); } } },
  ];

  bindings.forEach(({ id, fn }) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => {
      fn(el.value);
      if (state.selected) {
        updateOutliner();
        // Save undo on mouse up (change event instead)
      }
    });
    el.addEventListener('change', () => {
      if (state.selected) saveUndoState();
    });
  });

  // 材质
  document.getElementById('mat-color').addEventListener('input', (e) => {
    if (!state.selected) return;
    const mat = state.selected.userData.material;
    if (mat) mat.color.set((e.target as HTMLInputElement).value);
  });
  document.getElementById('mat-color').addEventListener('change', () => {
    if (state.selected) saveUndoState();
  });

  document.getElementById('mat-metal').addEventListener('input', (e) => {
    if (!state.selected) return;
    const mat = state.selected.userData.material;
    if (mat) mat.metalness = parseFloat((e.target as HTMLInputElement).value);
  });
  document.getElementById('mat-metal').addEventListener('change', () => {
    if (state.selected) saveUndoState();
  });

  document.getElementById('mat-rough').addEventListener('input', (e) => {
    if (!state.selected) return;
    const mat = state.selected.userData.material;
    if (mat) mat.roughness = parseFloat((e.target as HTMLInputElement).value);
  });
  document.getElementById('mat-rough').addEventListener('change', () => {
    if (state.selected) saveUndoState();
  });

  document.getElementById('mat-wireframe').addEventListener('change', (e) => {
    if (!state.selected) return;
    const mat = state.selected.userData.material;
    if (mat) { mat.wireframe = (e.target as HTMLInputElement).checked; saveUndoState(); }
  });

  document.getElementById('mat-shading').addEventListener('change', (e) => {
    if (!state.selected) return;
    const mat = state.selected.userData.material;
    if (mat) { mat.flatShading = (e.target as HTMLSelectElement).value === 'flat'; mat.needsUpdate = true; saveUndoState(); }
  });

  // 名称
  document.getElementById('obj-name').addEventListener('change', (e) => {
    if (!state.selected) return;
    state.selected.userData.name = e.target.value;
    updateOutliner();
    updateGizmoIndicator();
    saveUndoState();
  });

  // -------- 黏土控制绑定 ----------
  document.getElementById('clay-brush-type').addEventListener('change', (e) => {
    clay.brushType = e.target.value;
  });

  document.getElementById('clay-size').addEventListener('input', (e) => {
    clay.brushSize = parseFloat(e.target.value);
    document.getElementById('clay-size-val').textContent = clay.brushSize.toFixed(2);
    // 更新光标大小
    if (clay.cursor) {
      clay.cursor.scale.set(clay.brushSize, clay.brushSize, clay.brushSize);
    }
  });

  document.getElementById('clay-strength').addEventListener('input', (e) => {
    clay.brushStrength = parseFloat(e.target.value);
    document.getElementById('clay-strength-val').textContent = clay.brushStrength.toFixed(2);
  });

  document.getElementById('clay-subdivide').addEventListener('click', () => {
    if (!clay.target) { showToast('请先进入黏土模式'); return; }
    subdivideTargetMesh(1);
  });
}

// ============================================================
//  工具模式切换
// ============================================================
function setToolMode(mode) {
  // 浮灵模式切换
  if (mode === 'ghost') {
    if (ghost.active) {
      exitGhostMode();
      const prevMode = ghost.prevActiveTool !== 'ghost' ? ghost.prevActiveTool : 'select';
      state.toolMode = prevMode;
      document.querySelectorAll('.tool-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tool === prevMode);
      });
      if (prevMode !== 'select' && state.selected) {
        transformControls.setMode(prevMode);
        transformControls.attach(state.selected);
      } else {
        transformControls.detach();
      }
      updateGizmoIndicator();
      return;
    }
    enterGhostMode();
    return;
  }

  // 如果当前在浮灵模式，切换到其他模式时先退出
  if (ghost.active) {
    exitGhostMode();
  }

  // 黏土模式切换
  if (mode === 'clay') {
    if (state.toolMode === 'clay') {
      exitClayMode();
      state.toolMode = 'select';
      document.querySelectorAll('.tool-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tool === 'select');
      });
      updateGizmoIndicator();
      return;
    }
    // 如果从其他模式切换到黏土，先退出transform控件
    if (state.toolMode !== 'select') {
      transformControls.detach();
    }
    state.toolMode = mode;
    document.querySelectorAll('.tool-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tool === mode);
    });
    enterClayMode();
    updateGizmoIndicator();
    return;
  }

  // 从黏土模式切换到其他模式
  if (state.toolMode === 'clay') {
    exitClayMode();
  }

  state.toolMode = mode;
  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === mode);
  });
  if (mode === 'select') {
    transformControls.detach();
    transformControls.setMode('translate');
  } else {
    transformControls.setMode(mode);
    if (state.selected) {
      transformControls.attach(state.selected);
    }
  }
  updateGizmoIndicator();
}

// ============================================================
//  浮灵模式 (Ghost/Fly) — Roblox 风格
// ============================================================
const ghost = {
  active: false,
  yaw: 0,
  pitch: 0,
  speed: 4,
  keys: { forward: false, backward: false, left: false, right: false, up: false, down: false },
  euler: new THREE.Euler(0, 0, 0, 'YXZ'),
  quat: new THREE.Quaternion(),
  vec: new THREE.Vector3(),
  onPointerLockChange: null,
  onMouseMove: null,
  onKeyDown: null,
  onKeyUp: null,
  prevActiveTool: 'select',
};

function toggleGhostMode() {
  if (ghost.active) {
    exitGhostMode();
  } else {
    enterGhostMode();
  }
}

function enterGhostMode() {
  if (clay.active) exitClayMode();
  if (state.toolMode === 'clay') {
    document.querySelectorAll('.tool-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tool === 'select');
    });
  }

  ghost.prevActiveTool = state.toolMode;
  state.toolMode = 'ghost';
  ghost.active = true;

  // 更新工具栏按钮高亮
  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === 'ghost');
  });

  // 禁用 OrbitControls
  orbitControls.enabled = false;
  transformControls.detach();

  // 从当前相机初始化朝向
  ghost.euler.setFromQuaternion(camera.quaternion, 'YXZ');
  ghost.yaw = ghost.euler.y;
  ghost.pitch = ghost.euler.x;

  // 重置按键状态
  ghost.keys = { forward: false, backward: false, left: false, right: false, up: false, down: false };

  // 显示HUD和准星
  document.getElementById('ghost-hud').classList.add('show');
  document.getElementById('ghost-crosshair').classList.add('show');

  // 请求指针锁定
  renderer.domElement.requestPointerLock();

  showToast('🌊 浮灵模式 · WASD 移动 · 鼠标环顾');
  updateGizmoIndicator();
}

function exitGhostMode() {
  if (!ghost.active) return;

  ghost.active = false;
  state.toolMode = ghost.prevActiveTool !== 'ghost' ? ghost.prevActiveTool : 'select';

  // 更新工具栏
  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === state.toolMode);
  });

  // 恢复 OrbitControls
  orbitControls.enabled = true;

  // 退出指针锁定
  if (document.pointerLockElement) {
    document.exitPointerLock();
  }

  // 隐藏HUD和准星
  document.getElementById('ghost-hud').classList.remove('show');
  document.getElementById('ghost-crosshair').classList.remove('show');

  // 重置按键
  ghost.keys = { forward: false, backward: false, left: false, right: false, up: false, down: false };

  renderer.domElement.style.cursor = '';

  showToast('退出浮灵模式');
  updateGizmoIndicator();
}

function setupGhostControls() {
  // 指针锁定变化
  ghost.onPointerLockChange = () => {
    if (!document.pointerLockElement && ghost.active) {
      // 指针解锁时如果还在浮灵模式，重新请求
      // 但允许用户通过点击外部取消 - 不自动重锁
    }
  };
  document.addEventListener('pointerlockchange', ghost.onPointerLockChange);
  document.addEventListener('mozpointerlockchange', ghost.onPointerLockChange);

  // 鼠标移动 - 视角控制
  ghost.onMouseMove = (e) => {
    if (!ghost.active || !document.pointerLockElement) return;
    const sensitivity = 0.002;
    ghost.yaw -= e.movementX * sensitivity;
    ghost.pitch -= e.movementY * sensitivity;
    ghost.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, ghost.pitch));

    ghost.euler.set(ghost.pitch, ghost.yaw, 0, 'YXZ');
    camera.quaternion.setFromEuler(ghost.euler);
  };
  document.addEventListener('mousemove', ghost.onMouseMove);

  // 键盘按下
  ghost.onKeyDown = (e) => {
    if (!ghost.active) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    switch (e.code) {
      case 'KeyW': ghost.keys.forward = true; e.preventDefault(); break;
      case 'KeyS': ghost.keys.backward = true; e.preventDefault(); break;
      case 'KeyA': ghost.keys.left = true; e.preventDefault(); break;
      case 'KeyD': ghost.keys.right = true; e.preventDefault(); break;
      case 'Space': ghost.keys.up = true; e.preventDefault(); break;
      case 'ShiftLeft': case 'ShiftRight': ghost.keys.down = true; e.preventDefault(); break;
    }
  };
  document.addEventListener('keydown', ghost.onKeyDown);

  // 键盘释放
  ghost.onKeyUp = (e) => {
    if (!ghost.active) return;
    switch (e.code) {
      case 'KeyW': ghost.keys.forward = false; e.preventDefault(); break;
      case 'KeyS': ghost.keys.backward = false; e.preventDefault(); break;
      case 'KeyA': ghost.keys.left = false; e.preventDefault(); break;
      case 'KeyD': ghost.keys.right = false; e.preventDefault(); break;
      case 'Space': ghost.keys.up = false; e.preventDefault(); break;
      case 'ShiftLeft': case 'ShiftRight': ghost.keys.down = false; e.preventDefault(); break;
    }
  };
  document.addEventListener('keyup', ghost.onKeyUp);

  // 点击视口时重新锁定指针
  renderer.domElement.addEventListener('click', () => {
    if (ghost.active && !document.pointerLockElement) {
      renderer.domElement.requestPointerLock();
    }
  });
}

function updateGhostMovement(delta) {
  if (!ghost.active) return;

  const speed = ghost.speed * delta;
  const dir = ghost.vec.set(0, 0, 0);

  // 获取相机朝向向量
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  const up = new THREE.Vector3(0, 1, 0);

  // 水平移动（忽略俯仰影响）
  forward.y = 0;
  forward.normalize();
  right.y = 0;
  right.normalize();

  if (ghost.keys.forward) dir.add(forward);
  if (ghost.keys.backward) dir.sub(forward);
  if (ghost.keys.left) dir.sub(right);
  if (ghost.keys.right) dir.add(right);
  if (ghost.keys.up) dir.add(up);
  if (ghost.keys.down) dir.sub(up);

  if (dir.length() > 0) {
    dir.normalize().multiplyScalar(speed);
    camera.position.add(dir);
    orbitControls.target.copy(camera.position);
  }
}

// ============================================================
//  视口视角控制
// ============================================================
function setView(viewName) {
  const dist = 8;
  let pos;
  switch (viewName) {
    case 'front': pos = [0, 0, dist]; break;
    case 'back': pos = [0, 0, -dist]; break;
    case 'top': pos = [0, dist, 0.01]; break;
    case 'bottom': pos = [0, -dist, 0.01]; break;
    case 'left': pos = [-dist, 0, 0]; break;
    case 'right': pos = [dist, 0, 0]; break;
    default: pos = [6, 4, 8]; break;
  }
  camera.position.set(pos[0], pos[1], pos[2]);
  camera.lookAt(0, 0, 0);
  orbitControls.target.set(0, 0, 0);
  orbitControls.update();
}

function toggleOrtho() {
  state.isOrtho = !state.isOrtho;
  if (state.isOrtho) {
    const half = 6;
    const orthoCamera = new THREE.OrthographicCamera(-half, half, half, -half, 0.1, 100);
    orthoCamera.position.copy(camera.position);
    orthoCamera.quaternion.copy(camera.quaternion);
    // We need to swap cameras, but OrbitControls doesn't support this easily.
    // For simplicity, we'll just show a toast.
    showToast('正交模式（实验性，需刷新）');
  } else {
    showToast('透视模式');
  }
  document.querySelector('[data-view="perspective"]').textContent = state.isOrtho ? '□' : '3D';
}

// ============================================================
//  导出 / 导入
// ============================================================
function exportSceneJSON() {
  if (state.objects.length === 0) { showToast('场景为空'); return; }
  const data = state.objects.map(o => serializeObject(o));
  const blob = new Blob([JSON.stringify({ version: 1, objects: data }, null, 2)], { type: 'application/json' });
  downloadBlob(blob, 'scene.json');
  showToast('场景已导出为 JSON');
}

function exportGLB() {
  if (state.objects.length === 0) { showToast('场景为空'); return; }
  showToast('正在导出 GLB...');
  // 使用 Three.js GLTFExporter
  import('three/addons/exporters/GLTFExporter.js').then(({ GLTFExporter }) => {
    const exporter = new GLTFExporter();
    const sceneCopy = new THREE.Scene();
    state.objects.forEach(o => {
      const clone = o.clone();
      sceneCopy.add(clone);
    });
    exporter.parse(sceneCopy, (glb) => {
      const blob = new Blob([glb], { type: 'application/octet-stream' });
      downloadBlob(blob, 'scene.glb');
      showToast('导出 GLB 完成');
    }, (err) => {
      console.error(err);
      showToast('导出失败');
    }, { binary: true });
  }).catch(() => {
    showToast('GLB导出器加载失败，请检查网络');
  });
}

function importSceneJSON(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      if (!data.objects || !Array.isArray(data.objects)) throw new Error('无效格式');
      saveUndoState();
      data.objects.forEach(d => {
        const mesh = deserializeObject(d);
        scene.add(mesh);
        state.objects.push(mesh);
      });
      updateOutliner();
      updateSceneInfo();
      showToast(`导入 ${data.objects.length} 个物体`);
    } catch (err) {
      showToast('文件格式错误: ' + err.message);
    }
  };
  reader.readAsText(file);
}

function importSceneGLB(file) {
  showToast('正在导入 GLB...');
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      const loader = new GLTFLoader();
      const arrayBuffer = e.target.result;
      const result = await new Promise((resolve, reject) => {
        loader.parse(arrayBuffer, '', resolve, reject);
      });

      const gltf = result;
      const imported = [];

      gltf.scene.traverse((child) => {
        if (child.isMesh) {
          // 生成唯一 ID 和名称
          const id = generateId();
          const name = child.name || `导入物体 ${state.objectIdCounter}`;
          child.userData.id = id;
          child.userData.name = name;
          child.userData.type = child.geometry.type;
          child.userData.geometryParams = getDefaultParams('box');
          child.userData.material = child.material;

          // 确保材质是 MeshStandardMaterial
          if (!child.material.isMeshStandardMaterial) {
            const srcColor = child.material.color ? child.material.color.getHex() : 0xcccccc;
            const mat = new THREE.MeshStandardMaterial({
              color: srcColor,
              metalness: child.material.metalness ?? 0.1,
              roughness: child.material.roughness ?? 0.6,
            });
            child.material = mat;
            child.userData.material = mat;
          }
          // 也确保现有 StandardMaterial 的 userData 引用正确
          child.userData.material = child.material;

          child.castShadow = true;
          child.receiveShadow = true;
          imported.push(child);
        }
      });

      if (imported.length === 0) {
        showToast('GLB 文件中未找到网格物体');
        return;
      }

      saveUndoState();
      imported.forEach(mesh => {
        scene.add(mesh);
        state.objects.push(mesh);
      });
      updateOutliner();
      updateSceneInfo();
      selectObject(imported[0]);
      showToast(`导入 GLB: ${imported.length} 个物体`);
    } catch (err) {
      console.error(err);
      showToast('GLB 导入失败: ' + err.message);
    }
  };
  reader.readAsArrayBuffer(file);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ============================================================
//  Toast 通知
// ============================================================
let toastTimeout = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => el.classList.remove('show'), 2000);
}

// 自定义输入对话框（替代 window.prompt，兼容 Tauri WebView）
function showInputDialog(label: string, defaultValue: string, onConfirm: (val: string) => void) {
  const existing = document.getElementById('custom-prompt-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'custom-prompt-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);';

  const box = document.createElement('div');
  box.style.cssText = 'background:rgba(255,255,255,0.95);backdrop-filter:blur(24px);border-radius:14px;padding:24px 28px;width:380px;max-width:90vw;box-shadow:0 20px 60px rgba(0,0,0,0.3);animation:modalSlideUp 0.2s cubic-bezier(0.22,1,0.36,1);';

  const title = document.createElement('div');
  title.style.cssText = 'font-size:14px;font-weight:600;color:var(--gray-800);margin-bottom:14px;';
  title.textContent = label;

  const input = document.createElement('input');
  input.type = 'text';
  input.value = defaultValue;
  input.style.cssText = 'width:100%;background:var(--gray-50);border:0.5px solid var(--gray-200);color:var(--gray-800);padding:8px 12px;border-radius:8px;font-size:13px;outline:none;font-family:inherit;box-sizing:border-box;';
  input.focus();
  input.select();

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:14px;';

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = '取消';
  cancelBtn.style.cssText = 'background:var(--gray-50);border:0.5px solid var(--gray-200);color:var(--gray-600);padding:6px 16px;border-radius:8px;cursor:pointer;font-size:12px;font-family:inherit;';

  const okBtn = document.createElement('button');
  okBtn.textContent = '确认';
  okBtn.style.cssText = 'background:var(--blue);border:none;color:#fff;padding:6px 16px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;font-family:inherit;';

  const close = (result: string | null) => {
    overlay.remove();
    if (result !== null) onConfirm(result);
  };

  cancelBtn.onclick = () => close(null);
  okBtn.onclick = () => close(input.value);
  input.onkeydown = (e) => { if (e.key === 'Enter') close(input.value); if (e.key === 'Escape') close(null); };
  overlay.onclick = (e) => { if (e.target === overlay) close(null); };

  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(okBtn);
  box.appendChild(title);
  box.appendChild(input);
  box.appendChild(btnRow);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  setTimeout(() => input.focus(), 50);
}

// ============================================================
//  FPS 计数器
// ============================================================
let frameCount = 0;
let lastFpsTime = 0;
function updateFPS(time) {
  frameCount++;
  if (time - lastFpsTime >= 1000) {
    document.getElementById('fps-counter').textContent = `FPS: ${frameCount}`;
    frameCount = 0;
    lastFpsTime = time;
  }
}

// ============================================================
//  动画循环
// ============================================================
let lastTime = 0;
function animate(time) {
  requestAnimationFrame(animate);
  const delta = lastTime ? Math.min((time - lastTime) / 1000, 0.1) : 0.016;
  lastTime = time;

  if (ghost.active) {
    updateGhostMovement(delta);
  } else {
    orbitControls.update();
  }
  renderer.render(scene, camera);
  updateFPS(time);
}

// ============================================================
//  图形选择弹窗
// ============================================================
function openShapeModal() {
  const grid = document.getElementById('shape-grid');
  grid.innerHTML = '';
  SHAPES.forEach(({ type, label, svg }) => {
    const btn = document.createElement('button');
    btn.className = 'modal-shape-btn';
    btn.innerHTML = `${svg}<span class="shape-label">${label}</span>`;
    btn.addEventListener('click', () => {
      addObject(type);
      closeShapeModal();
    });
    grid.appendChild(btn);
  });
  document.getElementById('shape-modal').classList.add('open');
}

function closeShapeModal() {
  document.getElementById('shape-modal').classList.remove('open');
}

// 键盘 Escape 关闭弹窗
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const modal = document.getElementById('shape-modal');
    if (modal.classList.contains('open')) closeShapeModal();
  }
});

// ============================================================
//  面板拖拽调整宽度
// ============================================================
function setupPanelResizer() {
  const resizer = document.getElementById('panel-resizer');
  const root = document.documentElement;
  let startX = 0, startWidth = 0;

  function onDragStart(e) {
    e.preventDefault();
    startX = e.clientX;
    startWidth = parseInt(getComputedStyle(root).getPropertyValue('--panel-w'));
    resizer.classList.add('active');
    document.addEventListener('mousemove', onDrag);
    document.addEventListener('mouseup', onDragEnd);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  function onDrag(e) {
    const dx = startX - e.clientX;
    const newWidth = Math.max(180, Math.min(500, startWidth + dx));
    root.style.setProperty('--panel-w', newWidth + 'px');
    // 实时更新分隔条位置
    resizer.style.right = newWidth + 'px';
  }

  function onDragEnd() {
    resizer.classList.remove('active');
    document.removeEventListener('mousemove', onDrag);
    document.removeEventListener('mouseup', onDragEnd);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }

  resizer.addEventListener('mousedown', onDragStart);
}

// ============================================================
//  右键菜单 — 场景集合
// ============================================================
let contextTarget = null;

function setupContextMenu() {
  const menu = document.getElementById('context-menu');

  // 右键显示菜单（使用事件委托）
  document.getElementById('outliner-list').addEventListener('contextmenu', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    e.preventDefault();
    const id = li.dataset.id;
    const obj = getObjectById(id);
    if (!obj) return;
    contextTarget = obj;
    selectObject(obj);

    // 定位菜单
    const x = Math.min(e.clientX, window.innerWidth - 160);
    const y = Math.min(e.clientY, window.innerHeight - 140);
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    menu.classList.add('open');
  });

  // 菜单项点击
  menu.addEventListener('click', (e) => {
    const item = e.target.closest('.context-menu-item');
    if (!item) return;
    const action = item.dataset.action;
    if (!contextTarget) return;

    switch (action) {
      case 'duplicate':
        duplicateObject(contextTarget);
        break;
      case 'delete':
        selectObject(contextTarget);
        deleteSelected();
        break;
      case 'rename':
        renameObject(contextTarget);
        break;
      case 'save-to-library':
        saveObjectToLibrary(contextTarget);
        break;
    }
    closeContextMenu();
  });

  // 点击其他地方关闭菜单
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.context-menu')) closeContextMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeContextMenu();
  });
}

function closeContextMenu() {
  document.getElementById('context-menu').classList.remove('open');
  contextTarget = null;
}

function duplicateObject(obj) {
  if (!obj) return;
  saveUndoState();
  const data = serializeObject(obj);
  data.id = generateId();
  data.name = `${obj.userData.name} (副本)`;
  data.position[0] += 0.8;
  data.position[2] += 0.8;
  const mesh = deserializeObject(data);
  scene.add(mesh);
  state.objects.push(mesh);
  selectObject(mesh);
  updateOutliner();
  updateSceneInfo();
  showToast(`复制 ${mesh.userData.name}`);
}

function renameObject(obj) {
  if (!obj) return;
  showInputDialog('输入新名称：', obj.userData.name, (newName) => {
    if (newName && newName.trim()) {
      obj.userData.name = newName.trim();
      updateOutliner();
      updatePropertyPanel();
      updateGizmoIndicator();
      saveUndoState();
      showToast(`已重命名为 ${newName}`);
    }
  });
}

// ============================================================
//  UI 事件绑定
// ============================================================
function setupUI() {
  // 工具按钮
  document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => setToolMode(btn.dataset.tool));
  });

  // 添加物体（弹窗选择）
  document.querySelectorAll('.tool-btn[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      switch (action) {
        case 'delete': deleteSelected(); break;
        case 'duplicate': duplicateSelected(); break;
        case 'frame-selected': frameSelected(); break;
      }
    });
  });

  // 添加图形弹窗
  document.getElementById('btn-add-shape').addEventListener('click', openShapeModal);
  document.getElementById('shape-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeShapeModal();
  });

  // 顶栏按钮
  document.querySelectorAll('.header-btn[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      switch (action) {
        case 'new-scene': newScene(); break;
        case 'save-scene': exportSceneJSON(); break;
        case 'load-scene': document.getElementById('file-input').click(); break;
        case 'export-glb': exportGLB(); break;
        case 'undo': undo(); break;
        case 'redo': redo(); break;
      }
    });
  });

  // 视口按钮
  document.querySelectorAll('.viewport-btn[data-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      if (view === 'perspective') {
        toggleOrtho();
      } else {
        setView(view);
      }
    });
  });

  document.querySelector('[data-action="frame-selected"]').addEventListener('click', frameSelected);

  document.querySelector('[data-action="reset-view"]').addEventListener('click', () => {
    camera.position.set(6, 4, 8);
    orbitControls.target.set(0, 0, 0);
    orbitControls.update();
    showToast('重置视角');
  });

  document.querySelector('[data-action="toggle-grid"]').addEventListener('click', () => {
    gridHelper.visible = !gridHelper.visible;
    showToast(gridHelper.visible ? '显示网格' : '隐藏网格');
  });

  document.querySelector('[data-action="toggle-axes"]').addEventListener('click', () => {
    axesHelper.visible = !axesHelper.visible;
    showToast(axesHelper.visible ? '显示坐标轴' : '隐藏坐标轴');
  });

  // 文件输入
  document.getElementById('file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const name = file.name.toLowerCase();
    if (name.endsWith('.json')) {
      importSceneJSON(file);
    } else if (name.endsWith('.glb') || name.endsWith('.gltf')) {
      importSceneGLB(file);
    } else {
      showToast('支持 .json / .glb / .gltf 格式');
    }
    e.target.value = '';
  });
}

function newScene() {
  if (state.objects.length > 0 && !confirm('确定要新建场景？当前修改将丢失。')) return;
  if (clay.active) exitClayMode();
  state.toolMode = 'select';
  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === 'select');
  });
  state.objects.forEach(o => {
    scene.remove(o);
    o.geometry.dispose();
    o.material.dispose();
  });
  state.objects = [];
  state.selected = null;
  state.undoStack = [];
  state.redoStack = [];
  transformControls.detach();
  updateOutliner();
  updatePropertyPanel();
  updateSceneInfo();
  updateGizmoIndicator();
  showToast('新建场景');
}

function frameSelected() {
  if (!state.selected) {
    // 适配所有物体
    if (state.objects.length === 0) return;
    const box = new THREE.Box3();
    state.objects.forEach(o => box.expandByObject(o));
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const dist = maxDim * 1.5 + 2;
    camera.position.set(center.x + dist * 0.6, center.y + dist * 0.4, center.z + dist * 0.6);
    orbitControls.target.copy(center);
    orbitControls.update();
  } else {
    const box = new THREE.Box3().setFromObject(state.selected);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const dist = maxDim * 2 + 1;
    camera.position.set(center.x + dist * 0.6, center.y + dist * 0.4, center.z + dist * 0.6);
    orbitControls.target.copy(center);
    orbitControls.update();
  }
}

// ============================================================
//  键盘快捷键
// ============================================================
function setupKeyboard() {
  document.addEventListener('keydown', (e) => {
    // 忽略输入框内的快捷键
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    const key = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;

    if (ctrl && key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    if (ctrl && key === 'z' && e.shiftKey) { e.preventDefault(); redo(); }
    if (ctrl && key === 'y') { e.preventDefault(); redo(); }
    if (key === 'g') { e.preventDefault(); setToolMode('ghost'); return; }
    if (ghost.active) return;
    if (key === 'f1') { e.preventDefault(); showShortcutsHelp(); return; }
    if (key === 'q') { e.preventDefault(); setToolMode('select'); }
    if (key === 'w') { e.preventDefault(); setToolMode('translate'); }
    if (key === 'e') { e.preventDefault(); setToolMode('rotate'); }
    if (key === 'r') { e.preventDefault(); setToolMode('scale'); }
    if (key === 't') { e.preventDefault(); setToolMode('clay'); }
    if (key === 'f') { e.preventDefault(); frameSelected(); }
    if (key === 'delete' || key === 'backspace') { e.preventDefault(); deleteSelected(); }
    if (key === 'd' && e.shiftKey) { e.preventDefault(); duplicateSelected(); }
    if (key === 'a' && ctrl) { e.preventDefault(); selectAll(); }
    if (key === 'm' && e.shiftKey) { e.preventDefault(); mirrorSelected('x'); }
    if (key === 'x' && e.shiftKey) { e.preventDefault(); toggleSnap(); }
    if (key === 'p') { e.preventDefault(); togglePivotMode(); }
    if (ctrl && key === 'w') { e.preventDefault(); toggleWireframe(); }
    if (key === 'home') { e.preventDefault();
      camera.position.set(6, 4, 8);
      orbitControls.target.set(0, 0, 0);
      orbitControls.update();
    }
    if (key === 'tab') { e.preventDefault(); selectNext(); }
  });
}

// ============================================================
//  窗口自适应
// ============================================================
//  捏土工作室 (Clay Studio) — 独立黏土雕刻模式
// ============================================================
const cs = {
  active: false,
  mesh: null as THREE.Mesh | null,
  material: null as THREE.MeshStandardMaterial | null,
  scene: null as THREE.Scene | null,
  camera: null as THREE.PerspectiveCamera | null,
  renderer: null as THREE.WebGLRenderer | null,
  orbitControls: null as any,
  gridHelper: null as THREE.Group | null,
  // Sculpting state
  brushType: 'push',
  brushSize: 0.8,
  brushStrength: 0.3,
  brushFalloff: 1.0,
  symmetry: false,
  wireframe: false,
  isSculpting: false,
  clayType: 'sphere',
  undoStack: [] as Float32Array[],
  redoStack: [] as Float32Array[],
  // Vertex cache
  vertCache: [] as { x: number; y: number; z: number; nx: number; ny: number; nz: number }[],
  // Sculpting hit
  raycaster: new THREE.Raycaster(),
  pointer: new THREE.Vector2(),
  hitPoint: new THREE.Vector3(),
  hitNormal: new THREE.Vector3(),
  lastPointer: new THREE.Vector2(),
  cursorRing: null as THREE.Mesh | null,
};

function csCreateGeometry(type: string): THREE.BufferGeometry {
  switch (type) {
    case 'sphere': {
      const geo = new THREE.SphereGeometry(1.2, 64, 48);
      // 添加表面躁点 — 像真黏土一样有微小凹凸
      csAddClayNoise(geo, 0.03, 2.5);
      return geo;
    }
    case 'block': {
      // 🧱 实心黏土方砖 — 大块、厚重、密实，像真黏土砖
      const geo = new THREE.BoxGeometry(2.0, 1.6, 2.0, 40, 32, 40);
      csAddClayNoise(geo, 0.06, 2.5);
      csRoundBoxEdges(geo, 0.15);
      return geo;
    }
    case 'cylinder': {
      const geo = new THREE.CylinderGeometry(0.9, 0.9, 2.0, 48, 28);
      csAddClayNoise(geo, 0.05, 2.0);
      return geo;
    }
    case 'lump': {
      // 不规则黏土块 — 手工揉捏感
      const base = new THREE.SphereGeometry(1.2, 56, 42);
      const pos = base.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const i3 = i * 3;
        const x = pos.array[i3], y = pos.array[i3+1], z = pos.array[i3+2];
        // 大幅度的低频噪声 = 整体形状不规则
        const noise = 1 + 0.18 * Math.sin(x*2.5 + z*1.7) * Math.cos(y*2.2 + x*1.3)
                        + 0.12 * Math.sin(x*4 + y*3 + z*5) * 0.5
                        + 0.08 * Math.cos(x*6 - z*4 + y*2);
        pos.array[i3] = x * noise;
        pos.array[i3+1] = y * (1 + 0.12 * Math.cos(x*3.5) * Math.sin(z*3.5));
        pos.array[i3+2] = z * noise;
      }
      // 表面细粒度躁点
      csAddClayNoise(base, 0.04, 3.0);
      base.computeVertexNormals();
      return base;
    }
    default: {
      const geo = new THREE.BoxGeometry(1.6, 1.2, 1.6, 32, 28, 32);
      csAddClayNoise(geo, 0.08, 1.8);
      csRoundBoxEdges(geo, 0.12);
      return geo;
    }
  }
}

// 添加表面噪声 — 让黏土看起来像真实的手工黏土
function csAddClayNoise(geo: THREE.BufferGeometry, strength: number, freq: number) {
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const i3 = i * 3;
    const x = pos.array[i3], y = pos.array[i3+1], z = pos.array[i3+2];
    const nx = x * freq, ny = y * freq, nz = z * freq;
    const n = Math.sin(nx*1.3 + ny*0.7 + nz*2.1) * Math.cos(ny*1.8 - nx*0.9 + nz*1.2)
            + Math.sin(nz*2.3 - nx*1.1 + ny*0.5) * 0.5
            + Math.cos(nx*3.7 + ny*2.9 + nz*1.3) * 0.3;
    const offset = n * strength;
    // 沿法线方向微移（简化为沿半径方向）
    const len = Math.sqrt(x*x + y*y + z*z) || 1;
    pos.array[i3] += (x/len) * offset;
    pos.array[i3+1] += (y/len) * offset;
    pos.array[i3+2] += (z/len) * offset;
  }
  geo.computeVertexNormals();
}

// 圆润盒子边角 — 通过沿法线移动顶点
function csRoundBoxEdges(geo: THREE.BufferGeometry, radius: number) {
  const pos = geo.attributes.position;
  const halfW = 0.80, halfH = 0.60, halfD = 0.80;
  for (let i = 0; i < pos.count; i++) {
    const i3 = i * 3;
    let x = pos.array[i3], y = pos.array[i3+1], z = pos.array[i3+2];
    // 限制在边界内并圆润
    const cx = Math.max(-halfW + radius, Math.min(halfW - radius, x));
    const cy = Math.max(-halfH + radius, Math.min(halfH - radius, y));
    const cz = Math.max(-halfD + radius, Math.min(halfD - radius, z));
    // 如果靠近边角，向圆角方向移动
    const dx = x - cx, dy = y - cy, dz = z - cz;
    const len = Math.sqrt(dx*dx + dy*dy + dz*dz);
    if (len > radius) {
      const scale = radius / len;
      pos.array[i3] = cx + dx * scale;
      pos.array[i3+1] = cy + dy * scale;
      pos.array[i3+2] = cz + dz * scale;
    }
  }
  geo.computeVertexNormals();
}

function csGetCurrentColor(): string {
  const active = document.querySelector('.cs-color-dot.active') as HTMLElement;
  return active?.dataset.csColor || '#c97d5e';
}

function csInitMesh(type: string) {
  if (cs.mesh) {
    cs.scene!.remove(cs.mesh);
    cs.mesh.geometry.dispose();
    cs.material?.dispose();
  }
  let geo = csCreateGeometry(type);
  if (geo.index) { const ni = geo.toNonIndexed(); geo.dispose(); geo = ni; }
  // 黏土材质 — 使用渐变着色模拟真实黏土的厚重感
  cs.material = new THREE.MeshToonMaterial({
    color: csGetCurrentColor(),
    side: THREE.DoubleSide,
  });
  cs.mesh = new THREE.Mesh(geo, cs.material);
  cs.mesh.castShadow = true;
  cs.mesh.receiveShadow = true;
  // 让黏土坐在桌面上（桌面顶部约 -1.51，方块半高 0.8）
  cs.mesh.position.y = -0.7;
  cs.scene!.add(cs.mesh);
  // 更新轨道控制目标
  cs.orbitControls!.target.set(0, -0.3, 0);
  cs.clayType = type;
  cs.undoStack = [];
  cs.redoStack = [];
  csRebuildVertCache();
  csUpdateStats();
}

function csRebuildVertCache() {
  if (!cs.mesh) return;
  const pos = cs.mesh.geometry.attributes.position;
  cs.vertCache = [];
  for (let i = 0; i < pos.count; i++) {
    const i3 = i * 3;
    cs.vertCache.push({
      x: pos.array[i3], y: pos.array[i3 + 1], z: pos.array[i3 + 2],
      nx: 0, ny: 0, nz: 0,
    });
  }
  csComputeNormals();
}

function csComputeNormals() {
  if (!cs.mesh) return;
  const pos = cs.mesh.geometry.attributes.position;
  const count = pos.count;
  const fc = count / 3;
  for (let i = 0; i < count; i++) { cs.vertCache[i].nx = 0; cs.vertCache[i].ny = 0; cs.vertCache[i].nz = 0; }
  const arr = pos.array;
  for (let f = 0; f < fc; f++) {
    const i0 = f * 3, i1 = f * 3 + 1, i2 = f * 3 + 2;
    const ax = arr[i1*3] - arr[i0*3], ay = arr[i1*3+1] - arr[i0*3+1], az = arr[i1*3+2] - arr[i0*3+2];
    const bx = arr[i2*3] - arr[i0*3], by = arr[i2*3+1] - arr[i0*3+1], bz = arr[i2*3+2] - arr[i0*3+2];
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const len = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;
    const nxf = nx/len, nyf = ny/len, nzf = nz/len;
    cs.vertCache[i0].nx += nxf; cs.vertCache[i0].ny += nyf; cs.vertCache[i0].nz += nzf;
    cs.vertCache[i1].nx += nxf; cs.vertCache[i1].ny += nyf; cs.vertCache[i1].nz += nzf;
    cs.vertCache[i2].nx += nxf; cs.vertCache[i2].ny += nyf; cs.vertCache[i2].nz += nzf;
  }
  for (let i = 0; i < count; i++) {
    const v = cs.vertCache[i];
    const l = Math.sqrt(v.nx*v.nx + v.ny*v.ny + v.nz*v.nz) || 1;
    v.nx /= l; v.ny /= l; v.nz /= l;
  }
}

function csSaveUndo() {
  if (!cs.mesh) return;
  cs.undoStack.push(new Float32Array(cs.mesh.geometry.attributes.position.array));
  if (cs.undoStack.length > 40) cs.undoStack.shift();
  cs.redoStack = [];
}

function csUndo() {
  if (cs.undoStack.length === 0) return;
  cs.redoStack.push(new Float32Array(cs.mesh!.geometry.attributes.position.array));
  cs.mesh!.geometry.attributes.position.array.set(cs.undoStack.pop()!);
  cs.mesh!.geometry.attributes.position.needsUpdate = true;
  cs.mesh!.geometry.computeVertexNormals();
  csRebuildVertCache();
  csUpdateStats();
}

function csRedo() {
  if (cs.redoStack.length === 0) return;
  cs.undoStack.push(new Float32Array(cs.mesh!.geometry.attributes.position.array));
  cs.mesh!.geometry.attributes.position.array.set(cs.redoStack.pop()!);
  cs.mesh!.geometry.attributes.position.needsUpdate = true;
  cs.mesh!.geometry.computeVertexNormals();
  csRebuildVertCache();
  csUpdateStats();
}

function csSubdivide() {
  if (!cs.mesh) return;
  csSaveUndo();
  const geo = cs.mesh.geometry;
  const pos = geo.attributes.position;
  const nonIndexed = geo.index ? geo.toNonIndexed() : geo.clone();
  const positions = nonIndexed.attributes.position.array;
  const fc = positions.length / 9;
  const np: number[] = [];
  const v = (i: number) => [positions[i*3], positions[i*3+1], positions[i*3+2]];
  const mid = (a: number[], b: number[]) => [(a[0]+b[0])/2, (a[1]+b[1])/2, (a[2]+b[2])/2];
  for (let f = 0; f < fc; f++) {
    const a = v(f*3), b = v(f*3+1), c = v(f*3+2);
    const mab = mid(a,b), mbc = mid(b,c), mca = mid(c,a);
    [a,mab,mca, b,mbc,mab, c,mca,mbc, mab,mbc,mca].forEach(vv => np.push(vv[0],vv[1],vv[2]));
  }
  const ng = new THREE.BufferGeometry();
  ng.setAttribute('position', new THREE.Float32BufferAttribute(np, 3));
  ng.computeVertexNormals();
  cs.mesh.geometry = ng;
  geo.dispose();
  csRebuildVertCache();
  csUpdateStats();
  showToast(`细分完成 — ${cs.vertCache.length.toLocaleString()} 顶点`);
}

function csGetHit(event: PointerEvent): boolean {
  if (!cs.mesh) return false;
  const rect = (document.getElementById('cs-viewport')!).getBoundingClientRect();
  cs.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  cs.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  cs.raycaster.setFromCamera(cs.pointer, cs.camera!);
  const hits = cs.raycaster.intersectObject(cs.mesh, false);
  if (hits.length > 0) {
    cs.hitPoint.copy(hits[0].point);
    cs.hitNormal.copy(hits[0].face!.normal).transformDirection(cs.mesh.matrixWorld);
    return true;
  }
  return false;
}

function csApplyBrush(event: PointerEvent) {
  if (!cs.mesh || !cs.isSculpting) return;
  const ctrl = event.ctrlKey || event.metaKey;
  const shift = event.shiftKey;
  const brushType = ctrl ? 'smooth' : cs.brushType;
  const pos = cs.mesh.geometry.attributes.position;
  const radius = cs.brushSize;
  const strength = cs.brushStrength * 0.06;
  const falloff = cs.brushFalloff;
  const localHit = cs.hitPoint.clone();
  cs.mesh.worldToLocal(localHit);
  const sqR = radius * radius;
  const outerR = radius * 1.8;  // 外围隆起区域
  const sqOuterR = outerR * outerR;

  type Affected = { index: number; influence: number; dist: number; mirror?: boolean };
  const inner: Affected[] = [];   // 笔刷核心区
  const outer: Affected[] = [];   // 外围隆起区

  for (let i = 0; i < cs.vertCache.length; i++) {
    const vc = cs.vertCache[i];
    const dx = vc.x - localHit.x, dy = vc.y - localHit.y, dz = vc.z - localHit.z;
    const ds = dx*dx + dy*dy + dz*dz;
    if (ds < sqR) {
      const d = Math.sqrt(ds);
      inner.push({ index: i, influence: Math.pow(Math.max(0, 1 - d/radius), falloff), dist: d });
    } else if (ds < sqOuterR) {
      const d = Math.sqrt(ds);
      outer.push({ index: i, influence: Math.pow(Math.max(0, 1 - (d-radius)/(outerR-radius)), falloff), dist: d });
    }
  }

  if (inner.length === 0) return;

  // 对称模式：镜像处理
  const allInner = [...inner], allOuter = [...outer];
  if (cs.symmetry) {
    const mh = localHit.clone(); mh.x = -mh.x;
    for (let i = 0; i < cs.vertCache.length; i++) {
      if (allInner.find(a => a.index === i) || allOuter.find(a => a.index === i)) continue;
      const vc = cs.vertCache[i];
      const dx = vc.x - mh.x, dy = vc.y - mh.y, dz = vc.z - mh.z;
      const ds = dx*dx + dy*dy + dz*dz;
      if (ds < sqR) {
        const d = Math.sqrt(ds);
        allInner.push({ index: i, influence: Math.pow(Math.max(0, 1 - d/radius), falloff), dist: d, mirror: true });
      } else if (ds < sqOuterR) {
        const d = Math.sqrt(ds);
        allOuter.push({ index: i, influence: Math.pow(Math.max(0, 1 - (d-radius)/(outerR-radius)), falloff), dist: d, mirror: true });
      }
    }
  }

  switch (brushType) {
    case 'push': {
      // 🍞 揉面效果：向内压 → 周围隆起（体积守恒）
      const dy = event.clientY - cs.lastPointer.y;
      const sign = shift ? -1 : (Math.abs(dy) > 1 ? Math.sign(dy) : 1);
      
      // 第一步：核心区向内移动
      let totalDisplaced = 0;
      allInner.forEach(({ index, influence }) => {
        const vc = cs.vertCache[index];
        const off = strength * influence * sign;
        vc.x += vc.nx * off;
        vc.y += vc.ny * off;
        vc.z += vc.nz * off;
        totalDisplaced += Math.abs(off) * influence;
      });

      // 第二步：外围区向外隆起，补偿被压入的体积
      if (totalDisplaced > 0 && allOuter.length > 0) {
        let totalOuterWeight = 0;
        allOuter.forEach(({ influence }) => { totalOuterWeight += influence; });
        if (totalOuterWeight > 0) {
          const redistributeStrength = totalDisplaced / totalOuterWeight * 0.7;
          allOuter.forEach(({ index, influence }) => {
            const vc = cs.vertCache[index];
            const off = redistributeStrength * influence * sign;
            vc.x -= vc.nx * off;  // 向外（反向）隆起
            vc.y -= vc.ny * off;
            vc.z -= vc.nz * off;
          });
        }
      }
      break;
    }
    case 'smooth': {
      // 拉普拉斯平滑
      const sf = strength * 3;
      const sm = new Map<number, { x: number; y: number; z: number; inf: number }>();
      const allVerts = [...allInner, ...allOuter];
      allVerts.forEach(({ index, influence }) => {
        let sx = 0, sy = 0, sz = 0, cnt = 0;
        const vc = cs.vertCache[index];
        allVerts.forEach(({ index: j }) => {
          if (j === index) return;
          const vj = cs.vertCache[j];
          const d = Math.sqrt((vc.x-vj.x)**2 + (vc.y-vj.y)**2 + (vc.z-vj.z)**2);
          if (d < radius*0.6) { sx += vj.x; sy += vj.y; sz += vj.z; cnt++; }
        });
        if (cnt > 0) sm.set(index, { x: sx/cnt, y: sy/cnt, z: sz/cnt, inf: influence });
      });
      sm.forEach(({ x, y, z, inf }, idx) => {
        const vc = cs.vertCache[idx];
        const f = sf * inf;
        vc.x += (x - vc.x) * f; vc.y += (y - vc.y) * f; vc.z += (z - vc.z) * f;
      });
      break;
    }
    case 'inflate': {
      const sign = shift ? -1 : 1;
      allInner.forEach(({ index, influence }) => {
        const vc = cs.vertCache[index];
        const off = strength * influence * sign;
        vc.x += vc.nx * off; vc.y += vc.ny * off; vc.z += vc.nz * off;
      });
      break;
    }
    case 'flatten': {
      const pn = cs.hitNormal.clone(); cs.mesh!.worldToLocal(pn);
      allInner.forEach(({ index, influence }) => {
        const vc = cs.vertCache[index];
        const dx = vc.x - localHit.x, dy = vc.y - localHit.y, dz = vc.z - localHit.z;
        const dist = dx*pn.x + dy*pn.y + dz*pn.z;
        const off = dist * influence * strength * 8;
        vc.x -= pn.x * off; vc.y -= pn.y * off; vc.z -= pn.z * off;
      });
      break;
    }
    case 'pinch': {
      const sign = shift ? -1 : 1;
      // 捏夹：核心区向内聚拢
      let totalPinch = 0;
      allInner.forEach(({ index, influence }) => {
        const vc = cs.vertCache[index];
        const off = strength * influence * sign;
        vc.x += (localHit.x - vc.x) * off;
        vc.y += (localHit.y - vc.y) * off;
        vc.z += (localHit.z - vc.z) * off;
        totalPinch += Math.abs(off) * influence;
      });
      // 外围隆起补偿
      if (totalPinch > 0 && allOuter.length > 0) {
        let tw = 0; allOuter.forEach(({ influence }) => { tw += influence; });
        if (tw > 0) {
          const rs = totalPinch / tw * 0.5;
          allOuter.forEach(({ index, influence }) => {
            const vc = cs.vertCache[index];
            vc.x += (vc.x - localHit.x) * rs * influence;
            vc.y += (vc.y - localHit.y) * rs * influence;
            vc.z += (vc.z - localHit.z) * rs * influence;
          });
        }
      }
      break;
    }
    case 'grab': {
      const dx = event.clientX - cs.lastPointer.x;
      const dy = event.clientY - cs.lastPointer.y;
      const s = 0.012;
      [...allInner, ...allOuter].forEach(({ index, influence }) => {
        const vc = cs.vertCache[index];
        vc.x += dx * s * influence; vc.y -= dy * s * influence;
      });
      break;
    }
    case 'carve': {
      const sign = shift ? -1 : 1;
      allInner.forEach(({ index, influence }) => {
        const vc = cs.vertCache[index];
        const d = strength * influence * 0.15 * sign;
        vc.x -= vc.nx * d; vc.y -= vc.ny * d; vc.z -= vc.nz * d;
      });
      break;
    }
  }

  // 写回顶点数据
  const allModified = [...allInner, ...allOuter];
  allModified.forEach(({ index }) => {
    const vc = cs.vertCache[index];
    const i3 = index * 3;
    pos.array[i3] = vc.x; pos.array[i3+1] = vc.y; pos.array[i3+2] = vc.z;
  });
  pos.needsUpdate = true;
}

function csOnPointerDown(event: PointerEvent) {
  if (event.button !== 0) return;
  if (!csGetHit(event)) return;
  cs.isSculpting = true;
  cs.lastPointer.set(event.clientX, event.clientY);
  cs.orbitControls!.enabled = false;
  csSaveUndo();
  document.getElementById('cs-hud')!.classList.add('show');
  csApplyBrush(event);
}

function csOnPointerMove(event: PointerEvent) {
  if (!cs.mesh) return;
  if (csGetHit(event)) {
    if (cs.cursorRing) {
      cs.cursorRing.position.copy(cs.hitPoint);
      const up = new THREE.Vector3(0,1,0);
      cs.cursorRing.quaternion.setFromUnitVectors(up, cs.hitNormal);
      cs.cursorRing.scale.setScalar(cs.brushSize);
      cs.cursorRing.visible = true;
    }
  } else {
    if (cs.cursorRing) cs.cursorRing.visible = false;
  }
  if (!cs.isSculpting) return;
  csApplyBrush(event);
  cs.lastPointer.set(event.clientX, event.clientY);
}

function csOnPointerUp(_event: PointerEvent) {
  if (!cs.isSculpting) return;
  cs.isSculpting = false;
  cs.orbitControls!.enabled = true;
  document.getElementById('cs-hud')!.classList.remove('show');
  if (cs.mesh) {
    cs.mesh.geometry.computeVertexNormals();
    csComputeNormals();
    csUpdateStats();
  }
}

function csUpdateStats() {
  if (!cs.mesh) return;
  const vc = cs.mesh.geometry.attributes.position.count;
  const fc = vc / 3;
  const vertEl = document.getElementById('cs-stat-verts');
  const faceEl = document.getElementById('cs-stat-faces');
  const vertCountEl = document.getElementById('cs-vert-count');
  const brushEl = document.getElementById('cs-stat-brush');
  if (vertEl) vertEl.textContent = vc.toLocaleString();
  if (faceEl) faceEl.textContent = Math.round(fc).toLocaleString();
  if (vertCountEl) vertCountEl.textContent = `顶点: ${vc.toLocaleString()}`;
  const names: Record<string,string> = { push:'推拉', smooth:'平滑', inflate:'膨胀', flatten:'压平', pinch:'捏夹', grab:'拖拽', carve:'刻痕' };
  if (brushEl) brushEl.textContent = names[cs.brushType] || cs.brushType;
}

function csSetBrush(type: string) {
  cs.brushType = type;
  document.querySelectorAll('.cs-brush-btn').forEach(b => b.classList.toggle('active', (b as HTMLElement).dataset.csBrush === type));
  document.getElementById('cs-hud-brush')!.textContent = '✋ ' + ({push:'推拉',smooth:'平滑',inflate:'膨胀',flatten:'压平',pinch:'捏夹',grab:'拖拽',carve:'刻痕'} as any)[type];
  csUpdateStats();
}

function csSetClayType(type: string) {
  csSaveUndo();
  csInitMesh(type);
  document.querySelectorAll('.cs-clay-type-chip').forEach(b => b.classList.toggle('active', (b as HTMLElement).dataset.csClay === type));
}

function csToggleSymmetry() {
  cs.symmetry = !cs.symmetry;
  document.getElementById('btn-cs-symmetry')!.classList.toggle('active', cs.symmetry);
  const el = document.getElementById('cs-symmetry-indicator')!;
  if (cs.symmetry) el.classList.add('show'); else el.classList.remove('show');
  showToast(cs.symmetry ? '对称模式: 开' : '对称模式: 关');
  csUpdateStats();
}

function csToggleWireframe() {
  cs.wireframe = !cs.wireframe;
  if (cs.mesh) {
    if (cs.wireframe) {
      // 切换线框模式
      const wfMat = new THREE.MeshBasicMaterial({ color: csGetCurrentColor(), wireframe: true, side: THREE.DoubleSide });
      cs.mesh.material = wfMat;
    } else {
      cs.mesh.material = cs.material!;
    }
  }
  document.getElementById('btn-cs-wireframe')!.style.color = cs.wireframe ? 'var(--terracotta)' : '';
}

function csSetView(view: string) {
  const dist = 7;
  const p: Record<string,number[]> = { front:[0,0,dist], top:[0,dist,0.01], right:[dist,0,0] };
  const pos = p[view] || [4,3,6];
  cs.camera!.position.set(pos[0], pos[1], pos[2]);
  cs.camera!.lookAt(0,0,0);
  cs.orbitControls!.target.set(0,0,0);
  cs.orbitControls!.update();
}

function csFrameSelected() {
  if (!cs.mesh) return;
  const box = new THREE.Box3().setFromObject(cs.mesh);
  const c = box.getCenter(new THREE.Vector3());
  const s = box.getSize(new THREE.Vector3());
  const d = Math.max(s.x,s.y,s.z) * 2 + 1;
  cs.camera!.position.set(c.x+d*0.6, c.y+d*0.5, c.z+d*0.6);
  cs.orbitControls!.target.copy(c);
  cs.orbitControls!.update();
}

async function csExportGLB() {
  if (!cs.mesh) { showToast('无模型'); return; }
  showToast('正在导出...');
  try {
    const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
    const expScene = new THREE.Scene();
    const clone = new THREE.Mesh(cs.mesh.geometry.clone(), cs.material!.clone());
    expScene.add(clone);
    new GLTFExporter().parse(expScene, (glb: ArrayBuffer) => {
      const blob = new Blob([glb], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'clay-sculpture.glb';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('导出 GLB 完成 ✅');
    }, (err: any) => { console.error(err); showToast('导出失败'); }, { binary: true });
  } catch { showToast('导出器加载失败'); }
}

// ============================================================
//  素材库 (LocalStorage)
// ============================================================
const LIBRARY_KEY = 'clay_material_library';

function getLibrary(): any[] {
  try { return JSON.parse(localStorage.getItem(LIBRARY_KEY) || '[]'); } catch { return []; }
}
function saveLibraryData(data: any[]) { localStorage.setItem(LIBRARY_KEY, JSON.stringify(data)); }

function openSaveLibraryModal() {
  if (!cs.mesh) { showToast('无模型可保存'); return; }
  showInputDialog('输入模型名称:', '我的捏土作品', (name) => {
    if (name && name.trim()) csSaveToLibrary(name.trim());
  });
}

// 从建模场景中保存选中物体到素材库（使用 GLB 二进制，完美保留材质颜色）
async function saveObjectToLibrary(obj: any) {
  if (!obj) { showToast('请先选择物体'); return; }

  const doSave = async (name: string) => {
    if (!name || !name.trim()) { showToast('已取消'); return; }
    const trimmedName = name.trim();

    try {
      showToast('📦 正在导出...');

      // 创建临时场景，克隆目标物体
      const tempScene = new THREE.Scene();
      const clone = obj.clone(true); // 深度克隆，保留材质
      tempScene.add(clone);

      const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
      const exporter = new GLTFExporter();

      const glbBuffer: ArrayBuffer = await new Promise((resolve, reject) => {
        exporter.parse(tempScene, (result: ArrayBuffer) => resolve(result), reject, { binary: true });
      });

      // 转 base64
      const bytes = new Uint8Array(glbBuffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      const base64 = btoa(binary);

      // 计算顶点数
      let totalVerts = 0;
      clone.traverse((c: any) => {
        if (c.isMesh && c.geometry?.attributes?.position) {
          totalVerts += c.geometry.attributes.position.count;
        }
      });

      const item = {
        id: Date.now(), name: trimmedName,
        date: new Date().toISOString().slice(0, 10),
        color: 0xc97d5e, // 预览图标颜色（GLB 已包含完整颜色）
        vertexCount: totalVerts,
        glb: base64, // GLB 二进制数据
      };

      const lib = getLibrary(); lib.unshift(item); if (lib.length > 20) lib.length = 20;
      saveLibraryData(lib);
      showToast(`✅ "${trimmedName}" 已存入素材库 (${(base64.length/1024).toFixed(0)}KB)`);
    } catch (err: any) {
      showToast('导出失败: ' + err.message);
      console.error(err);
    }
  };

  showInputDialog('输入素材名称:', obj.userData.name || '模型素材', (name) => doSave(name));
}

function csSaveToLibrary(name: string) {
  if (!cs.mesh) return;
  const pos = cs.mesh.geometry.attributes.position.array;
  const norm = cs.mesh.geometry.attributes.normal?.array || null;
  const uv = cs.mesh.geometry.attributes.uv?.array || null;
  const item = {
    id: Date.now(), name,
    date: new Date().toISOString().slice(0,10),
    color: cs.material!.color.getHex(),
    roughness: cs.material!.roughness,
    metalness: cs.material!.metalness,
    vertices: Array.from(pos),
    normals: norm ? Array.from(norm) : null,
    uvs: uv ? Array.from(uv) : null,
    vertexCount: pos.length / 3,
  };
  const lib = getLibrary();
  lib.unshift(item);
  if (lib.length > 20) lib.length = 20;
  saveLibraryData(lib);
  showToast(`"${name}" 已存入素材库 📦`);
}

function openLibraryModal() {
  const grid = document.getElementById('lib-grid')!;
  const lib = getLibrary();
  if (lib.length === 0) {
    grid.innerHTML = '<div class="lib-empty">素材库为空<br>前往 🫱 捏土工作室 雕刻后存入</div>';
  } else {
    grid.innerHTML = lib.map((item, idx) => `
      <div class="lib-item" data-idx="${idx}">
        <div class="lib-icon" style="background:${typeof item.color === 'string' ? item.color : '#' + (item.color ?? 0xc97d5e).toString(16).padStart(6, '0')}">🫱</div>
        <div class="lib-name">${item.name}</div>
        <div class="lib-info">${item.glb ? (item.glb.length/1024).toFixed(0)+'KB' : Math.round(item.vertexCount||0)+'顶点'}</div>
        <div class="lib-del" data-idx="${idx}">✕</div>
      </div>`).join('');
  }
  document.getElementById('library-modal')!.classList.add('open');
  grid.querySelectorAll('.lib-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('lib-del')) return;
      loadFromLibrary(parseInt((el as HTMLElement).dataset.idx!));
    });
  });
  grid.querySelectorAll('.lib-del').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt((el as HTMLElement).dataset.idx!);
      const lib2 = getLibrary();
      showToast(`已删除 "${lib2[idx]?.name}"`);
      lib2.splice(idx, 1);
      saveLibraryData(lib2);
      openLibraryModal();
    });
  });
}

async function loadFromLibrary(idx: number) {
  const lib = getLibrary();
  const item = lib[idx];
  if (!item) return;
  saveUndoState();

  try {
    // 优先使用 GLB 格式（完美保留材质颜色）
    if (item.glb) {
      showToast('📦 正在加载素材...');
      const binary = atob(item.glb);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      const loader = new GLTFLoader();
      const gltf = await new Promise<any>((resolve, reject) => {
        loader.parse(bytes.buffer, '', resolve, reject);
      });

      const root = gltf.scene;
      const imported: any[] = [];
      root.traverse((child: any) => {
        if (child.isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;
          if (!child.userData.id) child.userData.id = generateId();
          if (!child.userData.name) child.userData.name = item.name;
          if (!child.userData.type) child.userData.type = 'library';
          if (child.material) child.userData.material = child.material;
        }
      });
      root.userData.id = generateId();
      root.userData.name = item.name;
      root.userData.type = 'library';
      root.position.set((Math.random() - 0.5) * 3, 0.5, (Math.random() - 0.5) * 3);

      scene.add(root);
      state.objects.push(root);
      document.getElementById('library-modal')!.classList.remove('open');
      selectObject(root);
      updateOutliner();
      updateSceneInfo();
      showToast(`✅ 已导入 "${item.name}" (GLB)`);
      return;
    }

    // 旧格式兼容：从顶点数据重建
    if (!item.vertices || item.vertices.length === 0) {
      showToast('素材数据不完整');
      return;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(item.vertices), 3));
    if (item.normals?.length) geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(item.normals), 3));
    if (item.uvs?.length) geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(item.uvs), 2));
    if (!item.normals?.length) geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      color: item.color ?? 0xc97d5e, roughness: item.roughness ?? 0.7,
      metalness: item.metalness ?? 0, envMapIntensity: 0.4,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.id = generateId();
    mesh.userData.name = item.name;
    mesh.userData.type = 'library';
    mesh.userData.material = mat;
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.position.set((Math.random()-0.5)*3, 0.5, (Math.random()-0.5)*3);
    scene.add(mesh);
    state.objects.push(mesh);
    document.getElementById('library-modal')!.classList.remove('open');
    selectObject(mesh);
    updateOutliner(); updateSceneInfo();
    showToast(`已导入 "${item.name}"`);
  } catch (err: any) {
    showToast('导入失败: ' + err.message);
    console.error(err);
  }
}

// ============================================================
//  Enter / Exit Clay Studio
// ============================================================
function enterClayStudio() {
  document.getElementById('app')!.style.display = 'none';
  document.getElementById('clay-studio')!.style.display = '';
  cs.active = true;

  const csViewport = document.getElementById('cs-viewport')!;

  // 简洁明亮的场景 — 突出黏土本身
  cs.scene = new THREE.Scene();
  cs.scene.background = new THREE.Color('#d5cfc6');

  cs.camera = new THREE.PerspectiveCamera(45, csViewport.clientWidth/csViewport.clientHeight, 0.1, 1000);
  cs.camera.position.set(3, 2.2, 4.2); cs.camera.lookAt(0, 0.2, 0);

  cs.renderer = new THREE.WebGLRenderer({ antialias: true });
  cs.renderer.setSize(csViewport.clientWidth, csViewport.clientHeight);
  cs.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  cs.renderer.shadowMap.enabled = true;
  cs.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  cs.renderer.toneMapping = THREE.NoToneMapping;
  cs.renderer.outputColorSpace = THREE.SRGBColorSpace;
  csViewport.insertBefore(cs.renderer.domElement, csViewport.firstChild);

  // 简洁光照 — 突出体积
  cs.scene.add(new THREE.AmbientLight('#ffffff', 0.5));
  const kl = new THREE.DirectionalLight('#ffffff', 2.0);
  kl.position.set(6, 10, 6); kl.castShadow = true;
  kl.shadow.mapSize.set(2048, 2048);
  kl.shadow.camera.near = 0.5; kl.shadow.camera.far = 30;
  kl.shadow.camera.left = -10; kl.shadow.camera.right = 10;
  kl.shadow.camera.top = 10; kl.shadow.camera.bottom = -10;
  kl.shadow.bias = -0.0001;
  cs.scene.add(kl);
  cs.scene.add(new THREE.DirectionalLight('#ffffff', 0.5).translateX(-4).translateY(3).translateZ(-5));
  cs.scene.add(new THREE.DirectionalLight('#ffffff', 0.3).translateX(-2).translateY(-1).translateZ(7));

  // 简洁的浅色桌面
  const tableGeo = new THREE.CylinderGeometry(2.8, 3.0, 0.18, 48);
  const tableMat = new THREE.MeshStandardMaterial({ color: '#ddc8b0', roughness: 0.5, metalness: 0 });
  const table = new THREE.Mesh(tableGeo, tableMat);
  table.position.y = -1.6; table.receiveShadow = true;
  cs.scene.add(table);

  // 浅色地面
  const floorGeo = new THREE.CircleGeometry(6, 48);
  const floorMat = new THREE.MeshStandardMaterial({ color: '#e8e0d8', roughness: 0.8, metalness: 0 });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2; floor.position.y = -1.7; floor.receiveShadow = true;
  cs.scene.add(floor);

  // Orbit controls
  cs.orbitControls = new OrbitControls(cs.camera, cs.renderer.domElement);
  cs.orbitControls.enableDamping = true; cs.orbitControls.dampingFactor = 0.08;
  cs.orbitControls.minDistance = 1.5; cs.orbitControls.maxDistance = 12;
  cs.orbitControls.target.set(0, -0.3, 0);
  cs.scene.add(table);

  // 细网格 — 极淡
  cs.gridHelper = new THREE.Group();
  const g = new THREE.GridHelper(10, 16, '#5a4030', '#3a2820');
  (g.material as THREE.Material).transparent = true; (g.material as THREE.Material).opacity = 0.12;
  cs.gridHelper.add(g);
  cs.scene.add(cs.gridHelper);

  // Orbit controls
  cs.orbitControls = new OrbitControls(cs.camera, cs.renderer.domElement);
  cs.orbitControls.enableDamping = true; cs.orbitControls.dampingFactor = 0.08;
  cs.orbitControls.minDistance = 1.5; cs.orbitControls.maxDistance = 12;
  cs.orbitControls.target.set(0, -0.3, 0);

  // Brush cursor ring
  const ringGeo = new THREE.RingGeometry(0.45, 0.55, 48);
  const ringMat = new THREE.MeshBasicMaterial({ color: '#ffffff', side: THREE.DoubleSide, transparent: true, opacity: 0.6, depthWrite: false });
  cs.cursorRing = new THREE.Mesh(ringGeo, ringMat);
  cs.cursorRing.visible = false; cs.cursorRing.renderOrder = 999;
  cs.scene.add(cs.cursorRing);

  // Pointer events
  cs.renderer.domElement.addEventListener('pointerdown', csOnPointerDown);
  cs.renderer.domElement.addEventListener('pointermove', csOnPointerMove);
  cs.renderer.domElement.addEventListener('pointerup', csOnPointerUp);
  cs.renderer.domElement.addEventListener('pointerleave', csOnPointerUp);

  // 默认用实心方块
  csInitMesh('block');
  csUpdateStats();

  function csAnimate() {
    if (!cs.active) return;
    requestAnimationFrame(csAnimate);
    cs.orbitControls!.update();
    cs.renderer!.render(cs.scene!, cs.camera!);
  }
  csAnimate();

  const csResize = () => {
    if (!cs.active) return;
    const w = csViewport.clientWidth, h = csViewport.clientHeight;
    cs.camera!.aspect = w/h; cs.camera!.updateProjectionMatrix();
    cs.renderer!.setSize(w,h);
  };
  window.addEventListener('resize', csResize);
  new ResizeObserver(csResize).observe(csViewport);

  showToast('🫱 实心黏土已就绪 · 拖拽左键雕刻');
}

function exitClayStudio() {
  cs.active = false;
  if (cs.renderer) { cs.renderer.dispose(); }
  if (cs.mesh) { cs.mesh.geometry.dispose(); cs.material?.dispose(); }
  if (cs.scene) { cs.scene.clear(); }
  document.getElementById('cs-viewport')!.querySelectorAll('canvas').forEach(c => c.remove());
  document.getElementById('clay-studio')!.style.display = 'none';
  document.getElementById('app')!.style.display = '';
}

function setupClayStudioButtons() {
  document.getElementById('btn-clay-studio')!.addEventListener('click', enterClayStudio);
  document.getElementById('btn-cs-back')!.addEventListener('click', exitClayStudio);
  document.getElementById('btn-cs-undo')!.addEventListener('click', csUndo);
  document.getElementById('btn-cs-redo')!.addEventListener('click', csRedo);
  document.getElementById('btn-cs-reset')!.addEventListener('click', () => { if(confirm('换一块新黏土？当前雕刻将丢失。')) csInitMesh(cs.clayType); });
  document.getElementById('btn-cs-export')!.addEventListener('click', csExportGLB);
  document.getElementById('btn-cs-save-lib')!.addEventListener('click', openSaveLibraryModal);
  document.getElementById('btn-cs-subdivide')!.addEventListener('click', csSubdivide);
  document.getElementById('btn-cs-symmetry')!.addEventListener('click', csToggleSymmetry);
  document.getElementById('btn-cs-wireframe')!.addEventListener('click', csToggleWireframe);
  document.getElementById('btn-cs-frame')!.addEventListener('click', csFrameSelected);

  // Brush buttons
  document.querySelectorAll('.cs-brush-btn').forEach(b => {
    b.addEventListener('click', () => csSetBrush((b as HTMLElement).dataset.csBrush!));
  });

  // Clay type chips
  document.querySelectorAll('.cs-clay-type-chip').forEach(b => {
    b.addEventListener('click', () => csSetClayType((b as HTMLElement).dataset.csClay!));
  });

  // Color preset dots
  document.querySelectorAll('.cs-color-dot').forEach(dot => {
    dot.addEventListener('click', () => {
      document.querySelectorAll('.cs-color-dot').forEach(d => d.classList.remove('active'));
      dot.classList.add('active');
      const color = (dot as HTMLElement).dataset.csColor!;
      if (cs.material) cs.material.color.set(color);
    });
  });

  // Brush settings
  (document.getElementById('cs-brush-size') as HTMLInputElement).addEventListener('input', (e) => {
    cs.brushSize = parseFloat((e.target as HTMLInputElement).value);
    document.getElementById('cs-brush-size-val')!.textContent = cs.brushSize.toFixed(2);
  });
  (document.getElementById('cs-brush-strength') as HTMLInputElement).addEventListener('input', (e) => {
    cs.brushStrength = parseFloat((e.target as HTMLInputElement).value);
    document.getElementById('cs-brush-strength-val')!.textContent = cs.brushStrength.toFixed(2);
  });
  (document.getElementById('cs-brush-falloff') as HTMLInputElement).addEventListener('input', (e) => {
    cs.brushFalloff = parseFloat((e.target as HTMLInputElement).value);
    document.getElementById('cs-brush-falloff-val')!.textContent = cs.brushFalloff.toFixed(1);
  });

  // Material library
  document.getElementById('btn-open-library')!.addEventListener('click', openLibraryModal);
  document.getElementById('library-modal')!.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) (e.currentTarget as HTMLElement).classList.remove('open');
  });
}

// ============================================================
//  AI 智能建模
// ============================================================
const AI_SETTINGS_KEY = 'ai_model_settings';
let aiLastCode = '';
let aiLastPrompt = '';

function getAISettings(): { url: string; model: string; key: string } {
  try { return JSON.parse(localStorage.getItem(AI_SETTINGS_KEY) || '{}'); }
  catch { return {} as any; }
}

function saveAISettings(s: { url: string; model: string; key: string }) {
  localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(s));
}

function openAIModal() {
  const s = getAISettings();
  (document.getElementById('ai-api-url') as HTMLInputElement).value = s.url || 'https://api.openai.com/v1/chat/completions';
  (document.getElementById('ai-model-name') as HTMLInputElement).value = s.model || 'gpt-4o';
  (document.getElementById('ai-api-key') as HTMLInputElement).value = s.key || '';
  document.getElementById('ai-status')!.textContent = '';
  document.getElementById('ai-result')!.style.display = 'none';
  document.getElementById('ai-modal')!.classList.add('open');
}

function closeAIModal() {
  document.getElementById('ai-modal')!.classList.remove('open');
}

// 投射 AI 生成的模型到场景（可多次调用）
function aiProjectToScene() {
  if (!aiLastCode) { showToast('请先生成模型'); return; }
  const addObjectToScene = (obj: THREE.Object3D) => {
    if (!obj) return;
    const id = generateId();
    obj.userData.id = id;
    obj.userData.name = `AI: ${aiLastPrompt.slice(0, 30)}`;
    (obj as any).userData.type = 'ai-generated';
    (obj as any).userData.geometryParams = {};
    if ((obj as any).isMesh) (obj as any).userData.material = (obj as any).material;
    obj.castShadow = true; obj.receiveShadow = true;
    obj.traverse((child) => {
      if ((child as any).isMesh) {
        const cm = child as THREE.Mesh;
        cm.castShadow = true; cm.receiveShadow = true;
        if (!cm.userData.id) cm.userData.id = generateId();
        if (!cm.userData.name) cm.userData.name = 'AI子件';
        if (!(cm.userData as any).type) (cm.userData as any).type = 'ai-generated';
        (cm.userData as any).material = cm.material;
      }
    });
    scene.add(obj);
    state.objects.push(obj as any);
    selectObject(obj as any);
    updateOutliner();
    updateSceneInfo();
  };
  try {
    const fn = new Function('THREE', 'scene', 'addObjectToScene', aiLastCode);
    fn(THREE, scene, addObjectToScene);
    saveUndoState();
    showToast('AI 模型已投射到场景 📥');
  } catch (err: any) {
    showToast('投射失败: ' + err.message);
  }
}

async function aiGenerateModel() {
  const prompt = (document.getElementById('ai-prompt') as HTMLTextAreaElement).value.trim();
  if (!prompt) { showToast('请输入模型描述'); return; }

  const url = (document.getElementById('ai-api-url') as HTMLInputElement).value.trim();
  const model = (document.getElementById('ai-model-name') as HTMLInputElement).value.trim();
  const key = (document.getElementById('ai-api-key') as HTMLInputElement).value.trim();
  saveAISettings({ url, model, key });

  if (!url || !model) { showToast('请配置 API 端点和模型名称'); return; }

  const statusEl = document.getElementById('ai-status')!;
  const resultEl = document.getElementById('ai-result')!;
  const codeEl = document.getElementById('ai-code')!;

  statusEl.textContent = '🤔 AI 正在思考...';
  statusEl.style.color = 'var(--blue)';
  resultEl.style.display = 'none';

  // 动画点
  let dots = 0;
  const thinkingInterval = setInterval(() => {
    dots = (dots + 1) % 4;
    statusEl.textContent = '🤔 AI 正在思考' + '.'.repeat(dots);
  }, 400);

  const systemPrompt = `You are a 3D modeling expert. Output ONLY valid JavaScript code (no markdown, no explanations) that creates a 3D model using Three.js v0.160.
Available globals: THREE, scene, addObjectToScene(mesh).
Rules:
- Call addObjectToScene(yourMesh) ONCE to add the model
- Use MeshStandardMaterial with hex colors
- Position the model at y=0.5
- Keep under 80 lines

Example output for "red car":
const body=new THREE.Mesh(new THREE.BoxGeometry(2,0.6,1),new THREE.MeshStandardMaterial({color:0xff2222,roughness:0.5}));body.position.y=0.5;
const roof=new THREE.Mesh(new THREE.BoxGeometry(1,0.4,0.9),new THREE.MeshStandardMaterial({color:0xff2222,roughness:0.5}));roof.position.set(-0.1,1,0);
const group=new THREE.Group();group.add(body);group.add(roof);
for(let i=0;i<4;i++){const w=new THREE.Mesh(new THREE.CylinderGeometry(0.25,0.25,0.15,16),new THREE.MeshStandardMaterial({color:0x111111}));w.rotation.z=Math.PI/2;w.position.set((i<2?-1:1)*0.7,0.25,(i%2===0?-1:1)*0.5);group.add(w);}
addObjectToScene(group);`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Create a 3D model of: ${prompt}` },
        ],
        temperature: 0.5,
        max_tokens: 3000,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      clearInterval(thinkingInterval);
      codeEl.textContent = 'HTTP ' + response.status + ': ' + err.slice(0, 500);
      resultEl.style.display = '';
      throw new Error(`API ${response.status}: ${err.slice(0, 100)}`);
    }

    const data = await response.json();
    // 兼容多种 API 响应格式
    let content = data.choices?.[0]?.message?.content
               || data.choices?.[0]?.text
               || data.message?.content
               || data.content
               || '';
    
    if (!content || !content.trim()) {
      clearInterval(thinkingInterval);
      codeEl.textContent = JSON.stringify(data, null, 2).slice(0, 500);
      resultEl.style.display = '';
      throw new Error('AI 返回空内容，请检查模型名称和API配置');
    }

    clearInterval(thinkingInterval);
    statusEl.textContent = '🔧 正在构建模型...';
    statusEl.style.color = 'var(--blue)';

    // 提取代码 — 兼容各种 markdown 格式
    let code = content;
    // 提取 ```javascript ... ``` 或 ```js ... ``` 或 ``` ... ``` 内的代码
    const codeBlockMatch = code.match(/```(?:javascript|js)?\n?([\s\S]*?)```/);
    if (codeBlockMatch) code = codeBlockMatch[1];
    // 清理残留的 markdown 标记
    code = code.replace(/```/g, '').trim();

    codeEl.textContent = code;
    resultEl.style.display = '';

    // 执行生成的代码
    const addObjectToScene = (obj: THREE.Object3D) => {
      if (!obj) { console.warn('AI generated undefined object'); return; }
      const id = generateId();
      // 不论 Mesh 还是 Group，都设置基础 userData
      obj.userData.id = id;
      obj.userData.name = `AI: ${prompt.slice(0, 30)}`;
      (obj as any).userData.type = 'ai-generated';
      (obj as any).userData.geometryParams = {};
      if ((obj as any).isMesh) {
        const m = obj as THREE.Mesh;
        (m.userData as any).material = m.material;
      }
      obj.castShadow = true;
      obj.receiveShadow = true;
      // 遍历子对象
      obj.traverse((child) => {
        if ((child as any).isMesh) {
          const cm = child as THREE.Mesh;
          cm.castShadow = true;
          cm.receiveShadow = true;
          if (!cm.userData.id) cm.userData.id = generateId();
          if (!cm.userData.name) cm.userData.name = `AI子件`;
          if (!(cm.userData as any).type) (cm.userData as any).type = 'ai-generated';
          (cm.userData as any).material = cm.material;
          (cm.userData as any).geometryParams = {};
        }
      });
      scene.add(obj);
      state.objects.push(obj as any);
      saveUndoState();
      selectObject(obj as any);
      updateOutliner();
      updateSceneInfo();
    };

    // 沙箱执行
    aiLastCode = code;
    aiLastPrompt = prompt;
    const fn = new Function('THREE', 'scene', 'addObjectToScene', code);
    fn(THREE, scene, addObjectToScene);

    statusEl.textContent = '✅ 生成成功！';
    statusEl.style.color = '#34c759';
    showToast('AI 模型已添加到场景 🤖');
  } catch (err: any) {
    clearInterval(thinkingInterval);
    statusEl.textContent = `❌ ${err.message.slice(0, 80)}`;
    statusEl.style.color = '#ff3b30';
    console.error('AI modeling error:', err);
  }
}

function setupAIModeling() {
  document.getElementById('btn-ai-model')!.addEventListener('click', openAIModal);
  document.getElementById('btn-ai-generate')!.addEventListener('click', aiGenerateModel);
  document.getElementById('btn-ai-project')!.addEventListener('click', aiProjectToScene);
  document.getElementById('btn-ai-settings-toggle')!.addEventListener('click', () => {
    const panel = document.getElementById('ai-settings')!;
    panel.style.display = panel.style.display === 'none' ? '' : 'none';
  });
  document.getElementById('ai-modal')!.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeAIModal();
  });
}

function onResize() {
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

window.addEventListener('resize', onResize);
// 也用 ResizeObserver 更准确
new ResizeObserver(onResize).observe(viewport);

// ============================================================
//  初始化
// ============================================================
function init() {
  initClay();
  setupUI();
  setupKeyboard();
  setupGhostControls();
  setupPanelResizer();
  setupContextMenu();
  setupPropertyBindings();
  setupClayStudioButtons();
  setupAIModeling();
  updateOutliner();
  updateSceneInfo();
  updateGizmoIndicator();
  renderMaterialPresets(document.getElementById('material-presets-list'));
  renderShortcutsHelp();
  animate(0);

  // 默认添加几个示例物体
  const box = addObject('box');
  box.position.set(0, 0.5, 0);
  box.userData.material.color.setHex(0x0071e3);
  saveUndoState();

  const sphere = addObject('sphere');
  sphere.position.set(2.2, 0.6, 0.5);
  sphere.userData.material.color.setHex(0xff9f0a);
  saveUndoState();

  const cyl = addObject('cylinder');
  cyl.position.set(-2.0, 0.6, -0.8);
  cyl.userData.material.color.setHex(0x34c759);
  saveUndoState();

  // 默认选中第一个物体
  selectObject(state.objects[0]);
  updateOutliner();
  updatePropertyPanel();
  updateGizmoIndicator();

  showToast('Model3D 已就绪 · Q/W/E/R 切换工具');
}

init();
