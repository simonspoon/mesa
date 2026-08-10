#!/usr/bin/env bash
# Scripts gate (mesa task 785): exercises user-authored shell scripts end to
# end — create -> list -> show (by id and by name) -> update -> run -> delete —
# over both the CLI (`mesa script ...`) and the API (`/api/scripts...`),
# against a throwaway MESA_DB and a throwaway HOME.
#
# The load-bearing assertions, beyond CRUD shape:
#   * a run's nonzero exit is DATA: the CLI exits 0 carrying `exit_code`;
#   * no argument value is ever interpolated into a string a shell parses — a
#     `; rm -rf ... #` value is echoed literally and creates nothing;
#   * a declared argument with no value this call is genuinely UNSET on the
#     child (`${MESA_ARG_X-UNSET}` under `set -u`), never empty;
#   * output over 64 KiB is truncated with the `[truncated]` marker;
#   * cwd is resolved server-side: a project-bound script runs in that
#     project's `local_path`, an unbound one in `$HOME`, and a bound project
#     with no `local_path` is 422 validation;
#   * the read/write asymmetry — reads and run behind `require_agent_access`,
#     authoring loopback-only — holds in BOTH `serve` and `serve --lan`.
set -euo pipefail

cd "$(dirname "$0")/.."
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

cargo build --quiet
MESA=target/debug/mesa

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"; [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null; [ -n "${LAN_PID:-}" ] && kill "$LAN_PID" 2>/dev/null; true' EXIT
export MESA_DB="$TMP/mesa.db"

# A throwaway HOME: the unbound-script cwd rule points at it, and nothing here
# should touch the real ~/.mesa.
mkdir -p "$TMP/home"
export HOME="$TMP/home"
HOME_REAL=$(cd "$TMP/home" && pwd -P)

CHECKS=0
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { CHECKS=$((CHECKS + 1)); echo "ok: $*"; }

# run <expected-exit> <cmd...> — captures STDOUT, STDERR, CODE.
run() {
  local expected=$1; shift
  set +e
  STDOUT=$("$@" 2>"$TMP/stderr")
  CODE=$?
  set -e
  STDERR=$(cat "$TMP/stderr")
  [ "$CODE" -eq "$expected" ] ||
    fail "expected exit $expected, got $CODE: $* (stdout: $STDOUT) (stderr: $STDERR)"
}

jqs() { jq -r "$1" <<<"$STDOUT"; }
jqe() { jq -r "$1" <<<"$STDERR"; }

# ---- fixtures: a project with a local_path, and one without ----

mkdir -p "$TMP/workdir"
WORKDIR=$(cd "$TMP/workdir" && pwd -P)

run 0 "$MESA" project create "Scripts project" --no-git
P=$(jqs .id)
run 0 "$MESA" project update "$P" --path "$WORKDIR"
[ "$(jqs .local_path)" = "$WORKDIR" ] || fail "fixture: project local_path"

run 0 "$MESA" project create "Pathless project" --no-git
PNOPATH=$(jqs .id)
[ "$(jqs .local_path)" = "null" ] || fail "fixture: pathless project must have no local_path"

run 0 "$MESA" project create "Pathless project 2" --no-git
PNOPATH2=$(jqs .id)

# ================= CLI =================

# ---- create ----

# positional NAME + positional BODY
run 0 "$MESA" script create hello 'echo hi'
[ "$(jqs .name)" = "hello" ] || fail "CLI create: name"
[ "$(jqs .body)" = "echo hi" ] || fail "CLI create: body verbatim"
[ "$(jqs .project_id)" = "null" ] || fail "CLI create: unbound by default"
[ "$(jqs .description)" = "null" ] || fail "CLI create: description null by default"
[ "$(jqs '.args | length')" = "0" ] || fail "CLI create: args default to []"
[ "$(jqs .created_at)" != "null" ] || fail "CLI create: created_at"
[ "$(jqs .updated_at)" != "null" ] || fail "CLI create: updated_at"
S_HELLO=$(jqs .id)
ok "CLI script create: positional NAME + BODY returns the full record"

# flag form: --name/--body-file, bound to a project by NAME, with typed args
printf 'printf "%%s|%%s" "$1" "$MESA_ARG_COUNT"\n' > "$TMP/body.sh"
run 0 "$MESA" script create --name greet --body-file "$TMP/body.sh" \
  --project "Scripts project" --description "greets a target" \
  --arg 'target:text:required' --arg 'count:number=1'
[ "$(jqs .name)" = "greet" ] || fail "CLI create flag form: name"
[ "$(jqs .project_id)" = "$P" ] || fail "CLI create: --project resolves a project NAME"
[ "$(jqs .description)" = "greets a target" ] || fail "CLI create: description"
[ "$(jqs '.args | length')" = "2" ] || fail "CLI create: two declared args"
[ "$(jqs '.args[0].name')" = "target" ] || fail "CLI create: arg name"
[ "$(jqs '.args[0].kind')" = "text" ] || fail "CLI create: arg kind"
[ "$(jqs '.args[0].required')" = "true" ] || fail "CLI create: arg required"
[ "$(jqs '.args[1].kind')" = "number" ] || fail "CLI create: number kind"
[ "$(jqs '.args[1].required')" = "false" ] || fail "CLI create: optional arg"
[ "$(jqs '.args[1].default')" = "1" ] || fail "CLI create: arg default"
[ "$(jqs .body)" = "$(cat "$TMP/body.sh")" ] || fail "CLI create: --body-file body verbatim"
S_GREET=$(jqs .id)
ok "CLI script create: --name/--body-file/--project NAME/--description/--arg (typed, required, default)"

# --arg-json carries the full ScriptArg shape, choices included
run 0 "$MESA" script create picker 'printf "%s" "$MESA_ARG_MODE"' \
  --arg-json '{"name":"mode","label":"Mode","kind":"choice","required":true,"default":null,"choices":["fast","slow"]}'
