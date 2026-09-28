// Load GLB/GLTF/FBX files picked in the UI and prepare their scenes:
//   prepareMain  — humanoid main model (height window + floor grounding)
//   prepareProp  — general prop: longest dimension → 1.6 m, grounded, centered
//
// Grounding is computed from a FRESH world box AFTER any rescale (stale
// pre-scale coordinates break when the GLB root carries its own offset), and
// when the model has a skeleton we sanity-check the mesh box against the
// bone positions — a bind box that plunges far below every bone is not
// trusted (that mismatch is what buries skinned characters in the floor).

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

const gltfLoader = new GLTFLoader();
const fbxLoader = new FBXLoader();

// GLTF / GLB 로더
export function loadGLTF(file) {
  return new Promise((resolve, reject) => {
    file
      .arrayBuffer()
      .then((buf) => gltfLoader.parse(buf, '', resolve, (e) => reject(e || new Error('GLTF parse failed'))))
      .catch(reject);
  });
}

// FBX 로더
export function loadFBX(file) {
  return new Promise((resolve, reject) => {
    file
      .arrayBuffer()
      .then((buf) => {
        try {
          const group = fbxLoader.parse(buf, '');
          resolve(group);
        } catch (e) {
          reject(e || new Error('FBX parse failed'));
        }
      })
      .catch(reject);
  });
}

// 파일 확장자(.glb, .gltf, .fbx)에 맞춰 자동으로 파싱하고
// 동일하게 { scene } 형태로 반환하는 통합 로더
export async function loadModel(file) {
  const ext = (file.name || '').split('.').pop().toLowerCase();

  if (ext === 'fbx') {
    const scene = await loadFBX(file);
    return { scene };
  } else if (ext === 'gltf' || ext === 'glb') {
    return await loadGLTF(file);
  } else {
    throw new Error(`지원하지 않는 파일 포맷입니다: .${ext}`);
  }
}

// Fresh world-space bounds + lowest bone (skeleton floor reference).
function floorInfo(scene) {
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene);
  let boneMin = null;
  const p = new THREE.Vector3();
  scene.traverse((o) => {
    if (o.isBone) {
      o.getWorldPosition(p);
      if (boneMin === null || p.y < boneMin) boneMin = p.y;
    }
  });
  return { box, boneMin };
}

// Resolve the world Y to subtract so the model stands on y = 0.
function groundOffsetY(box, boneMin) {
  let gy = box.min.y;
  if (boneMin !== null && gy < boneMin - 0.15) gy = boneMin;
  return gy;
}

// Main model: only rescale outside our working window so the bundled
// mannequin keeps its tuned proportions; always ground + center.
export function prepareMain(scene) {
  let info = floorInfo(scene);
  const h = info.box.max.y - info.box.min.y;
  const k = Number.isFinite(h) && (h < 1.55 || h > 1.8) ? 1.72 / h : 1;
  if (k !== 1) {
    scene.scale.multiplyScalar(k);
    info = floorInfo(scene); // re-measure AFTER scaling
  }
  const { box, boneMin } = info;
  const cx = (box.min.x + box.max.x) / 2;
  const cz = (box.min.z + box.max.z) / 2;
  scene.position.x -= cx;
  scene.position.y -= groundOffsetY(box, boneMin);
  scene.position.z -= cz;
  scene.updateMatrixWorld(true);
  return scene;
}

// Prop: normalize any object/person to a comparable size, stand it on the
// floor, center it, and remember the base scale for the size slider.
export function prepareProp(scene) {
  let info = floorInfo(scene);
  const size = info.box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const k = maxDim > 1e-4 ? 1.6 / maxDim : 1;
  if (k !== 1) {
    scene.scale.multiplyScalar(k);
    info = floorInfo(scene); // re-measure AFTER scaling
  }
  const { box, boneMin } = info;
  const cx = (box.min.x + box.max.x) / 2;
  const cz = (box.min.z + box.max.z) / 2;
  scene.position.x -= cx;
  scene.position.y -= groundOffsetY(box, boneMin);
  scene.position.z -= cz;
  scene.updateMatrixWorld(true);
  scene.userData.baseScale = scene.scale.x;
  return scene;
}

export function disposeScene(scene) {
  scene.traverse((o) => {
    if (o.isMesh) {
      o.geometry?.dispose?.();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => m?.dispose?.());
    }
  });
}