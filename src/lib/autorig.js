// Auto-rig: embed the bundled mannequin's skeleton into an uploaded
// un-rigged humanoid GLB and skin it with proximity weights, so the normal
// rig pipeline (limits, FK, IK, presets, colliders) works on any humanoid.
//
// The template is the default mannequin's Hips subtree: canonical joint
// names, identity rest rotations — pose math transfers unchanged.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { JOINT_ORDER } from './joints.js';

let templatePromise = null;

function loadTemplate() {
  if (!templatePromise) {
    templatePromise = new GLTFLoader().loadAsync('/mannequin.gltf').then((gltf) => {
      const hips = gltf.scene.getObjectByName('Hips');
      if (!hips) throw new Error('template skeleton missing');
      const box = new THREE.Box3().setFromObject(gltf.scene);
      return { hips, templateH: box.max.y - box.min.y };
    });
  }
  return templatePromise;
}

// --- geometry helpers -------------------------------------------------------

function distToSegment(p, a, b) {
  const ab = new THREE.Vector3().subVectors(b, a);
  const ap = new THREE.Vector3().subVectors(p, a);
  const len2 = ab.lengthSq();
  const t = len2 > 1e-12 ? Math.max(0, Math.min(1, ap.dot(ab) / len2)) : 0;
  const closest = new THREE.Vector3().copy(a).addScaledVector(ab, t);
  return closest.distanceTo(p);
}

// Build { joint: { a, b } } segments in world space from a joint subtree.
// Leaf joints (Hand/Foot/Head) extrapolate from their parent direction.
function buildSegments(root) {
  root.updateMatrixWorld(true);
  const nodes = {};
  root.traverse((o) => {
    if (JOINT_ORDER.includes(o.name)) nodes[o.name] = o;
  });
  const w = (n) => n.getWorldPosition(new THREE.Vector3());
  const segs = {};
  for (const name of JOINT_ORDER) {
    const n = nodes[name];
    if (!n) continue;
    const a = w(n);
    // first managed child = tail
    let tail = null;
    for (const child of n.children) {
      if (JOINT_ORDER.includes(child.name)) {
        tail = w(child);
        break;
      }
    }
    if (!tail) {
      const parent = n.parent && nodes[n.parent.name] ? nodes[n.parent.name] : null;
      if (parent) {
        const dir = a.clone().sub(w(parent));
        const len = dir.length() || 0.1;
        tail = a.clone().addScaledVector(dir.normalize(), len * 0.7);
      } else {
        tail = a.clone().add(new THREE.Vector3(0, 0.1, 0));
      }
    }
    segs[name] = { a, b: tail };
  }
  return segs;
}

// Per-vertex weights: inverse-distance to the 17 bone segments (top 4).
// `meshWorld` transforms local vertices into the same world space as `segs`.
function skinGeometry(geometry, segments, meshWorld) {
  const pos = geometry.attributes.position;
  const n = pos.count;
  const idx = new Uint16Array(n * 4);
  const wgt = new Float32Array(n * 4);
  const p = new THREE.Vector3();
  const entries = [];
  for (let i = 0; i < n; i++) {
    p.fromBufferAttribute(pos, i).applyMatrix4(meshWorld);
    entries.length = 0;
    for (let j = 0; j < JOINT_ORDER.length; j++) {
      const s = segments[JOINT_ORDER[j]];
      if (!s) continue;
      const d = distToSegment(p, s.a, s.b);
      entries.push([j, 1 / (Math.pow(d + 0.03, 3))]);
    }
    entries.sort((x, y) => y[1] - x[1]);
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += entries[k] ? entries[k][1] : 0;
    for (let k = 0; k < 4; k++) {
      idx[i * 4 + k] = entries[k] ? entries[k][0] : 0;
      wgt[i * 4 + k] = entries[k] ? entries[k][1] / sum : 0;
    }
  }
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(wgt, 4));
}