[ "$(jqs '.args[0].kind')" = "choice" ] || fail "CLI create --arg-json: kind"
[ "$(jqs '.args[0].label')" = "Mode" ] || fail "CLI create --arg-json: label"
[ "$(jqs '.args[0].choices | join(",")')" = "fast,slow" ] || fail "CLI create --arg-json: choices"
S_PICKER=$(jqs .id)
ok "CLI script create --arg-json: full ScriptArg shape incl. choices"

# both positional and flag for the same required arg is a usage error
run 2 "$MESA" script create dup 'echo x' --name dup
[ "$(jqe .error.code)" = "usage" ] || fail "CLI create positional+flag: code=usage"
ok "CLI script create NAME positionally AND as --name: exit 2, code=usage"

# neither form is a usage error too
run 2 "$MESA" script create
ok "CLI script create with no NAME/BODY: exit 2 usage"

# --arg and --arg-json conflict
run 2 "$MESA" script create conflicting 'echo x' --arg 'a:text' --arg-json '{"name":"b","kind":"text","required":false}'
[ "$(jqe .error.code)" = "usage" ] || fail "CLI create --arg + --arg-json: code=usage"
ok "CLI script create: --arg and --arg-json conflict, exit 2 usage"

# ---- create: domain errors ----

run 1 "$MESA" script create empty-body '   '
[ "$(jqe .error.code)" = "validation" ] || fail "CLI create empty body: error.code"
ok "CLI script create with a blank body: exit 1, code=validation"

run 1 "$MESA" script create '   ' 'echo x'
[ "$(jqe .error.code)" = "validation" ] || fail "CLI create blank name: error.code"
ok "CLI script create with a blank name: exit 1, code=validation"

run 1 "$MESA" script create hello 'echo other'
[ "$(jqe .error.code)" = "conflict" ] || fail "CLI create duplicate name: error.code"
ok "CLI script create with a duplicate name: exit 1, code=conflict"

run 1 "$MESA" script create badarg 'echo x' --arg 'bad name:text'
[ "$(jqe .error.code)" = "validation" ] || fail "CLI create bad arg name: error.code"
ok "CLI script create with an invalid arg name: exit 1, code=validation"

run 1 "$MESA" script create dupargs 'echo x' --arg 'a:text' --arg 'a:text'
[ "$(jqe .error.code)" = "validation" ] || fail "CLI create duplicate arg names: error.code"
ok "CLI script create with duplicate arg names: exit 1, code=validation"

run 1 "$MESA" script create nochoices 'echo x' \
  --arg-json '{"name":"m","kind":"choice","required":true,"choices":[]}'
[ "$(jqe .error.code)" = "validation" ] || fail "CLI create choice without choices: error.code"
ok "CLI script create with kind=choice and empty choices: exit 1, code=validation"

run 1 "$MESA" script create textchoices 'echo x' \
  --arg-json '{"name":"m","kind":"text","required":false,"choices":["a"]}'
[ "$(jqe .error.code)" = "validation" ] || fail "CLI create non-choice with choices: error.code"
ok "CLI script create with choices on a non-choice kind: exit 1, code=validation"

run 1 "$MESA" script create orphan 'echo x' --project 999999
[ "$(jqe .error.code)" != "null" ] || fail "CLI create unknown project: error payload"
ok "CLI script create with an unknown project: exit 1 with an error payload"

# ---- list ----

run 0 "$MESA" script list
[ "$(jqs type)" = "array" ] || fail "CLI list: bare array"
[ "$(jqs length)" = "3" ] || fail "CLI list: expected 3 scripts, got $STDOUT"
[ "$(jqs 'map(.name) | join(",")')" = "greet,hello,picker" ] ||
  fail "CLI list: ordered by name COLLATE NOCASE, got $STDOUT"
ok "CLI script list: bare JSON array ordered by name"

run 0 "$MESA" script list "$P"
[ "$(jqs length)" = "1" ] || fail "CLI list scoped: expected 1"
[ "$(jqs '.[0].name')" = "greet" ] || fail "CLI list scoped: wrong script"
ok "CLI script list <PROJECT>: scoped by project id"

run 0 "$MESA" script list --project "Scripts project"
[ "$(jqs length)" = "1" ] || fail "CLI list --project NAME: expected 1"
ok "CLI script list --project NAME: a project argument takes an id or a name"

# ---- show / get ----

run 0 "$MESA" script show "$S_HELLO"
[ "$(jqs .id)" = "$S_HELLO" ] || fail "CLI show by id"
[ "$(jqs .body)" = "echo hi" ] || fail "CLI show: full record includes body"
ok "CLI script show <ID>: full record"

run 0 "$MESA" script show hello
[ "$(jqs .id)" = "$S_HELLO" ] || fail "CLI show by name"
ok "CLI script show <NAME>: resolves by name"

run 0 "$MESA" script show HELLO
[ "$(jqs .id)" = "$S_HELLO" ] || fail "CLI show by name: case-insensitive"
ok "CLI script show <NAME>: case-insensitive exact match"

run 0 "$MESA" script get "$S_HELLO"
[ "$(jqs .id)" = "$S_HELLO" ] || fail "CLI get alias"
ok "CLI script get: alias for show"

run 1 "$MESA" script show 999999
[ "$(jqe .error.code)" = "not_found" ] || fail "CLI show unknown id: error.code"
ok "CLI script show unknown id: exit 1, code=not_found"

run 1 "$MESA" script show no-such-script
[ "$(jqe .error.code)" = "not_found" ] || fail "CLI show unknown name: error.code"
ok "CLI script show unknown name: exit 1, code=not_found"

# ---- update ----

run 0 "$MESA" script update "$S_HELLO" --description "says hi"
[ "$(jqs .description)" = "says hi" ] || fail "CLI update: description"
[ "$(jqs .body)" = "echo hi" ] || fail "CLI update: untouched fields preserved"
ok "CLI script update --description: patches one field, leaves the rest"

