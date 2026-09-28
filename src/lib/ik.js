// Analytic two-bone IK with joint limits and collision response.
//
// solveChain():
//   1. clamps the target out of body colliders (point test, effector radius)
//   2. solves the chain exactly (law of cosines + pole vector)
//   3. samples the limb segments against the colliders; if the arm/leg still
//      passes through the body the target is nudged out and we re-solve
//   4. clamps both joint rotations to their anatomical limits
//
// Everything is driven through the rig object created in rig.js.

import * as THREE from 'three';
import { CHAINS, HINGES, JOINT_LIMITS, clamp, deg2rad, rad2deg } from './joints.js';
import { worstPointCollision, segmentCollision, resolvePointOut } from './collision.js';

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();

const _a = new THREE.Vector3();
const _t = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _midDir = new THREE.Vector3();
const _eff = new THREE.Vector3();
const _midPos = new THREE.Vector3();
const _curDir = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _qd = new THREE.Quaternion();
const _qw = new THREE.Quaternion();
const _pw = new THREE.Quaternion();

function setWorldQuaternion(obj, qWorld) {
  // parent.matrixWorld is kept current by root.updateMatrixWorld / updates below
  const pq = obj.parent.getWorldQuaternion(new THREE.Quaternion());
  obj.quaternion.copy(pq.invert().multiply(qWorld)).normalize();
  obj.updateMatrixWorld(true);
}

// Clamp a joint to its anatomical limits.
//   • hinge joints (elbows/knees): physical bend angle around the hinge axis
//   • everything else: euler XYZ component limits
export function clampJointRotation(obj) {
  const hinge = HINGES[obj.name];
  if (hinge) return hingeClamp(obj, hinge);

  const lim = JOINT_LIMITS[obj.name];
  if (!lim) return false;
  const e = new THREE.Euler().setFromQuaternion(obj.quaternion, 'XYZ');
  const dx = rad2deg(e.x), dy = rad2deg(e.y), dz = rad2deg(e.z);
  const cx = clamp(dx, lim.x[0], lim.x[1]);
  const cy = clamp(dy, lim.y[0], lim.y[1]);
  const cz = clamp(dz, lim.z[0], lim.z[1]);
  const changed = cx !== dx || cy !== dy || cz !== dz;
  if (changed) {
    e.set(deg2rad(cx), deg2rad(cy), deg2rad(cz), 'XYZ');
    obj.quaternion.setFromEuler(e);
    obj.updateMatrixWorld(true);
  }
  return changed;
}

// Signed bend angle (degrees) of a hinge joint, measured between the parent
// bone direction (rest) and the child bone direction, in the parent's local
// frame, around the hinge axis. Used by the clamp and by tests.
export function hingeBendDegrees(obj) {
  const h = HINGES[obj.name];
  if (!h) return 0;
  const parent = obj.parent;
  const child = obj.getObjectByName(h.child);
  if (!child || !parent) return 0;
  const midW = obj.getWorldPosition(new THREE.Vector3());
  const endW = child.getWorldPosition(new THREE.Vector3());
  const dirW = endW.sub(midW);
  if (dirW.lengthSq() < 1e-12) return 0;
  dirW.normalize();
  const pq = parent.getWorldQuaternion(new THREE.Quaternion());
  const dirL = dirW.applyQuaternion(pq.clone().invert());
  const ref = obj.position.clone().normalize();
  const axis = _v3.set(h.axis[0], h.axis[1], h.axis[2]).normalize();
  const theta = Math.atan2(axis.dot(_v4.crossVectors(ref, dirL)), ref.dot(dirL));
  return rad2deg(theta);
}

