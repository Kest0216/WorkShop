#!/bin/bash
# The hub ends on its own, or never gets ready, and the page recovers after a wake or a display change.
#  A. the hub crashes while the page is open -> error view with the last stderr lines (secrets redacted),
#     Restart starts a new hub on a new port and loads the page again (no blank window)
#  B. the hub fails at boot                  -> "did not start" with its last lines, secrets redacted
#  C. the hub never prints WORKSHOP_READY    -> stopped after the time limit, error view
#  D. wake and display change                -> a live page gets "workshop:resume"; a blank page is reloaded
. "$(dirname "$0")/lib.sh"
KEY="$(openssl rand -hex 32)"
no_key() { ! state_json status | grep -q "$KEY"; }

echo "=== A. hub crash, then Restart"
new_base crash
ws_open WORKSHOP_STUB_KEY="$KEY"
check "the page loads" wait_page 1 90
PORT1=$(state hub.port); HP=$(hub_pids | head -1)
ws_eval crash "return (await window.__ws.api('POST', '/api/stub/crash', {})).status" >/dev/null
check "the error view appears" wait_state 30 status.kind hub-stopped
check "its title is plain" state_is status.title "The WorkShop hub stopped"
check "it says the hub ended unexpectedly, with the exit code" state_has status.message "ended unexpectedly (exit code 7)"
check "it says the work is saved" state_has status.message "Your work is saved on disk"
check "it shows the last stderr lines" state_has status.detail "TypeError: cannot read properties of undefined"
check "the owner key is redacted in the view" no_key
check "the key in the URL line is redacted" state_has status.detail '#k=\[redacted\]'
check "the session cookie is redacted" state_has status.detail 'workshop_owner_[0-9]*=\[redacted\]'
check "buttons: Restart, Show Log, Quit" [ "$(buttons)" = '["Restart","ShowLog","Quit"]' ]
check "the dead page is gone from the web view" state_is page.onHub false
check "the launcher log has the last lines" has "hub: last output: stub hub: fatal: TypeError" "$LOG"
check "the owner key is not in the launcher log" hasnt "$KEY" "$LOG"
check "the old hub process is gone" wait_gone 5 "$HP"
cmd "snapshot hub-stopped"
cmd "status-button 1"
check "Restart starts a new hub and loads the page again" wait_page 2 90
check "the new hub listens on a new port" [ "$(state hub.port)" != "$PORT1" ]
check "the page opened a new owner session" count_ge "REQ POST /api/session -> 200" "$REQ" 2
check "exactly one hub" [ "$(hub_count)" = 1 ]
quit_app 30; end_case "A"

echo "=== B. hub fails at boot"
rm -rf "$BASE/data"; new_selftest_dir selftest-b
ws_open WORKSHOP_STUB_FAIL=boot WORKSHOP_STUB_KEY="$KEY"
check "the error view appears" wait_state 60 status.kind hub-stopped
check "it says the hub did not start" state_has status.message "did not start (exit code 1)"
check "it shows the hub's last lines" state_has status.detail "cannot open config/models.json"
check "the owner key is redacted (the launcher never saw it)" no_key
check "an API-key-like value is redacted" bash -c "! plutil -extract status json -o - '$ST/launcher-state.json' | grep -q FAKEFAKE"
check "the owner key is not in the launcher log" hasnt "$KEY" "$LOG"
LP=$(launcher_pid); cmd "status-button 3"
check "Quit quits" wait_gone 20 "$LP"
end_case "B"

echo "=== C. no WORKSHOP_READY line"
rm -rf "$BASE/data"; new_selftest_dir selftest-c
ws_open WORKSHOP_STUB_NO_READY=1 WORKSHOP_READY_TIMEOUT=4
check "the error view appears" wait_state 60 status.kind hub-stopped
check "it says why" state_has status.message "no ready line within 4 seconds"
check "the silent hub was stopped" wait_true 10 '[ "$(hub_count)" = 0 ]'
quit_app 30; end_case "C"

echo "=== D. wake and display change"
rm -rf "$BASE/data"; new_selftest_dir selftest-d
ws_open
check "the page loads" wait_page 1 90
cmd wake
check "after a wake a live page stays" wait_for 15 has "page: alive after wake" "$LOG"
check "and gets the workshop:resume event" wait_for 15 has '"kind":"resume","n":1' "$REQ"
check "no reload was needed" state_is page.loads 1
ws_eval blank "document.body.replaceChildren(); return document.body.childElementCount" >/dev/null
cmd screens
check "after a display change a blank page is noticed" wait_for 15 has "page: blank after a display change -> loading it again" "$LOG"
check "and loaded again" wait_page 2 60
check "the reloaded page works with the session cookie" wait_for 20 has '"hadKey":false,"session":null,"stateStatus":200' "$REQ"
quit_app 30; end_case "D"
finish
