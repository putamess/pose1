import { useRef } from 'react';
import { JOINT_ORDER, JOINT_LIMITS, HIPS_POS_LIMITS } from '../lib/joints.js';
import { PRESETS } from '../lib/pose.js';
import { VIEW_MODES } from '../lib/appearance.js';

const AXIS = ['X', 'Y', 'Z'];

// Exponential prop scale: slider 0…1000 maps to 0.01×…500× (log scale).
const SCALE_MIN = 0.01;
const SCALE_MAX = 500;
const toSlider = (v) =>
  Math.round((1000 * Math.log(v / SCALE_MIN)) / Math.log(SCALE_MAX / SCALE_MIN));
const fromSlider = (t) => {
  const v = SCALE_MIN * Math.pow(SCALE_MAX / SCALE_MIN, t / 1000);
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, Number(v.toPrecision(3))));
};
const fmtScale = (v) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));

function Section({ title, children, hint }) {
  return (
    <section className="panel-section">
      <h3>
        {title}
        {hint && <span className="hint">{hint}</span>}
      </h3>
      {children}
    </section>
  );
}

function JointSliders({ rig, selected, onChange }) {
  if (!rig || !selected) {
    return <div className="muted">캔버스에서 몸통을 클릭하거나 아래에서 관절을 선택하세요.</div>;
  }
  const lim = JOINT_LIMITS[selected];
  const rot = rig.getRotationDeg(selected);
  const isHips = selected === 'Hips';
  const hips = rig.getHipsPos();

  return (
    <div className="sliders">
      <div className="selected-joint">
        <span className="joint-dot" />
        {selected}
        <span className="muted">
          {' '}· 한계 {lim ? `${lim.x[0]}~${lim.x[1]}°` : ''}
        </span>
      </div>
      {AXIS.map((ax, i) => {
        const range = lim[ax.toLowerCase()];
        return (
          <label key={ax} className="slider-row">
            <span className="axis">{ax}</span>
            <input
              type="range"
              min={range[0]}
              max={range[1]}
              step={1}
              value={Math.round(rot[i])}
              onChange={(e) => onChange(selected, i, Number(e.target.value))}
            />
            <span className="deg">{Math.round(rot[i])}°</span>
            <span className="range">
              {range[0]}…{range[1]}
            </span>
          </label>
        );
      })}
      {isHips && (
        <>
          <div className="sub-label">골반 높이/위치 (m)</div>
          {['x', 'y', 'z'].map((ax, i) => (
            <label key={ax} className="slider-row">
              <span className="axis">{ax.toUpperCase()}</span>
              <input
                type="range"
                min={HIPS_POS_LIMITS[ax][0]}
                max={HIPS_POS_LIMITS[ax][1]}
                step={0.01}
                value={Number(hips[i].toFixed(2))}
                onChange={(e) =>
                  onChange('hipsPos', i, Number(e.target.value))
                }
              />
              <span className="deg">{hips[i].toFixed(2)}</span>
            </label>
          ))}
        </>
      )}
    </div>
  );
}

