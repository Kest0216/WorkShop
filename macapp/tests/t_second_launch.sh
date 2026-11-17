#!/bin/bash
# A second launch never starts a second hub and never opens a second window.
#  A. the app is opened again (double-click on a running app)  -> the same instance shows its window
#  B. `open -n` (ask for a new instance)                        -> refused by LSMultipleInstancesProhibited
#  C. the binary is started a second time, around LaunchServices -> the new instance finds the hub in
#     data/run/hub.lock, sees that it belongs to the first instance, brings that one forward, and leaves
#  D. two copies of the binary started at the same moment (no login-shell delay), 3 times
#     -> data/run/launcher.lock lets only one start a hub; the other hands over. Before that lock, two
#        hubs ran for one data folder in 3 of 4 tries (both passed the hub's own lock check)
#  E. a Finder duplicate ("WorkShop copy.app") opened right after the original -> still one hub
. "$(dirname "$0")/lib.sh"
new_base second
ws_open
check "the page loads" wait_page 1 90
LP=$(launcher_pid); HP=$(hub_pids | head -1)
LOCK_BEFORE="$(cat "$BASE/data/run/hub.lock")"

echo "=== A. open the running app again"
cmd "close-window"
check "the window is closed first" wait_state 15 window.visible false
ws_open
check "opening the app again shows the window" wait_state 30 window.visible true
check "it is a reopen of the same instance" has "app: reopen request" "$LOG"
check "still one launcher" [ "$(launcher_count)" = 1 ]
check "still one hub" [ "$(hub_count)" = 1 ]

echo "=== B. open -n"
env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" PATH=/usr/bin:/bin:/usr/sbin:/sbin TMPDIR="$(getconf DARWIN_USER_TEMP_DIR)" \
  /usr/bin/open -g -n --env "WORKSHOP_SELFTEST_DIR=$BASE/selftest-n" "$APP" 2>"$BASE/open-n.err"
sleep 4
if [ "$(launcher_count)" = 1 ]; then
  ok "open -n did not start a second launcher"
else
  # LaunchServices let a second copy start: the lock-file rule must then send it away (same as case C).
  check "a second copy started by open -n leaves by itself" wait_true 30 '[ "$(launcher_count)" = 1 ]'
fi
check "still one hub" [ "$(hub_count)" = 1 ]

echo "=== C. start the binary a second time"
cmd "close-window"
check "the window is closed first" wait_state 15 window.visible false
ST2="$BASE/selftest-2"; mkdir -p "$ST2"
env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" PATH=/usr/bin:/bin:/usr/sbin:/sbin TMPDIR="$(getconf DARWIN_USER_TEMP_DIR)" \
  WORKSHOP_SELFTEST_DIR="$ST2" "$BIN" >/dev/null 2>"$BASE/second.err" &
P2=$!
check "the second instance leaves by itself" wait_gone 60 "$P2"
check "it handed over to the first instance" [ "$(plutil -extract handedOverTo raw -o - "$ST2/launcher-state-at-quit.json")" = "$LP" ]
check "it logged why" has "another WorkShop (pid $LP) already runs the hub (pid $HP)" "$LOG"
check "the first instance showed its window" wait_state 30 window.visible true
check "the first instance logged the request" has "another WorkShop was opened for this folder" "$LOG"
check "the first launcher still runs" [ "$(launcher_pid)" = "$LP" ]
check "exactly one hub, the same one" [ "$(hub_pids | tr '\n' ' ')" = "$HP " ]
check "the lock file did not change" [ "$(cat "$BASE/data/run/hub.lock")" = "$LOCK_BEFORE" ]
check "the page kept its session (no reload)" state_is page.loads 1
quit_app 30; end_case "second launch"

echo "=== D. two binaries at the same moment"
fenv() { env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" PATH=/usr/bin:/bin:/usr/sbin:/sbin TMPDIR="$(getconf DARWIN_USER_TEMP_DIR)" "$@"; }
for i in 1 2 3; do
  rm -rf "$BASE/data" "$BASE/sd1" "$BASE/sd2"; mkdir -p "$BASE/sd1" "$BASE/sd2"
  fenv WORKSHOP_SHELL=/usr/bin/false WORKSHOP_SELFTEST_DIR="$BASE/sd1" "$BIN" >/dev/null 2>&1 &
  fenv WORKSHOP_SHELL=/usr/bin/false WORKSHOP_SELFTEST_DIR="$BASE/sd2" "$BIN" >/dev/null 2>&1 &
  check "try $i: one of them leaves by itself" wait_true 30 '[ "$(launcher_count)" = 1 ]'
  check "try $i: exactly one hub" wait_true 10 '[ "$(hub_count)" = 1 ]'
  check "try $i: exactly one READY" [ "$(grep -c 'READY on port' "$LOG")" = 1 ]
  check "try $i: the one that left handed over (or found the hub)" has "another WorkShop (pid [0-9]*) .*-> bringing it to the front and leaving" "$LOG"
  check "try $i: the hub's lock names the hub that runs" has "\"pid\":$(hub_pids | head -1)," "$BASE/data/run/hub.lock"
  quit_app 30; end_case "D-$i"
done

echo "=== E. a Finder duplicate of the app, opened right after the original"
rm -rf "$BASE/data"; new_selftest_dir selftest-e; mkdir -p "$BASE/selftest-e2"
cp -R "$APP" "$BASE/WorkShop copy.app"
COPY_RX="$(path_rx "$BASE/WorkShop copy.app/Contents/MacOS/WorkShop")"
ws_open
fenv /usr/bin/open -g --env "WORKSHOP_SELFTEST_DIR=$BASE/selftest-e2" "$BASE/WorkShop copy.app" 2>/dev/null
sleep 6
check "one launcher in all" [ "$(( $(launcher_count) + $(pgrep -f "$COPY_RX" | wc -l) ))" = 1 ]
check "exactly one hub" [ "$(hub_count)" = 1 ]
pkill -TERM -f "$COPY_RX"; quit_app 30
"$LSREG" -u "$BASE/WorkShop copy.app" 2>/dev/null
check "the copy is gone too" wait_true 10 '! pgrep -f "$COPY_RX" >/dev/null'
end_case "E"
finish
