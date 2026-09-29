# POSE TOOL — 3D 마네퀸 포저

React + three.js(React Three Fiber + drei) 기반 브라우저 포즈 도구.
glTF 마네퀸을 불러와 관절을 직접 움직이고, IK로 손·발을 드래그해 포즈를 만든 뒤
PNG로 내보낼 수 있습니다.

## 실행

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # 프로덕션 빌드 → dist/
```

URL로 모델 지정도 가능: `?model=/your_model.glb` (public/ 안의 파일)

## 조작법

| 조작 | 동작 |
|---|---|
| 드래그 (빈 공간) | 카메라 회전 (OrbitControls, 우클릭/휠로 이동·줌) |
| 몸통 클릭 / 우측 관절 칩 | 관절 선택 → TransformControls 회전 기즈모(FK) |
| 기즈모 링 드래그 | 선택 관절 회전 (한도 자동 적용) |
| **손·발 클릭 후 드래그** | **IK — 두 뼈 분석 솔버가 팔·다리를 자동으로 구부림** |
| 우측 슬라이더 | 선택 관절의 XYZ 각도 정밀 조절 (한계 표시) |
| 프리셋 버튼 | 서기 / T-POSE / 앉기 / 걷기 / 인사 / 기지개 / 구부리기 / 발차기 |
| 포즈 저장 | localStorage + JSON 내보내기/불러오기 |
| **＋ 캐릭터 추가** | **GLB 추가(복수 가능) → 다중 캐릭터. 기본 마니퀸과 동시 편집, 클릭으로 활성 전환, ✕ 삭제** |
| **Shift+드래그 (캐릭터)** | **캐릭터를 지면 위에서 화면 기준으로 끌어 원하는 위치에 배치** |
| **소품 배치** | **GLB 복수 업로드 → 씬에 배치. 캔버스 클릭 선택 → 이동 기즈모, 크기 0.01–500×(로그 슬라이더)·회전(Y)·좌표·삭제** |
| 보기 모드 | 노멀 / **선화**(외곽선+페이퍼 셰이더) / **실루엣**(overrideMaterial) |
| PNG 내보내기 | 현재 모드 그대로 캔버스 → 다운로드 (메인·소품 모두 포함) |

## 구현 구조

```
public/mannequin.gltf      # 스크립트로 생성한 관절형 마네퀸 (useGLTF로 로드)
src/
  lib/
    joints.js              # 관절 트리·한도(도)·히지 의미론·프리셋 포즈
    ik.js                  # 두 뼈 분석 IK (이중 접기 방지, 홀드백 한도 포함)
    collision.js           # 구·캡슐 충돌 검사 및 바디 푸시백 (관절 각도로 해결)
    rig.js                 # glTF 스페이스 관절 제어: 피드포워드·FK·IK·프리셋·충돌 완화
    pose.js                # 포즈 직렬화 + localStorage 저장/목록
    appearance.js          # 렌더 모드: 노멀 / 선화(외곽선 헐) / 실루엣
    modelLoader.js         # 파일 선택 GLB 로드 + 캐릭터/소품 정규화(높이·바닥)
    autorig.js             # 뼈 없는 GLB에 기본 마니퀸 골격 임베드 + 근접 가중 스킨
    naming.js              # 외국 규칙 뼈 이름 → 우리 규칙 자동 개명
    exporter.js            # 캔버스 → PNG 다운로드
  components/
    Mannequin.jsx          # useGLTF 로딩·기본 캐릭터 리그 생성(?model= URL 포함 자동 리깅)
    PoseCanvas.jsx         # R3F 캔버스, 조명, 바닥, OrbitControls, 소품 그룹, 모드 적용
    InteractionController.jsx # 다중 캐릭터 픽킹·FK 기즈모·IK 드래그·Shift 이동·소품 픽킹
    UIPanel.jsx            # 보기 모드·캐릭터 목록·소품·프리셋·관절 슬라이더·포즈 저장·PNG
