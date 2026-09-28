// Map foreign rig naming conventions onto our canonical joint names so any
// humanoid glTF skeleton (Mixamo, Blender exports, ...) can drive the rig.
// We RENAME nodes in place — everything downstream (selection, colliders,
// chains, presets) keeps working by name.

const ALIASES = {
  // spine / head
  hips: 'Hips', pelvis: 'Hips',
  spine: 'Spine',
  spine2: 'Chest', spine02: 'Chest', spine03: 'Chest', chest: 'Chest', upperchest: 'Chest',
  neck: 'Neck',
  head: 'Head',
  // arms L
  leftarm: 'UpperArmL', leftupperarm: 'UpperArmL', lupperarm: 'UpperArmL',
  upperarml: 'UpperArmL', larm: 'UpperArmL', arml: 'UpperArmL',
  leftforearm: 'ForearmL', leftlowerarm: 'ForearmL', lforearm: 'ForearmL',
  forearml: 'ForearmL', lowerarml: 'ForearmL',
  lefthand: 'HandL', lhand: 'HandL', handl: 'HandL',
  // arms R
  rightarm: 'UpperArmR', rightupperarm: 'UpperArmR', rupperarm: 'UpperArmR',
  upperarmr: 'UpperArmR', rarm: 'UpperArmR', armr: 'UpperArmR',
  rightforearm: 'ForearmR', rightlowerarm: 'ForearmR', rforearm: 'ForearmR',
  forearmr: 'ForearmR', lowerarmr: 'ForearmR',
  righthand: 'HandR', rhand: 'HandR', handr: 'HandR',
  // legs L
  leftupleg: 'UpperLegL', leftupperleg: 'UpperLegL', lupleg: 'UpperLegL',
  upperlegl: 'UpperLegL', uplegl: 'UpperLegL', leftthigh: 'UpperLegL', thighl: 'UpperLegL',
  leftleg: 'LowerLegL', leftlowerleg: 'LowerLegL', lleg: 'LowerLegL',
  lowerlegl: 'LowerLegL', leftshin: 'LowerLegL', shinl: 'LowerLegL',
  leftfoot: 'FootL', lfoot: 'FootL', footl: 'FootL',
  // legs R
  rightupleg: 'UpperLegR', rightupperleg: 'UpperLegR', rupleg: 'UpperLegR',
  upperlegr: 'UpperLegR', uplegr: 'UpperLegR', rightthigh: 'UpperLegR', thighr: 'UpperLegR',
  rightleg: 'LowerLegR', rightlowerleg: 'LowerLegR', rleg: 'LowerLegR',
  lowerlegr: 'LowerLegR', rightshin: 'LowerLegR', shinr: 'LowerLegR',
  rightfoot: 'FootR', rfoot: 'FootR', footr: 'FootR',
};
const KNOWN = new Set(Object.values(ALIASES));
const MULTI_SEGMENT = /[^a-z0-9]/g;

// 'mixamorig:Hips' | 'Armature|mixamorigLeftArm' | 'Bip01_L_UpperArm' → 'hips'/'leftarm'/...
function normalize(raw) {
  let s = String(raw).toLowerCase();
  s = s.split(/[|:/\\]/).pop();            // path/namespace segment
  s = s.replace(MULTI_SEGMENT, '');        // drop _ - . spaces
  s = s.replace(/^mixamorig/, '');
  s = s.replace(/^armature/, '');
  s = s.replace(/^bip\d+/, '');
  s = s.replace(/^bone/, '');
  return s;
}

// Renames matching nodes to canonical names. Idempotent; never renames two
// nodes to the same target (canonical-named nodes always win).
export function applyJointNameMap(root) {
  const taken = new Set();
  root.traverse((o) => {
    if (KNOWN.has(o.name)) taken.add(o.name);
  });
  const renames = [];
  root.traverse((o) => {
    if (KNOWN.has(o.name)) return;          // already canonical
    const target = ALIASES[normalize(o.name)];
    if (!target || taken.has(target)) return;
    renames.push([o, target]);
    taken.add(target);
  });
  for (const [o, target] of renames) o.name = target;
  return renames.map(([o, t]) => `${o.name || '(unnamed)'}→${t}`);
}
