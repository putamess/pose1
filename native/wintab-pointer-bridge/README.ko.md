# Photoshop CS6용 WM_POINTER → WinTab 브리지 (실험용)

`Photoshop.exe`와 같은 폴더에 둘 수 있는 **64비트 `wintab32.dll`의 C++ 소스 프로젝트**입니다. Windows의 `WM_POINTER` 중 `PT_PEN`만 받아 WinTab 패킷으로 변환합니다. 물리 마우스 입력을 펜 입력으로 바꾸거나 Windows 전체의 입력 설정을 변경하지 않습니다.

> **중요:** 이 저장소에는 아직 컴파일된 `.dll` 바이너리가 없습니다. 현재 작업 환경은 Linux이며 MSVC/MinGW와 Windows SDK가 없어 Windows 바이너리를 빌드하거나 Photoshop CS6·삼성 S펜에서 런타임 검증을 할 수 없습니다. 아래는 Windows x64에서 빌드하도록 만든 프로젝트 소스입니다. Photoshop에서 동작한다고 검증된 완제품으로 간주하면 안 됩니다.

## 구현 범위

- `WTInfoA/W`, `WTOpenA/W`, `WTClose`, `WTEnable`, `WTOverlap`, `WTGet/SetA/W`
- `WTPacket`, `WTPacketsGet/Peek`, `WTDataGet/Peek`, `WTQueueSizeGet/Set`, `WTQueuePacketsEx`
- `WM_POINTER` 펜의 화면 X/Y, 접촉/호버, tip·barrel 버튼, 압력, eraser 표시, 방향/회전 데이터 변환
- Windows가 펜에서 함께 생성하는 호환 `WM_MOUSE*` 메시지는 기본 설정에서 **Photoshop 프로세스 안에서만** 억제합니다. 억제는 WinTab 펜 입력을 한 번 관찰한 뒤에만 시작하며, 실제 마우스의 일반 `WM_MOUSE*` 메시지는 그대로 둡니다.
- DLL은 컨텍스트가 열린 창과 같은 UI 스레드의 하위 창만 서브클래싱합니다. 전역 마우스 훅, 드라이버, 레지스트리 변경은 없습니다.

`WTSave/Restore`, 설정 대화상자, 외부 Wintab manager, 제조사별 확장과 접선 압력은 지원하지 않습니다. `WTX_TILT` 확장 대신 표준 `PK_ORIENTATION`/`PK_ROTATION`으로 기울기 정보를 best-effort 변환합니다. Windows/드라이버가 `WM_POINTER`에서 실제 압력·틸트를 제공하지 않으면 그 데이터도 얻을 수 없습니다.

## 빌드 (Windows x64)

1. Visual Studio 2022의 **Desktop development with C++**, Windows 10/11 SDK, CMake 3.21 이상을 설치합니다.
2. PowerShell에서 이 폴더로 이동한 뒤 실행합니다.

```powershell
.\build-x64.ps1
```

또는 Visual Studio 2022 x64 개발자 프롬프트에서 직접:

```powershell
cmake -S . -B out -G "Visual Studio 17 2022" -A x64
cmake --build out --config Release
```

결과 파일: `out\Release\wintab32.dll`

이 프로젝트는 x64만 허용합니다. **32비트 Photoshop CS6에는 로드할 수 없습니다.** 다른 Visual Studio 버전을 쓰면 생성기 이름을 설치된 버전에 맞추세요.

## Photoshop 폴더에만 설치

Photoshop을 완전히 종료한 뒤, 실제 64비트 실행 파일 경로를 지정합니다.

```powershell
.\install-photoshop.ps1 `
  -PhotoshopExePath 'C:\Program Files\Adobe\Adobe Photoshop CS6 (64 Bit)\Photoshop.exe'
```

설치 스크립트는 실행 파일과 DLL이 모두 x64인지 확인하고, `wintab32.dll`을 **지정한 `Photoshop.exe`의 폴더에만** 복사합니다. 레지스트리, Windows 폴더, 태블릿 드라이버, 다른 앱은 수정하지 않습니다. Photoshop 폴더의 쓰기 권한이 필요하면 관리자 PowerShell이 필요할 수 있습니다.

대상 폴더에 `wintab32.dll`이 이미 있으면 스크립트는 덮어쓰지 않고 중단합니다. 기존 파일이 제조사 WinTab 드라이버 DLL일 수 있으므로 먼저 확인하세요. 교체가 정말 의도된 경우에만 `-ReplaceExisting`을 추가하면, 기존 DLL을 같은 Photoshop 폴더 안의 `.backup-날짜` 파일로 복사한 다음 교체합니다.

롤백은 Photoshop을 종료한 뒤 이 폴더의 `wintab32.dll`을 제거하고, 백업 파일이 있다면 원래 이름으로 되돌리면 됩니다. Windows 시스템 파일을 복구할 필요는 없습니다.

## 설정

설치 스크립트는 설정 파일이 없을 때만 `wintab-pointer-bridge.ini`도 Photoshop 폴더에 복사합니다.

```ini
[Bridge]
SuppressPenMouse=1
```

`1`은 Photoshop 안에서 펜이 만든 호환 마우스 메시지만 억제합니다. 마우스 자체의 메시지는 억제하지 않습니다. 진단 중 억제가 다른 입력 동작과 충돌하면 값을 `0`으로 바꾸고 Photoshop을 재시작하세요.

## 확인 절차와 한계

1. 프로세스가 64비트 Photoshop인지 확인합니다.
2. Photoshop을 실행해 새 문서에서 브러시 스트로크, 압력 변화, 실제 마우스 동작을 각각 확인합니다.
3. 로드가 안 되거나 태블릿 없음으로 나오면 Process Explorer 등으로 Photoshop이 이 폴더의 DLL을 실제 로드했는지 확인합니다. 앱이 다른 경로에서 WinTab을 직접 로드하면 앱 폴더 복사만으로 대체되지 않을 수 있습니다.
4. 펜이 계속 마우스 입력으로만 보이면 이 DLL이 로드되지 않았거나, 해당 Photoshop 빌드/삼성 드라이버가 브리지의 가정과 다를 수 있습니다. 이 구현만으로 문제 해결을 보장하지 않습니다.

현재 프로젝트는 **Photoshop CS6 Extended와 삼성 S펜에서 실기 검증되지 않았습니다.** 특히 WinTab 전체 호환성, Photoshop이 실제 호출하는 export 집합, 다중 컨텍스트 우선순위, 멀티 모니터 좌표, 펜 hover/틸트는 Windows에서 별도 검증이 필요합니다. 실제 테스트 전에는 Photoshop 폴더에 있는 기존 `wintab32.dll`을 보존하세요.

## 참고

- [Wacom WinTab 기본 구조와 컨텍스트/패킷 모델](https://developer-docs.wacom.com/docs/icbt/windows/wintab/wintab-basics/)
- [Wacom WinTab API 레퍼런스](https://developer-docs.wacom.com/docs/icbt/windows/wintab/wintab-reference/)
- WinTab 헤더의 ABI 정의는 이 프로젝트의 `wintab_compat.h`에 필요한 범위만 직접 선언했습니다.