run 0 "$MESA" script update hello --body 'echo hello there'
[ "$(jqs .body)" = "echo hello there" ] || fail "CLI update by name: body"
ok "CLI script update <NAME> --body: resolves by name"

run 0 "$MESA" script update "$S_HELLO" --name hello-again
[ "$(jqs .name)" = "hello-again" ] || fail "CLI update: name"
ok "CLI script update --name: renames"

run 1 "$MESA" script update "$S_HELLO" --name greet
[ "$(jqe .error.code)" = "conflict" ] || fail "CLI update to a taken name: error.code"
ok "CLI script update to an already-taken name: exit 1, code=conflict"

run 1 "$MESA" script update "$S_HELLO" --body '  '
[ "$(jqe .error.code)" = "validation" ] || fail "CLI update blank body: error.code"
ok "CLI script update with a blank body: exit 1, code=validation"

run 2 "$MESA" script update "$S_HELLO"
[ "$(jqe .error.code)" = "usage" ] || fail "CLI update with no field flag: code=usage"
[ -z "$STDOUT" ] || fail "CLI update usage error: stdout must be empty"
ok "CLI script update with no field flag: exit 2, code=usage, empty stdout"

run 1 "$MESA" script update 999999 --description x
[ "$(jqe .error.code)" = "not_found" ] || fail "CLI update unknown id: error.code"
ok "CLI script update unknown id: exit 1, code=not_found"

# ---- run ----

run 0 "$MESA" script run greet --set target=world --set count=7
[ "$(jqs .script_id)" = "$S_GREET" ] || fail "CLI run: script_id"
[ "$(jqs .exit_code)" = "0" ] || fail "CLI run: exit_code"
[ "$(jqs .stdout)" = "world|7" ] || fail "CLI run: values arrive positionally AND as MESA_ARG_*: $STDOUT"
[ "$(jqs .stderr)" = "" ] || fail "CLI run: stderr empty"
[ "$(jqs .truncated)" = "false" ] || fail "CLI run: truncated false"
ok "CLI script run --set: values arrive positionally (\$1) and as MESA_ARG_<NAME>"

# a default fills in for an absent optional argument
run 0 "$MESA" script run greet --set target=solo
[ "$(jqs .stdout)" = "solo|1" ] || fail "CLI run: default not applied: $STDOUT"
ok "CLI script run: a declared default fills in for an absent optional argument"

run 0 "$MESA" script run "$S_PICKER" --set mode=slow
[ "$(jqs .stdout)" = "slow" ] || fail "CLI run choice: $STDOUT"
ok "CLI script run: a valid choice value is accepted"

# ---- run: validation errors (all exit 1, nothing executed) ----

run 1 "$MESA" script run greet
[ "$(jqe .error.code)" = "validation" ] || fail "CLI run missing required arg: error.code"
ok "CLI script run with a missing required argument: exit 1, code=validation"

run 1 "$MESA" script run greet --set target=x --set nope=1
[ "$(jqe .error.code)" = "validation" ] || fail "CLI run undeclared key: error.code"
ok "CLI script run with an undeclared --set key: exit 1, code=validation"

run 1 "$MESA" script run greet --set target=x --set count=twelve
[ "$(jqe .error.code)" = "validation" ] || fail "CLI run non-numeric number: error.code"
ok "CLI script run with a non-numeric value for a number arg: exit 1, code=validation"

run 1 "$MESA" script run "$S_PICKER" --set mode=sideways
[ "$(jqe .error.code)" = "validation" ] || fail "CLI run bad choice: error.code"
ok "CLI script run with a value outside a choice list: exit 1, code=validation"

run 1 "$MESA" script run 999999
[ "$(jqe .error.code)" = "not_found" ] || fail "CLI run unknown id: error.code"
ok "CLI script run unknown id: exit 1, code=not_found"

# ---- run: a nonzero exit is DATA, not a failure ----

run 0 "$MESA" script create failer 'echo out; echo err >&2; exit 3'
S_FAIL=$(jqs .id)
run 0 "$MESA" script run failer
[ "$(jqs .exit_code)" = "3" ] || fail "CLI run failing script: exit_code must be 3, got $STDOUT"
[ "$(jqs .stdout)" = "out" ] || fail "CLI run failing script: stdout captured separately"
[ "$(jqs .stderr)" = "err" ] || fail "CLI run failing script: stderr captured separately"
ok "CLI script run of a script exiting 3: CLI exit 0, exit_code: 3 in the payload, streams separated"

# ---- run: output truncation at 64 KiB ----

run 0 "$MESA" script create chatty "head -c $((64 * 1024 + 2048)) /dev/zero | tr '\\0' 'x'"
run 0 "$MESA" script run chatty
[ "$(jqs .truncated)" = "true" ] || fail "CLI run oversized stdout: truncated must be true"
[ "$(jqs '.stdout | endswith("\n[truncated]")')" = "true" ] ||
  fail "CLI run oversized stdout: missing the [truncated] marker"
[ "$(jqs '.stdout | length')" -le $((64 * 1024 + 12)) ] ||
  fail "CLI run oversized stdout: not capped at 64 KiB"
ok "CLI script run: stdout over 64 KiB is truncated with the [truncated] marker and truncated: true"

# ---- INJECTION PROOF: a value is data, never shell syntax ----

PWNED="$TMP/pwned"
run 0 "$MESA" script create echoer 'printf "%s" "$1"' --arg 'target:text:required'
run 0 "$MESA" script run echoer --set "target=; touch $PWNED #"
[ "$(jqs .stdout)" = "; touch $PWNED #" ] ||
  fail "INJECTION: value must be echoed literally, got: $STDOUT"
[ -e "$PWNED" ] && fail "INJECTION: the value was executed — $PWNED was created"
ok "INJECTION PROOF: a '; touch … #' value is echoed literally and creates nothing"

