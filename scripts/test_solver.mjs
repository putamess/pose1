// Headless validation of the pose/IK/collision maths against the generated
// glTF.  Run:  npm run test:solver
// (No WebGL needed — we only build the Object3D hierarchy from the glTF JSON.)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

import { createRig } from '../src/lib/rig.js';
import {
  JOINT_ORDER, JOINT_LIMITS, CHAINS, HIPS_POS_LIMITS, HINGES,
} from '../src/lib/joints.js';
import { PRESETS, clampPose, capturePoseFromRig } from '../src/lib/pose.js';
import { checkJointCollision, solveChain, clampJointRotation, hingeBendDegrees } from '../src/lib/ik.js';
import { worstPointCollision, segmentCollision } from '../src/lib/collision.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GLTF = path.join(__dirname, '..', 'public', 'mannequin.gltf');

let failures = 0;
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (!cond) {
    failures++;
    console.error(`  ✗ FAIL: ${msg}`);
  }
}
function section(name) {
  console.log(`\n== ${name}`);
}

// ---------------------------------------------------------------- build ----

function buildSceneFromGLTF(file) {
  const gltf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const objs = gltf.nodes.map((n) => {
    const o = new THREE.Object3D();
    o.name = n.name || '';
    if (n.translation) o.position.fromArray(n.translation);
    if (n.rotation) o.quaternion.fromArray(n.rotation);
    if (n.scale) o.scale.fromArray(n.scale);
    return o;
  });
  gltf.nodes.forEach((n, i) => {
    (n.children || []).forEach((c) => objs[i].add(objs[c]));
  });
  const scene = new THREE.Scene();
  scene.add(objs[gltf.scenes[gltf.scene].nodes[0]]);
  scene.updateMatrixWorld(true);
  return scene;
}

section('리그 구조');
const scene = buildSceneFromGLTF(GLTF);
let rig;
try {
  rig = createRig(scene);
  ok(true, 'createRig');
} catch (e) {
  ok(false, `createRig threw: ${e.message}`);
  process.exit(1);
}
for (const j of JOINT_ORDER) ok(!!rig.joints[j], `joint exists: ${j}`);

const len = (chainKey) => {
  const ch = CHAINS[chainKey];
  return [
    rig.joints[ch.mid].position.length(),
    rig.joints[ch.end].position.length(),
  ];
};
ok(Math.abs(len('armL')[0] - 0.27) < 1e-6, 'arm l1 = 0.27');
ok(Math.abs(len('armL')[1] - 0.24) < 1e-6, 'arm l2 = 0.24');
ok(Math.abs(len('legL')[0] - 0.42) < 1e-6, 'leg l1 = 0.42');
ok(Math.abs(len('legL')[1] - 0.40) < 1e-6, 'leg l2 = 0.40');

// ---------------------------------------------------------------- limits ---

section('관절 한계');
{
  const neck = rig.joints.Neck;
  neck.rotation.set(0, THREE.MathUtils.degToRad(200), 0, 'XYZ');
  scene.updateMatrixWorld(true);
  const changed = clampJointRotation(neck);
  const deg = THREE.MathUtils.radToDeg(new THREE.Euler().setFromQuaternion(neck.quaternion, 'XYZ').y);
  ok(changed, 'neck 200° gets clamped');
  ok(Math.abs(deg) <= 60.001, `neck y after clamp = ${deg.toFixed(1)} ≤ 60`);
  ok(JOINT_LIMITS.Neck.y[1] - JOINT_LIMITS.Neck.y[0] <= 120, 'neck y span ≤ 120° (360 impossible)');

  // slider path: setRotationDeg clamps too
  const res = rig.setRotationDeg('Neck', [0, 250, 0], { checkCollision: false });
  ok(Math.abs(res.value[1]) <= 60, 'setRotationDeg clamps to limit');
}

