# Helpers for the scenario tests. Source it:  . "$(dirname "$0")/lib.sh"
#
# Rules the tests keep:
#   - They never touch the real WorkShop folder. Each test works in its own temp folder: a copy of the
#     built app next to a copy of the stub hub (macapp/stub).
#   - The app under test is built with the bundle id local.workshop.app.test, so its preferences and web
#     data are not those of the real app. tests/cleanup_state.sh removes them.
#   - Every launch is Finder-like: `env -i` with PATH=/usr/bin:/bin:/usr/sbin:/sbin, then `open -g`
#     (in the background). `open` alone forwards the caller's whole environment, Finder does not.
#   - The app runs in self-test mode (WORKSHOP_SELFTEST_DIR): browser, Finder and notifications are
#     recorded, not opened. Dialogs are answered by the launcher.
#   - Quit from a script with a signal, never with AppleScript (that would raise an Automation prompt).
#
# WS_TMP_ROOT overrides where the temp folders go (default: the per-user temp directory).

TESTS="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
MACAPP="$(dirname "$TESTS")"
TEST_ID="local.workshop.app.test"
WS_TMP_ROOT="${WS_TMP_ROOT:-$(getconf DARWIN_USER_TEMP_DIR)workshop-tests}"
APP_SRC="$WS_TMP_ROOT/app-under-test/WorkShop.app"
RESULTS="$WS_TMP_ROOT/results"
LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
TEST_NAME="$(basename "${0%.sh}")"
PASSED=0
FAILED=0
ALL_BASES=()
SLOW="${WS_SLOW:-1}"            # multiply every wait (a busy Mac needs more)
# The stub's test children run "sleep 6000.731", "sleep 6001.731", "sleep 6002.731": unique on this Mac,
# so another program's "sleep 600" never counts as a leftover and is never killed by a test.
KID_RX='sleep 600[0-2][.]731'

find_node() {
  if command -v node >/dev/null 2>&1; then command -v node; return; fi
  local c
  for c in $(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V -r) "$HOME/.volta/bin/node" /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -x "$c" ] && { echo "$c"; return; }
  done
  return 1
}

ensure_app() {    # builds the app under test once (build.sh skips when nothing changed)
  mkdir -p "$WS_TMP_ROOT" "$RESULTS"
  WORKSHOP_BUNDLE_ID="$TEST_ID" "$MACAPP/build.sh" "$WS_TMP_ROOT/app-under-test" > "$RESULTS/build.txt" 2>&1 || { echo "build failed, see $RESULTS/build.txt"; exit 1; }
}

APP_READY=""
new_base() {      # new_base <name> [nostub]   sets BASE APP BIN ST LOG REQ SLOG
  [ -n "$APP_READY" ] || { ensure_app; APP_READY=1; }      # once per script; build.sh skips when nothing changed
  BASE="$WS_TMP_ROOT/$1"; ALL_BASES+=("$BASE")
  [ -d "$BASE/WorkShop.app" ] && "$LSREG" -u "$BASE/WorkShop.app" 2>/dev/null
  rm -rf "$BASE"; mkdir -p "$BASE"
  cp -R "$APP_SRC" "$BASE/WorkShop.app"
  [ "${2:-}" = nostub ] || add_stub
  APP="$BASE/WorkShop.app"; BIN="$APP/Contents/MacOS/WorkShop"
  BIN_RX="$(path_rx "$BIN")"; SRV_RX="$(path_rx "$BASE/server/index.js")"
  LOG="$BASE/data/logs/launcher.log"; REQ="$BASE/data/logs/stub-requests.log"
  new_selftest_dir selftest
}
# A pgrep pattern for a path. Non-ASCII letters become ".+": LaunchServices hands the app a decomposed
# (NFD) path, a shell types the composed (NFC) one, and pgrep compares bytes.
path_rx() { printf '%s' "$1" | perl -CS -pe 's/([^\x00-\x7f]+)|([^A-Za-z0-9 \/_-])/defined $1 ? ".+" : "\\$2"/ge'; }
# test_shell <name>: copies tests/<name> into the temp base and prints its path there. The app under test
# must never read a file under ~/Desktop: macOS would ask the owner for Desktop access in the app's name
# (a privacy prompt on screen), and the shell would hang until it is answered.
test_shell() { mkdir -p "$BASE/shells"; cp "$TESTS/$1" "$BASE/shells/$1"; chmod +x "$BASE/shells/$1"; printf '%s' "$BASE/shells/$1"; }
add_stub() { cp -R "$MACAPP/stub/server" "$MACAPP/stub/ui" "$MACAPP/stub/package.json" "$BASE/"; }
new_selftest_dir() {   # a fresh self-test folder for the next launch
  ST="$BASE/$1"; SLOG="$ST/selftest.log"
  rm -rf "$ST"; mkdir -p "$ST/picked-folder"
  printf 'WorkShop upload sample\nline 2\n' > "$ST/upload-sample.txt"
}