# the same value through the environment, and through backticks/\$( )
run 0 "$MESA" script create envechoer 'printf "%s" "$MESA_ARG_TARGET"' --arg 'target:text:required'
run 0 "$MESA" script run envechoer --set 'target=$(touch '"$PWNED"') `touch '"$PWNED"'`'
[ "$(jqs .stdout)" = '$(touch '"$PWNED"') `touch '"$PWNED"'`' ] ||
  fail "INJECTION: env value must be literal, got: $STDOUT"
[ -e "$PWNED" ] && fail "INJECTION: a command substitution in a value ran"
ok "INJECTION PROOF: \$( ) and backticks in a value reach MESA_ARG_* literally, unexpanded"

# a value that would break out of the --arg spec parser is still just a value
run 0 "$MESA" script run echoer --set 'target=a:b=c:required'
[ "$(jqs .stdout)" = "a:b=c:required" ] || fail "INJECTION: --set value with : and = mangled: $STDOUT"
ok "CLI script run --set: only the FIRST = splits NAME=VALUE; the value keeps its : and ="

# ---- UNSET, not empty: the env_remove sweep ----

run 0 "$MESA" script create unsetter 'set -u; printf "%s" "${MESA_ARG_NOTE-UNSET}"' --arg 'note:text'
# Poison mesa's own environment: "not supplied" must not read a stale value.
export MESA_ARG_NOTE=stale
run 0 "$MESA" script run unsetter
[ "$(jqs .stdout)" = "UNSET" ] ||
  fail "UNSET: an unsupplied declared arg must be unset, not empty/stale, got: $STDOUT"
[ "$(jqs .exit_code)" = "0" ] || fail "UNSET: the body must have run under set -u"
run 0 "$MESA" script run unsetter --set note=given
[ "$(jqs .stdout)" = "given" ] || fail "UNSET: a supplied value must arrive: $STDOUT"
unset MESA_ARG_NOTE
ok "an unsupplied declared argument leaves MESA_ARG_<NAME> genuinely UNSET (not empty, not stale) under set -u"

# set -u itself fires on the unset variable when the body does not default it
run 0 "$MESA" script create strict 'set -u; printf "%s" "$MESA_ARG_NOTE"' --arg 'note:text'
run 0 "$MESA" script run strict
[ "$(jqs .exit_code)" != "0" ] || fail "set -u must fire on a genuinely unset variable"
[ "$(jqs '.stderr | test("unbound variable")')" = "true" ] ||
  fail "set -u diagnostic expected on stderr, got: $STDOUT"
ok "set -u fires (\"unbound variable\") for an unsupplied argument — proof the variable is absent, not empty"

# ---- cwd ----

run 0 "$MESA" script create wherebound 'pwd -P' --project "$P"
run 0 "$MESA" script run wherebound
[ "$(jqs '.stdout | rtrimstr("\n")')" = "$WORKDIR" ] ||
  fail "cwd: a project-bound script must run in the project's local_path, got: $STDOUT"
ok "CLI script run: a project-bound script runs in that project's local_path"

run 0 "$MESA" script create whereunbound 'pwd -P'
run 0 "$MESA" script run whereunbound
[ "$(jqs '.stdout | rtrimstr("\n")')" = "$HOME_REAL" ] ||
  fail "cwd: an unbound script must run in \$HOME, got: $STDOUT"
ok "CLI script run: an unbound script runs in \$HOME"

run 0 "$MESA" script create wherepathless 'pwd -P' --project "$PNOPATH"
S_NOPATH=$(jqs .id)

# ---- --quiet: accepted on create/update/show/delete only ----

# The quiet shape is the record minus exactly `body` and `description`.
quiet_parity() { # quiet_parity <label> <full-json> <quiet-json>
  local label=$1 full=$2 quiet=$3
  local dropped
  dropped=$(jq -r --argjson q "$quiet" \
    '[keys_unsorted[] as $k | select($q | has($k) | not) | $k] | sort | join(",")' <<<"$full")
  [ "$dropped" = "body,description" ] ||
    fail "$label: --quiet must drop exactly body,description — dropped: [$dropped]"
  [ "$(jq -S 'del(.body, .description)' <<<"$full")" = "$(jq -S . <<<"$quiet")" ] ||
    fail "$label: --quiet changed a value, not just the key set"
}

run 0 "$MESA" script show "$S_GREET"
FULL=$STDOUT
run 0 "$MESA" script show "$S_GREET" --quiet
quiet_parity "script show" "$FULL" "$STDOUT"
ok "--quiet on script show: drops exactly body+description, every other key and value identical"

run 0 "$MESA" script create quiettest 'echo q' --description "d" --quiet
QUIET=$STDOUT
QID=$(jq -r .id <<<"$QUIET")
run 0 "$MESA" script show "$QID"
quiet_parity "script create" "$STDOUT" "$QUIET"
[ "$(jqs .body)" = "echo q" ] || fail "quiet create: the record was still stored in full"
ok "--quiet on script create: prints the record minus body+description, storing it in full"

run 0 "$MESA" script update "$QID" --description "d2"
FULL=$STDOUT
run 0 "$MESA" script update "$QID" --description "d3" --quiet
QUIET=$STDOUT
run 0 "$MESA" script show "$QID"
quiet_parity "script update" "$STDOUT" "$QUIET"
ok "--quiet on script update: drops exactly body+description"

run 0 "$MESA" script show "$QID"
FULL=$STDOUT
run 0 "$MESA" script delete "$QID" --quiet
quiet_parity "script delete" "$FULL" "$STDOUT"
run 1 "$MESA" script show "$QID"
[ "$(jqe .error.code)" = "not_found" ] || fail "quiet delete: the record is actually gone"
ok "--quiet on script delete: drops exactly body+description and the record is gone"