```

### 핵심 기술 포인트

- **외부 GLB 지원**: 파일에서 로드하면 높이 정규화 + 바닥 정렬 후 배치.
  뼈 이름은 `mixamorig:LeftArm` 같은 관례를 자동으로 우리 규칙
  (`UpperArmL` 등)으로 개명해서(any humanoid glTF) 리그에 연결하고,
  슬라이더/프리셋은 **레스트 포즈 기준 델타**로 동작해 레스트가 다른
  스켈레톤도 안전합니다. **뼈 없는 모델은 자동으로 리깅됩니다** — 내장된
  기본 마니퀸의 Hips 서브트리(17관절)를 클론해 삽입하고, A포즈/T포즈를
  감지해 팔 체인을 메시에 맞춰 피팅(회전+길이)한 뒤, 뼈 세그먼트 거리 기반
  top-4 가중치로 스킨을 변환합니다. 이후 제한·IK·프리셋이 그대로 동작하며,
  모든 캐릭터는 개별 루트로 씬에 배치되어 Shift+드래그로 배치할 수 있고
  클릭 시 편집 대상이 전환됩니다(유한개 동시 존재·개별 삭제 가능).
  로드됩니다.
- **FK**: drei `TransformControls`를 선택 관절에 attach. 드래그 종료 시
  힌지(팔꿈치·무릎)는 물리 굽힘 각도로, 나머지는 한도 슬라이더와 동일한
  축별 한도로 보정합니다.
- **IK**: 어깨~손목 / 고관절~발목의 **두 뼈 분석 솔버**(law of cosines).
  접힘(branch) 방지 홀드백과 원위 관절(손목·발목) 홀드백 한도 포함.
  목표가 너무 멀 때는 체인 위치에서 캡으로 가깝게 클램프.
- **한도**: 부채꼴(도) 단위. 힌지 관절은 접힘 각도로, 기타는
  휴식 자세 기준 축별 한도로 검사·보정 (예: 목 요우 ±60°).
- **충돌**: 몸통·머리·골반 구/캡슐 + 상대 체인 무시 목록으로
  팔이 몸통을 관통하지 않으며, 위반 시 관절 각도로 푸시백 후
  반복 보정으로 FK·IK 모두를 지나갑니다.
- **선화**: BackSide 확장 매트(MeshBasic) + `ShaderMaterial` 외곽선
  (법선 방향 두께 증폭) + 페이퍼 램버트 재질 — 스크린 필터가 아닌
  셰이더/메시 테크닉.
- **실루엣**: `scene.overrideMaterial`로 전 플랫 블랙 + 흰 배경.

## 테스트

```bash
npm test               # 노드 테스트 전부 (솔버·개명·자동 리깅·바닥 정렬)
npm run test:ui        # 브라우저 E2E 전부 (아래 개발 서버 실행 필요)

npm run test:solver     # IK·한도·충돌·프리셋 솔버 테스트 (257 checks)
npm run test:naming     # 외국 뼈 이름 매핑 단위 테스트
npm run test:autorig    # 자동 리깅(스키닝·가중치·디폼) 단위 테스트
npm run test:grounding  # 바닥 정렬 테스트
npm run test:smoke      # 선택/슬라이더/저장/PNG UI 스모크
npm run test:e2e        # 기즈모 회전 + IK 드래그 E2E
npm run test:import     # 다중 캐릭터·소품 배치 E2E
npm run test:user-model # 리깅 없는 모델 자동 리깅 E2E
```

브라우저 테스트(`test:*` 중 UI 계열)는 `localhost:5173`에서 `npm run dev`가
실행 중이어야 합니다. Playwright에 내려받은 브라우저 대신 시스템 Chromium을
쓰려면 `CHROMIUM_BIN=/path/to/chromium` 환경 변수를 지정하세요.

### 테스트 픽스처

`test:autorig` / `test:import` / `test:user-model`은 `public/`에 커밋된 GLB
픽스처 2개를 사용합니다. `mannequin.gltf`(단일 소스)로부터 다시 생성:

```bash
npm run gen:fixtures
```

- `public/mannequin_user.glb` — 뼈 없는 모델 (자동 리깅·소품 테스트)
- `public/soldier_user.glb` — Mixamo 관절 이름 + A-포즈 리그 모델
  (개명 파이프라인·다중 캐릭터 테스트)

## 디버그 훅

브라우저 콘솔에서 사용 가능:
`window.__POSE__` (gl, scene, camera, THREE) · `window.__SCENE__` (현재 scene)
· `window.__TC__` (TransformControls)
