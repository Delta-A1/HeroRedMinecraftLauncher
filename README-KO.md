# Fire Crew Launcher R9 개발용 소스

R9 내부 테스트용 Windows 배포본과 같은 기능 구성을 편집 가능한 Electron/Node.js 프로젝트로 정리한 소스입니다. Electron 실행 파일, DLL, `node_modules`, Minecraft·Java 실행 파일과 사용자 로그인 데이터는 포함하지 않습니다.

## R9 기준

| 항목 | 버전 또는 설정 |
| --- | --- |
| 런처 | Fire Crew Launcher `1.0.1` |
| Minecraft Java Edition | `26.2` |
| Forge | `65.0.9` |
| Java 런타임 | Mojang `java-runtime-epsilon` / Java 25 |
| 배포 매니페스트 | `fire-crew-26.2-city-building-r2` |
| 서버 | `185.207.166.118:19003` |
| 대상 OS | Windows 10/11 x64 |

R9에는 Microsoft/Minecraft 기기 코드 로그인, 프로필·스킨 표시, Java·Minecraft·Forge 자동 설치, 증분 패치, 서버 목록 자동 등록, Quick Play 직접 접속, 실시간 서버 접속 인원, SOOP 공지·비밀기지 탭, 3장 배경 루프가 들어 있습니다.

## 개발 시작

Node.js 22 이상과 npm을 설치한 뒤 프로젝트 폴더에서 실행합니다.

```powershell
npm ci
npm test
npm start
```

Windows x64 테스트 배포본은 다음 명령으로 만듭니다.

```powershell
npm run pack:win
```

출력 폴더는 `dist\불꽃단 런처-win32-x64`입니다.

## GitHub Releases 자동 업데이트

`assets/runtime-config.json`의 `githubRepository`를 `소유자/저장소` 형식으로 설정하면 런처가 시작될 때 최신 GitHub Release를 백그라운드에서 확인합니다. 설정 화면의 **런처 업데이트 확인** 버튼으로도 언제든 다시 확인할 수 있습니다.

```json
{
  "githubRepository": "Delta-A1/HeroRedMinecraftLauncher",
  "githubReleaseAsset": "",
  "autoUpdateEnabled": true
}
```

공개 릴리스용 ZIP과 SHA-256 파일은 다음 명령으로 만듭니다.

```powershell
npm run release:win
```

생성된 `release\fire-crew-launcher-windows-x64-v<버전>.zip`과 같은 이름의 `.sha256` 파일을 GitHub Release에 함께 첨부하고, 태그를 `v<package.json 버전>` 형식으로 지정합니다. `githubReleaseAsset`을 비워 두면 런처가 Windows x64 ZIP을 자동 선택합니다. 값이 있으면 해당 이름과 정확히 일치하는 자산만 사용합니다.

GitHub에 소스를 올린 뒤 `v<package.json 버전>` 태그를 푸시하면 `.github/workflows/release.yml`이 Windows 빌드와 테스트를 수행하고 위 두 자산을 GitHub Release로 자동 게시합니다. 태그와 `package.json` 버전이 다르면 잘못된 업데이트 게시를 막기 위해 작업이 실패합니다.

새 버전을 게시할 때는 `package.json`의 `version`만 올리면 런처 표시 버전, 업데이트 비교 버전, 릴리스 ZIP 이름이 함께 변경됩니다.

업데이트는 ZIP 다운로드 후 SHA-256 검증, 안전한 임시 폴더 압축 해제, 런처 종료 후 파일 교체, 자동 재시작 순서로 진행됩니다. 설치 폴더에 쓰기 권한이 있어야 하므로 Windows의 보호된 시스템 폴더보다는 사용자 쓰기 가능 폴더에 배포하세요.

## 주요 경로

| 경로 | 역할 |
| --- | --- |
| `src/main.js` | Electron 메인 프로세스와 설치·로그인·실행 흐름 |
| `src/auth-service.js` | Microsoft/Xbox/Minecraft 인증 |
| `src/minecraft-service.js` | Java 25, Minecraft 26.2, Forge 설치·실행 |
| `src/patch-service.js` | 매니페스트와 해시 검증, 증분 패치 |
| `src/server-status.js` | Minecraft 상태 프로토콜 기반 실시간 접속 인원 조회 |
| `src/server-list.js` | `servers.dat`에 Fire Crew 서버 등록 |
| `src/skin-service.js` | 공식 Minecraft 스킨 조회·캐시 |
| `src/renderer/` | 런처 메인 화면 HTML/CSS/JavaScript |
| `assets/distribution-manifest.json` | R9 클라이언트 모드 14개와 제거 대상 |
| `assets/runtime-config.json` | Microsoft 공개 클라이언트 ID와 배포 설정 |
| `test/` | Node 자동 테스트 |
| `tools/` | 매니페스트·키·Windows 패키징 보조 도구 |

