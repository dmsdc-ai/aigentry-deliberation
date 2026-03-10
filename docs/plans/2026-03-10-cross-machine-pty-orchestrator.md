# Cross-Machine AI Agent Orchestrator (PTY-Based)
**Date:** 2026-03-10

## 1. 개요 및 배경 (Background)
AIGentry 생태계 내에서, 서로 다른 머신(Machine A, Machine B)에서 실행 중인 AI 에이전트(Claude Code, Gemini CLI 등) 간의 실시간 컨텍스트 주입 및 협업을 달성하기 위한 아키텍처 논의.

초기에는 `aigentry-brain`(CMP)을 직접 주입하는 방식을 고려했으나, **"기억(Storage/CMP)"**과 **"실시간 액션(Transport/PTY)"**의 역할을 분리하는 것이 타당하다는 결론에 도달함.

## 2. 기존 방식의 한계
* **일반 CLI의 한계:** 순정 `claude`나 `gemini` CLI는 터미널(stdin) 입력을 대기(idle)할 뿐, 외부 네트워크(HTTP/Tailscale)에서 날아오는 신호를 수신할 수 없음.
* **aigentry-deliberation의 한계:** 딜리버레이션 패키지에 포함된 `observer.js` 데몬은 네트워크 수신이 가능하지만, 이는 '딜리버레이션' 전용이므로 일반 CLI를 깨우는 공용 목적으로 쓰기에는 역할이 겹치고 혼재됨.

## 3. 새로운 아키텍처 결정: 전용 'Agent Daemon' 분리
기존 `aigentry-deliberation`에서 네트워크 수신 데몬 역할을 완전히 분리하여, 머신 레벨에서 모든 AI 에이전트 CLI를 백그라운드에서 관장하는 신규 시스템(가칭 `aigentry-daemon`)을 개발하기로 함.

### 동작 원리 (The PTY Flow)
1. **사용자 지시:** Machine A에서 "Machine B의 프론트엔드 세션에 컬러코드 전달해"라고 지시.
2. **명시적 타겟팅 (Discovery & Confirm):** Machine A의 AI는 B머신의 데몬에게 세션 목록을 조회(`list_remote_sessions`). 타겟 세션(예: `frontend-ui-3k2`)을 식별하면 사용자에게 확인을 받거나 명확한 ID로 HTTP POST 요청을 보냄.
3. **PTY 래핑 및 주입 (The Magic):** Machine B의 데몬이 HTTP 요청을 받음. 데몬은 해당 `session_id`와 매핑된 가상 터미널(PTY)을 찾음.
4. **강제 기상 (Wake-up):** 데몬이 가상 터미널의 `stdin`에 전송받은 텍스트를 타이핑하고 `\n`(엔터)을 입력함. 
5. **실행:** Idle 상태이던 CLI가 사용자의 키보드 입력으로 착각하고 깨어나 프롬프트를 수행함.

## 4. 핵심 원칙 (Core Principles)
* **결정론적 라우팅 (Deterministic Routing):** 컨텍스트 주입은 AI의 컨텍스트를 오염시킬 수 있는 파괴적(Mutating) 쓰기 작업이므로, 애매한 경로 라우팅을 금지하고 반드시 명시적 `session_id` (마치 IP 주소처럼)를 통해 주입하도록 강제함. (Human-in-the-loop 확인 필수)
* **작업 공간 분리 (Workspace-Aware):** 데몬은 각 CLI 에이전트가 어느 프로젝트 폴더(`spawn_cwd`)에서 돌고 있는지 엄격히 트래킹해야 함.
* **보안:** 데몬은 `root`가 아닌 유저 레벨(`systemd user service` 등)로 동작해야 하며, 실행 가능한 명령어는 화이트리스트로 관리됨.

## 5. 경쟁 및 유사 서비스 (Market Research)
* MCP 생태계, LangChain, AutoGen 등에서는 이러한 "interactive CLI를 PTY 레벨에서 원격으로 깨우는(Wake-up) 브릿지"가 존재하지 않음.
* 기존 DevOps의 `tmux send-keys` 방식을 AI 오케스트레이션과 HTTP/Tailscale에 접목한 완전한 **Novel Architecture**임.
