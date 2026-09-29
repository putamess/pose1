// Self-collision: approximate the body with boxes, a sphere and capsules,
// then keep IK targets / limb segments out of them.
//
// Colliders are declared in *local space* of a rig node so they follow the
// torso/head as the spine bends. Tests inflate the collider by a "skin"
// radius (limb thickness + margin) — a limb centre-line entering that volume
// means the limb surface is visually intersecting the body.
//
// Sizes/offsets are authored in METRES, and every comparison (half-extents,
// radius, `skin`) stays in metres. A foreign rig may keep its joints in
// centimetres under a 0.01-scaled armature, so each shape also remembers the
// node's world scale and converts its own offset into node-local units —
// otherwise the collider silently shrinks to ~1 mm and self-collision
// stops working on exactly the models that need it most.

import * as THREE from 'three';

export const COLLIDER_SPECS = [
  // upper torso (rib cage) — attached to the chest
  { kind: 'box', node: 'Chest', c: [0, 0.02, 0], half: [0.11, 0.12, 0.10], id: 'upperTorso' },
  // belly / lower torso — attached to the hips
  { kind: 'box', node: 'Hips', c: [0, 0.06, 0.01], half: [0.115, 0.13, 0.10], id: 'belly' },
  // pelvis block — wider, catches crouching legs
  { kind: 'box', node: 'Hips', c: [0, -0.04, 0], half: [0.165, 0.10, 0.115], id: 'pelvis' },
  // head
  { kind: 'sphere', node: 'Head', c: [0, 0.11, 0], r: 0.105, id: 'head' },
  // thighs
  { kind: 'capsule', a: 'UpperLegL', b: 'LowerLegL', r: 0.095, id: 'thighL' },
  { kind: 'capsule', a: 'UpperLegR', b: 'LowerLegR', r: 0.095, id: 'thighR' },
];

// Horizontal distance between the two hip joints, measured on the bundled
// mannequin. The whole collider model is authored against that figure, so it
// doubles as the reference for re-fitting the model to another character.
export const CANONICAL_HIP_SEP = 0.18;

// How much to shrink/grow the collider model for this rig.
//
// The specs above are fixed metre sizes tuned on the mannequin, where the
// thighs (r 0.095 + skin 0.078) sit 0.18 m apart — only 7 mm of clearance. A
// real character with slightly narrower hips therefore starts life INSIDE its
// own colliders, every pose registers a penetration, and FK/IK reject all of
// them: "this model can't be posed". Scaling the model by the rig's actual hip
// separation keeps the same relative clearances on any proportion.
export function fitScale(root) {
  const l = root.getObjectByName('UpperLegL');
  const r = root.getObjectByName('UpperLegR');
  if (!l || !r) return 1;
  const a = l.getWorldPosition(new THREE.Vector3());
  const b = r.getWorldPosition(new THREE.Vector3());
  const sep = Math.hypot(a.x - b.x, a.z - b.z);
  if (!(sep > 1e-4)) return 1;
  return THREE.MathUtils.clamp(sep / CANONICAL_HIP_SEP, 0.6, 1.4);
}

export function buildColliders(root, fit = 1) {
  root.updateMatrixWorld(true);
  const ws = new THREE.Vector3();
  return COLLIDER_SPECS.map((s) => {
    const col = { ...s };
    if (s.kind === 'capsule') {
      col.nodeA = root.getObjectByName(s.a);
      col.nodeB = root.getObjectByName(s.b);
      if (!col.nodeA || !col.nodeB) throw new Error('collider nodes missing: ' + s.a + '/' + s.b);
      // capsules are measured from world bone positions, so their radius is
      // already in metres — only the fit factor applies.
      col.r = s.r * fit;
    } else {
      col.node = root.getObjectByName(s.node);
      if (!col.node) throw new Error('collider node missing: ' + s.node);
      // Uniform world scale of the node (a 0.01 armature means the joint
      // lives in centimetres). Offset is authored in metres → local units.
      col.node.getWorldScale(ws);
      col.scale = (ws.x + ws.y + ws.z) / 3 || 1;
      col.cLocal = new THREE.Vector3(...s.c).multiplyScalar(fit / col.scale);
      col.r = s.r === undefined ? undefined : s.r * fit;              // sphere
      col.half = s.half ? s.half.map((v) => v * fit) : s.half;         // box
    }
    return col;
  });
}

const _p = new THREE.Vector3();
const _c = new THREE.Vector3();

