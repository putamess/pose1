// Foreign-rig regression test (node).
//
// public/female.glb is a real Mixamo export and breaks every assumption the
// bundled mannequin happens to satisfy:
//   • the armature carries a Z-up rotation and a 0.0085 world scale, so joint
//     LOCAL coordinates are centimetres, not metres
//   • joints bind with large non-identity rotations (Hips -90° X, thighs
//     180° Z, feet 61° X)
// Each bug below crashed straight into one of those differences. Everything
// here must also keep working on the bundled mannequin (test_solver.mjs).

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { readFileSync } from 'node:fs';
import { prepareMain } from '../src/lib/modelLoader.js';
import { createRig } from '../src/lib/rig.js';
import { clampJointRotation } from '../src/lib/ik.js';
import { PRESETS, clampPose } from '../src/lib/pose.js';
import { JOINT_ORDER, JOINT_LIMITS, CHAINS, REST_HIPS_POS } from '../src/lib/joints.js';
import { segmentCollision, worstPointCollision } from '../src/lib/collision.js';

globalThis.ProgressEvent = class ProgressEvent {
  constructor(type, init = {}) { this.type = type; Object.assign(this, init); }
};
if (typeof globalThis.self === 'undefined') {
  Object.defineProperty(globalThis, 'self', { value: globalThis });
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok   ' + m); } else { fail++; console.log('  FAIL ' + m); } };
const section = (t) => console.log('\n== ' + t);

const buf = readFileSync('public/female.glb');
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const gltf = await new Promise((res, rej) =>
  new GLTFLoader().parse(ab, '', res, rej));
const scene = prepareMain(gltf.scene);
const rig = createRig(scene);
const hips = rig.joints.Hips;

// world-space bounds of the deformed mesh (pose-aware, unlike Box3.setFromObject)
function meshBounds() {
  scene.updateMatrixWorld(true);
  const b = new THREE.Box3();
  scene.traverse((o) => {
    if (o.isSkinnedMesh) {
      o.computeBoundingBox();
      b.union(o.boundingBox.clone().applyMatrix4(o.matrixWorld));
    } else if (o.isMesh) {
      b.expandByObject(o);
    }
  });
  return b;
}

section('모델이 실제로 "외국 리그"인지 전제 확인');
{
  const ws = new THREE.Vector3();
  hips.parent.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), ws);
  ok(ws.x < 0.05, `조인트 로컬 단위는 미터가 아님 (world scale ${ws.x.toFixed(4)})`);
  const e = new THREE.Euler().setFromQuaternion(hips.quaternion, 'XYZ');
  ok(Math.abs(THREE.MathUtils.radToDeg(e.x)) > 45,
    `Hips rest 회전이 항등이 아님 (x ${THREE.MathUtils.radToDeg(e.x).toFixed(0)}°)`);
  ok(hips.position.length() > 50, `Hips 로컬 위치가 미터 스케일이 아님 (|p| ${hips.position.length().toFixed(0)})`);
}

section('프리셋 적용 후 지면에 가라앉지 않음 (hips 좌표계 버그)');
{
  const restY = hips.getWorldPosition(new THREE.Vector3()).y;
  for (const p of PRESETS) {
    rig.applyPose(clampPose(p));
    const b = meshBounds();
    const y = hips.getWorldPosition(new THREE.Vector3()).y;
    ok(b.min.y > -0.06 && b.min.y < 0.25,
      `${p.id.padEnd(8)} 발이 지면에 붙어 있음 (box.min.y ${b.min.y.toFixed(3)})`);
    if (p.id === 'stand' || p.id === 'tpose') {
      ok(Math.abs(y - restY) < 0.02,
        `${p.id.padEnd(8)} 서기 프리셋이 엉덩이를 움직이지 않음 (${y.toFixed(3)} vs rest ${restY.toFixed(3)})`);
    }
  }
  rig.applyPose(clampPose(PRESETS[0]));
  const sit = PRESETS.find((p) => p.id === 'sit');
  const standY = hips.getWorldPosition(new THREE.Vector3()).y;
  rig.applyPose(clampPose(sit));
  const sitY = hips.getWorldPosition(new THREE.Vector3()).y;
  ok(Math.abs((standY - sitY) - (REST_HIPS_POS[1] - sit.hipsPos[1])) < 0.03,
    `앉기 = 엉덩이 ${(REST_HIPS_POS[1] - sit.hipsPos[1]).toFixed(2)} m 하강 (실제 ${(standY - sitY).toFixed(3)} m)`);
}

