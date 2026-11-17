#!/bin/bash
# The hub and everything it started must end with the launcher, however the launcher ends.
# The stub hub starts three test children (sleep 6000.731 / 6001.731 / 6002.731): one in the hub's process group,
# one detached in its own session (like an agent), one grandchild under a shell.
#  A. the launcher gets SIGKILL (crash, Force Quit)  -> the hub sees stdin end-of-file, shuts down, takes its children along
#  B. a stubborn hub (ignores stdin end-of-file and SIGTERM), normal quit -> the launcher escalates to SIGKILL
#     and sweeps the process group and every descendant it saw when the stop began
#  C. the hub crashes (exits without its shutdown code) while it has children -> the launcher kills the
#     ones the hub left behind, also the detached one that launchd adopted (it remembers every descendant)
#  D. the hub is killed with kill -9 while it has children -> same
#  E. the hub crashes during its boot, before READY, with children -> same, and the error view shows
#  F. the launcher quits (SIGTERM) or is killed (kill -9) while the login shell lookup still runs
#     -> the shell and what its rc files started are gone at once (a watchdog holds a pipe from the launcher)
#  G. the launcher quits while the hub boots (before READY) with children -> nothing left
. "$(dirname "$0")/lib.sh"
kids() { pgrep -f "$KID_RX" | wc -l | tr -d ' '; }

echo "=== A. kill -9 the launcher"
new_base orphans
ws_open WORKSHOP_STUB_SPAWN_KIDS=1
check "the page loads" wait_page 1 90
check "the hub started its test children" wait_for 15 has "KIDS " "$REQ"
LP=$(launcher_pid); HP=$(hub_pids | head -1)
check "the three children run (one in its own session)" [ "$(kids)" -ge 3 ]
kill -9 "$LP"; T0=$(perl -MTime::HiRes=time -e 'printf "%.2f", time')
check "the launcher is gone" wait_gone 5 "$LP"
check "the hub saw its stdin close and shut down" wait_for 10 has "SHUTDOWN reason=stdin-" "$REQ"
check "the hub is gone" wait_gone 10 "$HP"
check "every child is gone" wait_true 10 '[ "$(kids)" = 0 ]'
echo "  note  all gone $(perl -MTime::HiRes=time -e "printf '%.2f', time - $T0") s after kill -9"
check "the hub removed its lock" [ ! -e "$BASE/data/run/hub.lock" ]
end_case "A"

echo "=== B. stubborn hub, normal quit"
rm -rf "$BASE/data"; new_selftest_dir selftest-b
ws_open WORKSHOP_STUB_SPAWN_KIDS=1 WORKSHOP_STUB_STUBBORN=1
check "the page loads" wait_page 1 90
check "the hub started its test children" wait_for 15 has "KIDS " "$REQ"
LP=$(launcher_pid); HP=$(hub_pids | head -1)
T0=$(date +%s)
quit_app 30
check "the launcher quits" [ -z "$(launcher_pid)" ]
echo "  note  quit took $(( $(date +%s) - T0 )) s (5 s for stdin end-of-file, 3 s for SIGTERM, then SIGKILL)"
check "the hub ignored stdin end-of-file and SIGTERM" has "STUBBORN: ignoring SIGTERM" "$REQ"
check "the launcher escalated to SIGKILL" has "hub: ignored SIGTERM -> SIGKILL" "$LOG"
check "it killed the rest of the process group" has "killed leftover members of process group $HP" "$LOG"
check "it killed the leftover descendants (the detached child)" has "killed leftover descendants" "$LOG"
check "the hub is gone" wait_gone 5 "$HP"
check "every child is gone" wait_true 5 '[ "$(kids)" = 0 ]'
end_case "B"

