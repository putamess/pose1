// Unit test (node) for the foreign rig-name mapping: Mixamo-style joints get
// renamed to canonical names, canonical/mesh names stay untouched, and the
// mapping is idempotent with canonical names winning collisions.
import { applyJointNameMap } from '../src/lib/naming.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.log('  FAIL ' + m); } };

function fakeScene(names) {
  const root = { children: [] };
  for (const n of names) root.children.push({ name: n, children: [] });
  // minimal traverse (depth 2 is all we need)
  root.traverse = (fn) => { fn(root); for (const c of root.children) fn(c); };
  return root;
}

// 1. Mixamo names map onto canonical joints
{
  const s = fakeScene([
    'mixamorig:Hips', 'mixamorig:Spine', 'mixamorig:Spine2', 'mixamorig:Neck', 'mixamorig:Head',
    'mixamorig:LeftArm', 'mixamorig:LeftForeArm', 'mixamorig:LeftHand',
    'mixamorig:RightArm', 'mixamorig:RightForeArm', 'mixamorig:RightHand',
    'mixamorig:LeftUpLeg', 'mixamorig:LeftLeg', 'mixamorig:LeftFoot',
    'mixamorig:RightUpLeg', 'mixamorig:RightLeg', 'mixamorig:RightFoot',
  ]);
  applyJointNameMap(s);
  const names = s.children.map((c) => c.name);
  ok(names.includes('Hips'), 'mixamorig:Hips → Hips');
  ok(names.includes('Chest'), 'mixamorig:Spine2 → Chest');
  ok(names.includes('ForearmL'), 'mixamorig:LeftForeArm → ForearmL');
  ok(names.includes('HandR'), 'mixamorig:RightHand → HandR');
  ok(names.includes('FootL'), 'mixamorig:LeftFoot → FootL');
  ok(names.includes('UpperLegR'), 'mixamorig:RightUpLeg → UpperLegR');
  ok(names.length === 17 && new Set(names).size === 17, 'all 17 joints renamed uniquely');
}

// 2. Canonical and mesh names are left alone
{
  const s = fakeScene(['Hips', 'HandL', 'HandMeshL', 'BallWristL', 'Armature', 'Prop_01']);
  applyJointNameMap(s);
  const names = s.children.map((c) => c.name);
  ok(names.join(',') === 'Hips,HandL,HandMeshL,BallWristL,Armature,Prop_01',
    'canonical/mesh/prop names untouched: ' + names.join(','));
}

// 3. Canonical name wins a collision with a foreign alias
{
  const s = fakeScene(['Hips', 'pelvis']); // both normalize to Hips
  applyJointNameMap(s);
  const names = s.children.map((c) => c.name);
  ok(names[0] === 'Hips' && names[1] === 'pelvis', 'existing Hips wins; pelvis not renamed onto it');
}

// 4. Idempotent
{
  const s = fakeScene(['mixamorig:Hips', 'mixamorig:LeftArm', 'HandMeshL']);
  const first = applyJointNameMap(s).length;
  const second = applyJointNameMap(s).length;
  ok(first === 2 && second === 0, 'second run is a no-op (' + first + ' → ' + second + ' renames)');
}

// 5. Odd separators (Blender / Bip-style) still map
{
  const s = fakeScene(['Armature|mixamorigLeftUpLeg', 'Bip01_L_UpperArm', 'spine_02']);
  applyJointNameMap(s);
  const names = s.children.map((c) => c.name);
  ok(names.includes('UpperLegL'), 'Armature|mixamorigLeftUpLeg → UpperLegL');
  ok(names.includes('UpperArmL'), 'Bip01_L_UpperArm → UpperArmL');
  ok(names.includes('Chest'), 'spine_02 → Chest');
}

console.log(pass + '/' + (pass + fail) + ' naming tests passed');
process.exit(fail ? 1 : 0);
