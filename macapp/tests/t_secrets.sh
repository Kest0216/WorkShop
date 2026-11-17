#!/bin/bash
# The owner key (contract section 6) is never logged, shown in a window title, saved in preferences or
# web data, left in the page address or its history, or put in a child environment.
# The stub prints the key on stderr at boot (WORKSHOP_STUB_LEAK=1) and again when it crashes, so the
# redaction is tested too. The key is a test value made here.
. "$(dirname "$0")/lib.sh"
KEY="$(openssl rand -hex 32)"
ID="$TEST_ID"
WEBDIRS=("$HOME/Library/WebKit/$ID" "$HOME/Library/Caches/$ID" "$HOME/Library/HTTPStorages/$ID"
         "$HOME/Library/Saved Application State/$ID.savedState" "$(getconf DARWIN_USER_CACHE_DIR)$ID" "$(getconf DARWIN_USER_TEMP_DIR)$ID")
key_nowhere_in() { ! grep -rqa -- "$KEY" "$@" 2>/dev/null; }

new_base secrets
ws_open WORKSHOP_STUB_KEY="$KEY" WORKSHOP_STUB_LEAK=1
check "the page loads" wait_page 1 90
HP=$(hub_pids | head -1)
check "the page used the key (session opened)" has "REQ POST /api/session -> 200" "$REQ"
check "the page address has no fragment" state_is page.hasFragment false
W="$(ws_eval where 'return window.__ws.where()')"
check "location.hash is empty in the page" bash -c "echo '$W' | grep -q '\"hash\":\"\"'"
check "no history entry holds the key" state_is history.anyFragmentWithKey false
echo "  note  WebKit's in-memory record of the first address of the page (initialURL) holds the key: $(state history.anyInitialURLWithKey) (memory only, never written to disk: see the web data check below)"
check "the window title is WorkShop" state_is window.title WorkShop
check "the hub's arguments do not hold the key" bash -c "! ps -ww -o args= -p $HP | grep -q '$KEY'"
# WORKSHOP_STUB_KEY is the test hook that hands the stub its key; any OTHER place in the environment fails.
check "the hub's environment does not hold the key" bash -c "! ps eww -o command= -p $HP | sed 's/WORKSHOP_STUB_KEY=$KEY//' | grep -q '$KEY'"
check "the launcher's environment does not hold the key" bash -c "! ps eww -o command= -p $(launcher_pid) | sed 's/WORKSHOP_STUB_KEY=$KEY//' | grep -q '$KEY'"
cmd "menu View|Reload"
check "after a reload the page works from the cookie alone" wait_for 30 has '"hadKey":false,"session":null,"stateStatus":200' "$REQ"
check "still no history entry with the key" state_is history.anyFragmentWithKey false
ws_eval crash "return (await window.__ws.api('POST', '/api/stub/crash', {})).status" >/dev/null
check "the hub crashed (its stderr holds the key three times)" wait_state 30 status.kind hub-stopped
check "the error view shows the leak line, redacted" state_has status.detail "the owner key is \[redacted\]"
check "the error view never shows the key" bash -c "! plutil -extract status json -o - '$ST/launcher-state.json' | grep -q '$KEY'"
quit_app 30
end_case "secrets"
sleep 1
check "the key is not in the launcher log" key_nowhere_in "$LOG"
check "the key is not in the stub's request log" key_nowhere_in "$REQ"
check "the key is not in anything under data/" key_nowhere_in "$BASE/data"
check "the key is not in the self-test files" key_nowhere_in "$ST"
PREFS="$(defaults export "$ID" - 2>/dev/null)"
check "the preferences exist (window frame)" bash -c "echo '$PREFS' | grep -q 'NSWindow Frame'"
check "the key is not in the preferences" bash -c "! echo '$PREFS' | grep -q '$KEY'"
check "the key is not in the web data, caches or saved state" key_nowhere_in "${WEBDIRS[@]}"
finish
