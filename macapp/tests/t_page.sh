#!/bin/bash
# What the web view must support, driven through the stub page (window.__ws) in self-test mode:
#  A. alert / confirm / prompt as native sheets
#  B. <input type=file> -> native open panel
#  C. downloads -> the Downloads folder (the test folder in self-test mode), shown in Finder; SSE survives
#  D. navigation lock: target=_blank and links away from the hub go to the default browser (http/https only);
#     file:, mailto:, ftp: and other schemes are refused; the window never leaves the hub
#  E. the Edit menu works in a text field (Select All)
#  F. the native bridge: notify, badge, pickFolder, reveal, quitState; every bad message is refused
#  G. hostile page: window.open and script navigations to other origins (another site, the same port on
#     "localhost"), a hub page that redirects away, huge strings, a look-alike folder, two folder panels
# In self-test mode the browser, Finder and macOS notifications are recorded, not opened.
. "$(dirname "$0")/lib.sh"
new_base page
ws_open
check "the page loads" wait_page 1 90
click() { ws_eval "c$RANDOM" "window.__ws.click('$1'); await window.__ws.sleep(${2:-300}); return 1" >/dev/null; }
bridge() { ws_eval "b$RANDOM" "return await window.__ws.bridge($1)"; }
refused() { case "$1" in *'"error"'*) return 0;; *) return 1;; esac; }
okreply() { case "$1" in *'"ok":true'*) return 0;; *) return 1;; esac; }

echo "=== A. dialogs"
click btnAlert
check "alert() shows a sheet and returns" wait_for 15 has '"which":"alert","returned":true' "$REQ"
check "the sheet carries the page text" has 'dialog 1 (alert): “WorkShop” / “Hello from alert()”' "$SLOG"
cmd "answer 1"; click btnConfirm
check "confirm() OK -> true" wait_for 15 has '"which":"confirm","result":true' "$REQ"
cmd "answer 2"; click btnConfirm
check "confirm() Cancel -> false" wait_for 15 has '"which":"confirm","result":false' "$REQ"
check "confirm buttons are OK and Cancel" has '(confirm): .*buttons=\["OK", "Cancel"\]' "$SLOG"
click btnPrompt
check "prompt() returns the text field" wait_for 15 has '"which":"prompt","result":"order-1"' "$REQ"

echo "=== B. file input"
click file 1500
check "the open panel appeared as a sheet" wait_for 15 has "file-panel visible=true sheetAttached=true" "$SLOG"
check "the chosen file reached the page" wait_for 15 has '"kind":"upload","name":"upload-sample.txt","bytes":30' "$REQ"

echo "=== C. downloads"
click lnkDownloadAttr 1000
click lnkDownloadBlob 1500
check "two downloads finished" wait_true 20 '[ "$(ls "$ST/downloads" | wc -l | tr -d " ")" -ge 2 ]'
check "the files hold the hub's bytes" bash -c "grep -l 'hello from the WorkShop stub download' '$ST'/downloads/* | wc -l | grep -q 2"
check "each download is shown in Finder (recorded)" bash -c "plutil -extract reveals json -o - '$ST/launcher-state.json' | sed 's#\\\\/#/#g' | grep -o 'downloads/' | wc -l | grep -q 2"
check "the SSE stream survived the downloads" hasnt "SSE close" "$REQ"
echo "  note  saved: $(ls "$ST/downloads" | tr '\n' ' ')"