function hingeClamp(obj, h) {
  const parent = obj.parent;
  const child = obj.getObjectByName(h.child);
  if (!child || !parent) return false;

  const midW = obj.getWorldPosition(_v1);
  const endW = child.getWorldPosition(_v2);
  const dirW = endW.sub(midW);
  if (dirW.lengthSq() < 1e-12) return false;
  dirW.normalize();

  const pq = parent.getWorldQuaternion(new THREE.Quaternion());
  const dirL = dirW.applyQuaternion(pq.clone().invert());
  const ref = obj.position.clone().normalize();
  const axis = _v3.set(h.axis[0], h.axis[1], h.axis[2]).normalize();
  const theta = Math.atan2(axis.dot(_v4.crossVectors(ref, dirL)), ref.dot(dirL));
  const tDeg = rad2deg(theta);
  const c = clamp(tDeg, h.min, h.max);
  if (Math.abs(c - tDeg) < 1e-6) return false;

  // rotate the child-bone direction by the correction, preserving any
  // out-of-plane (valgus/twist) deviation
  dirL.applyAxisAngle(axis, deg2rad(c - tDeg));
  const targetDir = dirL.clone().applyQuaternion(pq);

  const boneLocal = child.position.clone().normalize();
  const curQ = obj.getWorldQuaternion(new THREE.Quaternion());
  const curDir = boneLocal.applyQuaternion(curQ);
  const qd = new THREE.Quaternion().setFromUnitVectors(curDir, targetDir);
  const qw = qd.clone().multiply(curQ);
  setWorldQuaternion(obj, qw);
  return true;
}

// Core exact two-bone solve: rotates root & mid joints so `end` reaches target.
// (exported for tests/debugging)
export function applyTwoBone(root, mid, end, l1, l2, target, poleVec) {
  root.getWorldPosition(_a);
  _dir.subVectors(target, _a);
  const len = _dir.length();
  if (len < 1e-9) _dir.set(0, -1, 0); else _dir.multiplyScalar(1 / len);
  const minD = Math.abs(l1 - l2) + 1e-4;
  const maxD = l1 + l2 - 1e-4;
  const dist = clamp(len, minD, maxD);
  _eff.copy(_a).addScaledVector(_dir, dist);

  const cosA = clamp((l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist), -1, 1);
  const alpha = Math.acos(cosA);

  // pole, orthogonalised against the root→target direction
  _pole.copy(poleVec).normalize();
  _pole.addScaledVector(_dir, -_pole.dot(_dir));
  if (_pole.lengthSq() < 1e-10) {
    // degenerate: fall back to the current mid-joint direction
    mid.getWorldPosition(_pole);
    _pole.sub(_a);
    _pole.addScaledVector(_dir, -_pole.dot(_dir));
    if (_pole.lengthSq() < 1e-10) _pole.set(0, 1, 0).addScaledVector(_dir, -_dir.y);
  }
  _pole.normalize();

  _axis.crossVectors(_dir, _pole).normalize();
  _midDir.copy(_dir).applyAxisAngle(_axis, alpha);
  _midPos.copy(_a).addScaledVector(_midDir, l1);

  // rotate root joint: bone axis (local) → midDir (world)
  const boneAxisA = mid.position.clone().normalize();
  const curA = root.getWorldQuaternion(new THREE.Quaternion());
  _curDir.copy(boneAxisA).applyQuaternion(curA);
  _qd.setFromUnitVectors(_curDir, _midDir);
  _qw.copy(_qd).multiply(curA);
  setWorldQuaternion(root, _qw);

  // rotate mid joint: bone axis (local) → target direction (world)
  mid.getWorldPosition(_a);
  const boneAxisB = end.position.clone().normalize();
  const curB = mid.getWorldQuaternion(new THREE.Quaternion());
  _curDir.copy(boneAxisB).applyQuaternion(curB);
  _desired.subVectors(_eff, _midPos).normalize();
  _qd.setFromUnitVectors(_curDir, _desired);
  _qw.copy(_qd).multiply(curB);
  setWorldQuaternion(mid, _qw);
}