// --- arm pose fitting ---------------------------------------------------------
// Uploaded humanoids are often A-posed while the template is T-posed. Detect
// each arm's extremity in the mesh, then rotate + length-fit the template's
// arm chain (upper→fore→hand) onto it before binding. Legs/torso/head already
// align via the uniform height scale.
function fitArms(scene, hipsClone, joints, meshH) {
  const box = new THREE.Box3().setFromObject(scene);
  const yGate = box.min.y + 0.3 * meshH; // ignore feet
  let maxX = -Infinity, minX = Infinity;
  const p = new THREE.Vector3();
  scene.traverse((o) => {
    if (!o.isMesh || o.userData.isLineArt) return;
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      if (p.y < yGate) continue;
      if (p.x > maxX) maxX = p.x;
      if (p.x < minX) minX = p.x;
    }
  });
  if (!isFinite(maxX)) return null;

  const stats = {};
  hipsClone.updateMatrixWorld(true);
  for (const side of [
    { s: 1, up: 'UpperArmL', fore: 'ForearmL', hand: 'HandL', px: maxX },
    { s: -1, up: 'UpperArmR', fore: 'ForearmR', hand: 'HandR', px: minX },
  ]) {
    const upper = joints[side.up];
    const fore = joints[side.fore];
    const hand = joints[side.hand];
    if (!upper || !fore || !hand) continue;
    if (side.s > 0 && maxX < 0.2) continue; // no arm-side geometry
    if (side.s < 0 && minX > -0.2) continue;

    const shoulder = upper.getWorldPosition(new THREE.Vector3());
    const dx = side.px - shoulder.x;
    // hand height: use the mesh extremity's y at that extreme x (recompute)
    const dy = (side.s > 0 ? armExtremityY(scene, 'max', yGate) : armExtremityY(scene, 'min', yGate)) - shoulder.y;
    const reach = Math.hypot(dx, dy);
    if (reach < 0.1) continue;

    // rotate the (straight, identity-rest) arm chain onto the mesh direction
    const target = Math.atan2(dy, dx);
    const base = Math.atan2(0, side.s); // template points ±X
    let theta = target - base;
    while (theta > Math.PI) theta -= 2 * Math.PI;
    while (theta < -Math.PI) theta += 2 * Math.PI;
    theta = Math.max(-1.92, Math.min(1.92, theta)); // ±110° sanity
    upper.rotation.z = theta;

    // length-fit: scale forearm/hand local offsets so the hand lands on the tip
    const localLen = Math.abs(fore.position.x) + Math.abs(hand.position.x);
    const wrapperScale = hipsClone.parent ? hipsClone.parent.scale.x : 1;
    const ratio = Math.max(0.7, Math.min(1.8, reach / (localLen * wrapperScale)));
    fore.position.x = Math.sign(fore.position.x || side.s) * Math.abs(fore.position.x) * ratio;
    hand.position.x = Math.sign(hand.position.x || side.s) * Math.abs(hand.position.x) * ratio;
    stats[side.s > 0 ? 'L' : 'R'] = { thetaDeg: Math.round((theta * 180) / Math.PI), ratio: Number(ratio.toFixed(2)) };
  }
  hipsClone.updateMatrixWorld(true);
  return stats;
}

function armExtremityY(scene, mode, yGate) {
  let bestX = mode === 'max' ? -Infinity : Infinity;
  let bestY = 0;
  const p = new THREE.Vector3();
  scene.traverse((o) => {
    if (!o.isMesh || o.userData.isLineArt) return;
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      if (p.y < yGate) continue;
      if (mode === 'max' ? p.x > bestX : p.x < bestX) {
        bestX = p.x;
        bestY = p.y;
      }
    }
  });
  return bestY;
}

// --- public API -------------------------------------------------------------

// Embed the template skeleton into `scene` (already prepared/grounded) and
// convert every mesh to a SkinnedMesh bound to it. Returns stats.
export async function attachMannequinRig(scene, template) {
  const tpl = template || (await loadTemplate());
  const box = new THREE.Box3().setFromObject(scene);
  const meshH = box.max.y - box.min.y;
  const scale = meshH > 0.01 ? meshH / tpl.templateH : 1;

  // Clone the Hips subtree (canonical names, identity rests) under a wrapper.
  const wrapper = new THREE.Group();
  wrapper.name = 'AutoRigRoot';
  const hipsClone = tpl.hips.clone(true);
  // Bones only — the template's visual meshes hang under bones and must not
  // be transplanted into the uploaded model.
  const stray = [];
  hipsClone.traverse((o) => {
    if (o.isMesh || o.isSkinnedMesh) stray.push(o);
  });
  stray.forEach((m) => m.parent && m.parent.remove(m));
  wrapper.add(hipsClone);
  wrapper.scale.setScalar(scale);
  scene.add(wrapper);
  scene.updateMatrixWorld(true);

  const joints = {};
  hipsClone.traverse((o) => {
    if (JOINT_ORDER.includes(o.name)) joints[o.name] = o;
  });
  const bones = JOINT_ORDER.map((n) => joints[n]);
  if (bones.some((b) => !b)) throw new Error('template clone incomplete');

  // Pose-fit arms to the mesh (A/T/angled), then bind.
  const armFit = fitArms(scene, hipsClone, joints, meshH);
  scene.updateMatrixWorld(true);

  const skeleton = new THREE.Skeleton(bones);

  // Segments from the CLONED subtree: world space after wrapper scale —
  // the same space as the bones that will actually deform the mesh.
  const segs = buildSegments(hipsClone);

  let skinned = 0;
  const toConvert = [];
  scene.traverse((o) => {
    if (o.isMesh && !o.isSkinnedMesh && !o.userData.isLineArt && o.parent) {
      toConvert.push(o);
    }
  });
  for (const mesh of toConvert) {
    mesh.updateMatrixWorld(true);
    skinGeometry(mesh.geometry, segs, mesh.matrixWorld);

    const sk = new THREE.SkinnedMesh(mesh.geometry, mesh.material);
    sk.name = mesh.name;
    sk.castShadow = mesh.castShadow;
    sk.receiveShadow = mesh.receiveShadow;
    sk.position.copy(mesh.position);
    sk.quaternion.copy(mesh.quaternion);
    sk.scale.copy(mesh.scale);
    mesh.parent.add(sk);
    mesh.parent.remove(mesh);
    sk.updateMatrixWorld(true);
    sk.bind(skeleton);
    skinned++;
  }
  scene.updateMatrixWorld(true);
  return { skinned, scale: Number(scale.toFixed(3)), armFit };
}

// Cheap check: does the scene already carry a (mapped) Hips joint?
export function hasSkeleton(scene) {
  return !!scene.getObjectByName('Hips');
}

export function resetTemplateCache() {
  templatePromise = null;
}
