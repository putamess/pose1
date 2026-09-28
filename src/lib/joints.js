// Joint definitions for the mannequin rig (see scripts/gen_gltf.py).
// Euler order is THREE's default 'XYZ'. All angles in DEGREES.
// Rest pose: T-pose, character faces +z, +x is the character's left.

export const JOINT_ORDER = [
  'Hips', 'Spine', 'Chest', 'Neck', 'Head',
  'UpperArmL', 'ForearmL', 'HandL',
  'UpperArmR', 'ForearmR', 'HandR',
  'UpperLegL', 'LowerLegL', 'FootL',
  'UpperLegR', 'LowerLegR', 'FootR',
];

// Per-axis angle limits [min, max] in degrees. A neck that spins 360° is
// exactly what these exist to prevent.
export const JOINT_LIMITS = {
  Hips:      { x: [-20, 25], y: [-30, 30], z: [-20, 20] },
  Spine:     { x: [-25, 40], y: [-30, 30], z: [-25, 25] },
  Chest:     { x: [-20, 35], y: [-35, 35], z: [-25, 25] },
  Neck:      { x: [-25, 30], y: [-60, 60], z: [-20, 20] },   // no 360° spin!
  Head:      { x: [-20, 25], y: [-45, 45], z: [-20, 20] },

  UpperArmL: { x: [-90, 90], y: [-95, 95], z: [-100, 165] },
  ForearmL:  { x: [-80, 80], y: [-145, 5], z: [-5, 5] },
  HandL:     { x: [-70, 70], y: [-45, 45], z: [-45, 45] },
  UpperArmR: { x: [-90, 90], y: [-95, 95], z: [-165, 100] },
  ForearmR:  { x: [-80, 80], y: [-5, 145], z: [-5, 5] },
  HandR:     { x: [-70, 70], y: [-45, 45], z: [-45, 45] },

  UpperLegL: { x: [-125, 35], y: [-45, 45], z: [-30, 45] },
  LowerLegL: { x: [-5, 145], y: [-15, 15], z: [-10, 10] },
  FootL:     { x: [-20, 45], y: [-20, 20], z: [-15, 15] },
  UpperLegR: { x: [-125, 35], y: [-45, 45], z: [-45, 30] },
  LowerLegR: { x: [-5, 145], y: [-15, 15], z: [-10, 10] },
  FootR:     { x: [-20, 45], y: [-20, 20], z: [-15, 15] },
};

// Hips translation limits (metres) — lowering the hips is how you sit.
export const HIPS_POS_LIMITS = {
  x: [-0.18, 0.18],
  y: [0.38, 1.05],
  z: [-0.30, 0.30],
};

export const REST_HIPS_POS = [0, 0.94, 0];

// Two-bone IK chains.
//   pole: world-space direction the mid joint (elbow/knee) should favour.
//         arms: out+down+back (natural elbow); legs: forward (knee direction)
//   skin: collision radii per segment (root bone, mid bone) and effector point.
//   ignoreIds: colliders a chain must NOT test against (its own thigh — the
//         bone centre-line lies exactly on that capsule axis by definition).
export const CHAINS = {
  armL: {
    root: 'UpperArmL', mid: 'ForearmL', end: 'HandL',
    pole: [0.6, -0.65, -0.46],
    skinRoot: 0.05, skinMid: 0.046, skinEff: 0.044,
    sampleRoot: [0.3, 1], sampleMid: [0.05, 1],
    ignoreIds: [],
    limbName: '팔(왼쪽)',
  },
  armR: {
    root: 'UpperArmR', mid: 'ForearmR', end: 'HandR',
    pole: [-0.6, -0.65, -0.46],
    skinRoot: 0.05, skinMid: 0.046, skinEff: 0.044,
    sampleRoot: [0.3, 1], sampleMid: [0.05, 1],
    ignoreIds: [],
    limbName: '팔(오른쪽)',
  },
  legL: {
    root: 'UpperLegL', mid: 'LowerLegL', end: 'FootL',
    pole: [0, 0, 1],
    skinRoot: 0.078, skinMid: 0.063, skinEff: 0.057,
    sampleRoot: [0.6, 1], sampleMid: [0.05, 1],
    minY: 0.085,
    ignoreIds: ['thighL'],
    limbName: '다리(왼쪽)',
  },
  legR: {
    root: 'UpperLegR', mid: 'LowerLegR', end: 'FootR',
    pole: [0, 0, 1],
    skinRoot: 0.078, skinMid: 0.063, skinEff: 0.057,
    sampleRoot: [0.6, 1], sampleMid: [0.05, 1],
    minY: 0.085,
    ignoreIds: ['thighR'],
    limbName: '다리(오른쪽)',
  },
};

// Dragging a mesh whose ancestor is one of these joints starts an IK drag.
export const CHAIN_BY_END = {
  HandL: 'armL', HandR: 'armR', FootL: 'legL', FootR: 'legR',
};

// Which chains a joint rotation can affect (for FK collision checks).
export const CHAINS_BY_JOINT = (() => {
  const map = {};
  for (const [key, ch] of Object.entries(CHAINS)) {
    for (const j of [ch.root, ch.mid, ch.end]) {
      (map[j] = map[j] || []).push(key);
    }
  }
  const torso = ['Hips', 'Spine', 'Chest'];
  for (const j of torso) map[j] = Object.keys(CHAINS);
  return map;
})();

export const deg2rad = (d) => (d * Math.PI) / 180;
export const rad2deg = (r) => (r * 180) / Math.PI;
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// Hinge joints (elbows/knees) are NOT limited by euler components — an
// arbitrary IK orientation decomposes into wild XYZ angles that don't match
// anatomy. Instead we clamp the *physical bend angle* around the hinge axis
// in the parent joint's rest frame. Much more robust for both FK and IK.
//   axis: hinge axis in the PARENT joint's local rest frame
//   min/max: signed bend in degrees (negative = opposite bend direction)
export const HINGES = {
  ForearmL:  { min: -145, max: 5,   axis: [0, 1, 0], child: 'HandL' },
  ForearmR:  { min: -5,   max: 145, axis: [0, 1, 0], child: 'HandR' },
  LowerLegL: { min: -5,   max: 145, axis: [1, 0, 0], child: 'FootL' },
  LowerLegR: { min: -5,   max: 145, axis: [1, 0, 0], child: 'FootR' },
};

export function isHinge(name) {
  return !!HINGES[name];
}

export function clampDeg(name, euler) {
  const lim = JOINT_LIMITS[name];
  if (!lim) return euler;
  return [clamp(euler[0], lim.x[0], lim.x[1]),
          clamp(euler[1], lim.y[0], lim.y[1]),
          clamp(euler[2], lim.z[0], lim.z[1])];
}
