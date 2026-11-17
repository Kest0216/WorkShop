#!/bin/bash
# Launch from a Finder-like environment (PATH=/usr/bin:/bin:/usr/sbin:/sbin):
# node lookup through the login shell, hub start as in contract section 3b, the READY line,
# the owner session, the injected page style, and a clean quit.
# Then the same launch with plain `open` from this shell: the hub environment must be the same.
. "$(dirname "$0")/lib.sh"
KEY="$(openssl rand -hex 32)"

echo "=== A. Finder-like launch"
new_base launch
ws_open WORKSHOP_STUB_KEY="$KEY"
check "the page loads" wait_page 1 90
sleep 1
LP=$(launcher_pid); HP=$(hub_pids | head -1)
check "launched with the Finder PATH" has "launch: PATH=/usr/bin:/bin:/usr/sbin:/sbin" "$LOG"
check "node found through the login shell" has "hub: node v.* \[login shell" "$LOG"
check "hub started with no arguments" has 'START .* argv=\[\] ' "$REQ"
check "hub working folder is the WorkShop folder" has "START .* cwd=$(cd "$BASE" && pwd -P) argv" "$REQ"
check "hub stdin is a pipe held by the launcher" has "WATCHDOG on" "$REQ"
check "hub is a child of the launcher" [ "$(ps -o ppid= -p "$HP" | tr -d ' ')" = "$LP" ]
check "hub leads its own process group" [ "$(ps -o pgid= -p "$HP" | tr -d ' ')" = "$HP" ]
check "hub got the login PATH as WORKSHOP_PATH" has "ENV WORKSHOP_PATH=/" "$REQ"
check "hub PATH finds git and node" has 'ENV found={"git":"/[^"]*","node":"/' "$REQ"
check "lock file data/run/hub.lock holds the hub pid" has "\"pid\":$HP," "$BASE/data/run/hub.lock"
check "page posted the key once and got the cookie" has "REQ POST /api/session -> 200" "$REQ"
check "state call carries the owner cookie" has "REQ GET /api/state -> 200 cookie=yes" "$REQ"
check "SSE stream is open" has "SSE open id=1 since=1000" "$REQ"
check "page removed the key fragment" has '"hadKey":true,"session":200,"stateStatus":200,"hashAfter":""' "$REQ"
check "launcher sees no fragment in the page address" state_is page.hasFragment false
check "launcher holds the session cookie (memory only)" [ "$(state page.sessionCookies)" -ge 1 ]
check "secure context and native bridge present" has '"bridge":true,"dpr":[0-9.]*,"secureContext":true' "$REQ"
check "canvas renders pixelated (injected style, page CSP on)" has '"imageRendering":"pixelated"' "$REQ"
check "canvas cannot be selected" has '"userSelect":"none"' "$REQ"
check "no rubber-band scrolling" has '"overscrollY":"none"' "$REQ"
check "window title is WorkShop" state_is window.title WorkShop
check "minimum content size is 1000 x 640" state_is window.minContentSize "{1000, 640}"
check "developer extras are off" state_is inspectable false
check "the key is not in the launcher log" hasnt "$KEY" "$LOG"
check "the key is not in the stub log" hasnt "$KEY" "$REQ"
check "SSE keeps flowing" wait_for 30 has '"kind":"sse","messages":5' "$REQ"
PATH_A="$(grep 'ENV PATH=' "$REQ" | sed 's/.*ENV PATH=//')"
NAMES_A="$(grep 'ENV found' "$REQ" | sed 's/.*names=//')"
quit_app 30
check "SIGTERM quits the app" [ -z "$(launcher_pid)" ]
check "hub shut down on stdin end-of-file" has "SHUTDOWN reason=stdin-eof" "$REQ"
check "lock file removed by the hub" [ ! -e "$BASE/data/run/hub.lock" ]
end_case "A"

echo "=== B. plain open from this shell (it forwards the caller's environment)"
rm -rf "$BASE/data"; new_selftest_dir selftest2
CALLER_VARS=$(env | grep -cE '^(CLAUDE|ANTHROPIC)')
/usr/bin/open -g --env "WORKSHOP_SELFTEST_DIR=$ST" --env "WORKSHOP_STUB_KEY=$KEY" "$APP"
check "the page loads" wait_page 1 90
sleep 0.5
echo "  note  this shell has $CALLER_VARS CLAUDE*/ANTHROPIC* variables"
check "hub environment has no CLAUDE or ANTHROPIC names" bash -c "grep 'ENV found' '$REQ' | grep -vqE 'CLAUDE|ANTHROPIC'"
check "hub got the same variable names as in A" [ "$(grep 'ENV found' "$REQ" | sed 's/.*names=//')" = "$NAMES_A" ]
check "hub got the same PATH as in A" [ "$(grep 'ENV PATH=' "$REQ" | sed 's/.*ENV PATH=//')" = "$PATH_A" ]
quit_app 30
end_case "B"
finish