# quiet output is JSON with the same keys — never byte-identical ordering games
run 2 "$MESA" script list --quiet
[ "$(jqe .error.code)" = "usage" ] || fail "--quiet on list: code=usage"
ok "--quiet on script list: rejected as an unknown argument, exit 2 usage"

run 2 "$MESA" script run echoer --set target=x --quiet
[ "$(jqe .error.code)" = "usage" ] || fail "--quiet on run: code=usage"
ok "--quiet on script run: rejected as an unknown argument, exit 2 usage"

# ---- delete echoes the full destroyed record (the safety floor) ----

run 0 "$MESA" script show "$S_FAIL"
FULL=$STDOUT
run 0 "$MESA" script delete "$S_FAIL"
[ "$(jq -S . <<<"$STDOUT")" = "$(jq -S . <<<"$FULL")" ] ||
  fail "CLI delete: must echo the full destroyed record verbatim"
ok "CLI script delete: echoes the full destroyed record (recovery transcript)"

run 0 "$MESA" script delete strict
[ "$(jqs .name)" = "strict" ] || fail "CLI delete by name"
ok "CLI script delete <NAME>: resolves by name"

run 1 "$MESA" script delete 999999
[ "$(jqe .error.code)" = "not_found" ] || fail "CLI delete unknown id: error.code"
ok "CLI script delete unknown id: exit 1, code=not_found"

# ---- project delete SETs NULL, it does not cascade ----

run 0 "$MESA" project delete "$PNOPATH"
run 0 "$MESA" script show "$S_NOPATH"
[ "$(jqs .project_id)" = "null" ] ||
  fail "project delete must SET NULL on a bound script, not destroy it: $STDOUT"
ok "deleting a project unbinds its scripts (ON DELETE SET NULL) instead of destroying them"

# ================= API =================

PORT=17789
"$MESA" serve --port "$PORT" >"$TMP/serve.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$PORT/api/projects" >/dev/null 2>&1 && break
  sleep 0.1
done
curl -sf "http://127.0.0.1:$PORT/api/projects" >/dev/null ||
  fail "server did not start (log: $(cat "$TMP/serve.log"))"

api() { # api <expected-status> <method> <path> [json-body]
  local expected=$1 method=$2 path=$3 body=${4:-}
  local args=(-s -o "$TMP/body" -w '%{http_code}' -X "$method")
  case "$method" in
    POST | PUT | PATCH | DELETE)
      args+=(-H 'Content-Type: application/json' -d "${body:-{\}}")
      ;;
  esac
  STATUS=$(curl "${args[@]}" "http://127.0.0.1:$PORT$path")
  BODY=$(cat "$TMP/body")
  [ "$STATUS" = "$expected" ] ||
    fail "expected HTTP $expected, got $STATUS: $method $path ($BODY)"
}
jqb() { jq -r "$1" <<<"$BODY"; }

# ---- create ----

api 201 POST /api/scripts \
  "{\"project_id\":$P,\"name\":\"api-greet\",\"description\":\"from the api\",\"body\":\"printf '%s' \\\"\$MESA_ARG_WHO\\\"\",\"args\":[{\"name\":\"who\",\"label\":null,\"kind\":\"text\",\"required\":true,\"default\":null,\"choices\":null}]}"
[ "$(jqb .name)" = "api-greet" ] || fail "API create: name"
[ "$(jqb .project_id)" = "$P" ] || fail "API create: project_id"
[ "$(jqb '.args[0].kind')" = "text" ] || fail "API create: args round-trip"
AS=$(jqb .id)
ok "POST /api/scripts: 201 + the full Script JSON"

api 422 POST /api/scripts '{"name":"api-blank","body":"   "}'
[ "$(jqb .error.code)" = "validation" ] || fail "API create blank body: error.code"
ok "POST /api/scripts with a blank body: 422 validation"

api 409 POST /api/scripts '{"name":"api-greet","body":"echo x"}'
[ "$(jqb .error.code)" = "conflict" ] || fail "API create duplicate name: error.code"
ok "POST /api/scripts with a duplicate name: 409 conflict"

api 422 POST /api/scripts '{"name":"api-badarg","body":"echo x","args":[{"name":"bad name","kind":"text","required":false}]}'
[ "$(jqb .error.code)" = "validation" ] || fail "API create bad arg name: error.code"
ok "POST /api/scripts with an invalid arg name: 422 validation"

api 422 POST /api/scripts '{"name":"api-malformed"}'
[ "$(jqb .error.code)" != "null" ] || fail "API create malformed body: error payload"
ok "POST /api/scripts with a malformed body (no body field): 422"

api 422 POST /api/scripts '{not json'
ok "POST /api/scripts with unparseable JSON: 422 (JsonRejection, never a 500)"

# the repo-wide Content-Type gate covers these routes with no carve-out
NO_CT=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  -d '{"name":"x","body":"echo x"}' "http://127.0.0.1:$PORT/api/scripts")
[ "$NO_CT" = "415" ] || fail "POST /api/scripts without Content-Type: expected 415, got $NO_CT"
NO_CT=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH \
  -d '{"name":"x"}' "http://127.0.0.1:$PORT/api/scripts/$AS")
[ "$NO_CT" = "415" ] || fail "PATCH /api/scripts/{id} without Content-Type: expected 415, got $NO_CT"
NO_CT=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "http://127.0.0.1:$PORT/api/scripts/999999")
[ "$NO_CT" = "415" ] || fail "DELETE /api/scripts/{id} without Content-Type: expected 415, got $NO_CT"
NO_CT=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/scripts/$AS/run")
[ "$NO_CT" = "415" ] || fail "POST /api/scripts/{id}/run without Content-Type: expected 415, got $NO_CT"
ok "every mutating /api/scripts route without a JSON Content-Type is 415 (no carve-out in the global guard)"

# ---- list ----