## GitHub 모드 목록 관리

클라이언트는 `assets/runtime-config.json`의 `distributionManifestUrl`에서 서명된 모드 목록을 확인합니다. 새 버전이면 각 파일의 크기와 해시를 비교해 바뀐 파일만 내려받고, GitHub 또는 네트워크에 장애가 있으면 캐시된 목록이나 번들 목록으로 복귀합니다.

별도 관리 화면은 다음 명령으로 실행합니다.

```powershell
npm run modes
```

관리 화면만 별도의 Windows x64 실행 파일로 만들려면 다음 명령을 사용합니다.

```powershell
npm run modes:pack
```

산출물은 `dist-admin/Fire Crew 모드 관리자-win32-x64`에 생성됩니다. 이 도구는 런처 배포본과 별개이며, 패키징된 도구의 작업 목록은 사용자 데이터 폴더에 저장됩니다.

1. `admin-signing-key/fire-crew-manifest-private.pem`을 선택합니다.
2. 모드를 추가하고 다운로드 URL을 입력한 뒤 **URL 확인**으로 크기와 SHA-256을 계산합니다.
3. 목록 버전을 올리고 로컬 저장하거나 GitHub에 게시합니다.
4. GitHub 게시에는 도구 내 OAuth 로그인 또는 대상 저장소의 Contents 읽기/쓰기 권한을 가진 fine-grained PAT가 필요합니다. 직접 입력한 PAT는 저장되지 않습니다.

관리 도구 안에서 GitHub에 로그인할 수도 있습니다. GitHub Developer settings에서 OAuth App을 등록하고 **Enable Device Flow**를 켠 뒤 공개 Client ID를 입력합니다. 로그인 버튼을 누르면 브라우저가 열리고 인증 코드가 클립보드에 복사됩니다. 발급된 OAuth 토큰은 Windows 보안 저장소로 암호화되며 로그아웃 버튼으로 이 기기에서 삭제할 수 있습니다. OAuth App을 사용하지 않는 경우 기존처럼 PAT를 일회성으로 입력할 수도 있습니다.

모드 추가 시 직접 다운로드 주소 대신 `https://modrinth.com/mod/...` 형태의 프로젝트 페이지를 넣고 **자동 확인**을 누르면 Minecraft 26.2와 Forge 조건에 맞는 최신 버전을 선택해 실제 CDN 주소, 파일명, 크기와 SHA-1을 채웁니다.

최초 키는 `npm run manifest:key`로 만들 수 있습니다. 개인 키는 런처나 GitHub에 포함하지 말고 별도로 백업해야 합니다. 공개 키만 `distributionPublicKey`에 넣습니다. 현재 기본 원격 목록은 `Delta-A1/HeroRedMinecraftLauncher` 저장소의 `main/assets/distribution-manifest.json`입니다.

모드팩의 소규모 변경은 위 JSON만 새 버전으로 게시합니다. 런처 실행 파일 업데이트용 GitHub Release와 ZIP은 건드리지 않습니다. 반대로 런처 업데이트는 `githubRepository`의 Release만 확인하므로 모드 목록 커밋만으로 런처 업데이트 알림이 발생하지 않습니다.

클라이언트는 실행할 때마다 서명된 원격 모드 목록을 자동 확인합니다. Minecraft 기본 설치가 완료된 클라이언트에서 목록 버전이나 파일 해시가 바뀌면 변경된 모드만 즉시 내려받아 갱신합니다. 설정 화면의 **모드 업데이트 확인** 버튼으로도 언제든 다시 확인할 수 있으며, 이 흐름은 **런처 업데이트 확인**과 독립적입니다.

## R9 모드 구성

- Simple Voice Chat
- Xaero's Minimap / Xaero's World Map
- Mouse Tweaks
- Saro's Road Blocks / Road Signs
- Rechiseled
- Macaw's Windows / Paths and Pavings / Lights and Lamps / Furniture / Fences and Walls / Roofs
- Skniro's Furniture

충돌이 확인된 Connected Glass는 설치 목록에서 제외했고, 기존 설치본도 `remove` 목록으로 정리합니다.

## 사용자 데이터와 보안

사용자 데이터는 `%LOCALAPPDATA%\FireCrewLauncherLoginTest` 아래에 저장되며 소스 ZIP에는 들어 있지 않습니다. Microsoft Client Secret, 로그인 토큰, Ed25519 개인 키, RCON 비밀번호를 소스에 넣지 마세요. `assets/runtime-config.json`의 Microsoft ID는 데스크톱 공개 클라이언트 ID입니다.

현재 번들 매니페스트는 내부 테스트를 위해 서명 없는 로컬 사용이 허용되어 있습니다. 외부 공개 배포 전에는 서명된 원격 매니페스트와 Authenticode 코드 서명을 연결해야 합니다.
