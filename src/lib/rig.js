// The rig: resolves joints/colliders from the loaded glTF scene and exposes
// the operations the UI and interaction layer need (FK with limits+collision,
// IK solving, pose capture/apply).

import * as THREE from 'three';
import {
  CHAINS, CHAIN_BY_END, CHAINS_BY_JOINT, JOINT_LIMITS, JOINT_ORDER,
  HIPS_POS_LIMITS, clamp, rad2deg, isHinge,
} from './joints.js';
import { buildColliders, resolvePointOut, worstPointCollision } from './collision.js';
import { solveChain, clampJointRotation, checkJointCollision } from './ik.js';
import { applyPoseToRig, capturePoseFromRig } from './pose.js';
import { applyJointNameMap } from './naming.js';

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();

export function createRig(root) {
  // Foreign rigs (Mixamo & friends) get their nodes renamed to our joints.
  applyJointNameMap(root);

  const joints = {};
  for (const name of JOINT_ORDER) {
    const obj = root.getObjectByName(name);
    if (!obj) throw new Error(`joint missing in glTF: ${name}`);
    joints[name] = obj;
  }
  if (!joints.Hips) throw new Error('Hips missing');

  // Rest local rotations captured before any posing: sliders/presets work as
  // DELTAS from rest, so rigs with non-identity bind rotations stay sane.
  const rest = {};
  for (const name of JOINT_ORDER) rest[name] = joints[name].quaternion.clone();

  // Nearest joint to a world point (raycast fallback for skinned meshes).
  const _wp = new THREE.Vector3();
  function nearestJointName(point) {
    let best = null;
    let bestD = Infinity;
    for (const name of JOINT_ORDER) {
      const d = joints[name].getWorldPosition(_wp).distanceToSquared(point);
      if (d < bestD) {
        bestD = d;
        best = name;
      }
    }
    return bestD < 0.36 ? best : null; // >0.6 m away from every joint: none
  }

  const rig = {
    root,
    joints,
    rest,
    colliders: buildColliders(root),
    chainsByJoint: CHAINS_BY_JOINT,

    // Per-chain collider subsets (a leg never collides with its own thigh).
    chainColliders: {},

    getJoint(name) {
      return joints[name];
    },

    // ---- FK ---------------------------------------------------------------
    getRotationDeg(name) {
      const obj = joints[name];
      // delta = rest⁻¹ · current  (euler XYZ, degrees)
      _q.copy(rest[name]).invert().multiply(obj.quaternion);
      _e.setFromQuaternion(_q, 'XYZ');
      return [rad2deg(_e.x), rad2deg(_e.y), rad2deg(_e.z)];
    },

    // Set a joint's euler (degrees). Enforces limits. When checkCollision is
    // on, a pose that drives limbs through the body is rejected (returns
    // { ok:false }) so sliders/gizmos can snap back.
    setRotationDeg(name, deg, { checkCollision = true } = {}) {
      const obj = joints[name];
      const lim = JOINT_LIMITS[name];
      const hinge = isHinge(name);
      const prev = obj.quaternion.clone();
      // hinges are constrained physically (bend angle), not by euler bounds
      const d = hinge ? [...deg] : [
        lim ? clamp(deg[0], lim.x[0], lim.x[1]) : deg[0],
        lim ? clamp(deg[1], lim.y[0], lim.y[1]) : deg[1],
        lim ? clamp(deg[2], lim.z[0], lim.z[1]) : deg[2],
      ];
      obj.quaternion
        .copy(rest[name])
        .multiply(_q.setFromEuler(_e.set(
          THREE.MathUtils.degToRad(d[0]),
          THREE.MathUtils.degToRad(d[1]),
          THREE.MathUtils.degToRad(d[2]),
          'XYZ',
        )));
      root.updateMatrixWorld(true);
      clampJointRotation(obj);
      root.updateMatrixWorld(true);
      if (checkCollision) {
        const pen = checkJointCollision(rig, name);
        if (pen && pen.depth > 0.004) {
          obj.quaternion.copy(prev);
          root.updateMatrixWorld(true);
          return { ok: false, value: rig.getRotationDeg(name), pen };
        }
      }
      return { ok: true, value: rig.getRotationDeg(name) };
    },

    // Live clamp during a gizmo drag (limits only — no revert mid-drag).
    liveClamp(name) {
      const changed = clampJointRotation(joints[name]);
      if (changed) root.updateMatrixWorld(true);
      return changed;
    },

    // Called on gizmo mouse-up: revert the whole pose if anything now
    // intersects. Returns the offending chain or null.
    validateAfterGizmo(snapshot) {
      for (const key of Object.keys(CHAINS)) {
        const pen = checkJointCollision(rig, CHAINS[key].root);
        if (pen && pen.depth > 0.006) {
          applyPoseToRig(rig, snapshot);
          return key;
        }
      }
      return null;
    },

    // ---- hips translation -------------------------------------------------
    getHipsPos() {
      const p = joints.Hips.position;
      return [p.x, p.y, p.z];
    },
    setHipsPos(x, y, z) {
      const p = joints.Hips.position;
      p.set(
        clamp(x, HIPS_POS_LIMITS.x[0], HIPS_POS_LIMITS.x[1]),
        clamp(y, HIPS_POS_LIMITS.y[0], HIPS_POS_LIMITS.y[1]),
        clamp(z, HIPS_POS_LIMITS.z[0], HIPS_POS_LIMITS.z[1]),
      );
      root.updateMatrixWorld(true);
    },

    // ---- IK ---------------------------------------------------------------
    solveIK(chainKey, targetWorld) {
      return solveChain(rig, chainKey, targetWorld);
    },

    effectorWorldPos(chainKey, out) {
      const ch = CHAINS[chainKey];
      return joints[ch.end].getWorldPosition(out || new THREE.Vector3());
    },

    // Which chain (if any) a hit object belongs to — walk up ancestors.
    // The nearest-joint point fallback is ONLY for skinned meshes (whose
    // ancestors are the model root, not joints). Static models keep strict
    // ancestor semantics: a forearm hit must not be misread as a hand drag.
    chainForNode(obj, point) {
      let n = obj;
      let sawJoint = false;
      while (n && n !== root) {
        if (CHAIN_BY_END[n.name]) return CHAIN_BY_END[n.name];
        if (JOINT_LIMITS[n.name]) sawJoint = true;
        n = n.parent;
      }
      if (point && !sawJoint) {
        const near = nearestJointName(point);
        if (near && CHAIN_BY_END[near]) return CHAIN_BY_END[near];
      }
      return null;
    },

    // Nearest joint ancestor for a raycast hit (FK selection).
    // Fallback for skinned meshes: nearest joint to the hit point.
    jointForNode(obj, point) {
      let n = obj;
      while (n && n !== root) {
        if (JOINT_LIMITS[n.name]) return n.name;
        n = n.parent;
      }
      return point ? nearestJointName(point) : null;
    },

    jointWorldPos(name, out) {
      return joints[name].getWorldPosition(out || new THREE.Vector3());
    },

    // ---- pose -------------------------------------------------------------
    capturePose() {
      return capturePoseFromRig(rig);
    },
    applyPose(pose) {
      return applyPoseToRig(rig, pose);
    },

    // Is the hand/foot allowed at this world point? (used for cursor hints)
    effectorBlocked(chainKey, worldPoint) {
      const ch = CHAINS[chainKey];
      return !!worstPointCollision(
        rig.chainColliders[chainKey] || rig.colliders,
        worldPoint,
        ch.skinEff,
      );
    },
    resolveEffector(chainKey, worldPoint) {
      const ch = CHAINS[chainKey];
      return resolvePointOut(rig.chainColliders[chainKey] || rig.colliders, worldPoint, ch.skinEff);
    },
  };

  // Per-chain collider subsets (a leg never collides with its own thigh).
  for (const [key, ch] of Object.entries(CHAINS)) {
    const ignore = new Set(ch.ignoreIds || []);
    rig.chainColliders[key] = rig.colliders.filter((c) => !ignore.has(c.id));
  }

  return rig;
}