// Node-local offset of a collider centre. buildColliders() pre-scales it into
// the node's own units; a hand-built collider (tests, one-offs) may only carry
// the authored `c`, which is then assumed to already be in local units.
function localOffset(col, out) {
  return col.cLocal ? out.copy(col.cLocal) : out.set(col.c[0], col.c[1], col.c[2]);
}
const _ab = new THREE.Vector3();
const _ap = new THREE.Vector3();
const _q = new THREE.Vector3();
const _n = new THREE.Vector3();

function closestOnSegment(a, b, p, out) {
  _ab.subVectors(b, a);
  _ap.subVectors(p, a);
  const len2 = _ab.lengthSq();
  const t = len2 > 1e-12 ? THREE.MathUtils.clamp(_ap.dot(_ab) / len2, 0, 1) : 0;
  return out.copy(a).addScaledVector(_ab, t);
}

// Returns { normal (world, unit, points OUT of the collider), depth>0 } or null.
export function pointCollision(col, worldPoint, skin) {
  if (col.kind === 'capsule') {
    const a = _q.setFromMatrixPosition(col.nodeA.matrixWorld);
    const b = _p.setFromMatrixPosition(col.nodeB.matrixWorld);
    const closest = closestOnSegment(a, b, worldPoint, new THREE.Vector3());
    const d = _n.subVectors(worldPoint, closest);
    const dist = d.length();
    const r = col.r + skin;
    if (dist >= r) return null;
    if (dist < 1e-6) d.set(0, 1, 0); else d.multiplyScalar(1 / dist);
    return { normal: d.clone(), depth: r - dist };
  }
  if (col.kind === 'sphere') {
    // offset is stored in node-local units; the result is a world point, and
    // the radius test below stays in metres.
    const center = localOffset(col, _c).applyMatrix4(col.node.matrixWorld);
    const d = _n.subVectors(worldPoint, center);
    const dist = d.length();
    const r = col.r + skin;
    if (dist >= r) return null;
    if (dist < 1e-6) d.set(0, 1, 0); else d.multiplyScalar(1 / dist);
    return { normal: d.clone(), depth: r - dist };
  }
  // box — work in metres. `cLocal` is in node-local units, so the delta from
  // the collider centre is scaled back into metres before it is compared with
  // `half` and `skin` (both already metres, from CHAINS).
  const local = col.node.worldToLocal(_p.copy(worldPoint));
  local.sub(localOffset(col, _c)).multiplyScalar(col.scale || 1);
  const hx = col.half[0] + skin, hy = col.half[1] + skin, hz = col.half[2] + skin;
  const dx = hx - Math.abs(local.x);
  const dy = hy - Math.abs(local.y);
  const dz = hz - Math.abs(local.z);
  if (dx <= 0 || dy <= 0 || dz <= 0) return null;
  // exit through the least-penetrated face
  let axis = 'x', depth = dx;
  if (dy < depth) { axis = 'y'; depth = dy; }
  if (dz < depth) { axis = 'z'; depth = dz; }
  const n = new THREE.Vector3();
  n[axis] = Math.sign(local[axis]) || 1;
  n.applyQuaternion(col.node.getWorldQuaternion(new THREE.Quaternion()));
  return { normal: n, depth };
}

export function worstPointCollision(colliders, worldPoint, skin) {
  let worst = null;
  for (const col of colliders) {
    const hit = pointCollision(col, worldPoint, skin);
    if (hit && (!worst || hit.depth > worst.depth)) worst = hit;
  }
  return worst;
}

// Sample a bone segment (a→b) and return the deepest violation, if any.
export function segmentCollision(colliders, a, b, skin, samples = 6, t0 = 0, t1 = 1) {
  let worst = null;
  const p = new THREE.Vector3();
  for (let i = 0; i <= samples; i++) {
    const t = t0 + ((t1 - t0) * i) / samples;
    p.lerpVectors(a, b, t);
    const hit = worstPointCollision(colliders, p, skin);
    if (hit && (!worst || hit.depth > worst.depth)) {
      worst = { normal: hit.normal, depth: hit.depth, at: p.clone(), t };
    }
  }
  return worst;
}

// Push a point out of every collider it violates (used to clamp IK targets).
export function resolvePointOut(colliders, worldPoint, skin, eps = 0.004) {
  const p = worldPoint.clone();
  for (let i = 0; i < 4; i++) {
    const hit = worstPointCollision(colliders, p, skin);
    if (!hit) break;
    p.addScaledVector(hit.normal, hit.depth + eps);
  }
  return p;
}
