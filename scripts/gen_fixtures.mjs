// Generates the GLB fixtures used by the browser/unit tests from
// public/mannequin.gltf (the single geometry source, made by gen_gltf.py):
//
//   public/mannequin_user.glb — rig-less humanoid (auto-rig + prop tests)
//                               meshes only, baked world transforms, no joints
//   public/soldier_user.glb   — rigged humanoid with MIXAMO joint names
//                               (tests the foreign-name rename pipeline)
//
// Run: node scripts/gen_fixtures.mjs   (also: npm run gen:fixtures)
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = JSON.parse(readFileSync(path.join(root, 'public', 'mannequin.gltf'), 'utf8'));

// glTF data-URI buffer -> raw bin chunk (shared by both fixtures)
const bin = Buffer.from(src.buffers[0].uri.split(',')[1], 'base64');

// canonical joint -> Mixamo-style name (must stay in sync with src/lib/naming.js)
const JOINT_RENAMES = {
  Root: 'Armature',
  Hips: 'mixamorig:Hips',
  Spine: 'mixamorig:Spine',
  Chest: 'mixamorig:Spine2',
  Neck: 'mixamorig:Neck',
  Head: 'mixamorig:Head',
  UpperArmL: 'mixamorig:LeftArm',
  ForearmL: 'mixamorig:LeftForeArm',
  HandL: 'mixamorig:LeftHand',
  UpperArmR: 'mixamorig:RightArm',
  ForearmR: 'mixamorig:RightForeArm',
  HandR: 'mixamorig:RightHand',
  UpperLegL: 'mixamorig:LeftUpLeg',
  LowerLegL: 'mixamorig:LeftLeg',
  FootL: 'mixamorig:LeftFoot',
  UpperLegR: 'mixamorig:RightUpLeg',
  LowerLegR: 'mixamorig:RightLeg',
  FootR: 'mixamorig:RightFoot',
};

// Rest-pose tweak for the soldier fixture: a relaxed A-pose (arms down ~60°)
// like a typical uploaded character. Joints keep identity-free rests and the
// rig code captures rest rotations as pose deltas, so this stays valid — and
// it keeps the soldier's hands off the default mannequin's silhouette when
// both stand at the origin (pick rays would otherwise hit a perfect tie).
const A_POSE = {
  'mixamorig:LeftArm': [0, 0, -0.5, 0.8660254], // z-rotation -60°
  'mixamorig:RightArm': [0, 0, 0.5, 0.8660254], // z-rotation +60°
};

function gltfOf(nodes, sceneRoots) {
  return {
    asset: { version: '2.0', generator: 'pose-tool gen_fixtures.mjs' },
    scene: 0,
    scenes: [{ name: 'Scene', nodes: sceneRoots }],
    nodes,
    meshes: src.meshes,
    materials: src.materials,
    accessors: src.accessors,
    bufferViews: src.bufferViews,
    buffers: [{ byteLength: bin.length }], // GLB: binary chunk, no URI
  };
}

function writeGlb(file, gltf) {
  const json = Buffer.from(JSON.stringify(gltf), 'utf8');
  const jsonChunk = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const binChunk = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4, 0)]);
  const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;

  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0); // 'glTF'
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(total, 8);
  const jc = Buffer.alloc(8);
  jc.writeUInt32LE(jsonChunk.length, 0);
  jc.writeUInt32LE(0x4e4f534a, 4); // 'JSON'
  const bc = Buffer.alloc(8);
  bc.writeUInt32LE(binChunk.length, 0);
  bc.writeUInt32LE(0x004e4942, 4); // 'BIN\0'

  writeFileSync(file, Buffer.concat([head, jc, jsonChunk, bc, binChunk]));
  console.log('wrote ' + path.relative(root, file) + '  (' + (total / 1024).toFixed(1) + ' KB)');
}

// ---- soldier_user.glb: same hierarchy, Mixamo joint names, A-pose arms -----
{
  const nodes = src.nodes.map((n) => {
    const name = JOINT_RENAMES[n.name] ?? n.name;
    const out = { name };
    if (n.translation) out.translation = n.translation;
    if (A_POSE[name]) out.rotation = A_POSE[name];
    if (n.mesh !== undefined) out.mesh = n.mesh;
    if (n.children) out.children = n.children;
    return out;
  });
  writeGlb(
    path.join(root, 'public', 'soldier_user.glb'),
    gltfOf(nodes, [src.scenes[0].nodes[0]]),
  );
}

// ---- mannequin_user.glb: rig-less flat meshes at baked world transforms ----
{
  // rest pose is all-identity rotations, so world translation = sum of parents
  const world = new Map();
  const walk = (idx, parent) => {
    const t = src.nodes[idx].translation || [0, 0, 0];
    const w = [parent[0] + t[0], parent[1] + t[1], parent[2] + t[2]];
    world.set(idx, w);
    for (const c of src.nodes[idx].children || []) walk(c, w);
  };
  for (const r of src.scenes[0].nodes) walk(r, [0, 0, 0]);

  const nodes = [{ name: 'mannequin_user', children: [] }];
  for (const [idx, w] of world) {
    const n = src.nodes[idx];
    if (n.mesh === undefined) continue; // drop every joint node
    nodes[0].children.push(nodes.length);
    nodes.push({ name: n.name, translation: w, mesh: n.mesh });
  }
  writeGlb(path.join(root, 'public', 'mannequin_user.glb'), gltfOf(nodes, [0]));
}
