#!/bin/bash
# The hub prints a lot: 10 MB on stdout and 10 MB on stderr at once, in short lines and in one huge line.
# The launcher must stay responsive (the window's run loop is not busy with hub output), keep its memory
# flat, keep its own log small, and still show the right last lines (redacted) if the hub then crashes.
. "$(dirname "$0")/lib.sh"
KEY="$(openssl rand -hex 32)"
now() { perl -MTime::HiRes=time -e 'printf "%.2f", time'; }
rss() { ps -o rss= -p "$(launcher_pid)" | tr -d ' '; }
lt() { awk -v a="$1" -v b="$2" 'BEGIN { exit !(a < b) }'; }
new_base flood
ws_open WORKSHOP_STUB_KEY="$KEY"
check "the page loads" wait_page 1 90
RSS0=$(rss); echo "  note  launcher memory before: $RSS0 KB"
for spec in "10 100 short-lines" "10 4000000 4-MB-lines"; do
  set -- $spec
  ws_eval "f$2" "return (await window.__ws.api('POST', '/api/stub/flood', {mb: $1, lineBytes: $2})).status" >/dev/null
  T1=$(now); ws_eval "ping$2" "return 1" >/dev/null; T2=$(now)
  D=$(echo "$T2 - $T1" | bc)
  echo "  note  $3: a page round trip during the flood took $D s"
  check "$3: the window answers during the flood (under 1.5 s; it was 3.8 s before the fix)" lt "$D" 1.5
  check "$3: the hub could write all 20 MB" wait_for 60 has "FLOOD done mb=$1 lineBytes=$2" "$REQ"
  echo "  note  $3: $(grep "FLOOD done mb=$1 lineBytes=$2" "$REQ" | sed 's/.*FLOOD done //')"
  sleep 1
  RSS1=$(rss); echo "  note  $3: launcher memory after: $RSS1 KB"
  check "$3: launcher memory stays flat (less than 60 MB more)" lt "$RSS1" $((RSS0 + 61440))
done
check "the flood did not go into the launcher log (it stays small)" lt "$(wc -c < "$LOG")" 200000
check "the page still works" bash -c "echo '$(ws_eval st "return (await window.__ws.api('GET', '/api/state')).status")' | grep -q 200"
ws_eval crash "return (await window.__ws.api('POST', '/api/stub/crash', {})).status" >/dev/null
check "a crash after the flood shows the error view" wait_state 30 status.kind hub-stopped
check "it shows the crash lines, not flood lines, at the end" state_has status.detail "TypeError: cannot read properties of undefined"
check "the owner key is redacted there" bash -c "! plutil -extract status json -o - '$ST/launcher-state.json' | grep -q '$KEY'"
check "no flood line is longer than 2000 characters in the view" bash -c "plutil -extract status.detail raw -o - '$ST/launcher-state.json' | awk 'length > 2000 { exit 1 }'"
check "the owner key is not in the launcher log" hasnt "$KEY" "$LOG"
quit_app 30; end_case "flood"
finish