api 200 GET /api/scripts
[ "$(jqb type)" = "array" ] || fail "API list: bare array"
[ "$(jqb 'map(select(.name == "api-greet")) | length')" = "1" ] || fail "API list: new script present"
ok "GET /api/scripts: bare array"

api 200 GET "/api/scripts?project=$P"
[ "$(jqb 'all(.project_id == '"$P"')')" = "true" ] || fail "API list ?project: scoping"
[ "$(jqb 'map(select(.name == "api-greet")) | length')" = "1" ] || fail "API list ?project: missing script"
ok "GET /api/scripts?project=<id>: scoped to that project"

# ---- show ----

api 200 GET "/api/scripts/$AS"
[ "$(jqb .id)" = "$AS" ] || fail "API show: id"
[ "$(jqb .body)" != "null" ] || fail "API show: full record includes body"
ok "GET /api/scripts/{id}: full record"

api 404 GET /api/scripts/999999
[ "$(jqb .error.code)" = "not_found" ] || fail "API show unknown id: error.code"
ok "GET /api/scripts/{id} unknown id: 404 not_found"

# ---- update ----

api 200 PATCH "/api/scripts/$AS" '{"description":"patched"}'
[ "$(jqb .description)" = "patched" ] || fail "API patch: description"
[ "$(jqb .name)" = "api-greet" ] || fail "API patch: untouched fields preserved"
ok "PATCH /api/scripts/{id}: 200 + the updated record"

api 422 PATCH "/api/scripts/$AS" '{"body":"  "}'
[ "$(jqb .error.code)" = "validation" ] || fail "API patch blank body: error.code"
ok "PATCH /api/scripts/{id} with a blank body: 422 validation"

api 404 PATCH /api/scripts/999999 '{"description":"x"}'
[ "$(jqb .error.code)" = "not_found" ] || fail "API patch unknown id: error.code"
ok "PATCH /api/scripts/{id} unknown id: 404 not_found"

# ---- run ----

api 200 POST "/api/scripts/$AS/run" '{"values":{"who":"api"}}'
[ "$(jqb .script_id)" = "$AS" ] || fail "API run: script_id"
[ "$(jqb .exit_code)" = "0" ] || fail "API run: exit_code"
[ "$(jqb .stdout)" = "api" ] || fail "API run: stdout, got $BODY"
ok "POST /api/scripts/{id}/run: 200 + the ScriptRun payload"

api 422 POST "/api/scripts/$AS/run" '{"values":{}}'
[ "$(jqb .error.code)" = "validation" ] || fail "API run missing required: error.code"
ok "POST /api/scripts/{id}/run with a missing required value: 422 validation"

api 422 POST "/api/scripts/$AS/run" '{"values":{"who":"x","nope":"y"}}'
[ "$(jqb .error.code)" = "validation" ] || fail "API run undeclared key: error.code"
ok "POST /api/scripts/{id}/run with an undeclared value key: 422 validation"

api 422 POST "/api/scripts/$AS/run" '{"values":"not an object"}'
ok "POST /api/scripts/{id}/run with a malformed values map: 422"

api 404 POST /api/scripts/999999/run '{"values":{}}'
[ "$(jqb .error.code)" = "not_found" ] || fail "API run unknown id: error.code"
ok "POST /api/scripts/{id}/run unknown id: 404 not_found"

# a nonzero exit is data over HTTP too: 200 with exit_code
api 201 POST /api/scripts '{"name":"api-failer","body":"echo o; echo e >&2; exit 5"}'
AFAIL=$(jqb .id)
api 200 POST "/api/scripts/$AFAIL/run" '{"values":{}}'
[ "$(jqb .exit_code)" = "5" ] || fail "API run failing script: expected exit_code 5, got $BODY"
[ "$(jqb '.stdout | rtrimstr("\n")')" = "o" ] || fail "API run failing script: stdout, got $BODY"
[ "$(jqb '.stderr | rtrimstr("\n")')" = "e" ] || fail "API run failing script: stderr, got $BODY"
ok "POST /api/scripts/{id}/run of a script exiting 5: HTTP 200 with exit_code 5 — a nonzero exit is data"

# injection proof over HTTP as well
api 201 POST /api/scripts \
  "{\"name\":\"api-echoer\",\"body\":\"printf '%s' \\\"\$1\\\"\",\"args\":[{\"name\":\"target\",\"kind\":\"text\",\"required\":true}]}"
AECHO=$(jqb .id)
API_PWNED="$TMP/api-pwned"
api 200 POST "/api/scripts/$AECHO/run" \
  "{\"values\":{\"target\":\"; touch $API_PWNED #\"}}"
[ "$(jqb .stdout)" = "; touch $API_PWNED #" ] || fail "API INJECTION: value not literal: $BODY"
[ -e "$API_PWNED" ] && fail "API INJECTION: the value was executed"
ok "INJECTION PROOF over the API: a '; touch … #' value is echoed literally and creates nothing"

# ---- cwd, resolved server-side ----

api 201 POST /api/scripts "{\"project_id\":$P,\"name\":\"api-where\",\"body\":\"pwd -P\"}"
AWHERE=$(jqb .id)
api 200 POST "/api/scripts/$AWHERE/run" '{"values":{}}'
[ "$(jqb '.stdout | rtrimstr("\n")')" = "$WORKDIR" ] ||
  fail "API cwd: bound script must run in the project's local_path, got $BODY"
ok "POST /api/scripts/{id}/run: a project-bound script runs in that project's local_path (cwd never client-supplied)"

api 201 POST /api/scripts '{"name":"api-where-home","body":"pwd -P"}'
AHOME=$(jqb .id)
api 200 POST "/api/scripts/$AHOME/run" '{"values":{}}'
[ "$(jqb '.stdout | rtrimstr("\n")')" = "$HOME_REAL" ] ||
  fail "API cwd: an unbound script must run in \$HOME, got $BODY"
