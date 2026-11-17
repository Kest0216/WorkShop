#!/bin/bash
# The launcher with the REAL hub (mock lab only), not the stub.
# The temp base holds the test app and COPIES of server/, ui/ and config/models.json: the app and its children
# never read a file under ~/Desktop (macOS would ask the owner for Desktop access). server/index.js in the copy is
# a wrapper: it runs the real entry point (copied to server/hub-main.js) with --labs mock --secrets file, because
# the launcher passes no arguments. It also points TMPDIR into the base, so the mock agents' memory goes away
# with it. No real AI CLI runs; no Keychain item is read.
#  A. launch: READY, the real UI loads, the page opens the session, "#k=" leaves the address, /api/state is 200
#  E. the native bridge from the real page: quitState, badge, notify (recorded in self-test mode, no prompt)
#  B. POST /api/demo from the page; the job runs; Quit asks; Pause and quit pauses it; the hub stops in time;
#     nothing is left; the saved state has the job paused
#  C. launch again: the job is still paused and the page shows it; resume, ship the truck head, done
#  D. a running job, then kill -9 of the launcher: the hub and every mock agent are gone within seconds
#  F. a running job, then kill -9 of the launcher AND the hub at once: the agents live on until the next start,
#     whose hub kills them at boot
. "$(dirname "$0")/lib.sh"
ROOT="$(cd "$MACAPP/.." && pwd -P)"
NODE="$(find_node)" || { echo "no node"; exit 1; }

new_base realhub nostub
BASE_REAL="$(cd "$BASE" && pwd -P)"
cp -R "$ROOT/server" "$ROOT/ui" "$BASE/"
mkdir -p "$BASE/config" "$BASE/tmp"
cp "$ROOT/config/models.json" "$BASE/config/models.json"
printf '{"mockSpeed":1}\n' > "$BASE/config/settings.json"        # the demo runs at its own pace: agents stay mid-turn
mv "$BASE/server/index.js" "$BASE/server/hub-main.js"
cat > "$BASE/server/index.js" <<'EOF'
process.env.TMPDIR = new URL('../tmp/', import.meta.url).pathname; // test wrapper: agents keep temp files in the base
const { main } = await import('./hub-main.js'); // the real entry point; it does not run main() by itself when imported
main(['--labs', 'mock', '--secrets', 'file']); // the launcher passes no arguments: the mock lab only, no Keychain
EOF

echo "=== setup"
check "the copy holds no symlink" bash -c "[ -z \"\$(find '$BASE' -type l)\" ]"
check "no file in the copy names the real WorkShop folder" bash -c "! grep -rqF '$ROOT' '$BASE/server' '$BASE/ui' '$BASE/config'"
check "the real entry point only runs main() as the entry script" grep -q "if (isEntry) main()" "$BASE/server/hub-main.js"
echo "  note  node $NODE ($("$NODE" --version))"

MOCK_RX="mock-agent[.]mjs"
# Processes of this base: a command line that names it, or a working folder inside it.
base_procs() {
  {
    pgrep -f "$(path_rx "$BASE")"; [ "$BASE" = "$BASE_REAL" ] || pgrep -f "$(path_rx "$BASE_REAL")"
    /usr/sbin/lsof -d cwd -Fpn 2>/dev/null | awk -v a="$BASE" -v b="$BASE_REAL" '/^p/ { p = substr($0, 2) } /^n/ { n = substr($0, 2); if (n == a || n == b || index(n, a "/") == 1 || index(n, b "/") == 1) print p }'
  } | sort -u
}
mock_pids() {   # mock agents of this base: node <base>/server/providers/mock-agent.mjs
  { pgrep -f "$(path_rx "$BASE")/server/providers/$MOCK_RX"; pgrep -f "$(path_rx "$BASE_REAL")/server/providers/$MOCK_RX"; } | sort -u
}
mock_count() { mock_pids | wc -l | tr -d ' '; }
nothing_left() { [ -z "$(base_procs)" ]; }
any_alive() { local p; for p in "$@"; do kill -0 "$p" 2>/dev/null && return 0; done; return 1; }
jv() {          # jv '<eval result JSON>' [path]   prints the value (strings bare)
  "$NODE" -e 'let v; try { v = JSON.parse(process.argv[1]).v; } catch { v = null; } for (const k of (process.argv[2] || "").split(".").filter(Boolean)) v = v == null ? v : v[k]; process.stdout.write(typeof v === "string" ? v : JSON.stringify(v ?? null));' "$1" "${2:-}"
}
saved() {       # saved <js expression on s = data/state.json>
  "$NODE" -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(String(eval(process.argv[2])));' "$BASE/data/state.json" "$1" 2>/dev/null
}
API="const api = async (m, p, b) => { const r = await fetch(p, { method: m, headers: { 'X-WorkShop': '1', 'Content-Type': 'application/json', Accept: 'application/json' }, body: m === 'GET' ? undefined : JSON.stringify(b || {}) }); let j = null; try { j = await r.json(); } catch {} return { status: r.status, body: j }; };"
page_api() { ws_eval "a$RANDOM" "$API const r = await api($1); return r"; }    # page_api "'POST', '/api/demo', {}"
job_status() { jv "$(ws_eval "j$RANDOM" "$API const r = await api('GET', '/api/state'); return r.status === 200 ? ((r.body.state.jobs['$1'] || {}).status || 'none') : 'http ' + r.status")"; }
job_is() { [ "$(job_status "$1")" = "$2" ]; }
running_with_agents() { job_is "$1" running && [ "$(mock_count)" -ge 1 ]; }
no_desktop_reads() {    # no process of the app has a file open under ~/Desktop right now
  local p pids; pids="$(base_procs | tr '\n' ',' | sed 's/,$//')"
  [ -n "$pids" ] || return 0
  ! /usr/sbin/lsof -p "$pids" 2>/dev/null | grep -qF "$HOME/Desktop"
}

