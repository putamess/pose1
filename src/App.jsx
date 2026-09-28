// --- START OF FILE App.jsx ---

import { useCallback, useEffect, useRef, useState } from 'react';
import PoseCanvas from './components/PoseCanvas.jsx';
import UIPanel from './components/UIPanel.jsx';
import {
  PRESETS, clampPose, loadStoredPoses, saveStoredPoses, downloadJSON, readPoseFile,
} from './lib/pose.js';
import { capturePNG } from './lib/exporter.js';
import { loadModel, prepareMain, prepareProp, disposeScene } from './lib/modelLoader.js';
import { attachMannequinRig, hasSkeleton } from './lib/autorig.js';
import { applyJointNameMap } from './lib/naming.js';
import { createRig } from './lib/rig.js';

const DEFAULT_CHAR_ID = 'char_default';

function newCharId() {
  return `char_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export default function App() {
  const rootRef = useRef(null);
  const propsGroupRef = useRef(null);
  const rigRef = useRef(null);
  const charsRef = useRef([]);
  const glStateRef = useRef(null);
  const gizmoSnapRef = useRef(null);
  const statusTimer = useRef(null);

  // ---- characters: [{ id, name, scene, rig, error, isDefault, visible }] -----------
  const [characters, setCharacters] = useState([
    {
      id: DEFAULT_CHAR_ID, name: '기본 마니퀸', isDefault: true,
      scene: null, rig: null, error: null, visible: true, // visible 추가
    },
  ]);
  const [activeId, setActiveId] = useState(DEFAULT_CHAR_ID);
  const [moveCharId, setMoveCharId] = useState(null); // 캐릭터 이동 상태 추가
  const [propItems, setPropItems] = useState([]);
  const [selectedProp, setSelectedProp] = useState(null);
  const [selected, setSelected] = useState(null);
  const [viewMode, setViewMode] = useState('normal');
  const [uiTick, setUiTick] = useState(0);
  const [status, setStatus] = useState(null);
  const [ik, setIk] = useState({ active: false });
  const [saved, setSaved] = useState(loadStoredPoses);

  const activeChar =
    characters.find((c) => c.id === activeId) || characters[0];
  const rig = activeChar?.rig || null;
  const rigError = activeChar?.error || null;

  charsRef.current = characters
    .filter((c) => c.scene)
    .map((c) => ({ id: c.id, root: c.scene, rig: c.rig }));
    
  useEffect(() => {
    rigRef.current = rig;
  }, [rig]);

  const bump = useCallback(() => setUiTick((t) => t + 1), []);

  const notify = useCallback((text, type = 'info') => {
    setStatus({ text, type });
    if (statusTimer.current) clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => setStatus(null), 2600);
  }, []);

  const handleReady = useCallback((r, error, scene) => {
    setCharacters((prev) =>
      prev.map((c) =>
        c.isDefault
          ? { ...c, rig: r, error: r ? null : error || null, scene: scene || c.scene }
          : c,
      ),
    );
    bump();
  }, [bump]);

  const handleSelect = useCallback((name) => {
    setSelected(name);
    if (name) {
      setSelectedProp(null);
      setMoveCharId(null);
    }
    bump();
  }, [bump]);

  const handleSelectProp = useCallback((id) => {
    setSelectedProp(id);
    setSelected(null);
    setMoveCharId(null);
    bump();
  }, [bump]);

  // 포즈 모드로 캐릭터 선택
  const handleSelectChar = useCallback((id) => {
    setActiveId((cur) => (cur === id ? cur : id));
    setMoveCharId(null); // 포즈 모드시 이동 모드 해제
    setIk({ active: false });
    bump();
  }, [bump]);

  // 이동 모드로 캐릭터 선택
  const handleMoveChar = useCallback((id) => {
    setMoveCharId((cur) => (cur === id ? null : id));
    setSelected(null);
    setSelectedProp(null);
    bump();
  }, [bump]);

  // ON/OFF 가시성 토글
  const handleToggleCharVisibility = useCallback((id) => {
    setCharacters((prev) =>
      prev.map((c) => (c.id === id ? { ...c, visible: !c.visible } : c))
    );
    bump();
  }, [bump]);

  const handleIKUpdate = useCallback((state) => setIk(state), []);

  // ---- FK (gizmo) ---------------------------------------------------------
  const handleGizmoChange = useCallback(() => {
    if (rigRef.current && selected && !moveCharId && !selectedProp) {
      rigRef.current.liveClamp(selected);
    }
    bump();
  }, [selected, moveCharId, selectedProp, bump]);

  const handleGizmoDown = useCallback(() => {
    if (rigRef.current && selected && !moveCharId && !selectedProp) {
      gizmoSnapRef.current = rigRef.current.capturePose();
    }
  }, [selected, moveCharId, selectedProp]);

  const handleGizmoUp = useCallback(() => {
    const r = rigRef.current;
    if (!r || !gizmoSnapRef.current || moveCharId || selectedProp) return;
    const bad = r.validateAfterGizmo(gizmoSnapRef.current);
    if (bad) notify('충돌 방지: 몸통을 관통하려던 자세를 되돌렸어요', 'warn');
    bump();
  }, [notify, bump, moveCharId, selectedProp]);

  // ---- sliders ------------------------------------------------------------
  const handleJointChange = useCallback((joint, axis, value) => {
    const r = rigRef.current;
    if (!r) return;
    if (joint === '__reset__') {
      const name = selected;
      if (!name) return;
      r.setRotationDeg(name, [0, 0, 0], { checkCollision: false });
      r.root.updateMatrixWorld(true);
      bump();
      notify(`${name} 각도 초기화`);
      return;
    }
    if (joint === 'hipsPos') {
      const p = r.getHipsPos();
      p[axis] = value;
      r.setHipsPos(p[0], p[1], p[2]);
      bump();
      return;
    }
    const cur = r.getRotationDeg(joint);
    cur[axis] = value;
    const res = r.setRotationDeg(joint, cur);
    if (!res.ok) notify('충돌 방지: 그 각도는 몸통을 관통해요', 'warn');
    bump();
  }, [selected, bump, notify]);

  // ---- poses --------------------------------------------------------------
  const handlePreset = useCallback((p) => {
    const r = rigRef.current;
    if (!r) return;
    r.applyPose(clampPose(p));
    bump();
    notify(`프리셋 적용: ${p.name}`);
  }, [bump, notify]);

  const handleReset = useCallback(() => {
    handlePreset(PRESETS[0]);
  }, [handlePreset]);

  const handleSavePose = useCallback((name) => {
    const r = rigRef.current;
    if (!r) return;
    const entry = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name,
      date: new Date().toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' }),
      pose: r.capturePose(),
    };
    const list = [entry, ...saved].slice(0, 40);
    setSaved(list);
    saveStoredPoses(list);
    notify(`저장됨: ${name}`);
  }, [saved, notify]);

  const handleLoadPose = useCallback((entry) => {
    const r = rigRef.current;
    if (!r) return;
    r.applyPose(clampPose(entry.pose));
    bump();
    notify(`불러옴: ${entry.name}`);
  }, [bump, notify]);

  const handleDeletePose = useCallback((id) => {
    const list = saved.filter((s) => s.id !== id);
    setSaved(list);
    saveStoredPoses(list);
  }, [saved]);

  const handleExportJSON = useCallback(() => {
    const r = rigRef.current;
    if (!r) return;
    downloadJSON(r.capturePose(), `pose_${Date.now()}.json`);
    notify('포즈 JSON 내보냈어요');
  }, [notify]);

  const handleImportJSON = useCallback(async (file) => {
    const r = rigRef.current;
    if (!r) return;
    try {
      const pose = await readPoseFile(file);
      r.applyPose(clampPose(pose));
      bump();
      notify('포즈를 불러왔어요');
    } catch {
      notify('JSON 파일을 읽지 못했어요', 'warn');
    }
  }, [bump, notify]);

  // ---- PNG ----------------------------------------------------------------
  const handleExportPNG = useCallback((scale) => {
    const st = glStateRef.current;
    if (!st) return;
    const name = `pose_${viewMode}${scale > 1 ? `@${scale}x` : ''}_${Date.now()}.png`;
    capturePNG(st, { scale, filename: name });
    notify(`PNG 저장: ${name}`);
  }, [viewMode, notify]);

  // ---- character upload ---------------------------------------------------
  const handleAddCharacters = async (files) => {
    const addedIds = [];
    for (const f of files) {
      notify(`${f.name} 불러오는 중…`);
      try {
        const model = await loadModel(f);
        const scene = prepareMain(model.scene);
        scene.traverse((o) => {
          if (o.isMesh) {
            o.castShadow = true;
            o.receiveShadow = false;
          }
        });

        let rig = null;
        let error = null;
        let autoRigged = false;
        try {
          applyJointNameMap(scene);
          if (!hasSkeleton(scene)) {
            const st = await attachMannequinRig(scene);
            autoRigged = true;
          }
          scene.updateMatrixWorld(true);
          rig = createRig(scene);
        } catch (e) {
          error = e.message;
        }

        const id = newCharId();
        scene.userData.charId = id;
        setCharacters((prev) => [
          ...prev,
          { id, name: f.name, scene, rig, error, isDefault: false, visible: true }, // visible 추가
        ]);
        addedIds.push(id);
        if (autoRigged) {
          notify(`${f.name} · 기본 뼈대를 삽입했어요`);
        } else {
          notify(`${f.name} 캐릭터로 추가했어요`);
        }
      } catch (e) {
        notify(`${f.name}: GLB을 읽지 못했어요`, 'warn');
      }
    }
    if (addedIds.length) {
      setActiveId(addedIds[addedIds.length - 1]);
      setMoveCharId(null);
      setSelected(null);
      setSelectedProp(null);
      bump();
    }
  };

  const handleDeleteCharacter = (id) => {
    const item = characters.find((c) => c.id === id);
    if (!item || item.isDefault) return;
    setCharacters((prev) => prev.filter((c) => c.id !== id));
    setActiveId((cur) => (cur === id ? DEFAULT_CHAR_ID : cur));
    setMoveCharId((cur) => (cur === id ? null : cur));
    setSelected(null);
    setIk({ active: false });
    setTimeout(() => disposeScene(item.scene), 150);
    notify(`${item.name} 캐릭터를 삭제했어요`);
    bump();
  };

  // ---- props --------------------------------------------------------------
  const handleAddProps = async (files) => {
    const loaded = [];
    for (const f of files) {
      try {
        const model = await loadModel(f);
        const scene = prepareProp(model.scene);
        scene.traverse((o) => {
          if (o.isMesh) {
            o.castShadow = true;
            o.receiveShadow = false;
          }
        });
        const id = `prop_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        scene.userData.propId = id;
        loaded.push({ id, name: f.name, scene, x: 0, z: 0, scaleMul: 1, rotY: 0 });
      } catch (e) {
        notify(`${f.name}: GLB을 읽지 못했어요`, 'warn');
      }
    }
    if (!loaded.length) return;
    setPropItems((prev) => {
      const start = prev.length;
      return [
        ...prev,
        ...loaded.map((it, i) => {
          const item = { ...it, x: (start + i) % 2 === 0 ? 1.1 : -1.1 };
          const s = item.scene;
          s.position.x = item.x;
          return item;
        }),
      ];
    });
    setSelectedProp(loaded[loaded.length - 1].id);
    setMoveCharId(null);
    notify(`${loaded.length}개 소품을 배치했어요`);
  };

  const handlePropUpdate = (id, patch) => {
    setPropItems((prev) =>
      prev.map((p) => {
        if (p.id !== id) return p;
        const np = { ...p, ...patch };
        const s = np.scene;
        s.position.x = np.x;
        s.position.z = np.z;
        s.rotation.y = (np.rotY * Math.PI) / 180;
        s.scale.setScalar((s.userData.baseScale || 1) * np.scaleMul);
        s.updateMatrixWorld(true);
        return np;
      }),
    );
  };

  const handleDeleteProp = (id) => {
    const item = propItems.find((p) => p.id === id);
    setPropItems((prev) => prev.filter((p) => p.id !== id));
    setSelectedProp((cur) => (cur === id ? null : cur));
    if (item) setTimeout(() => disposeScene(item.scene), 150);
    notify('소품을 삭제했어요');
  };

  // ---- keyboard -----------------------------------------------------------
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setSelected(null);
        setSelectedProp(null);
        setMoveCharId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app">
      <PoseCanvas
        rootRef={rootRef}
        rigRef={rigRef}
        rig={rig}
        glStateRef={glStateRef}
        selected={selected}
        viewMode={viewMode}
        ik={ik}
        characters={characters}
        moveCharId={moveCharId} // 새로 추가된 prop
        propItems={propItems}
        selectedProp={selectedProp}
        propsGroupRef={propsGroupRef}
        charsRef={charsRef}
        onReady={handleReady}
        onSelect={handleSelect}
        onSelectProp={handleSelectProp}
        onSelectChar={handleSelectChar}
        onIKUpdate={handleIKUpdate}
        onGizmoChange={handleGizmoChange}
        onGizmoDown={handleGizmoDown}
        onGizmoUp={handleGizmoUp}
        onNotify={notify}
      />
      <UIPanel
        rig={rig}
        rigError={rigError}
        characters={characters}
        activeId={activeId}
        moveCharId={moveCharId} // 새로 추가된 prop
        onSelectChar={handleSelectChar}
        onMoveChar={handleMoveChar} // 새로 추가된 prop
        onToggleCharVisibility={handleToggleCharVisibility} // 새로 추가된 prop
        onDeleteChar={handleDeleteCharacter}
        onAddChars={handleAddCharacters}
        propItems={propItems}
        selectedProp={selectedProp}
        onAddProps={handleAddProps}
        onSelectProp={handleSelectProp}
        onDeleteProp={handleDeleteProp}
        onPropUpdate={handlePropUpdate}
        selected={selected}
        viewMode={viewMode}
        setViewMode={setViewMode}
        saved={saved}
        status={status}
        ik={ik}
        uiTick={uiTick}
        onSelect={handleSelect}
        onJointChange={handleJointChange}
        onPreset={handlePreset}
        onReset={handleReset}
        onSavePose={handleSavePose}
        onLoadPose={handleLoadPose}
        onDeletePose={handleDeletePose}
        onExportPNG={handleExportPNG}
        onExportJSON={handleExportJSON}
        onImportJSON={handleImportJSON}
        onNotify={notify}
      />
    </div>
  );
}