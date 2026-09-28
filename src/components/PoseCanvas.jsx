// --- START OF FILE PoseCanvas.jsx ---

import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, TransformControls, useProgress } from '@react-three/drei';
import { Suspense, useCallback, useEffect, useRef } from 'react';
import * as THREE from 'three';
import Mannequin, { appearanceAssets } from './Mannequin.jsx';
import InteractionController from './InteractionController.jsx';
import { applyAppearance } from '../lib/appearance.js';

// ---------------------------------------------------------------- scene ----

function SceneStyle({ mode }) {
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    if (typeof window !== 'undefined') window.__SCENE__ = scene;
  }, [scene]);
  useEffect(() => {
    scene.overrideMaterial =
      mode === 'silhouette' ? appearanceAssets.silhouetteMat : null;
    return () => {
      scene.overrideMaterial = null;
    };
  }, [mode, scene]);

  const bg = mode === 'normal' ? '#e6eaf0' : mode === 'line' ? '#faf7ef' : '#ffffff';
  return <color attach="background" args={[bg]} />;
}

function Ground({ visible }) {
  return (
    <mesh rotation-x={-Math.PI / 2} receiveShadow visible={visible}>
      <circleGeometry args={[40, 96]} />
      <meshStandardMaterial color="#d4d9e1" roughness={1} metalness={0} />
    </mesh>
  );
}

function Lights() {
  return (
    <>
      <hemisphereLight args={['#ffffff', '#aab4c2', 0.65]} />
      <directionalLight
        castShadow
        position={[2.4, 3.6, 2.0]}
        intensity={1.5}
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-2.5}
        shadow-camera-right={2.5}
        shadow-camera-top={3}
        shadow-camera-bottom={-1}
        shadow-camera-near={0.5}
        shadow-camera-far={12}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
      />
      <directionalLight position={[-2.5, 2.0, -1.5]} intensity={0.35} />
    </>
  );
}

function JointMarker({ rig, selected, mode }) {
  const ref = useRef();
  useFrame(() => {
    if (rig && selected && ref.current) {
      rig.jointWorldPos(selected, ref.current.position);
    }
  });
  return (
    <mesh ref={ref} visible={!!(rig && selected) && mode !== 'silhouette'} renderOrder={999}>
      <octahedronGeometry args={[0.032]} />
      <meshBasicMaterial
        color="#ff5252"
        wireframe
        transparent
        opacity={0.95}
        depthTest={false}
        toneMapped={false}
      />
    </mesh>
  );
}

function IKMarker({ ik, mode }) {
  if (!ik || !ik.active || mode === 'silhouette') return null;
  return (
    <mesh position={ik.target} renderOrder={999}>
      <sphereGeometry args={[0.016, 16, 16]} />
      <meshBasicMaterial color="#ff5252" depthTest={false} toneMapped={false} />
    </mesh>
  );
}

// 기즈모(TransformControls)가 카메라 회전을 방해하지 않도록 처리
function FKGizmo({ rig, selected, propObject, moveCharObject, onObjectChange, onMouseDown, onMouseUp, tcRef }) {
  const object = moveCharObject || propObject || (rig && selected ? rig.getJoint(selected) : null);
  if (!object) return null;
  
  const isTranslate = !!(moveCharObject || propObject);
  
  return (
    <TransformControls
      key={isTranslate ? 'translate' : 'rotate'}
      ref={tcRef}
      object={object}
      mode={isTranslate ? 'translate' : 'rotate'}
      space={isTranslate ? 'world' : 'local'}
      size={0.8}
      onObjectChange={onObjectChange}
      onMouseDown={onMouseDown}
      onMouseUp={onMouseUp}
    />
  );
}

function PropObject({ item, viewMode }) {
  useEffect(() => {
    applyAppearance(item.scene, viewMode, appearanceAssets);
  }, [item, viewMode]);
  return <primitive object={item.scene} />;
}

function CharacterScene({ item, viewMode, visible }) {
  useEffect(() => {
    applyAppearance(item.scene, viewMode, appearanceAssets);
  }, [item, viewMode]);
  return <primitive object={item.scene} visible={visible} />;
}

// ---------------------------------------------------------------- canvas ---