echo "=== A. launch with the real hub"
ws_open WORKSHOP_NODE="$NODE"
check "the page loads" wait_page 1 90
check "the launcher read the ready line" has "hub: READY on port" "$LOG"
LP=$(launcher_pid); HP=$(hub_pids | head -1); PORT=$(state hub.port)
check "the hub runs the real code with no arguments" bash -c "ps -o command= -p '$HP' | grep -qE 'node $(path_rx "$BASE")/server/index[.]js\$|node $(path_rx "$BASE_REAL")/server/index[.]js\$'"
check "hub.lock holds the hub pid and the real port" bash -c "grep -q '\"pid\":$HP,\"port\":$PORT}' '$BASE/data/run/hub.lock'"
echo "  note  port $PORT (preferred 47117)"
[ "$PORT" = 47117 ] || check "the preferred port was busy" bash -c "lsof -nP -iTCP:47117 -sTCP:LISTEN | grep -q LISTEN"
check "the hub's state, logs and projects stay in the base" bash -c "[ -f '$BASE/data/logs/hub.log' ] && [ -d '$BASE/data/run' ]"
R=$(ws_eval a1 "const st = await fetch('/api/state', { headers: { Accept: 'application/json' } }); return { title: document.title, app: !!document.querySelector('#scene') && !!document.querySelector('#nav'), hash: location.hash, state: st.status, cookieSeen: document.cookie.includes('workshop_owner') }")
check "the page is the real UI" [ "$(jv "$R" app)" = true ]
check "its title is WorkShop" [ "$(jv "$R" title)" = WorkShop ]
check "the page has no #k= in its address" [ "$(jv "$R" hash)" = "" ]
check "GET /api/state from the page answers 200 (the page posted the key to /api/session)" [ "$(jv "$R" state)" = 200 ]
check "the session cookie is HttpOnly (the page cannot read it)" [ "$(jv "$R" cookieSeen)" = false ]
check "the launcher holds the session cookie" [ "$(state page.sessionCookies)" -ge 1 ]
check "the launcher sees no fragment" state_is page.hasFragment false
check "no history entry keeps the key" state_is history.anyFragmentWithKey false
sleep 5.5
check "the page removed the fragment itself (the launcher's 5 s safety net did nothing)" hasnt "key fragment was still in the address" "$LOG"
check "nothing of the app reads under ~/Desktop" no_desktop_reads

