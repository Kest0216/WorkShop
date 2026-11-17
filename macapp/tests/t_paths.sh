#!/bin/bash
# Odd places for the WorkShop folder.
#  A. a folder name with spaces and non-ASCII letters ("Work Shop ✓ Ünïcødé"). LaunchServices hands the app
#     the decomposed (NFD) spelling, a shell or a page types the composed (NFC) one: both must work.
#     The page loads, the hub runs there, reveal accepts both spellings and still refuses a look-alike
#     sibling folder ("<folder>-evil"), and a second copy of the binary started with the NFC path hands
#     over to the first instance.
#  B. a read-only folder (no data/ yet)  -> a plain "cannot write to its folder" view, not a hub stack trace;
#     Try Again works once the folder is writable again
. "$(dirname "$0")/lib.sh"
NAME="Work Shop ✓ Ünïcødé"
NFC="$(printf '%s' "$NAME" | perl -CS -MUnicode::Normalize -pe '$_=NFC($_)')"
NFD="$(printf '%s' "$NAME" | perl -CS -MUnicode::Normalize -pe '$_=NFD($_)')"

echo "=== A. spaces and non-ASCII letters"
new_base "$NFC"
mkdir -p "$BASE-evil"; touch "$BASE-evil/x"
ws_open
check "the page loads" wait_page 1 90
check "the hub runs in that folder" has "START port=.* cwd=.*Work Shop .*argv=\[\]" "$REQ"
check "the launcher log names the folder" has "base=.*Work Shop " "$LOG"
bridge() { ws_eval "b$RANDOM" "return await window.__ws.bridge($1)"; }
okreply() { case "$1" in *'"ok":true'*) return 0;; *) return 1;; esac; }
refused() { case "$1" in *'"error"'*) return 0;; *) return 1;; esac; }
PARENT="$(dirname "$BASE")"
R=$(bridge "{type:'reveal', path:'$PARENT/$NFC/server/index.js'}"); check "reveal with the composed (NFC) spelling -> ok" okreply "$R"
R=$(bridge "{type:'reveal', path:'$PARENT/$NFD/server/index.js'}"); check "reveal with the decomposed (NFD) spelling -> ok" okreply "$R"
R=$(bridge "{type:'reveal', path:'$BASE-evil/x'}"); check "reveal of a look-alike sibling folder is refused" refused "$R"
R=$(bridge "{type:'reveal', path:'$BASE/server/../../$NFC-evil/x'}"); check "reveal through .. into the sibling is refused" refused "$R"
LP=$(launcher_pid); HP=$(hub_pids | head -1)
cmd "close-window"
check "the window is closed first" wait_state 15 window.visible false
ST2="$BASE/selftest-2"; mkdir -p "$ST2"
env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" PATH=/usr/bin:/bin:/usr/sbin:/sbin TMPDIR="$(getconf DARWIN_USER_TEMP_DIR)" \
  WORKSHOP_SELFTEST_DIR="$ST2" "$PARENT/$NFC/WorkShop.app/Contents/MacOS/WorkShop" >/dev/null 2>&1 &
P2=$!
check "a second binary (NFC path) leaves by itself" wait_gone 40 "$P2"
check "it handed over to the first instance" [ "$(plutil -extract handedOverTo raw -o - "$ST2/launcher-state-at-quit.json" 2>/dev/null)" = "$LP" ]
check "the first instance showed its window" wait_state 20 window.visible true
check "exactly one hub, the same one" [ "$(hub_pids | tr '\n' ' ')" = "$HP " ]
quit_app 30; end_case "A"
rm -rf "$BASE-evil"
sleep 1.5

echo "=== B. read-only folder"
rm -rf "$BASE/data"; new_selftest_dir selftest-b
ST="$WS_TMP_ROOT/paths-ro-selftest"; SLOG="$ST/selftest.log"; rm -rf "$ST"; mkdir -p "$ST"   # outside the locked folder
chmod a-w "$BASE"
ws_open
check "a plain error view appears" wait_state 60 status.kind read-only
check "its title says what is wrong" state_is status.title "WorkShop cannot write to its folder"
check "it names the folder" state_has status.message "Work Shop "
check "it says what to do" state_has status.message "What to do: copy the whole WorkShop folder"
check "buttons: Try Again, Show Folder, Quit" [ "$(buttons)" = '["TryAgain","ShowFolder","Quit"]' ]
check "no hub was started" [ "$(hub_count)" = 0 ]
check "nothing was written into the folder" [ ! -e "$BASE/data" ]
chmod u+w "$BASE"
cmd "status-button 1"
check "Try Again works once the folder is writable" wait_page 1 90
quit_app 30; end_case "B"
chmod -R u+w "$BASE" 2>/dev/null
rm -rf "$ST"
finish
