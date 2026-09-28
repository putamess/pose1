// Pose capture/apply, built-in presets and localStorage persistence.
// Joint angles are plain { jointName: [x, y, z] } in DEGREES (euler XYZ).
// The hips also carry a translation (how you sit down).

import * as THREE from 'three';
import {
  JOINT_ORDER, JOINT_LIMITS, HIPS_POS_LIMITS, REST_HIPS_POS, clamp, deg2rad, rad2deg,
} from './joints.js';

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();

export const PRESETS = [
  {
    id: 'stand', name: '서기', desc: '기본 직립 자세',
    hipsPos: [...REST_HIPS_POS],
    rot: {},
  },
  {
    id: 'tpose', name: 'T-POSE', desc: '리그 기준 자세',
    hipsPos: [...REST_HIPS_POS],
    rot: {},
  },
  {
    id: 'sit', name: '앉기', desc: '의자에 앉은 자세',
    hipsPos: [0, 0.55, 0],
    rot: {
      Hips: [3, 0, 0], Spine: [4, 0, 0], Chest: [2, 0, 0],
      UpperLegL: [-88, 0, 0], LowerLegL: [98, 0, 0], FootL: [-10, 0, 0],
      UpperLegR: [-88, 0, 0], LowerLegR: [98, 0, 0], FootR: [-10, 0, 0],
      UpperArmL: [0, -10, -78], ForearmL: [0, -18, 0],
      UpperArmR: [0, 10, 78], ForearmR: [0, 18, 0],
    },
  },
  {
    id: 'walk', name: '걸음', desc: '보행 순간 포착',
    hipsPos: [...REST_HIPS_POS],
    rot: {
      Hips: [0, -6, 0], Spine: [0, 5, 0], Chest: [0, 5, 0],
      UpperLegL: [-20, 0, -3], LowerLegL: [10, 0, 0], FootL: [-4, 0, 0],
      UpperLegR: [14, 0, 3], LowerLegR: [18, 0, 0], FootR: [25, 0, 0],
      UpperArmL: [18, 0, -76], ForearmL: [0, -14, 0],
      UpperArmR: [-18, 0, 76], ForearmR: [0, 14, 0],
      Head: [0, 6, 0],
    },
  },
  {
    id: 'wave', name: '인사', desc: '오른손 흔들기',
    hipsPos: [...REST_HIPS_POS],
    rot: {
      Spine: [0, -4, 0],
      UpperArmL: [0, 0, -78], ForearmL: [0, -12, 0],
      UpperArmR: [0, 0, -85], ForearmR: [0, 55, 0], HandR: [0, 0, 18],
      Head: [0, -8, -6],
    },
  },
  {
    id: 'stretch', name: '기지개', desc: '양팔 위로 쭉',
    hipsPos: [0, 0.95, 0],
    rot: {
      Hips: [-8, 0, 0], Spine: [-18, 0, 0], Chest: [-12, 0, 0],
      Neck: [-15, 0, 0], Head: [-10, 0, 0],
      UpperArmL: [0, 0, 88], ForearmL: [0, -15, 0],
      UpperArmR: [0, 0, -88], ForearmR: [0, 15, 0],
      UpperLegL: [-4, 0, 0], UpperLegR: [-4, 0, 0],
    },
  },
  {
    id: 'bow', name: '구부리기', desc: '허리 숙인 인사',
    hipsPos: [0, 0.92, -0.04],
    rot: {
      Hips: [20, 0, 0], Spine: [35, 0, 0], Chest: [30, 0, 0],
      Neck: [15, 0, 0], Head: [10, 0, 0],
      UpperArmL: [0, 0, -80], UpperArmR: [0, 0, 80],
      LowerLegL: [6, 0, 0], LowerLegR: [6, 0, 0],
    },
  },
  {
    id: 'kick', name: '발차기', desc: '오른발 앞차기',
    hipsPos: [0, 0.93, 0],
    rot: {
      Hips: [-10, 0, 0], Spine: [-12, 0, 0],
      UpperLegR: [-95, 0, 0], LowerLegR: [15, 0, 0], FootR: [10, 0, 0],
      UpperLegL: [5, 0, 0], LowerLegL: [5, 0, 0], FootL: [-6, 0, 0],
      UpperArmL: [0, -40, -70], ForearmL: [0, -35, 0],
      UpperArmR: [0, 30, 50], ForearmR: [0, 40, 0],
      Head: [0, -8, 0],
    },
  },
];

