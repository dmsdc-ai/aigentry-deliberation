#!/bin/bash
# auto-deliberate.sh - Automated AI Deliberation
# Usage:
#   bash auto-deliberate.sh "topic"              # New deliberation, 2 rounds
#   bash auto-deliberate.sh "topic" 3            # New deliberation, 3 rounds
#   bash auto-deliberate.sh --resume <session_id> # Resume existing session
#
# Requires: node, and at least 2 of: claude, codex, gemini CLIs installed

set -euo pipefail

MCP_SERVER="${HOME}/.local/lib/mcp-deliberation/index.js"
NODE=$(command -v node 2>/dev/null || echo "node")

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log()     { echo -e "${BLUE}[deliberation]${NC} $*"; }
success() { echo -e "${GREEN}[+]${NC} $*"; }
warn()    { echo -e "${YELLOW}[!]${NC} $*"; }
error()   { echo -e "${RED}[x]${NC} $*" >&2; }

# ── MCP JSON-RPC caller ──────────────────────────────────────────
# Sends initialize + initialized notification + tool call to the MCP server
# via stdin, then extracts the response for id:2.
mcp_call() {
    local tool_name="$1"
    local args="$2"
    local init='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"auto-deliberate","version":"1.0"}}}'
    local initialized='{"jsonrpc":"2.0","method":"notifications/initialized"}'
    local call="{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"${tool_name}\",\"arguments\":${args}}}"

    local output
    output=$(printf '%s\n%s\n%s\n' "$init" "$initialized" "$call" \
        | "$NODE" "$MCP_SERVER" 2>/dev/null)

    # Extract the tool response (id:2)
    echo "$output" | python3 -c "
import sys, json
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        obj = json.loads(line)
        if obj.get('id') == 2:
            result = obj.get('result', {})
            content = result.get('content', [{}])
            if content:
                print(content[0].get('text', ''))
            break
    except Exception:
        pass
" 2>/dev/null
}

# ── Detect available CLI speakers ───────────────────────────────
detect_speakers() {
    local speakers=()
    for cli in claude codex gemini qwen opencode llm; do
        if command -v "$cli" &>/dev/null; then
            speakers+=("$cli")
        fi
    done
    echo "${speakers[@]:-}"
}

# ── Invoke a CLI speaker ─────────────────────────────────────────
invoke_speaker() {
    local speaker="$1"
    local topic="$2"
    local context="$3"
    local prompt
    prompt="당신은 AI deliberation 토론의 참가자입니다. 다음 주제에 대해 의견을 제시해주세요.

주제: ${topic}
${context}

응답 형식:
**핵심 입장:** (구체적 제안)
**근거:** (2-3개)
**리스크/우려:** (1-2개)
**합의 가능 포인트:** (동의할 수 있는 것)
**미합의 포인트:** (결론 안 난 것)"

    case "$speaker" in
        claude)
            echo "$prompt" | claude -p 2>/dev/null \
                || echo "Claude response unavailable"
            ;;
        codex)
            codex exec "$prompt" 2>&1 \
                | grep -v "^OpenAI Codex\|^--------\|^workdir:\|^model:\|^provider:\|^approval:\|^sandbox:\|^reasoning\|^session id:\|^user$\|^mcp:\|^thinking$\|^tokens used$\|^[0-9,]*$" \
                || echo "Codex response unavailable"
            ;;
        gemini)
            gemini -p "$prompt" 2>&1 \
                | grep -v "^Loaded cached\|^Error during discovery" \
                || echo "Gemini response unavailable"
            ;;
        qwen)
            qwen "$prompt" 2>/dev/null \
                || echo "Qwen response unavailable"
            ;;
        opencode)
            opencode run "$prompt" 2>/dev/null \
                || echo "OpenCode response unavailable"
            ;;
        llm)
            echo "$prompt" | llm 2>/dev/null \
                || echo "LLM response unavailable"
            ;;
        *)
            echo "Unknown speaker: $speaker"
            ;;
    esac
}

