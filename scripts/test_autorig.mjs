// Auto-rig unit test (node): parse template + rigless GLB, embed, weight, deform.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { readFileSync } from 'node:fs';
import { attachMannequinRig } from '../src/lib/autorig.js';
import { createRig } from '../src/lib/rig.js';
import { applyJointNameMap } from '../src/lib/naming.js';

globalThis.ProgressEvent = class ProgressEvent {
  constructor(type, init = {}) { this.type = type; Object.assign(this, init); }
};
const selfProxy = new Proxy(globalThis, { get: (t, k) => t[k] });
if (typeof globalThis.self === 'undefined') Object.defineProperty(globalThis, 'self', { value: globalThis });

const loader = new GLTFLoader();
function parse(buf, path) {
  return new Promise((res, rej) => loader.parse(buf, '', res, rej));
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.log('  FAIL ' + m); } };

const tplBuf = readFileSync('public/mannequin.gltf').toString('utf8');
const tpl = await parse(tplBuf, 'mannequin.gltf');
const tplHips = tpl.scene.getObjectByName('Hips');
const tplBox = new THREE.Box3().setFromObject(tpl.scene);
const template = { hips: tplHips, templateH: tplBox.max.y - tplBox.min.y };
console.log('template H = ' + template.templateH.toFixed(3));
ok(!!tplHips, 'template Hips exists');

// rigless user glb
const userBuf = readFileSync('public/mannequin_user.glb');
const ab = userBuf.buffer.slice(userBuf.byteOffset, userBuf.byteOffset + userBuf.byteLength);
const userGltf = await parse(ab, 'mannequin_user.glb');
const scene = userGltf.scene;
const preBox = new THREE.Box3().setFromObject(scene);
const preH = preBox.max.y - preBox.min.y;
// ground it like prepareMain
scene.position.y -= preBox.min.y;
scene.position.x -= (preBox.min.x + preBox.max.x) / 2;
scene.position.z -= (preBox.min.z + preBox.max.z) / 2;
scene.updateMatrixWorld(true);
console.log('user mesh H = ' + preH.toFixed(3));
ok(!scene.getObjectByName('Hips'), 'user model has no rig');

const stats = await attachMannequinRig(scene, template);
console.log('auto-rig stats:', stats);
ok(stats.skinned >= 1, 'at least one mesh skinned: ' + stats.skinned);
ok(!!scene.getObjectByName('Hips'), 'Hips embedded');

// skin attributes sane
let mesh = null;
scene.traverse((o) => { if (o.isSkinnedMesh && !mesh) mesh = o; });
ok(!!mesh, 'SkinnedMesh created');
const si = mesh.geometry.attributes.skinIndex;
const sw = mesh.geometry.attributes.skinWeight;
ok(!!si && !!sw, 'skinIndex + skinWeight present');
let weightOk = true, idxOk = true;
for (let i = 0; i < sw.count; i++) {
  const s = sw.getX(i) + sw.getY(i) + sw.getZ(i) + sw.getW(i);
  if (Math.abs(s - 1) > 1e-3) weightOk = false;
  for (const c of ['X', 'Y', 'Z', 'W']) {
    if (si['get' + c](i) > 16) idxOk = false;
  }
}
ok(weightOk, 'weights normalized');
ok(idxOk, 'indices within 0..16');

// createRig works on the rigged scene
const rig = createRig(scene);
ok(!!rig && !!rig.joints && Object.keys(rig.joints).length >= 17, 'createRig joints: ' + Object.keys(rig.joints).length);

// deform check: rotate forearm, hand-region vertices should move (CPU skinning)
const forearm = rig.joints['ForearmL'];
ok(!!forearm, 'ForearmL exists');

// collect skinned meshes
const meshes = [];
scene.traverse((o) => { if (o.isSkinnedMesh) meshes.push(o); });
ok(meshes.length >= 1, 'skinned meshes: ' + meshes.length);

// rest pose: find globally nearest vertex to HandL
scene.updateMatrixWorld(true);
const handPos = rig.joints['HandL'].getWorldPosition(new THREE.Vector3());
let target = null, best = -1, bestD = 1e9;
for (const m of meshes) {
  const pos = m.geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const d = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld).distanceTo(handPos);
    if (d < bestD) { bestD = d; target = m; best = i; }
  }
}
ok(best >= 0 && bestD < 0.15, 'hand-adjacent vertex found (d=' + bestD.toFixed(3) + 'm)');

const siT = target.geometry.attributes.skinIndex;
const swT = target.geometry.attributes.skinWeight;
const boneNames = [];
for (let k = 0; k < 4; k++) {
  const c = 'XYZW'[k];
  if (swT['get' + c](best) > 0.1) boneNames.push(target.skeleton.bones[siT['get' + c](best)].name);
}
ok(boneNames.some((n) => /^(HandL|ForearmL|UpperArmL)$/.test(n)), 'arm-weighted: [' + boneNames.join(', ') + ']');

function skinPoint(m, i) {
  // three.js skinning: bindInverse * (sum w * boneWorld * boneInv) * bind * p
  const pos = m.geometry.attributes.position;
  const siA = m.geometry.attributes.skinIndex;
  const swA = m.geometry.attributes.skinWeight;
  const bind = m.matrixWorld;
  const p = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(bind);
  const out = new THREE.Vector3();
  for (let k = 0; k < 4; k++) {
    const c = 'XYZW'[k];
    const bi = siA['get' + c](i);
    const w = swA['get' + c](i);
    if (w === 0) continue;
    const b = m.skeleton.bones[bi];
    const mat = new THREE.Matrix4().multiplyMatrices(b.matrixWorld, m.skeleton.boneInverses[bi]);
    out.addScaledVector(p.clone().applyMatrix4(mat), w);
  }
  return out.applyMatrix4(new THREE.Matrix4().copy(bind).invert());
}

const rest = skinPoint(target, best);
forearm.rotation.z = -Math.PI / 3;
scene.updateMatrixWorld(true);
const after = skinPoint(target, best);
const deform = after.distanceTo(rest);
ok(deform > 0.02, 'hand vertex deforms on forearm rotation: ' + deform.toFixed(3) + 'm');

// T-pose sanity: arms fit stats reported
ok(stats.armFit && stats.armFit.L && stats.armFit.R, 'arm fit applied: ' + JSON.stringify(stats.armFit));

console.log(pass + '/' + (pass + fail) + ' auto-rig tests passed');
process.exit(fail ? 1 : 0);