export function clampPose(pose) {
  const out = { hipsPos: [...pose.hipsPos], rot: {} };
  for (const j of JOINT_ORDER) {
    const r = pose.rot[j];
    if (!r) continue;
    const lim = JOINT_LIMITS[j];
    out.rot[j] = [
      clamp(r[0], lim.x[0], lim.x[1]),
      clamp(r[1], lim.y[0], lim.y[1]),
      clamp(r[2], lim.z[0], lim.z[1]),
    ];
  }
  out.hipsPos = [
    clamp(out.hipsPos[0], HIPS_POS_LIMITS.x[0], HIPS_POS_LIMITS.x[1]),
    clamp(out.hipsPos[1], HIPS_POS_LIMITS.y[0], HIPS_POS_LIMITS.y[1]),
    clamp(out.hipsPos[2], HIPS_POS_LIMITS.z[0], HIPS_POS_LIMITS.z[1]),
  ];
  return out;
}

export function applyPoseToRig(rig, pose) {
  const p = clampPose(pose);
  const hips = rig.joints.Hips;
  hips.position.set(p.hipsPos[0], p.hipsPos[1], p.hipsPos[2]);
  for (const name of JOINT_ORDER) {
    const r = p.rot[name];
    const obj = rig.joints[name];
    const rest = rig.rest ? rig.rest[name] : null;
    if (!r) {
      if (rest) obj.quaternion.copy(rest);
      else obj.rotation.set(0, 0, 0, 'XYZ');
    } else {
      _e.set(deg2rad(r[0]), deg2rad(r[1]), deg2rad(r[2]), 'XYZ');
      _q.setFromEuler(_e);
      if (rest) obj.quaternion.copy(rest).multiply(_q);
      else obj.quaternion.copy(_q);
    }
  }
  rig.root.updateMatrixWorld(true);
  return p;
}

export function capturePoseFromRig(rig) {
  const rot = {};
  for (const name of JOINT_ORDER) {
    const obj = rig.joints[name];
    const rest = rig.rest ? rig.rest[name] : null;
    if (rest) {
      _q.copy(rest).invert().multiply(obj.quaternion);
      _e.setFromQuaternion(_q, 'XYZ');
    } else {
      _e.setFromQuaternion(obj.quaternion, 'XYZ');
    }
    rot[name] = [
      Math.round((rad2deg(_e.x)) * 10) / 10,
      Math.round((rad2deg(_e.y)) * 10) / 10,
      Math.round((rad2deg(_e.z)) * 10) / 10,
    ];
  }
  const h = rig.joints.Hips.position;
  return {
    hipsPos: [
      Math.round(h.x * 1000) / 1000,
      Math.round(h.y * 1000) / 1000,
      Math.round(h.z * 1000) / 1000,
    ],
    rot,
  };
}

// ---------------------------------------------------------------- storage --

const KEY = 'pose-tool.poses.v1';

export function loadStoredPoses() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function saveStoredPoses(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch (e) {
    console.warn('localStorage save failed', e);
  }
}

export function downloadJSON(pose, filename) {
  const blob = new Blob([JSON.stringify(pose, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function readPoseFile(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const pose = JSON.parse(fr.result);
        if (!pose || typeof pose !== 'object' || !pose.rot || !pose.hipsPos) {
          throw new Error('invalid pose file');
        }
        resolve(pose);
      } catch (e) {
        reject(e);
      }
    };
    fr.onerror = () => reject(new Error('file read error'));
    fr.readAsText(file);
  });
}
