#!/bin/bash
# Node lookup, all in a Finder-like environment.
#  A. the login shell is useless (/usr/bin/false)  -> known folders (newest ~/.nvm install here)
#  B. the login shell hangs                        -> 8 s time limit -> known folders
#  C. no node anywhere                             -> a friendly error view, no crash; its buttons work
#  D. a noisy login shell (banners, binary bytes, fake markers, 200 KB, a background job holding the pipe)
#                                                  -> the real answer is still read, nothing waits for EOF
#  E. the login shell does not exist               -> known folders, no hang
#  F. node in a folder with spaces and non-ASCII letters (WORKSHOP_NODE) -> used, and first on the hub PATH
. "$(dirname "$0")/lib.sh"

echo "=== A. login shell = /usr/bin/false"
new_base node
ws_open WORKSHOP_SHELL=/usr/bin/false
check "the page loads" wait_page 1 90
check "node came from a known folder, not the shell" has "hub: node v.* \[newest nvm install\]\|hub: node v.* \[known folder\]" "$LOG"
check "no login PATH captured, so WORKSHOP_PATH is not set" has "ENV WORKSHOP_PATH=null" "$REQ"
check "hub PATH still finds git" has 'ENV found={"git":"/' "$REQ"
quit_app 30; end_case "A"

echo "=== B. login shell hangs"
rm -rf "$BASE/data"; new_selftest_dir selftest-b
T0=$(date +%s)
SLOWSH="$(test_shell slowshell.sh)"
ws_open WORKSHOP_SHELL="$SLOWSH"
check "the page loads after the time limit" wait_page 1 120
check "the shell lookup timed out after 8 s" has "note: timed out after 8 s" "$LOG"
check "the window was up while the lookup ran (the app did not block)" [ -s "$ST/launcher-state.json" ]
echo "  note  page loaded $(( $(date +%s) - T0 )) s after launch"
quit_app 30
check "the hanging shell is gone" bash -c "! pgrep -f '$(path_rx "$SLOWSH")' >/dev/null"
end_case "B"

echo "=== C. no node at all"
rm -rf "$BASE/data"; new_selftest_dir selftest-c
ws_open WORKSHOP_TEST_NO_NODE=1 WORKSHOP_NODE=/nonexistent/bin/node
check "an error view appears" wait_state 60 status.kind no-node
check "its title names Node.js 20" state_is status.title "WorkShop needs Node.js 20 or newer"
check "it lists the folders it looked in" state_has status.message "/opt/homebrew/bin"
check "it names the login shell it asked" state_has status.message "login shell (/bin/zsh)"
check "it says what to do" state_has status.message "What to do: install Node.js"
check "buttons: Try Again, Open nodejs.org, Quit" [ "$(buttons)" = '["TryAgain","Opennodejs.org","Quit"]' ]
check "the app is still running (no crash)" [ -n "$(launcher_pid)" ]
check "no hub was started" [ "$(hub_count)" = 0 ]
cmd "snapshot no-node"
cmd "status-button 2"
check "Open nodejs.org goes to the browser (recorded)" wait_for 15 state_json_has externalOpens "nodejs.org"
cmd "status-button 1"
check "Try Again runs the lookup again and comes back" wait_for 30 count_ge "startup: no-node" "$LOG" 2
LP=$(launcher_pid)
cmd "status-button 3"
check "the Quit button quits" wait_gone 20 "$LP"
end_case "C"

echo "=== D. a noisy login shell"
rm -rf "$BASE/data"; new_selftest_dir selftest-d
JUNK="$(test_shell junkshell.sh)"
ws_open WORKSHOP_SHELL="$JUNK"
check "the page loads" wait_page 1 60
check "node came from the login shell, not a fallback" has "hub: node v.* \[login shell .*junkshell.sh (process.execPath)\]" "$LOG"
check "the fake markers before the real start were ignored" hasnt "/evil" "$LOG"
check "the login PATH was captured (WORKSHOP_PATH set)" bash -c "grep 'ENV WORKSHOP_PATH=' '$REQ' | grep -qv '=null'"
check "the fake PATH did not reach the hub" hasnt "/evil" "$REQ"
check "the lookup did not wait for the background job (well under 8 s)" bash -c "grep -o 'junkshell.sh took [0-9.]* s' '$LOG' | awk '{exit !(\$3 < 5)}'"
check "the rc file's background job is gone" bash -c "! pgrep -f 'sleep 30[.]4242' >/dev/null"
quit_app 30; end_case "D"

echo "=== E. the login shell does not exist"
rm -rf "$BASE/data"; new_selftest_dir selftest-e
ws_open WORKSHOP_SHELL=/nonexistent/bin/zsh
check "the page loads" wait_page 1 60
check "the log says the shell cannot run" has "note: shell not executable" "$LOG"
check "node came from a known folder" has "hub: node v.* \[newest nvm install\]\|hub: node v.* \[known folder\]" "$LOG"
quit_app 30; end_case "E"

echo "=== F. node in a folder with spaces and non-ASCII letters"
rm -rf "$BASE/data"; new_selftest_dir selftest-f
NODE="$(find_node)"; ODD="$BASE/My Tools ø/node bin"
mkdir -p "$ODD"; ln -s "$NODE" "$ODD/node"
ws_open WORKSHOP_NODE="$ODD/node"
check "the page loads" wait_page 1 60
check "that node was used" has "hub: node v.* at .*My Tools .*/node bin/node \[env WORKSHOP_NODE\]" "$LOG"
check "its folder is first on the hub PATH" bash -c "grep 'ENV PATH=' '$REQ' | grep -q 'PATH=.*My Tools .*/node bin:'"
quit_app 30; end_case "F"
finish