export function solveChain(rig, chainKey, targetWorld, opts = {}) {
  const ch = CHAINS[chainKey];
  const A = rig.joints[ch.root];
  const B = rig.joints[ch.mid];
  const C = rig.joints[ch.end];
  if (!A || !B || !C) return null;

  const root = rig.root;
  root.updateMatrixWorld(true);

  const l1 = B.position.length();
  const l2 = C.position.length();
  const poleWorld = new THREE.Vector3(...ch.pole);
  const colliders = rig.chainColliders[chainKey] || rig.colliders;
  const target = _t.copy(targetWorld);
  if (ch.minY !== undefined) target.y = Math.max(target.y, ch.minY);

  const samplesRoot = 5;
  const samplesMid = 6;
  let lastPen = null;

  for (let iter = 0; iter < 5; iter++) {
    // 1. keep the effector out of the body
    const pushed = resolvePointOut(colliders, target, ch.skinEff);
    target.copy(pushed);
    if (ch.minY !== undefined) target.y = Math.max(target.y, ch.minY);

    // 2. exact solve
    applyTwoBone(A, B, C, l1, l2, target, poleWorld);
    root.updateMatrixWorld(true);

    // 3. segment sweep — arms must not pass through the torso
    const aw = A.getWorldPosition(new THREE.Vector3());
    const bw = B.getWorldPosition(new THREE.Vector3());
    const cw = C.getWorldPosition(new THREE.Vector3());
    const [rt0, rt1] = ch.sampleRoot;
    const [mt0, mt1] = ch.sampleMid;
    const pen1 = segmentCollision(colliders, aw, bw, ch.skinRoot, samplesRoot, rt0, rt1);
    const pen2 = segmentCollision(colliders, bw, cw, ch.skinMid, samplesMid, mt0, mt1);
    lastPen = pen2 || pen1;
    if (!lastPen) break;
    // 4. nudge the target out along the penetration normal and retry
    target.addScaledVector(lastPen.normal, lastPen.depth + 0.006);
    if (ch.minY !== undefined) target.y = Math.max(target.y, ch.minY);
  }

  // 5. anatomical limits
  clampJointRotation(A);
  clampJointRotation(B);
  root.updateMatrixWorld(true);

  const reached = C.getWorldPosition(new THREE.Vector3());
  return {
    chain: chainKey,
    target: target.clone(),
    reached,
    penetration: lastPen,
    miss: reached.distanceTo(target),
  };
}

// FK path: validate a candidate rotation by running the collision sweep for
// every chain that joint belongs to. Returns null when the pose is clean,
// or the worst violation otherwise.
export function checkJointCollision(rig, jointName) {
  const chainNames = rig.chainsByJoint[jointName];
  if (!chainNames || !chainNames.length) return null;
  rig.root.updateMatrixWorld(true);
  let worst = null;
  for (const key of chainNames) {
    const ch = CHAINS[key];
    const colliders = rig.chainColliders[key] || rig.colliders;
    const A = rig.joints[ch.root];
    const B = rig.joints[ch.mid];
    const C = rig.joints[ch.end];
    const aw = A.getWorldPosition(new THREE.Vector3());
    const bw = B.getWorldPosition(new THREE.Vector3());
    const cw = C.getWorldPosition(new THREE.Vector3());
    const [rt0, rt1] = ch.sampleRoot;
    const [mt0, mt1] = ch.sampleMid;
    const hits = [
      segmentCollision(colliders, aw, bw, ch.skinRoot, 5, rt0, rt1),
      segmentCollision(colliders, bw, cw, ch.skinMid, 6, mt0, mt1),
      worstPointCollision(colliders, cw, ch.skinEff),
    ];
    for (const h of hits) {
      if (h && (!worst || h.depth > worst.depth)) worst = { ...h, chain: key };
    }
    if (ch.minY !== undefined && cw.y < ch.minY - 0.02) {
      if (!worst) worst = { chain: key, depth: 0, reason: 'ground', normal: new THREE.Vector3(0, 1, 0) };
    }
  }
  return worst;
}