section('hips 슬라이더는 미터 단위 델타로 동작');
{
  rig.applyPose(clampPose(PRESETS[0]));
  const rest = hips.getWorldPosition(new THREE.Vector3()).clone();
  ok(rig.getHipsPos()[1] > 0.5 && rig.getHipsPos()[1] < 1.4,
    `getHipsPos()가 미터 단위 정규값 (y ${rig.getHipsPos()[1].toFixed(3)})`);
  rig.setHipsPos(REST_HIPS_POS[0], REST_HIPS_POS[1] - 0.25, REST_HIPS_POS[2]);
  const moved = hips.getWorldPosition(new THREE.Vector3());
  ok(Math.abs((rest.y - moved.y) - 0.25) < 0.01,
    `setHipsPos(-0.25)가 정확히 0.25 m 내림 (실제 ${(rest.y - moved.y).toFixed(3)} m)`);
  rig.setHipsPos(...REST_HIPS_POS);
  ok(hips.getWorldPosition(new THREE.Vector3()).distanceTo(rest) < 0.001,
    '정규 위치로 복귀하면 rest 월드 위치로 돌아옴');
}

section('충돌체가 실제 크기(미터)를 유지 (단위 버그)');
{
  // sizes are authored on the mannequin, then re-fitted to this rig's hip
  // separation — so "correct" means authored × fit, in world metres.
  const fit = rig.fit;
  ok(fit > 0.8 && fit < 1.2, `비율 보정 계수가 합리적 (fit ${fit.toFixed(3)})`);
  for (const c of rig.colliders) {
    if (c.kind === 'box' || c.kind === 'sphere') {
      const o = c.cLocal.clone().applyMatrix4(c.node.matrixWorld);
      const origin = c.node.getWorldPosition(new THREE.Vector3());
      const off = o.distanceTo(origin);
      const want = Math.hypot(...c.c) * fit;
      ok(Math.abs(off - want) < 0.002,
        `${c.id.padEnd(11)} 오프셋 ${off.toFixed(3)} m (설계값×fit ${want.toFixed(3)} m)`);
    }
  }
  // and the box half-extents are compared in metres, so the torso really is
  // ~0.2 m thick in world space
  const belly = rig.colliders.find((c) => c.id === 'belly');
  const centre = belly.cLocal.clone().applyMatrix4(belly.node.matrixWorld);
  const edge = centre.clone();
  edge.x += belly.half[0];            // 1 half-extent in METRES, world axes
  ok(Math.abs(edge.distanceTo(centre) - belly.half[0]) < 1e-6,
    `half-extent 비교가 미터 기준 (${belly.half[0].toFixed(3)} m)`);
}

section('휴식 자세에서 자기 충돌이 없음 (비율 불일치 버그)');
{
  rig.applyPose(clampPose(PRESETS[0]));
  let worst = null;
  for (const key of Object.keys(CHAINS)) {
    const ch = rig.chains[key];
    const cols = rig.chainColliders[key] || rig.colliders;
    const aw = rig.joints[ch.root].getWorldPosition(new THREE.Vector3());
    const bw = rig.joints[ch.mid].getWorldPosition(new THREE.Vector3());
    const cw = rig.joints[ch.end].getWorldPosition(new THREE.Vector3());
    for (const hit of [
      segmentCollision(cols, aw, bw, ch.skinRoot, 8, ch.sampleRoot[0], ch.sampleRoot[1]),
      segmentCollision(cols, bw, cw, ch.skinMid, 8, ch.sampleMid[0], ch.sampleMid[1]),
      worstPointCollision(cols, cw, ch.skinEff),
    ]) if (hit && (!worst || hit.depth > worst.depth)) worst = { key, ...hit };
  }
  ok(!worst, `서기 자세가 자기 몸과 겹치지 않음${worst ? ` (${worst.key} depth ${worst.depth.toFixed(4)})` : ''}`);

  // ...which is what actually unlocks posing: sample every axis of every
  // joint and count how much of the range the character can really use.
  let total = 0, free = 0;
  const blocked = [];
  for (const j of JOINT_ORDER) {
    for (const [ai, ax] of ['x', 'y', 'z'].entries()) {
      const [lo, hi] = JOINT_LIMITS[j][ax];
      for (const v of [Math.round(lo * 0.5), Math.round(hi * 0.5), Math.round(hi * 0.9)]) {
        rig.applyPose(clampPose(PRESETS[0]));
        const d = [0, 0, 0]; d[ai] = v;
        const r = rig.setRotationDeg(j, d);
        total++;
        if (r.ok && Math.abs(rig.getRotationDeg(j)[ai] - v) < 1) free++;
        else blocked.push(`${j}.${ax}=${v}`);
      }
    }
  }
  ok(free / total > 0.85,
    `관절 가동 범위의 ${(100 * free / total).toFixed(0)}% 사용 가능 (${free}/${total})`);
  if (blocked.length) console.log('       (차단된 극단 각도: ' + blocked.join(' ') + ')');
}