# ── Extract session_id from mcp_call output ──────────────────────
extract_session_id() {
    local text="$1"
    # Try JSON-style quoted aigentry... id first
    local id
    id=$(echo "$text" | python3 -c "
import sys, re
text = sys.stdin.read()
# Match aigentry<alphanumeric>
m = re.search(r'aigentry[a-z0-9]+', text)
if m:
    print(m.group(0))
" 2>/dev/null)
    echo "${id:-}"
}

# ── Resume: load speakers/topic from state file ──────────────────
load_session_state() {
    local session_id="$1"
    local state_dir="${HOME}/.local/lib/mcp-deliberation/state"

    # Search all project state dirs for the session file
    local state_file
    state_file=$(find "$state_dir" -name "${session_id}.json" 2>/dev/null | head -1)

    if [[ -z "$state_file" || ! -f "$state_file" ]]; then
        error "Session state file not found for: $session_id"
        return 1
    fi

    # Parse topic and speakers from the JSON state
    python3 -c "
import sys, json
with open('$state_file') as f:
    s = json.load(f)
print('TOPIC=' + json.dumps(s.get('topic', '')))
print('SPEAKERS=' + ' '.join(s.get('speakers', [])))
print('MAX_ROUNDS=' + str(s.get('max_rounds', 2)))
print('CURRENT_ROUND=' + str(s.get('current_round', 1)))
" 2>/dev/null
}

# ── Main ─────────────────────────────────────────────────────────
main() {
    local topic=""
    local rounds=2
    local resume_id=""

    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --resume)
                resume_id="$2"
                shift 2
                ;;
            --rounds|-r)
                rounds="$2"
                shift 2
                ;;
            -*)
                error "Unknown flag: $1"
                exit 1
                ;;
            *)
                if [[ -z "$topic" ]]; then
                    topic="$1"
                elif [[ "$1" =~ ^[0-9]+$ ]]; then
                    rounds="$1"
                fi
                shift
                ;;
        esac
    done

    # Validate input
    if [[ -z "$topic" && -z "$resume_id" ]]; then
        echo "Usage:"
        echo "  bash auto-deliberate.sh \"topic\" [rounds]"
        echo "  bash auto-deliberate.sh \"topic\" --rounds 5"
        echo "  bash auto-deliberate.sh --resume <session_id>"
        exit 1
    fi

    # Check MCP server exists
    if [[ ! -f "$MCP_SERVER" ]]; then
        error "MCP server not found at: $MCP_SERVER"
        error "Install with: npx @dmsdc-ai/aigentry-deliberation install"
        exit 1
    fi

    # Check node is available
    if ! command -v "$NODE" &>/dev/null; then
        error "node not found. Install Node.js >= 18."
        exit 1
    fi

    # ── Resume mode ──────────────────────────────────────────────
    if [[ -n "$resume_id" ]]; then
        log "Resuming session: $resume_id"
        local state_vars
        state_vars=$(load_session_state "$resume_id") || exit 1

        # Eval to set TOPIC, SPEAKERS, MAX_ROUNDS, CURRENT_ROUND
        eval "$state_vars"
        topic="$TOPIC"
        rounds="$MAX_ROUNDS"
        local start_round="$CURRENT_ROUND"

        # Speakers from state (space-separated)
        read -ra speakers <<< "$SPEAKERS"

        success "Resuming: \"$topic\" | Round $start_round/$rounds | Speakers: ${speakers[*]}"
        echo ""
    else
        # ── New session: detect speakers ─────────────────────────
        local speakers_str
        speakers_str=$(detect_speakers)

        if [[ -z "$speakers_str" ]]; then
            error "No CLI speakers detected."
            error "Install at least 2 of: claude, codex, gemini, qwen, opencode, llm"
            exit 1
        fi

        read -ra speakers <<< "$speakers_str"

        if [[ ${#speakers[@]} -lt 2 ]]; then
            error "Need at least 2 CLI speakers. Found: ${speakers[*]}"
            error "Install more AI CLIs: claude, codex, gemini, qwen, opencode, llm"
            exit 1
        fi

        local start_round=1
        log "Speakers detected: ${speakers[*]}"
        log "Topic: $topic"
        log "Rounds: $rounds"
        echo ""
    fi

    # ── Start or resume deliberation session ─────────────────────
    local session_id=""

    if [[ -n "$resume_id" ]]; then
        session_id="$resume_id"
        success "Using existing session: $session_id"
    else
        log "Starting deliberation session..."

        local speakers_json
        speakers_json=$(printf '%s\n' "${speakers[@]}" \
            | python3 -c "import sys, json; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))")

        # Escape topic for JSON
        local topic_json
        topic_json=$(python3 -c "import json, sys; print(json.dumps(sys.argv[1]))" "$topic")

        local start_result
        start_result=$(mcp_call "deliberation_start" \
            "{\"topic\":${topic_json},\"speakers\":${speakers_json},\"rounds\":${rounds},\"ordering\":\"cyclic\"}")

        if [[ -z "$start_result" ]]; then
            error "Failed to start deliberation session. Is the MCP server working?"
            error "Test with: echo '{}' | node $MCP_SERVER"
            exit 1
        fi

        session_id=$(extract_session_id "$start_result")

        if [[ -z "$session_id" ]]; then
            error "Could not extract session_id from response."
            error "Response was:"
            echo "$start_result" >&2
            exit 1
        fi

        success "Session started: $session_id"
        echo ""
    fi

    # ── Run deliberation rounds ───────────────────────────────────
    local total_turns=$(( ${#speakers[@]} * rounds ))
    local turn=0
    local context=""

    for (( r=start_round; r<=rounds; r++ )); do
        echo -e "${CYAN}━━━ Round $r / $rounds ━━━${NC}"

        for speaker in "${speakers[@]}"; do
            turn=$(( turn + 1 ))
            log "[$turn/$total_turns] $speaker is thinking..."

            # Build context header for this turn
            local turn_context=""
            if [[ -n "$context" ]]; then
                turn_context=$'\n'"Previous discussion:"$'\n'"$context"
            fi

            # Get response from CLI speaker
            local response
            response=$(invoke_speaker "$speaker" "$topic" "$turn_context")

            if [[ -z "$response" || "$response" == *"unavailable"* ]]; then
                warn "$speaker returned no response. Using placeholder."
                response="[No response from $speaker in round $r]"
            fi

            # Escape response as JSON string
            local escaped_response
            escaped_response=$(python3 -c "
import sys, json
content = sys.stdin.read()
print(json.dumps(content))
" <<< "$response" 2>/dev/null)

            if [[ -z "$escaped_response" ]]; then
                warn "Failed to JSON-encode response from $speaker. Skipping submission."
            else
                # Escape session_id for JSON
                local session_id_json
                session_id_json=$(python3 -c "import json, sys; print(json.dumps(sys.argv[1]))" "$session_id")
                local speaker_json
                speaker_json=$(python3 -c "import json, sys; print(json.dumps(sys.argv[1]))" "$speaker")

                mcp_call "deliberation_respond" \
                    "{\"session_id\":${session_id_json},\"speaker\":${speaker_json},\"content\":${escaped_response}}" \
                    >/dev/null 2>&1

                success "$speaker Round $r submitted"
            fi

            # Accumulate abbreviated context for subsequent speakers
            local excerpt
            excerpt=$(echo "$response" | head -6)
            context="${context}"$'\n'"[${speaker} R${r}]: ${excerpt}"
        done

        echo ""
    done

    # ── Synthesize ────────────────────────────────────────────────
    echo -e "${CYAN}━━━ Synthesis ━━━${NC}"
    log "Generating synthesis report..."

    local synthesis_text
    synthesis_text=$(printf "# Auto-Deliberation Synthesis\n\nTopic: %s\nParticipants: %s\nRounds: %d\nSession: %s\n\nAll rounds completed. See full debate log in deliberation archive." \
        "$topic" "${speakers[*]}" "$rounds" "$session_id")

    local escaped_synthesis
    escaped_synthesis=$(python3 -c "
import sys, json
print(json.dumps(sys.stdin.read()))
" <<< "$synthesis_text" 2>/dev/null)

    local session_id_json
    session_id_json=$(python3 -c "import json, sys; print(json.dumps(sys.argv[1]))" "$session_id")

    local synth_result
    synth_result=$(mcp_call "deliberation_synthesize" \
        "{\"session_id\":${session_id_json},\"synthesis\":${escaped_synthesis}}")

    echo ""
    success "Deliberation complete!"
    echo ""
    echo -e "${YELLOW}Session ID:${NC} $session_id"
    echo ""

    if [[ -n "$synth_result" ]]; then
        echo "$synth_result"
    else
        warn "Synthesis response was empty. Check the session archive."
    fi

    echo ""
    log "Archive location: ~/.local/lib/mcp-deliberation/state/"
}

main "$@"