function PoseCanvas({
  rootRef,
  rigRef,
  rig,
  glStateRef,
  selected,
  viewMode,
  ik,
  characters,
  moveCharId,
  propItems,
  selectedProp,
  propsGroupRef,
  charsRef,
  onReady,
  onSelect,
  onSelectProp,
  onSelectChar,
  onIKUpdate,
  onGizmoChange,
  onGizmoDown,
  onGizmoUp,
  onNotify,
}) {
  const tcRef = useRef(null);
  const controlsRef = useRef(null); // 카메라 컨트롤 강제 복구를 위한 레퍼런스 추가

  const setTcRef = useCallback((c) => {
    tcRef.current = c;
    if (typeof window !== 'undefined') window.__TC__ = c;
  }, []);
  
  const { active: loading, progress } = useProgress();
  
  const propObject = propItems.find((p) => p.id === selectedProp)?.scene || null;
  const moveCharObject = characters.find((c) => c.id === moveCharId)?.scene || null; 
  const uploadedChars = characters.filter((c) => !c.isDefault && c.scene);
  const defaultChar = characters.find((c) => c.isDefault);

  return (
    <div className="canvas-wrap">
      <Canvas
        shadows
        dpr={[1, 2]}
        gl={{
          preserveDrawingBuffer: true,
          antialias: true,
          alpha: false,
          logarithmicDepthBuffer: true,
        }}
        camera={{ position: [1.7, 1.4, 2.7], fov: 40, near: 0.05, far: 5000 }}
        onCreated={({ gl, scene, camera }) => {
          glStateRef.current = { gl, scene, camera };
          if (typeof window !== 'undefined') {
            window.__POSE__ = { gl, scene, camera, assets: appearanceAssets, THREE };
          }
        }}
      >
        <SceneStyle mode={viewMode} />
        <Lights />
        <Ground visible={viewMode === 'normal'} />

        <Suspense fallback={null}>
          <Mannequin
            rootRef={rootRef}
            viewMode={viewMode}
            onReady={onReady}
            visible={defaultChar?.visible !== false} 
          />
        </Suspense>

        {uploadedChars.map((c) => (
          <CharacterScene key={c.id} item={c} viewMode={viewMode} visible={c.visible} />
        ))}

        <group ref={propsGroupRef}>
          {propItems.map((p) => (
            <PropObject key={p.id} item={p} viewMode={viewMode} />
          ))}
        </group>

        <JointMarker rig={rig} selected={selected} mode={viewMode} />
        <IKMarker ik={ik} mode={viewMode} />
        
        <FKGizmo
          rig={rig}
          selected={selected}
          propObject={propObject}
          moveCharObject={moveCharObject} 
          tcRef={setTcRef}
          onObjectChange={onGizmoChange}
          onMouseDown={() => {
            if (controlsRef.current) controlsRef.current.enabled = false;
            if (onGizmoDown) onGizmoDown();
          }}
          onMouseUp={() => {
            if (controlsRef.current) controlsRef.current.enabled = true;
            if (onGizmoUp) onGizmoUp();
          }}
        />

        <InteractionController
          rig={rig}
          charsRef={charsRef}
          tcRef={tcRef}
          propsGroupRef={propsGroupRef}
          onSelect={onSelect}
          onSelectProp={onSelectProp}
          onSelectChar={onSelectChar}
          onIKUpdate={onIKUpdate}
          onNotify={onNotify}
        />

        <OrbitControls
          ref={controlsRef}
          makeDefault
          target={[0, 0.95, 0]}
          enableDamping
          dampingFactor={0.08}
          minDistance={0.6}
          maxDistance={1500}
          minPolarAngle={0.05}
          maxPolarAngle={Math.PI / 2 + 0.08}
        />
      </Canvas>

      {/* 💡 수정됨: 로딩 창이 눈에 보이지 않게 남아 마우스를 가로막는 문제 방지 (pointerEvents: 'none' 추가) */}
      {loading && (
        <div className="loader" style={{ pointerEvents: 'none' }}>
          <div className="loader-bar">
            <div className="loader-fill" style={{ width: `${progress}%` }} />
          </div>
          <span>매니퀸 로딩 중… {progress.toFixed(0)}%</span>
        </div>
      )}
    </div>
  );
}

export default PoseCanvas;