function UIPanel(props) {
  const {
    rig, rigError, selected, viewMode, setViewMode, saved, status, ik, uiTick,
    characters, activeId, onSelectChar, onDeleteChar, onAddChars,
    propItems, selectedProp,
    onAddProps, onSelectProp, onDeleteProp, onPropUpdate,
    onSelect, onJointChange, onHipsChange, onPreset, onReset,
    onSavePose, onLoadPose, onDeletePose, onExportPNG, onExportJSON,
    onImportJSON, onNotify,
  } = props;
  const fileRef = useRef(null);
  const nameRef = useRef(null);
  const charFileRef = useRef(null);
  const propFileRef = useRef(null);

  return (
    <aside className="panel">
      <header className="panel-head">
        <h1>POSE TOOL</h1>
        <p>R3F · three.js · IK 매니퀸 포저</p>
      </header>

      <Section title="보기 모드" hint="PNG 내보내기에 적용됨">
        <div className="seg">
          {VIEW_MODES.map((m) => (
            <button
              key={m.id}
              className={viewMode === m.id ? 'on' : ''}
              onClick={() => setViewMode(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p className="tip">
          선화 = 셰이더(외곽선+종이색), 실루엣 = overrideMaterial 후처리.
        </p>
      </Section>

      <Section title="캐릭터 · 소품" hint="GLB 파일">
        <div className="save-row">
          <button className="wide" onClick={() => charFileRef.current?.click()}>
            ＋ 캐릭터 추가 (.glb)
          </button>
          <input
            ref={charFileRef}
            data-testid="char-file-input"
            type="file"
            accept=".glb,.gltf"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              const fs = [...e.target.files];
              if (fs.length) onAddChars(fs);
              e.target.value = '';
            }}
          />
        </div>
        <ul className="saved-list char-list" data-testid="char-list">
          {characters.map((c) => (
            <li key={c.id} className={activeId === c.id ? 'on' : ''}>
              <button
                className="link"
                onClick={() => onSelectChar(c.id)}
                title="활성 캐릭터로 전환"
              >
                {activeId === c.id ? '● ' : '○ '}
                {c.name}
              </button>
              {c.isDefault ? (
                <span className="muted">기본</span>
              ) : (
                <button className="del" onClick={() => onDeleteChar(c.id)} title="삭제">✕</button>
              )}
              {activeId === c.id && c.error && (
                <div className="notice compact">
                  리깅 없음 · 보기 모드만 가능
                  <span className="muted">{c.error}</span>
                </div>
              )}
            </li>
          ))}
        </ul>
        <div className="save-row">
          <button className="wide" onClick={() => propFileRef.current?.click()}>
            ＋ 소품 GLB 배치 (복수 선택 가능)
          </button>
          <input
            ref={propFileRef}
            data-testid="prop-file-input"
            type="file"
            accept=".glb,.gltf"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              const fs = [...e.target.files];
              if (fs.length) onAddProps(fs);
              e.target.value = '';
            }}
          />
        </div>
        {propItems.length > 0 && (
          <ul className="saved-list prop-list">
            {propItems.map((p) => (
              <li key={p.id} className={selectedProp === p.id ? 'on' : ''}>
                <button className="link" onClick={() => onSelectProp(p.id)} title="선택">
                  {p.name}
                </button>
                <button className="del" onClick={() => onDeleteProp(p.id)} title="삭제">✕</button>
                {selectedProp === p.id && (
                  <div className="prop-sliders">
                    <label className="mini-slider">
                      이동 X
                      <input
                        type="range" min={-50} max={50} step={0.1} value={p.x}
                        onChange={(e) => onPropUpdate(p.id, { x: +e.target.value })}
                      />
                      <span>{p.x.toFixed(2)}</span>
                    </label>
                    <label className="mini-slider">
                      이동 Z
                      <input
                        type="range" min={-50} max={50} step={0.1} value={p.z}
                        onChange={(e) => onPropUpdate(p.id, { z: +e.target.value })}
                      />
                      <span>{p.z.toFixed(2)}</span>
                    </label>
                    <label className="mini-slider">
                      크기
                      <input
                        data-testid="prop-scale"
                        type="range" min={0} max={1000} step={1}
                        value={toSlider(Math.min(SCALE_MAX, Math.max(SCALE_MIN, p.scaleMul)))}
                        onChange={(e) => onPropUpdate(p.id, { scaleMul: fromSlider(+e.target.value) })}
                      />
                      <span>{fmtScale(p.scaleMul)}×</span>
                    </label>
                    <label className="mini-slider">
                      회전(Y)
                      <input
                        type="range" min={0} max={360} step={1} value={p.rotY}
                        onChange={(e) => onPropUpdate(p.id, { rotY: +e.target.value })}
                      />
                      <span>{Math.round(p.rotY)}°</span>
                    </label>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="tip">
          캔버스에서 소품 클릭 → 이동 기즈모. 캐릭터는 <b>Shift+드래그</b>로 원하는 곳에 배치,
          클릭하면 편집 대상이 바뀌어요.
        </p>
      </Section>

      <Section title="프리셋 포즈">
        <div className="preset-grid">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              className="preset"
              onClick={() => onPreset(p)}
              title={p.desc}
              disabled={!rig}
            >
              <b>{p.name}</b>
              <span>{p.desc}</span>
            </button>
          ))}
        </div>
        <button className="wide" onClick={onReset} disabled={!rig}>↺ 초기 자세로 리셋</button>
      </Section>

      <Section title="관절 각도" hint={selected ? '' : '미선택'}>
        {rigError ? (
          <div className="notice">
            이 모델에는 리깅(뼈대)이 없어 포즈 편집은 불가해요.
            보기 모드 전환과 PNG 내보내기는 그대로 사용할 수 있어요.
            <span className="muted">{rigError}</span>
          </div>
        ) : (
          <>
            <JointSliders rig={rig} selected={selected} onChange={onJointChange} />
            <div className="chip-wrap">
              {JOINT_ORDER.map((j) => (
                <button
                  key={j}
                  className={`chip ${selected === j ? 'on' : ''}`}
                  onClick={() => onSelect(j)}
                >
                  {j}
                </button>
              ))}
            </div>
            {selected && (
              <button className="wide" onClick={() => onJointChange('__reset__')}>
                이 관절 각도 초기화
              </button>
            )}
          </>
        )}
      </Section>

      <Section title="포즈 저장" hint="localStorage">
        <div className="save-row">
          <input ref={nameRef} data-testid="pose-name-input" placeholder="포즈 이름 (예: 앉아서 인사)" maxLength={24} />
          <button
            className="primary"
            onClick={() => {
              const n = (nameRef.current?.value || '').trim() || `포즈 ${saved.length + 1}`;
              onSavePose(n);
              if (nameRef.current) nameRef.current.value = '';
            }}
          >
            저장
          </button>
        </div>
        {saved.length === 0 ? (
          <div className="muted">저장된 포즈가 없어요.</div>
        ) : (
          <ul className="saved-list">
            {saved.map((s) => (
              <li key={s.id}>
                <button className="link" onClick={() => onLoadPose(s)} title="적용">
                  {s.name}
                </button>
                <span className="muted">{s.date}</span>
                <button className="del" onClick={() => onDeletePose(s.id)} title="삭제">
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="save-row">
          <button className="wide" onClick={onExportJSON}>포즈 JSON 내보내기</button>
        </div>
        <div className="save-row">
          <button className="wide" onClick={() => fileRef.current?.click()}>JSON 불러오기</button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onImportJSON(f);
              e.target.value = '';
            }}
          />
        </div>
      </Section>

      <Section title="그림 내보내기" hint="PNG">
        <button className="wide primary" onClick={() => onExportPNG(1)}>
          📷 PNG 저장 (현재 크기)
        </button>
        <button className="wide" onClick={() => onExportPNG(2)}>
          📷 PNG 저장 (2배 해상도)
        </button>
      </Section>

      <footer className="panel-foot">
        <div className="hints">
          <span><b>드래그</b> 회전</span>
          <span><b>손·발 드래그</b> IK</span>
          <span><b>Shift+드래그</b> 캐릭터 이동</span>
          <span><b>몸 클릭</b> 관절 선택</span>
          <span><b>Esc</b> 선택 해제</span>
        </div>
        <div className="runtime">
          IK: {ik?.active ? (ik.blocked ? '충돌 방지 중…' : '이동 중') : '대기'}
          {selected ? ` · ${selected}` : ''}
        </div>
        {status && <div className={`status ${status.type || ''}`}>{status.text}</div>}
      </footer>
    </aside>
  );
}

export default UIPanel;
