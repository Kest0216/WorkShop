#!/bin/bash
# The hub code is missing or unreadable: a clear, friendly view (never a crash), nothing written in the wrong place.
#  A. no server/ folder next to the app   -> view with the folder it looked in; Try Again works once the folder is there
#  B. server/index.js is not readable     -> view that explains the macOS folder permission
#  C. the app runs from a translocated path (simulated) -> view that explains it
. "$(dirname "$0")/lib.sh"

echo "=== A. no server folder"
new_base noserver nostub
ws_open
check "an error view appears" wait_state 60 status.kind no-server
check "its title is plain" state_is status.title "WorkShop cannot find its hub"
check "it shows the file it looked for" state_has status.message "$BASE/server/index.js"
check "it says what to do" state_has status.message "What to do: put WorkShop.app back in the WorkShop folder"
check "buttons: Try Again, Show Folder, Quit" [ "$(buttons)" = '["TryAgain","ShowFolder","Quit"]' ]
check "the app is still running (no crash)" [ -n "$(launcher_pid)" ]
check "no data folder was created in the wrong place" [ ! -e "$BASE/data" ]
check "nothing else was written next to the app" [ "$(ls -A "$BASE" | sort | tr '\n' ' ')" = "WorkShop.app selftest " ]
cmd "snapshot no-server"
cmd "status-button 2"
check "Show Folder reveals the WorkShop folder (recorded)" wait_for 15 state_json_has reveals "$BASE"
add_stub
cmd "status-button 1"
check "after the folder is back, Try Again starts the hub and loads the page" wait_page 1 90
check "one hub runs" [ "$(hub_count)" = 1 ]
quit_app 30; end_case "A"

echo "=== B. server/index.js not readable"
rm -rf "$BASE/data"; new_selftest_dir selftest-b
chmod 000 "$BASE/server/index.js"
ws_open
check "an error view appears" wait_state 60 status.kind no-read
check "it names the file and the reason" state_has status.message "Permission denied"
check "it points at the macOS folder permission" state_has status.message "Privacy & Security > Files and Folders"
check "no hub was started" [ "$(hub_count)" = 0 ]
chmod 644 "$BASE/server/index.js"
LP=$(launcher_pid); cmd "status-button 2"
check "the Quit button quits" wait_gone 20 "$LP"
end_case "B"

echo "=== C. App Translocation guard (simulated path)"
TL="$BASE/AppTranslocation/0000/d"; mkdir -p "$TL"; cp -R "$APP" "$TL/WorkShop.app"
APP="$TL/WorkShop.app"; BIN="$APP/Contents/MacOS/WorkShop"; new_selftest_dir selftest-c
ws_open
check "an error view appears" wait_state 60 status.kind translocated
check "it explains the temporary copy" state_has status.message "App Translocation"
check "it shows the command that fixes it" state_has status.detail "xattr -dr com.apple.quarantine"
check "no data folder was created there" [ ! -e "$TL/data" ]
LP=$(launcher_pid); cmd "status-button 1"
check "the Quit button quits" wait_gone 20 "$LP"
"$LSREG" -u "$APP" 2>/dev/null
end_case "C"

echo "=== D. server/ folder present, server/index.js missing (the hub is not built yet)"
new_base nohubfile nostub
mkdir -p "$BASE/server"; echo "// another module" > "$BASE/server/store.js"
ws_open
check "an error view appears" wait_state 60 status.kind no-server
check "it names the missing start file" state_has status.message "$BASE/server/index.js"
check "it says the app is in the right folder" state_has status.message "WorkShop.app is in the right folder"
check "it says what to do" state_has status.message "What to do: put the complete WorkShop hub code"
check "no data folder was created" [ ! -e "$BASE/data" ]
LP=$(launcher_pid); cmd "status-button 3"
check "the Quit button quits" wait_gone 20 "$LP"
end_case "D"
finish
