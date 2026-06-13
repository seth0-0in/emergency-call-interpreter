# HANDOFF — 119 외국인 신고자 실시간 통번역 시스템

## 현재 구현 상태
- 양방향 실시간 통번역(STT→번역→TTS), STT 언어 자동 감지 + 수동 lock, 14개 언어.
- LLM 기반 신고 요약 및 사건 기록 문서(TXT/HTML/PDF) 생성.
- 콘솔↔시뮬레이터는 현재 BroadcastChannel(동일 origin) 기반.

## 로컬 실행
- npm install → npm run dev (콘솔/시뮬레이터 두 탭), 빌드는 npm run build.
- 환경변수는 .env.example 참고 (실제 값은 .env.local, 커밋 금지).

## 주요 기능
- /console 상황실 콘솔, /simulator 신고자 시뮬레이터, /upload 녹취 전사, /result 사건 기록 문서.

## 향후 개선 예정
- BroadcastChannel → WebSocket 전환(기기 분리/실환경 대응).
- 폐쇄망용 내부 배포 환경 연동 및 VAD wasm 내부 호스팅.