section('프리셋 = 한계 범위 & 바닥/충돌');
{
  for (const p of PRESETS) {
    const raw = p;
    for (const [j, r] of Object.entries(raw.rot)) {
      const lim = JOINT_LIMITS[j];
      ok(!!lim, `${p.id}: unknown joint ${j}`);
      if (!lim) continue;
      const inX = r[0] >= lim.x[0] && r[0] <= lim.x[1];
      const inY = r[1] >= lim.y[0] && r[1] <= lim.y[1];
      const inZ = r[2] >= lim.z[0] && r[2] <= lim.z[1];
      ok(inX && inY && inZ,
        `${p.id}.${j} = [${r}] within [${lim.x}][${lim.y}][${lim.z}]`);
    }
    // apply & measure
    rig.applyPose(clampPose(p));
    scene.updateMatrixWorld(true);
    const footL = rig.joints.FootL.getWorldPosition(new THREE.Vector3());
    const footR = rig.joints.FootR.getWorldPosition(new THREE.Vector3());
    ok(footL.y >= 0.07, `${p.id}: FootL ankle y ${footL.y.toFixed(3)} ≥ 0.07`);
    ok(footR.y >= 0.07, `${p.id}: FootR ankle y ${footR.y.toFixed(3)} ≥ 0.07`);
    const headY = rig.joints.Head.getWorldPosition(new THREE.Vector3()).y;
    const chestY = rig.joints.Chest.getWorldPosition(new THREE.Vector3()).y;
    ok(headY > chestY, `${p.id}: head above chest`);
    for (const key of Object.keys(CHAINS)) {
      const pen = checkJointCollision(rig, CHAINS[key].root);
      ok(!pen || pen.depth < 0.005,
        `${p.id}/${key}: self-collision depth ${pen ? pen.depth.toFixed(3) : '0'}`);
    }
    // round trip
    const cap = rig.capturePose();
    const again = rig.capturePose();
    ok(JSON.stringify(cap) === JSON.stringify(again), `${p.id}: capture stable`);
    rig.applyPose(cap);
    const cap2 = rig.capturePose();
    ok(JSON.stringify(cap2) === JSON.stringify(cap), `${p.id}: apply/capture round-trip`);
    console.log(`  · ${p.id} ok (footL y=${footL.y.toFixed(3)}, footR y=${footR.y.toFixed(3)})`);
  }
}

// ---------------------------------------------------------------- FK path --

section('FK: 충돌 거부 동작');
{
  rig.applyPose(clampPose(PRESETS[0])); // stand
  scene.updateMatrixWorld(true);
  // clean rotation is accepted
  let res = rig.setRotationDeg('ForearmL', [0, -40, 0]);
  ok(res.ok, 'normal forearm rotation accepted');
  // inject a fake collider engulfing the left arm → any arm move must revert
  const fake = {
    kind: 'sphere', node: rig.joints.UpperArmL, c: [0.14, 0, 0], r: 0.4, id: 'fake',
  };
  rig.colliders.push(fake);
  if (rig.chainColliders.armL) rig.chainColliders.armL.push(fake);
  const before = rig.getRotationDeg('ForearmL');
  res = rig.setRotationDeg('ForearmL', [0, -90, 0]);
  ok(!res.ok, 'penetrating forearm rotation rejected');
  const after = rig.getRotationDeg('ForearmL');
  const drift = Math.max(...before.map((v, i) => Math.abs(v - after[i])));
  ok(drift < 0.01, `rejected rotation reverted (drift ${drift.toFixed(4)}°)`);
  rig.colliders.pop();
  if (rig.chainColliders.armL) rig.chainColliders.armL.pop();
}