section('휴식 자세의 관절은 클램프되지 않음 (절대 euler 버그)');
{
  rig.applyPose(clampPose(PRESETS[0]));
  const twisted = [];
  for (const name of JOINT_ORDER) {
    const before = rig.joints[name].quaternion.clone();
    const changed = clampJointRotation(rig.joints[name], rig.rest[name]);
    const drift = THREE.MathUtils.radToDeg(before.angleTo(rig.joints[name].quaternion));
    if (changed || drift > 0.5) twisted.push(`${name}(${drift.toFixed(0)}°)`);
  }
  ok(twisted.length === 0,
    `rest 자세가 그대로 유지됨${twisted.length ? ' — 뒤틀림: ' + twisted.join(', ') : ''}`);
}

section('IK: 뼈 길이가 미터로 측정되어 목표에 도달');
{
  rig.applyPose(clampPose(PRESETS[0]));
  const hand = rig.joints.HandL;
  const start = hand.getWorldPosition(new THREE.Vector3());
  const shoulder = rig.joints.UpperArmL.getWorldPosition(new THREE.Vector3());
  // reachable target: 60 % of the arm's total length away from the shoulder
  const reach = shoulder.distanceTo(rig.joints.ForearmL.getWorldPosition(new THREE.Vector3()))
    + rig.joints.ForearmL.getWorldPosition(new THREE.Vector3()).distanceTo(start);
  // outward + forward, clear of the torso — a target inside the body is
  // correctly pushed out and reported as a miss, which would prove nothing.
  const target = shoulder.clone().addScaledVector(
    new THREE.Vector3(0.85, -0.30, 0.45).normalize(), reach * 0.75);
  const r = rig.solveIK('armL', target);
  ok(r.miss < 0.05, `팔 IK가 목표에 도달 (miss ${r.miss.toFixed(3)} m, 팔 길이 ${reach.toFixed(2)} m)`);
  ok(reach > 0.2 && reach < 1.2, `팔 길이가 미터 단위로 합리적 (${reach.toFixed(3)} m)`);

  rig.applyPose(clampPose(PRESETS[0]));
  const foot = rig.joints.FootL.getWorldPosition(new THREE.Vector3());
  const upLeg = rig.joints.UpperLegL.getWorldPosition(new THREE.Vector3());
  const legReach = upLeg.distanceTo(rig.joints.LowerLegL.getWorldPosition(new THREE.Vector3()))
    + rig.joints.LowerLegL.getWorldPosition(new THREE.Vector3()).distanceTo(foot);
  ok(legReach > 0.3 && legReach < 1.4, `다리 길이가 미터 단위로 합리적 (${legReach.toFixed(3)} m)`);
}

section('포즈 저장 → 불러오기 왕복');
{
  rig.applyPose(clampPose(PRESETS.find((p) => p.id === 'wave')));
  const captured = rig.capturePose();
  ok(captured.hipsPos[1] > 0.5 && captured.hipsPos[1] < 1.4,
    `저장된 hipsPos가 정규 미터값 (y ${captured.hipsPos[1].toFixed(3)})`);
  const beforeY = hips.getWorldPosition(new THREE.Vector3()).y;
  rig.applyPose(clampPose(PRESETS.find((p) => p.id === 'sit')));
  rig.applyPose(clampPose(captured));
  const afterY = hips.getWorldPosition(new THREE.Vector3()).y;
  ok(Math.abs(afterY - beforeY) < 0.005,
    `왕복 후 엉덩이 높이 유지 (${beforeY.toFixed(3)} → ${afterY.toFixed(3)})`);
}

console.log(`\n${pass}/${pass + fail} foreign-rig tests passed`);
process.exit(fail ? 1 : 0);
