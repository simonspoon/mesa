#!/usr/bin/env bash
# Shared helpers for the live-memory eval harness (mesa task 1149).
# Sourced by scripts/memory-eval.sh, baseline.sh and stress.sh — never run
# directly. Everything here assumes the caller has set MESA_BIN, MODEL, OUT
# and (per baseline) MESA_DB + MESA_CONFIG_FILE.

# Whitespace-separated words across the active notebook — the same rule
# core::live::word_count applies, so a harness assertion and a store guard
# count the same thing.
notebook_words() {
  "$MESA_BIN" live memory list 2>/dev/null | jq -r '[.[].body] | join(" ")' | wc -w | tr -d ' '
}
notebook_entries() {
  "$MESA_BIN" live memory list 2>/dev/null | jq 'length'
}

# with_timeout <secs> <stdin-file> <cmd...> — runs cmd in the background, its
# stdin from the file (a backgrounded job would otherwise read /dev/null), and
# kills it once the clock runs out. macOS ships no `timeout`, and gtimeout may
# be absent.
with_timeout() {
  local secs=$1 input=$2; shift 2
  "$@" < "$input" &
  local pid=$!
  ( sleep "$secs"; kill "$pid" 2>/dev/null ) &
  local watchdog=$!
  wait "$pid"
  local rc=$?
  kill "$watchdog" 2>/dev/null
  wait "$watchdog" 2>/dev/null
  return $rc
}

# claude_call <prompt-file> [pattern...] — one `claude -p` in print mode, the
# prompt on stdin (an argument would be swallowed by the variadic --tools
# flag), the JSON envelope on stdout. No pattern = a tool-less call; else each
# argument is one --allowedTools pattern, passed as its own word — a pattern
# holds spaces (`Bash(mesa live memory:*)`), so it must never be word-split. Every call is counted in
# $OUT/calls (one line per call) for the cost line.
claude_call() {
  local prompt_file=$1; shift
  echo "$(date +%s) $*" >> "$OUT/calls"
  local args=(-p --model "$MODEL" --output-format json --no-session-persistence)
  if [ $# -eq 0 ]; then
    args+=(--tools "")
  else
    args+=(--allowedTools "$@")
  fi
  with_timeout "${CLAUDE_TIMEOUT:-300}" "$prompt_file" "$REAL_CLAUDE" "${args[@]}"
}

# The `.result` text of a claude_call envelope, or "" when the call failed.
claude_result() { jq -r '.result // ""' 2>/dev/null; }

# free_port — a port nothing listens on, for a throwaway `mesa serve`.
free_port() {
  local p
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    p=$((20000 + RANDOM % 20000))
    if ! lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then echo "$p"; return; fi
  done
  echo "$p"
}

# serve_start <port> — starts `mesa serve` on the baseline's MESA_DB and waits
# until it answers. Sets SERVE_PID; the caller's trap must kill it.
serve_start() {
  local port=$1
  "$MESA_BIN" serve --port "$port" >"$BDIR/serve.log" 2>&1 &
  SERVE_PID=$!
  for _ in $(seq 1 50); do
    # Our own process must be the one answering: four baselines start at
    # once, and a serve that lost the port to a sibling would otherwise pass
    # this check on the sibling's server and write its turns into the wrong db.
    kill -0 "$SERVE_PID" 2>/dev/null || { echo "serve on :$port died: $(cat "$BDIR/serve.log")" >&2; return 1; }
    curl -s "http://127.0.0.1:$port/api/version" >/dev/null 2>&1 && return 0
    sleep 0.2
  done
  echo "serve on :$port never answered" >&2
  return 1
}

# utter <port> <text> — one `user` turn on the live session, over the route
# the page uses (there is no CLI verb for the person's side).
utter() {
  local port=$1 text=$2
  curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
    "http://127.0.0.1:$port/api/live/utterance" \
    -d "$(jq -n --arg t "$text" '{text: $t}')"
}

# write_stub_claude <dir> — the `claude` the live-agent template spawns: it
# records the prompt it was handed (its last argument, the one this branch's
# `live start` injects) and prints a --bg receipt; `stop` is a no-op.
write_stub_claude() {
  local dir=$1
  mkdir -p "$dir"
  cat > "$dir/claude" <<EOF
#!/usr/bin/env bash
case "\$1" in
  --bg)
    PROMPT=""
    for a in "\$@"; do PROMPT=\$a; done
    printf '%s' "\$PROMPT" > "$dir/last-prompt"
    echo "backgrounded · deadbeef (idle — send a prompt to start)"
    ;;
  stop) exit 0 ;;
  agents) echo '[]' ;;
  *) exit 0 ;;
esac
EOF
  chmod +x "$dir/claude"
}

# write_config <path> <stub-dir> <summary-mode> — the per-baseline
# ~/.mesa/config.json (reached through MESA_CONFIG_FILE, so the developer's own
# is never read or written). live-agent is the stub above; live-summary is:
#   none  — a no-op, no summary is ever written;
#   old   — main's SUMMARY_PROMPT (last5-summary-prompt.txt), run synchronously
#           by the real `claude -p`, no notebook verbs allowed;
#   new   — this branch's own prompt ({prompt}), notebook verbs allowed.
write_config() {
  local path=$1 stub=$2 mode=$3
  local summary
  case "$mode" in
    none) summary="true" ;;
    old) summary="PROMPT=\"\$(cat '$EVAL_DIR/last5-summary-prompt.txt')

You are summarising mesa live session {id}.\"
printf '%s' \"\$PROMPT\" | '$REAL_CLAUDE' -p --model '$MODEL' --output-format json --no-session-persistence --allowedTools 'Bash(mesa live turns:*)' 'Bash(mesa live summary set:*)' > '$BDIR/last-summary-call.json'" ;;
    new) summary="printf '%s' {prompt} | '$REAL_CLAUDE' -p --model '$MODEL' --output-format json --no-session-persistence --allowedTools 'Bash(mesa live turns:*)' 'Bash(mesa live summary set:*)' 'Bash(mesa live memory search:*)' 'Bash(mesa live memory add:*)' > '$BDIR/last-summary-call.json'" ;;
  esac
  jq -n --arg agent "'$stub/claude' --bg --agent mesa-live --name {name} -- {prompt}" \
        --arg summary "$summary" \
        '{commands: {"live-agent": $agent, "live-summary": $summary}}' > "$path"
}

# json_escape_file <file> — the file's text as one JSON string.
json_string_of() { jq -Rs . "$1"; }