ok "POST /api/scripts/{id}/run: an unbound script runs in \$HOME"

api 200 GET "/api/projects/$PNOPATH2"
[ "$(jqb .local_path)" = "null" ] || fail "API cwd fixture: project must have no local_path"
api 201 POST /api/scripts "{\"project_id\":$PNOPATH2,\"name\":\"api-nopath\",\"body\":\"pwd -P\"}"
ANOPATH=$(jqb .id)
api 422 POST "/api/scripts/$ANOPATH/run" '{"values":{}}'
[ "$(jqb .error.code)" = "validation" ] || fail "API cwd: no local_path must be 422 validation, got $BODY"
ok "POST /api/scripts/{id}/run for a bound project with no local_path: 422 validation"

# ---- delete ----

api 200 DELETE "/api/scripts/$AFAIL"
[ "$(jqb .id)" = "$AFAIL" ] || fail "API delete: echoes the destroyed record"
[ "$(jqb .body)" != "null" ] || fail "API delete: the echo is the FULL record"
ok "DELETE /api/scripts/{id}: 200, echoes the full destroyed record"

api 404 GET "/api/scripts/$AFAIL"
[ "$(jqb .error.code)" = "not_found" ] || fail "API delete: script actually gone"
ok "DELETE /api/scripts/{id}: a subsequent GET is 404 not_found"

api 404 DELETE /api/scripts/999999
[ "$(jqb .error.code)" = "not_found" ] || fail "API delete unknown id: error.code"
ok "DELETE /api/scripts/{id} unknown id: 404 not_found"

# ================= gates: default mode =================
# A script body is a program mesa will execute, so reads/run sit behind
# require_agent_access while authoring is loopback-only in BOTH modes. Every
# curl below originates on this machine, so the server always sees a LOOPBACK
# peer — the genuinely remote-peer case cannot be forged here (it is pinned by
# the Rust unit tests); what IS reachable is the Host/Origin half of the same
# gate, which is what these assertions pin.

raw() { # raw <method> <path> [extra curl args...]
  local method=$1 path=$2; shift 2
  STATUS=$(curl -s -o "$TMP/body" -w '%{http_code}' -X "$method" "$@" \
    "http://127.0.0.1:$PORT$path")
  BODY=$(cat "$TMP/body")
}

raw GET /api/scripts -H "Host: 127.0.0.1:$PORT"
[ "$STATUS" = "200" ] || fail "default: GET /api/scripts from a local Host must be 200, got $STATUS"
raw GET /api/scripts -H "Host: localhost:$PORT"
[ "$STATUS" = "200" ] || fail "default: GET /api/scripts with Host localhost:<port> must be 200"
ok "default mode: GET /api/scripts from this machine's own page is allowed"

raw GET /api/scripts -H "Host: evil.example"
[ "$STATUS" = "403" ] || fail "default: GET /api/scripts with a foreign Host must be 403, got $STATUS"
raw GET /api/scripts -H "Host: evil.example:$PORT"
[ "$STATUS" = "403" ] || fail "default: GET /api/scripts, foreign Host on our port must be 403"
ok "default mode: GET /api/scripts with a foreign Host is 403 (DNS-rebinding defense)"

raw GET /api/scripts -H "Host: 127.0.0.1:$PORT" -H 'Origin: https://evil.example'
[ "$STATUS" = "403" ] || fail "default: GET /api/scripts with a foreign Origin must be 403, got $STATUS"
ok "default mode: GET /api/scripts with a foreign Origin is 403 (require_agent_access)"

raw GET "/api/scripts/$AS" -H "Host: evil.example"
[ "$STATUS" = "403" ] || fail "default: GET /api/scripts/{id} with a foreign Host must be 403"
raw POST "/api/scripts/$AS/run" -H "Host: evil.example" \
  -H 'Content-Type: application/json' -d '{"values":{"who":"x"}}'
[ "$STATUS" = "403" ] || fail "default: run with a foreign Host must be 403, got $STATUS"
ok "default mode: show and run carry the same gate as list"

raw POST /api/scripts -H "Host: evil.example" -H 'Content-Type: application/json' \
  -d '{"name":"gate-probe","body":"echo x"}'
[ "$STATUS" = "403" ] || fail "default: authoring POST with a foreign Host must be 403, got $STATUS"
raw PATCH "/api/scripts/$AS" -H "Host: evil.example" -H 'Content-Type: application/json' \
  -d '{"description":"gate probe"}'
[ "$STATUS" = "403" ] || fail "default: authoring PATCH with a foreign Host must be 403"
raw DELETE "/api/scripts/$AS" -H "Host: evil.example" -H 'Content-Type: application/json'
[ "$STATUS" = "403" ] || fail "default: authoring DELETE with a foreign Host must be 403"
api 200 GET "/api/scripts/$AS"
[ "$(jqb .description)" = "patched" ] || fail "default: a refused authoring request must write nothing"
ok "default mode: POST/PATCH/DELETE /api/scripts from a foreign Host are all 403, writing nothing"

kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=

# ================= gates: --lan mode =================
# `--lan` skips the GLOBAL Host allowlist (opt-in LAN trust) but the scripts
# routes keep their own, stronger gate — the exact pairing api-check.sh pins
# for the shared boundary.

LAN_PORT=17791
"$MESA" serve --lan --port "$LAN_PORT" >"$TMP/lan.log" 2>&1 &
LAN_PID=$!
for _ in $(seq 1 50); do
  curl -sf -H "Host: 127.0.0.1:$LAN_PORT" "http://127.0.0.1:$LAN_PORT/api/projects" >/dev/null 2>&1 && break
  sleep 0.1
done
curl -sf -H "Host: 127.0.0.1:$LAN_PORT" "http://127.0.0.1:$LAN_PORT/api/projects" >/dev/null ||
  fail "--lan server did not start (log: $(cat "$TMP/lan.log"))"