echo "=== D. navigation lock and links"
click lnkBlankExt
check "target=_blank to another site -> browser" wait_for 10 state_json_has externalOpens "https://example.com/?from=workshop-blank"
click lnkBlankSame
check "target=_blank to the hub -> browser too (never a second window)" wait_for 10 state_json_has externalOpens "/sub/page2.html"
click lnkExt
check "a same-window link away from the hub -> browser" wait_for 10 state_json_has externalOpens "https://example.org/?from=workshop-samewindow"
ws_eval nav "location.href = 'https://example.net/from-script'; await window.__ws.sleep(500); return location.host" >/dev/null
check "a script navigation away from the hub -> browser" wait_for 10 state_json_has externalOpens "https://example.net/from-script"
click lnkFile
sleep 1
# WebKit itself blocks a file: link on an http page before the launcher is asked; either way it must go nowhere.
check "file: goes nowhere" bash -c "! plutil -extract externalOpens json -o - '$ST/launcher-state.json' | grep -q 'file:'"
click lnkMailto
check "mailto: is refused" wait_for 10 state_json_has refusedLinks "mailto:nobody@example.com"
click lnkFtpBlank
check "ftp: (target=_blank) is refused" wait_for 10 state_json_has refusedLinks "ftp://example.com/x"
check "nothing but http(s) went to the browser" bash -c "! plutil -extract externalOpens json -o - '$ST/launcher-state.json' | grep -qE '\"(file|mailto|ftp):'"
check "the window still shows the hub page" state_is page.onHub true
check "the page was never replaced" state_is page.loads 1
check "the window title never changed" state_is window.title WorkShop

echo "=== E. Edit menu in a text field"
ws_eval edit "return window.__ws.edit('hello')" >/dev/null
cmd "menu Edit|Select All"
sleep 1
SEL="$(ws_eval sel 'return window.__ws.selection()')"
check "Edit > Select All selects the text" bash -c "echo '$SEL' | grep -q '\"start\":0' && echo '$SEL' | grep -q '\"end\":5'"

echo "=== F. native bridge"
R=$(bridge "{type:'badge', count:3}"); check "badge 3 -> ok" okreply "$R"
check "the Dock badge shows 3" wait_state 5 dockBadge 3
R=$(bridge "{type:'badge', count:0}"); check "badge 0 -> ok" okreply "$R"
check "badge 0 clears the Dock badge" wait_state 5 dockBadge ""
for b in "{type:'badge', count:-1}" "{type:'badge', count:'3'}" "{type:'badge', count:1.5}" "{type:'badge', count:true}" "{type:'badge'}"; do
  R=$(bridge "$b"); check "refused: $b" refused "$R"
done
R=$(bridge "{type:'notify', title:'Truck is ready', body:'J1 waits for you.'}")
check "notify -> ok, shown" bash -c "echo '$R' | grep -q '\"shown\":true'"
check "the notification was raised (recorded)" wait_for 5 state_json_has notifications "Truck is ready"
for b in "{type:'notify'}" "{type:'notify', title:''}" "{type:'notify', title:42}" "{type:'notify', title:'x', body:7}"; do
  R=$(bridge "$b"); check "refused: $b" refused "$R"
done
R=$(bridge "{type:'pickFolder'}")
check "pickFolder returns the chosen folder" bash -c "echo '$R' | grep -q 'picked-folder'"
check "the folder panel appeared as a sheet" has "folder-panel visible=true sheetAttached=true" "$SLOG"
R=$(bridge "{type:'reveal', path:'$BASE/server'}"); check "reveal inside the WorkShop folder -> ok" okreply "$R"
check "it was shown in Finder (recorded)" wait_for 5 state_json_has reveals "/server"
ln -s /etc "$BASE/data/escape"
for b in "{type:'reveal', path:'/etc/hosts'}" "{type:'reveal', path:'$BASE/../'}" "{type:'reveal', path:'server'}" \
         "{type:'reveal', path:'$BASE/data/escape/hosts'}" "{type:'reveal', path:'$BASE/nope'}" "{type:'reveal'}"; do
  R=$(bridge "$b"); check "refused: $(echo "$b" | sed "s#$BASE#<base>#")" refused "$R"
done
R=$(bridge "{type:'quitState', live:true}"); check "quitState live:true -> ok" okreply "$R"
check "the launcher now knows a job is live" wait_state 5 page.live true
R=$(bridge "{type:'quitState', live:false}"); check "quitState live:false -> ok" okreply "$R"
for b in "{type:'quitState', live:'yes'}" "{type:'quitState', live:1}" "{type:'quitState'}"; do
  R=$(bridge "$b"); check "refused: $b" refused "$R"
