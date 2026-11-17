#!/bin/bash
# A hub already runs for this folder (data/run/hub.lock, contract section 3b).
# The owner key lives only in that hub's memory, so a new launcher cannot join it. It must never
# start a second hub for the same data folder.
#  A. a hub started by hand (like `npm start` in Terminal)  -> a view that says so; no second hub;
#     Try Again keeps waiting; Quit leaves that hub alone
#  B. the same, then "Stop It and Start Here"               -> that hub ends, the app starts its own
#  C. a stale lock file (the pid is dead)                   -> ignored, normal start
. "$(dirname "$0")/lib.sh"
NODE="$(find_node)" || { echo "node not found"; exit 1; }
start_by_hand() {      # a hub with no launcher: stdin is not a pipe
  ( cd "$BASE" && exec "$NODE" "$BASE/server/index.js" < /dev/null > "$BASE/by-hand.out" 2>&1 ) &
  wait_for 20 test -s "$BASE/data/run/hub.lock"
  FOREIGN="$(hub_pids | head -1)"
}

echo "=== A. hub started by hand"
new_base attach
start_by_hand
check "the hand-started hub runs and holds the lock" has "\"pid\":$FOREIGN," "$BASE/data/run/hub.lock"
ws_open
check "the app shows the 'already running' view" wait_state 60 status.kind hub-elsewhere
check "it names the process and says it was started outside the app" state_has status.message "process $FOREIGN"
check "it says why it cannot join (the owner key)" state_has status.message "owner key"
check "buttons: Try Again, Stop It and Start Here, Quit" [ "$(buttons)" = '["TryAgain","StopItandStartHere","Quit"]' ]
check "no second hub was started" [ "$(hub_pids | tr '\n' ' ')" = "$FOREIGN " ]
check "the launcher asked nothing of that hub with a session" hasnt "cookie=yes" "$REQ"
cmd "snapshot hub-elsewhere"
cmd "status-button 1"
sleep 3
check "Try Again: still the same view" state_is status.kind hub-elsewhere
check "Try Again: still one hub" [ "$(hub_pids | tr '\n' ' ')" = "$FOREIGN " ]
LP=$(launcher_pid); cmd "status-button 3"
check "the Quit button quits the app" wait_gone 20 "$LP"
check "the hand-started hub is still alive (the app does not own it)" kill -0 "$FOREIGN"
keep_logs

echo "=== B. Stop It and Start Here"
new_selftest_dir selftest-b
ws_open
check "the view appears again" wait_state 60 status.kind hub-elsewhere
cmd "status-button 2"
check "the hand-started hub ends" wait_gone 30 "$FOREIGN"
check "the app starts its own hub and loads the page" wait_page 1 90
OWN="$(hub_pids | head -1)"
check "exactly one hub, a child of the launcher" [ "$(hub_count)" = 1 -a "$(ps -o ppid= -p "$OWN" | tr -d ' ')" = "$(launcher_pid)" ]
quit_app 30; end_case "B"

echo "=== C. stale lock file"
new_selftest_dir selftest-c
/bin/sleep 0.1 & DEAD=$!; wait $DEAD
mkdir -p "$BASE/data/run"; printf '{"pid":%s,"port":59999}\n' "$DEAD" > "$BASE/data/run/hub.lock"
ws_open
check "the page loads" wait_page 1 90
check "the stale lock was ignored" has "stale hub lock ignored (pid $DEAD is not running)" "$LOG"
check "the lock now names the new hub" has "\"pid\":$(hub_pids | head -1)," "$BASE/data/run/hub.lock"
quit_app 30; end_case "C"
finish
