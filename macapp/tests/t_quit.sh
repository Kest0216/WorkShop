#!/bin/bash
# Quit (contract section 3b: "Quit with a live job asks: Keep working, or Pause and quit").
#  A. no live job                 -> no question; the hub stops at once
#  B. a live job, Keep working    -> the app, the hub and the job keep running
#  C. then Pause and quit         -> POST /api/jobs/J1/pause { hard: true } with the owner session, then the hub stops
#  D. the pause fails             -> a second question says why; Keep working keeps the app; SIGTERM still quits
#  E. log out / restart / shut down with a live job (macOS posts willPowerOff, then asks the app to quit)
#                                 -> no question (it would stall the log out); the job is paused, then the hub stops
# "quit" sends NSApp.terminate, exactly what Quit WorkShop (Cmd-Q) and the Dock's Quit do.
. "$(dirname "$0")/lib.sh"

echo "=== A. quit with no live job"
new_base quit
ws_open
check "the page loads" wait_page 1 90
check "the page reports no live job (bridge quitState)" wait_state 20 page.live false
LP=$(launcher_pid); HP=$(hub_pids | head -1)
T0=$(date +%s)
cmd quit
check "Quit ends the app" wait_gone 20 "$LP"
echo "  note  quit took $(( $(date +%s) - T0 )) s"
check "no question was asked" hasnt "(quit-live)" "$SLOG"
check "the launcher asked the hub with the owner session" has 'REQ GET /api/state -> 200 cookie=yes .*ua="WorkShop' "$REQ"
check "no pause was sent" hasnt "PAUSE" "$REQ"
check "the hub stopped at once, on stdin end-of-file" has "hub: ended after its stdin closed" "$LOG"
check "the hub process is gone" wait_gone 5 "$HP"
end_case "A"

echo "=== B. live job: Keep working"
rm -rf "$BASE/data"; new_selftest_dir selftest-b
ws_open WORKSHOP_STUB_LIVE=1
check "the page loads" wait_page 1 90
check "the page reports the live job (bridge quitState)" wait_state 20 page.live true
LP=$(launcher_pid); HP=$(hub_pids | head -1)
cmd "answer 1"; cmd quit
check "the quit question appears" wait_for 20 has 'dialog 1 (quit-live): “A job is still working”' "$SLOG"
check "its buttons are Keep working, Pause and quit" has 'buttons=\["Keep working", "Pause and quit"\]' "$SLOG"
check "Keep working was pressed" has 'pressing “Keep working”' "$SLOG"
sleep 2
check "the app keeps running" kill -0 "$LP"
check "the hub keeps running" kill -0 "$HP"
check "no pause was sent" hasnt "PAUSE" "$REQ"
check "the quit flow is over (a later quit asks again)" state_is quitFlowActive false

echo "=== C. live job: Pause and quit"
cmd "answer 2"; cmd quit
check "the question appears again" wait_for 20 has 'dialog 2 (quit-live)' "$SLOG"
check "Pause and quit ends the app" wait_gone 30 "$LP"
check "the pause route got the owner cookie and X-WorkShop" has 'REQ POST /api/jobs/J1/pause -> 200 cookie=yes xws=1 origin=- ua="WorkShop' "$REQ"
check "the pause is a hard pause" has 'PAUSE J1 body={"hard":true} status-before=running' "$REQ"
PL=$(grep -n 'PAUSE J1' "$REQ" | head -1 | cut -d: -f1); SL=$(grep -n 'SHUTDOWN' "$REQ" | head -1 | cut -d: -f1)
check "the pause came before the hub stopped" bash -c "[ -n '$PL' ] && [ -n '$SL' ] && [ '$PL' -lt '$SL' ]"
check "the hub shut down with the job paused" has 'SHUTDOWN reason=stdin-eof .*"J1:paused"' "$REQ"
check "the hub process is gone" wait_gone 5 "$HP"
end_case "B+C"

echo "=== D. the pause fails"
rm -rf "$BASE/data"; new_selftest_dir selftest-d
ws_open WORKSHOP_STUB_LIVE=1 WORKSHOP_STUB_PAUSE_FAIL=1
check "the page loads" wait_page 1 90
LP=$(launcher_pid)
cmd "answer 2"; cmd quit
check "the quit question appears" wait_for 20 has 'dialog 1 (quit-live)' "$SLOG"
check "a second question says the job could not be paused" wait_for 20 has 'dialog 2 (quit-pause-failed): “The job could not be paused”' "$SLOG"
check "it gives the hub's reason" has 'stub: the pause was refused' "$SLOG"
sleep 1.5
check "its first button (Keep working) keeps the app running" kill -0 "$LP"
check "the hub still runs" [ "$(hub_count)" = 1 ]
quit_app 30
check "SIGTERM still quits" [ -z "$(launcher_pid)" ]
check "without a question" hasnt "dialog 3" "$SLOG"
end_case "D"

echo "=== E. log out with a live job"
rm -rf "$BASE/data"; new_selftest_dir selftest-e
ws_open WORKSHOP_STUB_LIVE=1
check "the page loads" wait_page 1 90
check "the page reports a live job" wait_state 20 page.live true
LP=$(launcher_pid); HP=$(hub_pids | head -1)
cmd "answer 0"                                               # a question, if one came, would stay open
cmd power-off; sleep 0.5; cmd quit
check "the app quits by itself" wait_gone 20 "$LP"
check "no question was asked" hasnt "(quit-live)" "$SLOG"
check "the launcher logged why" has "quit: log out / shut down: live jobs \[\"J1\"\] paused" "$LOG"
check "the job was paused with the owner session" has 'REQ POST /api/jobs/J1/pause -> 200 cookie=yes xws=1' "$REQ"
check "the hub shut down with the job paused" has 'SHUTDOWN reason=stdin-eof .*"J1:paused"' "$REQ"
check "the hub process is gone" wait_gone 5 "$HP"
end_case "E"
finish