ws_open() {       # ws_open [KEY=VALUE ...]   Finder-like background launch in self-test mode
  local envs=() kv
  for kv in "WORKSHOP_SELFTEST_DIR=$ST" "$@"; do envs+=(--env "$kv"); done
  env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" PATH=/usr/bin:/bin:/usr/sbin:/sbin TMPDIR="$(getconf DARWIN_USER_TEMP_DIR)" \
    /usr/bin/open -g "${envs[@]}" "$APP"
}
launcher_pid() { pgrep -f "$BIN_RX" | head -1; }
launcher_count() { pgrep -f "$BIN_RX" | wc -l | tr -d ' '; }
hub_pids() { pgrep -f "$SRV_RX"; }
hub_count() { hub_pids | wc -l | tr -d ' '; }

wait_for() {      # wait_for <seconds> <command...>   0 when the command succeeds in time
  local t=$(( $1 * SLOW * 5 )) i; shift
  for i in $(seq 1 "$t"); do "$@" >/dev/null 2>&1 && return 0; sleep 0.2; done; return 1
}
wait_true() {     # wait_true <seconds> '<shell test>'   the test is evaluated again on every try (single quotes!)
  local s="$1"; shift; wait_for "$s" eval "$*"
}
wait_gone() {     # wait_gone <seconds> <pid>
  local t=$(( $1 * SLOW * 10 )) i
  for i in $(seq 1 "$t"); do kill -0 "$2" 2>/dev/null || return 0; sleep 0.1; done; return 1
}
state() { plutil -extract "$1" raw -o - "$ST/launcher-state.json" 2>/dev/null; }            # state status.kind
state_json() { plutil -extract "$1" json -o - "$ST/launcher-state.json" 2>/dev/null | sed 's#\\/#/#g'; }   # arrays and objects ("\/" -> "/")
state_is() { [ "$(state "$1")" = "$2" ]; }
state_has() { state "$1" | grep -q -- "$2"; }                                               # state_has <key> <pattern>
state_json_has() { state_json "$1" | grep -q -- "$2"; }
buttons() { state_json status.buttons | tr -d ' \n'; }                                       # ["TryAgain","Quit"]
count_ge() { [ "$(grep -c -- "$1" "$2" 2>/dev/null)" -ge "$3" ]; }                           # count_ge <pattern> <file> <n>
wait_state() { wait_for "$1" state_is "$2" "$3"; }                                           # wait_state <s> <key> <value>
page_loaded() { [ "$(state page.loads)" -ge "${1:-1}" ] 2>/dev/null && state_is status.visible false; }
wait_page() { wait_for "${2:-60}" page_loaded "${1:-1}"; }                                   # wait_page [loads] [seconds]

cmd() { printf '%s\n' "$*" >> "$ST/commands"; }
ws_eval() {       # ws_eval <tag> <js function body>   prints the JSON result line
  cmd "eval $1 $2"
  wait_for 20 grep -q "^eval-result $1 " "$SLOG" || { echo "(no result for $1)"; return 1; }
  grep "^eval-result $1 " "$SLOG" | tail -1 | sed "s/^eval-result $1 //"
}
quit_app() {      # clean quit with SIGTERM
  local p; p="$(launcher_pid)"
  [ -n "$p" ] || return 0
  kill -TERM "$p" 2>/dev/null; wait_gone "${1:-20}" "$p"
}
no_leftovers() {  # 0 when no launcher, no hub and no test child of this base is left
  ! pgrep -f "$BIN_RX" >/dev/null && ! pgrep -f "$SRV_RX" >/dev/null && ! pgrep -f "$KID_RX" >/dev/null
}
kill_leftovers() {
  pkill -9 -f "$BIN_RX" 2>/dev/null; pkill -9 -f "$SRV_RX" 2>/dev/null; pkill -9 -f "$KID_RX" 2>/dev/null; return 0
}

ok()  { PASSED=$((PASSED + 1)); echo "  PASS  $1"; }
bad() { FAILED=$((FAILED + 1)); echo "  FAIL  $1${2:+   [$2]}"; }
check() {         # check "<label>" <command...>
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$label"; else bad "$label"; fi
}
has() { grep -q -- "$1" "$2" 2>/dev/null; }          # has <pattern> <file>
hasnt() { ! grep -q -- "$1" "$2" 2>/dev/null; }

keep_logs() {     # copies the logs of this base to the results folder (for a look after the run)
  local d="$RESULTS/$TEST_NAME/$(basename "$BASE")-$(basename "$ST")"
  mkdir -p "$d"
  cp "$LOG" "$REQ" "$SLOG" "$ST/launcher-state.json" "$ST/launcher-state-at-quit.json" "$d/" 2>/dev/null
  cp "$ST"/*.png "$d/" 2>/dev/null
  return 0
}
end_case() {      # end of one launch: nothing may be left running; logs kept; base removed by finish
  sleep 0.3
  if no_leftovers; then ok "${1:-case}: no launcher, hub or child process left"; else bad "${1:-case}: processes left behind" "$(pgrep -fl "$(path_rx "$BASE")" | cut -c1-120 | tr '\n' ';')"; kill_leftovers; fi
  keep_logs
}
finish() {        # prints the totals; removes the temp base; exit code = failures
  local b
  for b in "${ALL_BASES[@]}"; do
    [ -d "$b" ] && { "$LSREG" -u "$b/WorkShop.app" 2>/dev/null; rm -rf "$b"; }
  done
  echo "RESULT $TEST_NAME passed=$PASSED failed=$FAILED"
  [ "$FAILED" = 0 ]
}