section('충돌 수학 (직접 검증)');
{
  const belly = rig.colliders.find((c) => c.id === 'belly');
  const inside = new THREE.Vector3(0, 1.0, 0.01); // centre of the belly box
  const hit = worstPointCollision([belly], inside, 0.0);
  ok(!!hit && hit.depth > 0.09, `point inside belly detected (depth ${hit && hit.depth.toFixed(3)})`);
  const outside = new THREE.Vector3(0, 1.0, 0.5);
  ok(!worstPointCollision([belly], outside, 0.0), 'far point is free');
  const segA = new THREE.Vector3(-0.3, 1.2, 0);
  const segB = new THREE.Vector3(0.3, 1.2, 0);
  const upper = rig.colliders.find((c) => c.id === 'upperTorso');
  const segHit = segmentCollision([upper], segA, segB, 0.05, 8);
  ok(!!segHit, 'segment through chest detected');
}

// ---------------------------------------------------------------- IK -------

section('IK: 팔 — 얼굴 만지기');
rig.applyPose(clampPose(PRESETS[0]));
scene.updateMatrixWorld(true);
{
  const head = rig.joints.Head.getWorldPosition(new THREE.Vector3());
  const target = head.clone().add(new THREE.Vector3(0.07, -0.02, 0.13));
  const res = solveChain(rig, 'armL', target);
  ok(!!res, 'solve returned');
  const miss = res.reached.distanceTo(res.target);
  ok(miss < 0.01, `effector reaches target (miss ${miss.toFixed(4)} m)`);
  // collision sweep must be clean
  const ch = CHAINS.armL;
  const aw = rig.joints[ch.root].getWorldPosition(new THREE.Vector3());
  const bw = rig.joints[ch.mid].getWorldPosition(new THREE.Vector3());
  const cw = rig.joints[ch.end].getWorldPosition(new THREE.Vector3());
  const p1 = segmentCollision(rig.colliders, aw, bw, ch.skinRoot, 6, 0.3, 1);
  const p2 = segmentCollision(rig.colliders, bw, cw, ch.skinMid, 8, 0.05, 1);
  ok(!p1, `no upper-arm penetration (depth ${p1 && p1.depth.toFixed(3)})`);
  ok(!p2, `no forearm penetration (depth ${p2 && p2.depth.toFixed(3)})`);
  // limits respected: ball joints → euler ranges, hinges → physical bend
  for (const j of [ch.root, ch.mid]) {
    const o = rig.joints[j];
    const lim = JOINT_LIMITS[j];
    if (HINGES[j]) {
      const bend = hingeBendDegrees(o);
      const h = HINGES[j];
      ok(bend >= h.min - 1e-3 && bend <= h.max + 1e-3,
        `${j} bend in range (${bend.toFixed(1)}° ∈ [${h.min}, ${h.max}])`);
    } else {
      const e = new THREE.Euler().setFromQuaternion(o.quaternion, 'XYZ');
      const d = [e.x, e.y, e.z].map((r) => (r * 180) / Math.PI);
      ok(d[0] >= lim.x[0] - 1e-6 && d[0] <= lim.x[1] + 1e-6, `${j} x in range (${d[0].toFixed(1)})`);
      ok(d[1] >= lim.y[0] - 1e-6 && d[1] <= lim.y[1] + 1e-6, `${j} y in range (${d[1].toFixed(1)})`);
      ok(d[2] >= lim.z[0] - 1e-6 && d[2] <= lim.z[1] + 1e-6, `${j} z in range (${d[2].toFixed(1)})`);
    }
  }
  console.log(`  · face touch miss=${miss.toFixed(4)}m`);
}

