#!/bin/bash
# The window and the menus.
#  A. closing the window keeps the app and the hub running; opening the app again brings the window back
#  B. menus: the standard set; Reload, zoom and Help work; the right-click menu is short
#  C. the window frame is remembered across launches; WORKSHOP_DEV=1 turns the developer extras on
. "$(dirname "$0")/lib.sh"
new_base window
ws_open
check "the page loads" wait_page 1 90
LP=$(launcher_pid); HP=$(hub_pids | head -1)

echo "=== A. close and reopen"
cmd "close-window"
check "the window closes" wait_state 15 window.visible false
N1=$(grep -c '"kind":"sse"' "$REQ"); sleep 8
check "the launcher keeps running" kill -0 "$LP"
check "the hub keeps running" kill -0 "$HP"
check "the page keeps its stream while the window is closed" [ "$(grep -c '"kind":"sse"' "$REQ")" -gt "$N1" ]
check "the stream was never dropped" hasnt "SSE close" "$REQ"
ws_open
check "opening the app again brings the window back" wait_state 30 window.visible true
check "it is the same launcher and the same hub" [ "$(launcher_pid)" = "$LP" -a "$(hub_pids | tr '\n' ' ')" = "$HP " ]
check "the window title is still WorkShop (never the page title)" state_is window.title WorkShop

echo "=== B. menus"
M() { state_json menus | tr -d '\n' | sed 's/  */ /g'; }
check "menu bar: WorkShop, Edit, View, Window, Help" [ "$(M | grep -o '"title" *: *"[A-Za-z]*"' | sed 's/.*: *//' | tr -d '"\n ')" = "WorkShopEditViewWindowHelp" ]
# Items are "<title>" or "<title> [<modifiers>-<key>]". Enter Full Screen carries the system's own Globe-F shortcut.
for item in "About WorkShop\"" "Hide WorkShop \[cmd-h\]" "Quit WorkShop \[cmd-q\]" "Undo \[cmd-z\]" "Cut \[cmd-x\]" "Copy \[cmd-c\]" "Paste \[cmd-v\]" \
            "Select All \[cmd-a\]" "Reload \[cmd-r\]" "Actual Size \[cmd-0\]" "Zoom In \[cmd-+\]" "Zoom Out \[cmd--\]" "Enter Full Screen" \
            "Minimize \[cmd-m\]" "WorkShop Help"; do
  check "menu item: $(echo "$item" | tr -d '\\"')" bash -c "plutil -extract menus json -o - '$ST/launcher-state.json' | grep -q '\"$item'"
done
check "Enter Full Screen appears once" [ "$(M | grep -o '"Enter Full Screen[^"]*"' | wc -l | tr -d ' ')" = 1 ]
zoom_is() { awk -v a="$(state page.zoom)" -v b="$1" 'BEGIN { exit !(a - b < 0.001 && b - a < 0.001) }'; }   # 1.1 prints as 1.1000000000000001
cmd "menu View|Zoom In"
check "View > Zoom In zooms the page" wait_for 10 zoom_is 1.1
cmd "menu View|Zoom Out"; cmd "menu View|Zoom Out"
check "View > Zoom Out zooms out" wait_for 10 zoom_is 0.9
cmd "menu View|Actual Size"
check "View > Actual Size resets the zoom" wait_for 10 zoom_is 1
cmd "menu View|Reload"
check "View > Reload loads the page again" wait_page 2 60
check "after a reload the page has no key and uses the cookie" wait_for 20 has '"hadKey":false,"session":null,"stateStatus":200' "$REQ"
cmd "drop-cookies"
check "(the web view's cookie is dropped, as when its network process restarts)" wait_for 15 has "drop-cookies: dropped" "$SLOG"
cmd "menu View|Reload"
check "Reload puts the session cookie back first" wait_for 30 has "the web view lost its session cookie -> putting it back" "$LOG"
check "and the page works again" wait_for 30 count_ge '"hadKey":false,"session":null,"stateStatus":200' "$REQ" 2
cmd "menu Help|WorkShop Help"
check "Help is disabled while there is no README.md" wait_for 10 has "menu: Help|WorkShop Help is disabled" "$SLOG"
echo "# WorkShop" > "$BASE/README.md"
cmd "menu Help|WorkShop Help"
check "Help opens README.md in its default app (recorded)" wait_for 10 state_json_has openedFiles "$BASE/README.md"
cmd "context-menu-test"
check "right-click menu keeps only Cut, Copy, Paste" wait_for 10 has "context-menu kept: Cut Copy Paste$" "$SLOG"
check "still one hub after all of this" [ "$(hub_pids | tr '\n' ' ')" = "$HP " ]

echo "=== C. remembered frame, developer switch"
# AppKit keeps a window inside the visible screen, so the test reads back where the window really went.
cmd "set-frame 120,120,1060,700"
check "the window moved" wait_for 10 has "frame now {{120, " "$SLOG"
check "the window kept its new size (above the minimum)" has "frame now .*{1060, 700}" "$SLOG"
sleep 1
quit_app 30
FRAME="$(plutil -extract window.frame raw -o - "$ST/launcher-state-at-quit.json")"
echo "  note  window frame at quit $FRAME"
end_case "A+B"
new_selftest_dir selftest-c
ws_open WORKSHOP_DEV=1
check "the page loads" wait_page 1 90
check "the next launch starts at the remembered frame" state_is window.frame "$FRAME"
check "it came from the preferences" has "restoredFromDefaults=true" "$LOG"
check "WORKSHOP_DEV=1 turns the web inspector on" state_is inspectable true
cmd "context-menu-test"
check "and keeps Inspect Element in the right-click menu" wait_for 10 has "context-menu kept: Cut Copy Paste - InspectElement$" "$SLOG"
quit_app 30; end_case "C"
finish
