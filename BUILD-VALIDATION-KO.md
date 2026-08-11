# Fire Crew Launcher R9 소스 검증 기록

검증 기준일: 2026-08-12

## 기준

- Fire Crew Launcher `0.4.3-login-test.9`
- Minecraft Java Edition `26.2`
- Forge `65.0.9`
- Mojang Java 25 (`java-runtime-epsilon`)
- 배포 매니페스트 `fire-crew-26.2-city-building-r2`
- 클라이언트 모드 14개
- Connected Glass 제외 및 제거 대상 등록

## 소스 ZIP 제외 항목

- Electron·Chromium 실행 바이너리와 DLL
- `node_modules`, `dist`, `release`
- Minecraft와 Java 런타임
- 사용자 Microsoft/Xbox/Minecraft 토큰과 스킨 캐시
- 관리자 개인 키와 서버 관리자 인증 정보

## 구현 확인 항목

- Microsoft 기기 코드 로그인과 Minecraft 소유권 확인
- Minecraft 프로필·스킨 표시와 64×32 레거시 스킨 잘림 방지
- Java 25, Minecraft 26.2, Forge 65.0.9 설치·복구
- 서버 목록 등록과 Quick Play 직접 접속
- Minecraft 상태 프로토콜 기반 실시간 접속 인원 조회
- SOOP 공지·비밀기지 카테고리 탭
- 3장 배경 이미지 자동 루프
- 14개 R9 모드의 URL·파일 크기·SHA-1 검증
- Connected Glass 자동 제거

`npm test` 결과: 39개 통과, 실패 0개. ZIP SHA-256은 압축 생성 후 별도로 산출합니다.