echo "=== E. native bridge from the real page"
R=$(ws_eval e1 "const w = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.workshop; if (!w) return 'no bridge'; const q = await w.postMessage({ type: 'quitState', live: false }); const b = await w.postMessage({ type: 'badge', count: 2 }); return { q, b }")
check "window.webkit.messageHandlers.workshop exists for the hub origin" bash -c "[ '$(jv "$R")' != '\"no bridge\"' ]"
check "quitState resolves ok" [ "$(jv "$R" q.ok)" = true ]
check "badge resolves ok" [ "$(jv "$R" b.ok)" = true ]
check "the Dock badge shows 2" wait_state 5 dockBadge 2
R=$(ws_eval e2 "const w = window.webkit.messageHandlers.workshop; const n = await w.postMessage({ type: 'notify', title: 'WorkShop test', body: 'from the real page' }); const b = await w.postMessage({ type: 'badge', count: 0 }); return { n, b }")
check "notify resolves ok (self-test mode records it: no permission prompt)" [ "$(jv "$R" n.ok)" = true ]
check "the notification was recorded" wait_for 5 state_json_has notifications "WorkShop test"
check "badge 0 clears the badge" wait_state 5 dockBadge ""

echo "=== B. a live job, then Quit: Pause and quit"
R=$(page_api "'POST', '/api/demo', {}")
J=$(jv "$R" body.id)
check "POST /api/demo from the page starts a job" bash -c "[ '$(jv "$R" status)' = 200 ] && echo '$J' | grep -qE '^J[0-9]+\$'"
check "the job reaches running with mock agents mid-turn" wait_for 120 running_with_agents "$J"
echo "  note  mock agents now: $(mock_count)"
check "nothing of the app reads under ~/Desktop" no_desktop_reads
HP=$(hub_pids | head -1)
cmd "answer 2"; cmd quit
check "the quit question appears" wait_for 20 has 'dialog 1 (quit-live): “A job is still working”' "$SLOG"
check "its buttons are Keep working, Pause and quit" has 'buttons=\["Keep working", "Pause and quit"\] -> pressing “Pause and quit”' "$SLOG"
check "the app quits" wait_gone 30 "$LP"
check "the launcher paused the job through the hub" has "quit: paused job $J" "$LOG"
check "no pause failed" hasnt "quit: pause failed" "$LOG"
check "the hub stopped within 5 s of stdin end-of-file" has "hub: ended after its stdin closed (exit code 0)" "$LOG"
check "the hub left nothing in its process group" hasnt "killed leftover members of process group" "$LOG"
check "the hub left no descendant behind" hasnt "killed leftover descendants" "$LOG"
check "the hub process is gone" wait_gone 5 "$HP"
check "no hub, mock agent or check process is left" wait_for 5 nothing_left
check "the saved state has the job paused by the owner" [ "$(saved "s.jobs.$J.status + '/' + s.jobs.$J.pauseReason")" = paused/owner ]
check "hub.lock is gone, launcher.lock stays" bash -c "[ ! -e '$BASE/data/run/hub.lock' ] && [ -e '$BASE/data/run/launcher.lock' ]"
end_case "B"

echo "=== C. launch again: the job is still paused; resume, ship, done"
new_selftest_dir selftest-c
ws_open WORKSHOP_NODE="$NODE"
check "the page loads" wait_page 1 90
LP=$(launcher_pid)
check "the job is still paused" job_is "$J" paused
check "no mock agent runs for the paused job" [ "$(mock_count)" = 0 ]
page_shows() { [ "$(jv "$(ws_eval "p$RANDOM" "return document.body.innerText.includes('Recipe Box') || document.body.innerText.includes('$J')")")" = true ]; }
check "the page shows the job" wait_for 15 page_shows
R=$(page_api "'POST', '/api/jobs/$J/resume', {}")
check "resume from the page answers 200" [ "$(jv "$R" status)" = 200 ]
delivering() { [ "$(jv "$(ws_eval "d$RANDOM" "$API const r = await api('GET', '/api/state'); const j = r.body.state.jobs['$J']; return j.status === 'delivering' && !!j.report")")" = true ]; }
check "the job runs on to delivering with a report" wait_for 400 delivering
# The truck head goes from the page straight to the ship call: the self-test log redacts 40-hex values.
R=$(ws_eval ship "$API const t = await api('GET', '/api/jobs/$J/truck'); const h = t.body && t.body.headSha; const s = /^[0-9a-f]{40}$/.test(h || '') ? await api('POST', '/api/jobs/$J/ship', { sha: h }) : null; return { head: /^[0-9a-f]{40}$/.test(h || ''), ship: s && s.body }")
check "the truck has a head (a commit id)" [ "$(jv "$R" head)" = true ]
check "ship the truck head" [ "$(jv "$R" ship.ok)" = true ]
check "the job is done" wait_for 60 job_is "$J" done
cmd quit
check "Quit with no live job ends the app without a question" wait_gone 30 "$LP"
check "no question was asked" hasnt "(quit-live)" "$SLOG"
check "the hub stopped on stdin end-of-file" has "hub: ended after its stdin closed (exit code 0)" "$LOG"
check "no hub, mock agent or check process is left" wait_for 5 nothing_left
end_case "C"

