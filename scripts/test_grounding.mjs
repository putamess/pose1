// Unit tests for model grounding/scaling (the "half-buried in the floor" fix).
import * as THREE from 'three';
import { prepareMain, prepareProp } from '../src/lib/modelLoader.js';

let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? pass++ : (fail++, console.log('FAIL:', name)); };

function mkGroup({ h, ty = 0, boneY = null, meshYDrop = 0 }) {
  const g = new THREE.Group();
  g.position.y = ty;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, h, 0.3));
  mesh.position.y = h / 2 - meshYDrop; // feet at local 0 (minus drop)
  g.add(mesh);
  if (boneY !== null) {
    const bone = new THREE.Bone();
    bone.position.y = boneY;
    g.add(bone);
  }
  return g;
}
const minY = (g) => { g.updateMatrixWorld(true); return new THREE.Box3().setFromObject(g).min.y; };
const boneWorldY = (g) => { let b; g.traverse((o) => { if (o.isBone) b = o; }); g.updateMatrixWorld(true); return b.getWorldPosition(new THREE.Vector3()).y; };

// A) tall model (out of window → k≠1) with negative root offset → grounded at 0
const a = prepareMain(mkGroup({ h: 2.4, ty: -0.5 }));
ok(Math.abs(minY(a)) < 1e-6, `A: tall+offset grounded (got ${minY(a).toFixed(4)})`);

// B) centered model, in-window height → grounded at 0
const b = prepareMain(mkGroup({ h: 1.7, ty: 0 }));
ok(Math.abs(minY(b)) < 1e-6, `B: centered in-window grounded (got ${minY(b).toFixed(4)})`);

// C) skeleton present, mesh box plunging far below bones → trust bones (bone → 0)
const c = prepareMain(mkGroup({ h: 1.7, ty: 0, boneY: 0.0, meshYDrop: 0.9 }));
ok(Math.abs(boneWorldY(c)) < 1e-6, `C: bone floor trusted (got ${boneWorldY(c).toFixed(4)})`);

// D) prop: tiny object with root offset → scaled to 1.6 maxDim, grounded
const d = prepareProp(mkGroup({ h: 0.5, ty: -0.2 }));
ok(Math.abs(minY(d)) < 1e-6, `D: prop grounded (got ${minY(d).toFixed(4)})`);
const dh = new THREE.Box3().setFromObject(d).getSize(new THREE.Vector3()).y;
ok(Math.abs(dh - 1.6) < 1e-3, `D: prop scaled to 1.6 (got ${dh.toFixed(3)})`);

// E) normal skeleton (bones near soles) → mesh box trusted, grounded at 0
const e = prepareMain(mkGroup({ h: 1.72, ty: 0.3, boneY: 0.05 }));
ok(Math.abs(minY(e)) < 1e-6, `E: normal skeleton grounded (got ${minY(e).toFixed(4)})`);

console.log(`checks: ${pass + fail}, failures: ${fail}`);
process.exit(fail ? 1 : 0);