lan_req() { # lan_req <method> <path> <host> [origin] [json-body]
  local method=$1 path=$2 host=$3 origin=${4:-} body=${5:-}
  local args=(-s -o "$TMP/body" -w '%{http_code}' -X "$method" -H "Host: $host")
  [ -n "$origin" ] && args+=(-H "Origin: $origin")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' -d "$body")
  curl "${args[@]}" "http://127.0.0.1:$LAN_PORT$path"
}

# The contrast: an ordinary route takes any Host under --lan; a scripts route
# does not. If these two ever agree, the boundary has collapsed.
[ "$(lan_req GET /api/projects 'evil.example')" = "200" ] ||
  fail "--lan: an ordinary route must accept any Host (global check skipped)"
[ "$(lan_req GET /api/scripts 'evil.example')" = "403" ] ||
  fail "--lan: GET /api/scripts must reject a DNS-name Host (rebinding defense)"
[ "$(lan_req GET /api/scripts "evil.example:$LAN_PORT")" = "403" ] ||
  fail "--lan: GET /api/scripts must reject a DNS-name Host even on our port"
ok "--lan: the global Host allowlist is skipped, but /api/scripts keeps its own rebinding defense"

[ "$(lan_req GET /api/scripts "127.0.0.1:$LAN_PORT")" = "200" ] ||
  fail "--lan: GET /api/scripts must accept a local Host"
[ "$(lan_req GET /api/scripts "192.0.2.7:$LAN_PORT")" = "200" ] ||
  fail "--lan: GET /api/scripts must accept an IP-literal Host (remote browser by IP)"
[ "$(lan_req GET /api/scripts '192.0.2.7:999')" = "403" ] ||
  fail "--lan: GET /api/scripts must reject an IP Host on a foreign port"
[ "$(lan_req GET /api/scripts "192.0.2.7:$LAN_PORT" "http://192.0.2.7:$LAN_PORT")" = "200" ] ||
  fail "--lan: GET /api/scripts must accept an Origin matching the Host"
[ "$(lan_req GET /api/scripts "192.0.2.7:$LAN_PORT" 'https://evil.example')" = "403" ] ||
  fail "--lan: GET /api/scripts must reject a foreign Origin (cross-site defense)"
ok "--lan: reads follow require_agent_access — IP-literal Host on our port allowed, foreign Origin refused"

# The run route is a read-shaped gate by design: a LAN peer may TRIGGER a
# script but never choose the program.
[ "$(lan_req POST "/api/scripts/$AS/run" "192.0.2.7:$LAN_PORT" '' '{"values":{"who":"lan"}}')" = "200" ] ||
  fail "--lan: run must be reachable from a LAN-shaped request (require_agent_access)"
[ "$(lan_req POST "/api/scripts/$AS/run" 'evil.example' '' '{"values":{"who":"x"}}')" = "403" ] ||
  fail "--lan: run must reject a DNS-name Host"
[ "$(lan_req POST "/api/scripts/$AS/run" "192.0.2.7:$LAN_PORT" 'https://evil.example' '{"values":{"who":"x"}}')" = "403" ] ||
  fail "--lan: run must reject a foreign Origin"
ok "--lan: POST /api/scripts/{id}/run is reachable LAN-side (trigger allowed) but shut to rebinding and cross-site pages"

# Authoring — choosing the PROGRAM — stays loopback-only in this mode too.
[ "$(lan_req POST /api/scripts "evil.example:$LAN_PORT" '' '{"name":"lan-probe","body":"echo x"}')" = "403" ] ||
  fail "--lan: authoring POST must reject a DNS-name Host"
[ "$(lan_req POST /api/scripts "127.0.0.1:$LAN_PORT" 'https://evil.example' '{"name":"lan-probe","body":"echo x"}')" = "403" ] ||
  fail "--lan: authoring POST must reject a foreign Origin"
[ "$(lan_req PATCH "/api/scripts/$AS" "evil.example:$LAN_PORT" '' '{"description":"lan probe"}')" = "403" ] ||
  fail "--lan: authoring PATCH must reject a DNS-name Host"
[ "$(lan_req DELETE "/api/scripts/$AS" "evil.example:$LAN_PORT" '' '{}')" = "403" ] ||
  fail "--lan: authoring DELETE must reject a DNS-name Host"
[ "$(lan_req GET "/api/scripts/$AS" "127.0.0.1:$LAN_PORT")" = "200" ] ||
  fail "--lan: the script must survive every refused authoring request"
[ "$(jq -r .description < "$TMP/body")" = "patched" ] ||
  fail "--lan: a refused authoring request must write nothing"
ok "--lan: POST/PATCH/DELETE /api/scripts are refused for a rebinding or cross-site page, writing nothing"

[ "$(lan_req POST /api/scripts "127.0.0.1:$LAN_PORT" '' '{"name":"lan-authored","body":"echo x"}')" = "201" ] ||
  fail "--lan: authoring from this machine's own page must still work"
ok "--lan: authoring from a loopback peer with a local Host still works (the flag never locks the owner out)"

# The Content-Type gate does not relax under --lan.
LAN_NO_CT=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Host: 127.0.0.1:$LAN_PORT" \
  -d 'name=x&body=echo+x' "http://127.0.0.1:$LAN_PORT/api/scripts")
[ "$LAN_NO_CT" = "415" ] ||
  fail "--lan: a form-encoded POST /api/scripts must still be 415, got $LAN_NO_CT"
LAN_NO_CT=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Host: 127.0.0.1:$LAN_PORT" \
  "http://127.0.0.1:$LAN_PORT/api/scripts/$AS/run")
[ "$LAN_NO_CT" = "415" ] ||
  fail "--lan: run with no Content-Type must still be 415, got $LAN_NO_CT"
ok "--lan: the Content-Type gate still fires on /api/scripts (the two halves never drift apart)"

echo "all $CHECKS checks passed"
