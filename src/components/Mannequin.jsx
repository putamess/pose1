import { useGLTF } from '@react-three/drei';
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { createRig } from '../lib/rig.js';
import { attachMannequinRig } from '../lib/autorig.js';
import { applyAppearance, makeAppearanceAssets } from '../lib/appearance.js';
import { prepareMain } from '../lib/modelLoader.js';

// Shared shader/material assets (created once per page).
const assets = makeAppearanceAssets();
export { assets as appearanceAssets };

// Pick the model with ?model=/your.glb (files in public/).
function resolveModelURL() {
  if (typeof window === 'undefined') return '/mannequin.gltf';
  const q = new URLSearchParams(window.location.search).get('model');
  return q || '/mannequin.gltf';
}

// 💡 수정됨: visible prop 추가
function Mannequin({ rootRef, viewMode, onReady, visible = true }) {
  const url = useMemo(resolveModelURL, []);
  const gltf = useGLTF(url);

  const urlScene = useMemo(() => {
    const s = prepareMain(gltf.scene);
    s.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = false;
      }
    });
    return s;
  }, [gltf]);

  const scene = urlScene;

  useEffect(() => {
    rootRef.current = scene;
    scene.userData.charId = 'char_default';
    let cancelled = false;
    (async () => {
      let rig = null;
      let error = null;
      try {
        rig = createRig(scene);
      } catch (e) {
        try {
          const st = await attachMannequinRig(scene);
          scene.updateMatrixWorld(true);
          rig = createRig(scene);
        } catch (e2) {
          error = e2.message;
        }
      }
      if (!cancelled && onReady) onReady(rig, error, scene);
    })();
    return () => {
      cancelled = true;
      rootRef.current = null;
    };
  }, [scene]);

  useEffect(() => {
    applyAppearance(scene, viewMode, assets);
  }, [scene, viewMode]);

  // 💡 수정됨: <primitive>에 visible 적용
  return <primitive object={scene} visible={visible} />;
}

useGLTF.preload('/mannequin.gltf');

export default Mannequin;