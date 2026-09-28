import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';

// Pointer interaction:
//   • drag a hand/foot  → two-bone IK with collision + limits
//   • click any other body part → select the nearest joint (FK gizmo)
//   • Shift+drag any character → move it across the ground plane (y = 0)
//   • drag empty space  → orbit (OrbitControls stays enabled there)
// Gizmo hits are detected first so the TransformControls ring always wins.
// Multi-character: hits are classified by walking up to userData.charId;
// each character's own rig drives its effector/IK checks.

function InteractionController({
  rig, charsRef, tcRef, propsGroupRef,
  onSelect, onSelectProp, onSelectChar, onIKUpdate, onNotify,
}) {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls);

  useEffect(() => {
    const dom = gl.domElement;
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let dragging = null; // { type:'ik'|'move', ... }
    let orbitDisabled = false;

    const toNDC = (e) => {
      const r = dom.getBoundingClientRect();
      ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
      return ndc;
    };

    const ownerCharId = (obj) => {
      let n = obj;
      while (n) {
        if (n.userData && n.userData.charId) return n.userData.charId;
        n = n.parent;
      }
      return null;
    };

    const pick = (e) => {
      ray.setFromCamera(toNDC(e), camera);
      const tc = tcRef.current;
      const gz = tc && tc.visible !== false ? ray.intersectObject(tc, true) : [];

      // characters (all roots), nearest body hit
      const entries = charsRef.current || [];
      const roots = entries.map((c) => c.root).filter(Boolean);
      let charHit = null;
      let cDist = Infinity;
      if (roots.length) {
        const ch = ray
          .intersectObjects(roots, true)
          .filter((h) => h.object.isMesh && !h.object.userData.isLineArt);
        if (ch.length) {
          charHit = ch[0];
          cDist = ch[0].distance;
        }
      }
      const ownerId = charHit ? ownerCharId(charHit.object) : null;
      const owner = ownerId ? entries.find((c) => c.id === ownerId) : null;

      // placed props (separate group), nearest prop hit
      let propHit = null;
      let pDist = Infinity;
      const group = propsGroupRef && propsGroupRef.current;
      if (group) {
        const ph = ray
          .intersectObject(group, true)
          .filter((h) => h.object.isMesh && !h.object.userData.isLineArt);
        if (ph.length) {
          pDist = ph[0].distance;
          let n = ph[0].object;
          while (n && n !== group) {
            if (n.userData && n.userData.propId) {
              propHit = n.userData.propId;
              break;
            }
            n = n.parent;
          }
        }
      }

      // hands/feet always win over the FK gizmo ring — unless a prop is
      // physically nearer to the camera than the effector
      const effector =
        owner && owner.rig && charHit && owner.rig.chainForNode(charHit.object, charHit.point);
      const gDist = gz.length ? gz[0].distance : Infinity;
      if (effector && cDist <= pDist) return { hit: charHit, ownerId, owner };
      if (propHit && pDist <= gDist && pDist <= cDist) return { prop: propHit };
      if (gDist <= cDist && gz.length) return { gizmo: true };
      if (charHit) return { hit: charHit, ownerId, owner };
      return null;
    };

    const disableOrbit = () => {
      if (controls && controls.enabled) {
        controls.enabled = false;
        orbitDisabled = true;
      }
    };
    const enableOrbit = () => {
      if (orbitDisabled && controls) controls.enabled = true;
      orbitDisabled = false;
    };

    const onDown = (e) => {
      if (e.button !== 0 || dragging) return;
      const p = pick(e);
      if (!p || p.gizmo) return;
      if (p.prop) {
        onSelectProp(p.prop);
        disableOrbit();
        return;
      }
      if (!p.hit || !p.owner) return;

      const root = p.owner.root;
      // Shift+drag: slide the character on the ground. Screen-delta mapping
      // (camera basis × metres-per-pixel at grab depth) — a y=0 plane
      // intersection explodes at shallow view angles (hit lands hundreds of
      // metres away); this stays stable from top-down to horizon views.
      if (e.shiftKey) {
        const rect = dom.getBoundingClientRect();
        const dist = camera.position.distanceTo(root.position);
        const k = (2 * dist * Math.tan((camera.fov * Math.PI) / 360)) / rect.height;
        const dir = camera.getWorldDirection(new THREE.Vector3());
        const fwd = new THREE.Vector3(dir.x, 0, dir.z);
        if (fwd.lengthSq() < 1e-8) fwd.set(0, 0, -1);
        else fwd.normalize();
        const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
        dragging = { type: 'move', root, k, fwd, right, lastX: e.clientX, lastY: e.clientY };
        if (p.ownerId) onSelectChar(p.ownerId);
        try { dom.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        disableOrbit();
        if (tcRef.current) tcRef.current.enabled = false;
        dom.style.cursor = 'move';
        return;
      }

      const owner = p.owner;
      const ownerRig = owner.rig;
      if (!ownerRig) return;
      // touching a character makes it the active one
      if (p.ownerId) onSelectChar(p.ownerId);

      const obj = p.hit.object;
      const chainKey = ownerRig.chainForNode(obj, p.hit.point);
      if (chainKey) {
        const effPos = ownerRig.effectorWorldPos(chainKey, new THREE.Vector3());
        const n = camera.getWorldDirection(new THREE.Vector3());
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, effPos);
        dragging = {
          type: 'ik',
          chain: chainKey,
          rig: ownerRig,
          plane,
          target: effPos.clone(),
        };
        try { dom.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        disableOrbit();
        if (tcRef.current) tcRef.current.enabled = false;
        onIKUpdate({ active: true, chain: chainKey, target: effPos.toArray() });
        dom.style.cursor = 'grabbing';
        return;
      }

      const jointName = ownerRig.jointForNode(obj, p.hit.point);
      if (jointName) {
        onSelect(jointName);
        disableOrbit(); // clicking the body shouldn't spin the camera
      }
    };

    const onMove = (e) => {
      if (dragging) {
        if (dragging.type === 'move') {
          const d = dragging;
          const dx = e.clientX - d.lastX;
          const dy = e.clientY - d.lastY;
          d.lastX = e.clientX;
          d.lastY = e.clientY;
          d.root.position.addScaledVector(d.right, dx * d.k);
          d.root.position.addScaledVector(d.fwd, -dy * d.k);
          d.root.updateMatrixWorld(true);
          return;
        }
        ray.setFromCamera(toNDC(e), camera);
        const out = new THREE.Vector3();
        if (ray.ray.intersectPlane(dragging.plane, out)) {
          const res = dragging.rig.solveIK(dragging.chain, out);
          if (res) dragging.target = res.target;
          onIKUpdate({
            active: true,
            chain: dragging.chain,
            target: dragging.target.toArray(),
            blocked: !!(res && res.penetration),
          });
        }
        return;
      }
      // hover feedback
      const p = pick(e);
      let cursor = '';
      if (p && p.prop) {
        cursor = 'move';
      } else if (p && p.hit && p.owner) {
        if (p.owner.rig && p.owner.rig.chainForNode(p.hit.object, p.hit.point)) cursor = 'grab';
        else cursor = 'pointer';
      }
      if (dom.style.cursor !== cursor) dom.style.cursor = cursor;
    };

    const finish = (e) => {
      if (dragging) {
        dragging = null;
        if (tcRef.current) tcRef.current.enabled = true;
        enableOrbit();
        onIKUpdate({ active: false });
        dom.style.cursor = '';
        if (e && e.pointerId !== undefined) {
          try { dom.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
        }
      } else {
        enableOrbit();
      }
    };

    dom.addEventListener('pointerdown', onDown);
    dom.addEventListener('pointermove', onMove);
    dom.addEventListener('pointerup', finish);
    dom.addEventListener('pointercancel', finish);
    dom.addEventListener('pointerleave', finish);
    return () => {
      dom.removeEventListener('pointerdown', onDown);
      dom.removeEventListener('pointermove', onMove);
      dom.removeEventListener('pointerup', finish);
      dom.removeEventListener('pointercancel', finish);
      dom.removeEventListener('pointerleave', finish);
    };
  }, [rig, gl, camera, controls, tcRef, charsRef, propsGroupRef, onSelect, onSelectProp, onSelectChar, onIKUpdate, onNotify]);

  return null;
}

export default InteractionController;
