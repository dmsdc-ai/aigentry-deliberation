#!/bin/bash
#
# Session Monitor — 단일 deliberation 세션 전용 터미널 뷰
#
# Usage:
#   bash session-monitor.sh <session_id> <project_slug>
#
# MCP 서버가 deliberation_start 시 자동으로 tmux 윈도우에서 실행합니다.
#

SESSION_ID="${1:?session_id 필요}"
PROJECT="${2:?project_slug 필요}"
STATE_FILE="$HOME/.local/lib/mcp-deliberation/state/$PROJECT/sessions/$SESSION_ID.json"

# 색상
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'
BOX_CONTENT_WIDTH=60
BOX_RULE="$(printf '%*s' "$((BOX_CONTENT_WIDTH + 2))" '' | tr ' ' '═')"

fit_to_width() {
  TEXT="$1" WIDTH="$2" node -e "
    const raw = String(process.env.TEXT ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    const target = Number(process.env.WIDTH ?? '60');

    const isWide = (cp) =>
      cp >= 0x1100 && (
        cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
        (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
        (cp >= 0xac00 && cp <= 0xd7a3) ||
        (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0xfe10 && cp <= 0xfe19) ||
        (cp >= 0xfe30 && cp <= 0xfe6f) ||
        (cp >= 0xff00 && cp <= 0xff60) ||
        (cp >= 0xffe0 && cp <= 0xffe6) ||
        (cp >= 0x1f300 && cp <= 0x1f64f) ||
        (cp >= 0x1f900 && cp <= 0x1f9ff) ||
        (cp >= 0x20000 && cp <= 0x3fffd)
      );

    const charWidth = (ch) => {
      const cp = ch.codePointAt(0);
      if (!cp || cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
      return isWide(cp) ? 2 : 1;
    };

    const src = Array.from(raw);
    const out = [];
    let width = 0;
    let truncated = false;
    for (const ch of src) {
      const w = charWidth(ch);
      if (width + w > target) {
        truncated = true;
        break;
      }
      out.push(ch);
      width += w;
    }

    if (truncated && target >= 3) {
      while (out.length > 0 && width + 3 > target) {
        const last = out.pop();
        width -= charWidth(last);
      }
      out.push('.', '.', '.');
      width += 3;
    }

    process.stdout.write(out.join('') + ' '.repeat(Math.max(0, target - width)));
  " 2>/dev/null
}

print_box_border() {
  printf "%b%s%b\n" "$BOLD" "$1${BOX_RULE}$2" "$NC"
}

print_box_row() {
  local text="$1"
  local color="${2:-$NC}"
  local fitted
  fitted="$(fit_to_width "$text" "$BOX_CONTENT_WIDTH")"
  printf "%b║%b %b%s%b %b║%b\n" "$BOLD" "$NC" "$color" "$fitted" "$NC" "$BOLD" "$NC"
}

pane_in_copy_mode() {
  if [ -z "$TMUX" ] || [ -z "${TMUX_PANE:-}" ]; then
    return 1
  fi
  [ "$(tmux display-message -p -t "$TMUX_PANE" "#{pane_in_mode}" 2>/dev/null)" = "1" ]
}

state_signature() {
  if [ ! -f "$STATE_FILE" ]; then
    echo "MISSING"
    return
  fi

  node -e "
    const fs = require('fs');
    try {
      const s = JSON.parse(fs.readFileSync('$STATE_FILE','utf-8'));
      const logs = Array.isArray(s.log) ? s.log : [];
      const last = logs.length > 0 ? logs[logs.length - 1] : {};
      const sig = [
        s.status ?? '',
        s.current_round ?? '',
        s.max_rounds ?? '',
        s.current_speaker ?? '',
        Array.isArray(s.speakers) ? s.speakers.join(',') : '',
        logs.length,
        last.timestamp ?? '',
        s.updated ?? '',
        s.synthesis ? s.synthesis.length : 0
      ].join('|');
      console.log(sig);
    } catch {
      console.log('PARSE_ERROR');
    }
  " 2>/dev/null
}

get_field() {
  node -e "
    try {
      const d = JSON.parse(require('fs').readFileSync('$STATE_FILE','utf-8'));
      const keys = '$1'.split('.');
      let val = d;
      for (const k of keys) val = val?.[k];
      if (Array.isArray(val)) console.log(val.length);
      else console.log(val ?? '?');
    } catch { console.log('?'); }
  " 2>/dev/null
}

render() {
  if [ ! -f "$STATE_FILE" ]; then
    echo -e "${DIM}세션 파일 대기 중: $STATE_FILE${NC}"
    return
  fi

  local topic=$(get_field "topic")
  local status=$(get_field "status")
  local round=$(get_field "current_round")
  local max_rounds=$(get_field "max_rounds")
  local participant_count=$(get_field "speakers")
  local speaker=$(get_field "current_speaker")
  local responses=$(get_field "log")

  # 상태 색상
  local status_color="$YELLOW"
  case "$status" in
    active) status_color="$GREEN" ;;
    completed) status_color="$CYAN" ;;
    awaiting_synthesis) status_color="$BLUE" ;;
  esac

  # 프로그레스 바
  if ! [[ "$participant_count" =~ ^[0-9]+$ ]]; then participant_count=2; fi
  if [ "$participant_count" -lt 1 ]; then participant_count=1; fi

  local total=$((max_rounds * participant_count))
  local filled=$responses
  [ "$filled" -gt "$total" ] 2>/dev/null && filled=$total
  local bar=""
  for ((i=0; i<filled; i++)); do bar+="█"; done
  for ((i=filled; i<total; i++)); do bar+="░"; done

  # 헤더
  print_box_border "╔" "╗"
  print_box_row "$topic" "$YELLOW"
  print_box_border "╠" "╣"
  print_box_row "Session:  $SESSION_ID" "$MAGENTA"
  print_box_row "Project:  $PROJECT" "$CYAN"
  print_box_row "Status:   $status" "$status_color"
  print_box_row "Round:    $round/$max_rounds  |  Next: $speaker" "$BOLD"
  print_box_row "Progress: [$bar] $responses/$total" "$GREEN"
  print_box_border "╚" "╝"
  echo ""

  # 토론 기록
  node -e "
    const fs = require('fs');
    try {
      const s = JSON.parse(fs.readFileSync('$STATE_FILE','utf-8'));

      if (s.synthesis) {
        console.log('\x1b[1m── Synthesis ──\x1b[0m');
        console.log('');
        const lines = s.synthesis.split('\n').slice(0, 20);
        lines.forEach(l => console.log('  ' + l));
        if (s.synthesis.split('\n').length > 20) console.log('  ...(truncated)');
        console.log('');
      }

      if (s.log.length === 0) {
        console.log('\x1b[2m  아직 응답이 없습니다. ' + s.current_speaker + ' 차례 대기 중...\x1b[0m');
        process.exit(0);
      }

      console.log('\x1b[1m── Debate Log ──\x1b[0m');
      console.log('');

      const palette = ['\x1b[34m', '\x1b[33m', '\x1b[35m', '\x1b[36m', '\x1b[32m', '\x1b[31m'];
      const icons = ['🔵', '🟡', '🟣', '🟢', '🟠', '⚪'];
      const hash = (name) => {
        let out = 0;
        for (let i = 0; i < name.length; i += 1) out = (out * 31 + name.charCodeAt(i)) >>> 0;
        return out;
      };
      const styleFor = (name) => {
        const idx = hash(String(name ?? '')) % palette.length;
        return { color: palette[idx], icon: icons[idx % icons.length] };
      };

      for (const entry of s.log) {
        const { color, icon } = styleFor(entry.speaker);
        console.log(color + '\x1b[1m' + icon + ' ' + entry.speaker + ' — Round ' + entry.round + '\x1b[0m');

        const lines = entry.content.split('\n');
        lines.forEach(l => console.log('  ' + l));
        console.log('');
      }

      if (s.status === 'active') {
        const nextColor = styleFor(s.current_speaker).color;
        console.log(nextColor + '  ⏳ Waiting for ' + s.current_speaker + ' (Round ' + s.current_round + ')...\x1b[0m');
      } else if (s.status === 'awaiting_synthesis') {
        console.log('\x1b[36m  🏁 모든 라운드 종료. 합성 대기 중...\x1b[0m');
      }
    } catch(e) {
      console.log('  읽기 실패: ' + e.message);
    }
  " 2>/dev/null

  echo ""

  # 완료 시 카운트다운
  if [ "$status" = "completed" ]; then
    echo -e "${CYAN}${BOLD}  ✅ Deliberation 완료!${NC}"
    echo -e "${DIM}  이 터미널은 30초 후 자동으로 닫힙니다...${NC}"
    for i in $(seq 30 -1 1); do
      printf "\r${DIM}  닫히기까지 %2d초...${NC}" "$i"
      sleep 1
      # 파일이 삭제되었으면 즉시 종료
      [ ! -f "$STATE_FILE" ] && break
    done
    echo ""
    exit 0
  fi
}

draw_frame() {
  # 전체 클리어 대신 홈 이동 + 하단 잔여 영역만 정리해서 깜빡임 감소
  printf '\033[H'
  render
  printf '\033[J'
  echo -e "${DIM}Auto-refresh on change (poll 2s) | Scroll: mouse wheel / PgUp (tmux copy-mode) | Ctrl+C${NC}"
}

# 커서 숨김 (종료 시 복구)
printf '\033[?25l'
trap 'printf "\033[?25h"' EXIT INT TERM
printf '\033[2J\033[H'

# tmux에서 스크롤(휠/업다운) 동작을 위해 mouse/copy history 옵션 활성화
if [ -n "$TMUX" ]; then
  tmux set-option -g mouse on >/dev/null 2>&1 || true
  tmux set-option -g history-limit 200000 >/dev/null 2>&1 || true
fi

# 메인 루프
last_sig=""
seen_file=0
while true; do
  if pane_in_copy_mode; then
    # 사용자가 스크롤 중이면 렌더 업데이트를 멈춰 화면 점프를 방지
    sleep 1
    continue
  fi

  if [ ! -f "$STATE_FILE" ]; then
    if [ "$seen_file" -eq 1 ]; then
      printf '\033[H\033[J'
      echo -e "${RED}세션이 삭제되었습니다.${NC}"
      sleep 3
      exit 0
    fi

    if [ "$last_sig" != "MISSING" ]; then
      draw_frame
      last_sig="MISSING"
    fi

    sleep 2
    continue
  fi

  seen_file=1
  sig="$(state_signature)"
  if [ "$sig" != "$last_sig" ]; then
    draw_frame
    last_sig="$sig"
  fi

  sleep 2
done