done
for b in "{type:'exec', cmd:'ls'}" "'just a string'" "{kind:'badge'}" "[1,2]"; do
  R=$(bridge "$b"); check "refused: $b" refused "$R"
done
echo "=== G. hostile page"
now() { perl -MTime::HiRes=time -e 'printf "%.2f", time'; }
ws_eval wo "return String(window.open('https://evil.example/popup'))" >/dev/null
check "window.open to another site -> browser, no second window" wait_for 10 state_json_has externalOpens "https://evil.example/popup"
ws_eval wj "return String(window.open('javascript:document.title=1'))" >/dev/null
ws_eval wf "return String(window.open('file:///etc/hosts'))" >/dev/null
check "window.open of file: is refused" wait_for 10 state_json_has refusedLinks "file:///etc/hosts"
ws_eval lh "location.href = 'http://localhost:' + location.port + '/'; await window.__ws.sleep(500); return 1" >/dev/null
check "the same port under another host name is another origin -> browser" wait_for 10 state_json_has externalOpens "http://localhost:$(state hub.port)/"
ws_eval rd "location.href = '/stub-redirect-away'; await window.__ws.sleep(800); return 1" >/dev/null
check "a hub page that redirects to another site -> browser, not the window" wait_for 10 state_json_has externalOpens "https://example.com/redirected-from-hub"
check "the window still shows the hub" state_is page.onHub true
mkdir -p "$BASE-evil"; touch "$BASE-evil/x"
R=$(bridge "{type:'reveal', path:'$BASE-evil/x'}"); check "refused: reveal of a look-alike folder <base>-evil" refused "$R"
R=$(bridge "{type:'reveal', path:'$BASE/server/../../$(basename "$BASE")-evil/x'}"); check "refused: reveal through .. into <base>-evil" refused "$R"
rm -rf "$BASE-evil"
for b in "{type:'badge', count:1e20}" "{type:'badge', count:NaN}" "{type:'badge', count:Infinity}" "{type:7}" "null" \
         "{type:'reveal', path:'/'+'x'.repeat(30*1024*1024)}" "{type:'quitState', live:new Boolean(true)}"; do
  R=$(bridge "$b"); check "refused: $(echo "$b" | cut -c1-60)" refused "$R"
done
sleep 0.6
T0=$(now); R=$(bridge "{type:'notify', title:'T'.repeat(20*1024*1024), body:'B'.repeat(20*1024*1024)}"); T1=$(now)
echo "  note  a 2 x 20 MB notify took $(echo "$T1 - $T0" | bc) s (6 s before the fix)"
check "a 2 x 20 MB notify is cut, not choked on (under 2 s)" awk -v d="$(echo "$T1 - $T0" | bc)" 'BEGIN { exit !(d < 2) }'
check "its title was cut to 120 characters" wait_for 5 bash -c "plutil -extract notifications json -o - '$ST/launcher-state.json' | grep -qE '\"T{120}\"' && ! plutil -extract notifications json -o - '$ST/launcher-state.json' | grep -qE 'T{121}'"
R=$(ws_eval twopf "const a = window.__ws.bridge({type:'pickFolder'}); const b = window.__ws.bridge({type:'pickFolder'}); return [await a, await b]")
check "two folder panels at once: the second is refused" bash -c "echo '$R' | grep -q 'picked-folder' && echo '$R' | grep -q 'a folder panel is already open'"
check "no reveal outside the WorkShop folder happened" bash -c "! plutil -extract reveals json -o - '$ST/launcher-state.json' | grep -qE '\"/etc|/private/etc'"
check "still one hub, still the same page" bash -c "[ $(hub_count) = 1 ] && [ $(state page.loads) = 1 ]"
check "nothing but http(s) ever went to the browser" bash -c "! plutil -extract externalOpens json -o - '$ST/launcher-state.json' | grep -qE '\"(file|javascript|mailto|ftp):'"
quit_app 30; end_case "page"
finish