echo "=== C. hub crash with children"
rm -rf "$BASE/data"; new_selftest_dir selftest-c
ws_open WORKSHOP_STUB_SPAWN_KIDS=1
check "the page loads" wait_page 1 90
check "the hub started its test children" wait_for 15 has "KIDS " "$REQ"
check "one child is detached (own session, like an agent)" bash -c "ps -axo pgid=,command= | grep '[s]leep 6001.731' | awk '{print \$1}' | grep -qv \"$(hub_pids | head -1)\""
sleep 1.2                                                    # the launcher looks at the hub's children once a second
ws_eval crash "return (await window.__ws.api('POST', '/api/stub/crash', {})).status" >/dev/null
check "the error view appears" wait_state 30 status.kind hub-stopped
check "every child is gone, the detached one too" wait_true 10 '[ "$(kids)" = 0 ]'
check "the launcher says it killed what the hub left behind" has "killed leftover descendants .*the hub ended by itself" "$LOG"
quit_app 30; end_case "C"

echo "=== D. kill -9 the hub while it has children"
rm -rf "$BASE/data"; new_selftest_dir selftest-d
ws_open WORKSHOP_STUB_SPAWN_KIDS=1
check "the page loads" wait_page 1 90
check "the hub started its test children" wait_for 15 has "KIDS " "$REQ"
sleep 1.2
kill -9 "$(hub_pids | head -1)"
check "the error view appears" wait_state 30 status.kind hub-stopped
check "it names the signal" state_has status.message "killed by signal 9"
check "every child is gone, the detached one too" wait_true 10 '[ "$(kids)" = 0 ]'
cmd "status-button 1"
check "Restart brings the page back" wait_page 2 90
quit_app 30; end_case "D"

echo "=== E. the hub crashes during boot, with children"
rm -rf "$BASE/data"; new_selftest_dir selftest-e
ws_open WORKSHOP_STUB_CRASH_AT_BOOT=1
check "the error view appears" wait_state 60 status.kind hub-stopped
check "it says the hub did not start" state_has status.message "did not start (exit code 9)"
check "it shows the hub's last line" state_has status.detail "crashed during boot"
check "every child is gone, the detached one too" wait_true 10 '[ "$(kids)" = 0 ]'
quit_app 30; end_case "E"

echo "=== F. quit or kill the launcher during a slow login shell"
shells() { pgrep -f "$(path_rx "$SLOWSH")" | wc -l | tr -d ' '; }
none_alive() { local p; for p in "$@"; do kill -0 "$p" 2>/dev/null && return 1; done; return 0; }
for how in TERM KILL; do
  rm -rf "$BASE/data"; new_selftest_dir "selftest-f-$how"; SLOWSH="$(test_shell slowshell.sh)"
  ws_open WORKSHOP_SHELL="$SLOWSH"
  check "SIG$how: the slow login shell runs" wait_true 15 '[ "$(shells)" -ge 1 ]'
  sleep 1
  SG=$(ps -o pgid= -p "$(pgrep -f "$(path_rx "$SLOWSH")" | head -1)" | tr -d ' ')
  SLEEPS=$(pgrep -g "$SG" -x sleep | tr '\n' ' ')
  check "SIG$how: the shell's rc program (sleep 60) runs in its group" [ -n "$SLEEPS" ]
  LP=$(launcher_pid); kill -"$how" "$LP"
  check "SIG$how: the launcher is gone" wait_gone 15 "$LP"
  check "SIG$how: the login shell is gone at once (not 60 s later)" wait_true 3 '[ "$(shells)" = 0 ]'
  check "SIG$how: what the shell started is gone too" wait_for 3 none_alive $SLEEPS
  check "SIG$how: no hub was started" [ "$(hub_count)" = 0 ]
  pkill -9 -f "$(path_rx "$SLOWSH")" 2>/dev/null
  end_case "F-$how"
  sleep 1.5                                                  # let LaunchServices notice the end of that instance
done

echo "=== G. quit while the hub boots, with children"
rm -rf "$BASE/data"; new_selftest_dir selftest-g
ws_open WORKSHOP_STUB_NO_READY=1 WORKSHOP_STUB_SPAWN_KIDS=1
check "the hub started its test children (no READY yet)" wait_for 30 has "KIDS " "$REQ"
LP=$(launcher_pid); kill -TERM "$LP"
check "the launcher quits" wait_gone 20 "$LP"
check "every child is gone" wait_true 10 '[ "$(kids)" = 0 ]'
end_case "G"
finish