section('IK: 팔 — 몸통 관통 시도 (충돌 방지)');
{
  const target = new THREE.Vector3(0, 1.2, -0.05); // hand driven through the chest
  const res = solveChain(rig, 'armL', target);
  const ch = CHAINS.armL;
  const aw = rig.joints[ch.root].getWorldPosition(new THREE.Vector3());
  const bw = rig.joints[ch.mid].getWorldPosition(new THREE.Vector3());
  const cw = rig.joints[ch.end].getWorldPosition(new THREE.Vector3());
  const p1 = segmentCollision(rig.colliders, aw, bw, ch.skinRoot, 6, 0.3, 1);
  const p2 = segmentCollision(rig.colliders, bw, cw, ch.skinMid, 8, 0.05, 1);
  const pe = worstPointCollision(rig.colliders, cw, ch.skinEff);
  ok(!p1, `upper arm kept out of body (depth ${p1 && p1.depth.toFixed(3)})`);
  ok(!p2, `forearm kept out of body (depth ${p2 && p2.depth.toFixed(3)})`);
  ok(!pe, `hand kept out of body (depth ${pe && pe.depth.toFixed(3)})`);
  console.log(`  · blocked target resolved to (${res.target.x.toFixed(2)}, ${res.target.y.toFixed(2)}, ${res.target.z.toFixed(2)})`);
}

section('IK: 다리 — 무릎 방향(pole)과 바닥');
{
  rig.applyPose(clampPose(PRESETS[0]));
  scene.updateMatrixWorld(true);
  // front kick target
  const target = new THREE.Vector3(0.09, 0.75, 0.55);
  const res = solveChain(rig, 'legL', target);
  const miss = res.reached.distanceTo(res.target);
  ok(miss < 0.01, `leg effector reaches target (miss ${miss.toFixed(4)})`);
  const hipZ = rig.joints.UpperLegL.getWorldPosition(new THREE.Vector3()).z;
  const kneeZ = rig.joints.LowerLegL.getWorldPosition(new THREE.Vector3()).z;
  ok(kneeZ > hipZ + 0.1, `knee points forward (kneeZ ${kneeZ.toFixed(2)} > hipZ ${hipZ.toFixed(2)})`);

  // drive the foot into the floor → minY clamp
  const down = new THREE.Vector3(0.09, -0.5, 0.05);
  const res2 = solveChain(rig, 'legL', down);
  ok(res2.target.y >= 0.085 - 1e-6, `foot target clamped to y ≥ 0.085 (${res2.target.y.toFixed(3)})`);
  const footY = rig.joints.FootL.getWorldPosition(new THREE.Vector3()).y;
  ok(footY >= 0.05, `foot above ground (${footY.toFixed(3)})`);
}

section('IK: 도달 한계 밖 목표');
{
  rig.applyPose(clampPose(PRESETS[0]));
  scene.updateMatrixWorld(true);
  const A = rig.joints.UpperArmL.getWorldPosition(new THREE.Vector3());
  const far = A.clone().add(new THREE.Vector3(5, 0, 0));
  const res = solveChain(rig, 'armL', far);
  const d = res.reached.distanceTo(A);
  const maxReach = 0.27 + 0.24;
  ok(d <= maxReach + 0.02, `reach clamped (${d.toFixed(3)} ≤ ${maxReach})`);
  ok(d > maxReach - 0.05, 'arm stays fully extended toward unreachable target');
}

section('IK: 수렴(연속 솔브 안정성)');
{
  rig.applyPose(clampPose(PRESETS[0]));
  scene.updateMatrixWorld(true);
  const target = new THREE.Vector3(0.3, 1.5, 0.3);
  const r1 = solveChain(rig, 'armL', target);
  const r2 = solveChain(rig, 'armL', r1.target);
  const drift = r2.reached.distanceTo(r1.reached);
  ok(drift < 0.005, `re-solve converges (drift ${drift.toFixed(4)} m)`);
}

section('골반 위치 한계');
{
  rig.setHipsPos(0, 5, 0);
  const p = rig.getHipsPos();
  ok(p[1] <= HIPS_POS_LIMITS.y[1] + 1e-9, `hips y clamped (${p[1]})`);
  rig.setHipsPos(0, 0.94, 0);
}

// ---------------------------------------------------------------- report ---

console.log(`\n${'='.repeat(46)}`);
console.log(`checks: ${checks}, failures: ${failures}`);
if (failures > 0) {
  console.log('RESULT: FAIL');
  process.exit(1);
}
console.log('RESULT: PASS ✅');