echo "=== D. a running job, then kill -9 of the launcher"
rm -rf "$BASE/data/state.json" "$BASE/data/work" "$BASE/projects"
new_selftest_dir selftest-d
ws_open WORKSHOP_NODE="$NODE"
check "the page loads" wait_page 1 90
LP=$(launcher_pid); HP=$(hub_pids | head -1)
R=$(page_api "'POST', '/api/demo', {}"); J=$(jv "$R" body.id)
check "the job reaches running with mock agents mid-turn" wait_for 120 running_with_agents "$J"
MOCKS=$(mock_pids | tr '\n' ' ')
kill -9 "$LP"; T0=$(perl -MTime::HiRes=time -e 'printf "%.2f", time')
check "the launcher is gone" wait_gone 5 "$LP"
check "the hub is gone within 5 s" wait_gone 5 "$HP"
check "every mock agent is gone" bash -c "! kill -0 $MOCKS 2>/dev/null"
check "nothing of the base is left" wait_for 5 nothing_left
echo "  note  all gone $(perl -MTime::HiRes=time -e "printf '%.2f', time - $T0") s after kill -9"
check "the hub paused the job as it stopped" [ "$(saved "s.jobs.$J.status")" = paused ]
check "with the reason in job.error" bash -c "echo '$(saved "s.jobs.$J.error")' | grep -q 'the WorkShop app quit'"
end_case "D"

echo "=== F. kill -9 of the launcher and the hub at once; the next start kills the leftovers"
new_selftest_dir selftest-f
ws_open WORKSHOP_NODE="$NODE"
check "the page loads" wait_page 1 90
LP=$(launcher_pid); HP=$(hub_pids | head -1)
R=$(page_api "'POST', '/api/jobs/$J/resume', {}")
check "resume answers 200" [ "$(jv "$R" status)" = 200 ]
check "the job runs with mock agents mid-turn" wait_for 120 running_with_agents "$J"
sleep 0.5                                                   # the runner writes data/run/<agent>/turn.json at spawn
MOCKS=$(mock_pids | tr '\n' ' ')
kill -9 "$LP" "$HP"
check "the launcher and the hub are gone" wait_for 5 bash -c "! kill -0 $LP 2>/dev/null && ! kill -0 $HP 2>/dev/null"
sleep 0.3
check "their mock agents live on (nobody swept them)" any_alive $MOCKS
new_selftest_dir selftest-f2
ws_open WORKSHOP_NODE="$NODE"
check "the page loads" wait_page 1 90
LP=$(launcher_pid)
check "the new hub killed the agents of the dead one" wait_for 10 bash -c "! kill -0 $MOCKS 2>/dev/null"
check "it says so in its log" has "killed agent processes of an earlier hub" "$BASE/data/logs/hub.log"
live_now() { case "$(job_status "$J")" in planning|plan_review|running|qa|delivering) return 0 ;; *) return 1 ;; esac; }
check "the job goes on (a crash is not a stop: crash recovery)" wait_for 30 live_now
cmd "answer 2"; cmd quit
check "Quit asks again (the job is live)" wait_for 20 has '(quit-live)' "$SLOG"
check "Pause and quit ends the app" wait_gone 30 "$LP"
check "no hub, mock agent or check process is left" wait_for 5 nothing_left
check "the job is paused on disk" [ "$(saved "s.jobs.$J.status")" = paused ]
end_case "F"
mem_hashes() {  # the mock agent's memory folder names for the jobs of this base (it hashes the bench path)
  local b j; for b in "$BASE" "$BASE_REAL"; do for j in J1 J2 J3; do
    "$NODE" -e 'process.stdout.write("j-" + require("crypto").createHash("sha256").update(process.argv[1]).digest("hex").slice(0, 16) + "\n")' "$b/data/work/$j"
  done; done
}
check "the mock agents kept their memory inside the base" [ -d "$BASE/tmp/workshop-mock" ]
USER_MEM="$(getconf DARWIN_USER_TEMP_DIR)workshop-mock"
check "none of it went to the user's temp folder" bash -c "for h in $(mem_hashes | tr '\n' ' '); do [ -e '$USER_MEM/'\$h ] && exit 1; done; exit 0"
finish
