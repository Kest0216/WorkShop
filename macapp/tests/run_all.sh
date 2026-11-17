#!/bin/bash
# Runs every scenario test, one at a time, and prints a pass/fail table.
# Windows appear on screen (behind other windows: every launch uses `open -g`). Each test quits its app
# and checks that no launcher, hub or child process is left. At the end, cleanup_state.sh removes the
# test app's preferences and web data. The output of each test stays in <temp>/workshop-tests/results/.
#   bash macapp/tests/run_all.sh                 all tests
#   bash macapp/tests/run_all.sh t_quit t_page   only these
. "$(dirname "$0")/lib.sh"
ALL="t_launch t_node t_missing_server t_paths t_second_launch t_attach t_window t_page t_quit t_orphans t_crash t_flood t_secrets t_realhub"
LIST="${*:-$ALL}"
mkdir -p "$RESULTS"
ensure_app || exit 1
ROWS=(); TP=0; TF=0
for t in $LIST; do
  printf 'run_all: %-18s ' "$t"
  T0=$(date +%s)
  bash "$TESTS/$t.sh" > "$RESULTS/$t.txt" 2>&1
  code=$?
  secs=$(( $(date +%s) - T0 ))
  line="$(grep '^RESULT ' "$RESULTS/$t.txt" | tail -1)"
  p="$(echo "$line" | sed -n 's/.*passed=\([0-9]*\).*/\1/p')"; f="$(echo "$line" | sed -n 's/.*failed=\([0-9]*\).*/\1/p')"
  [ -n "$p" ] || { p=0; f="?"; }
  verdict=PASS; { [ "$code" != 0 ] || [ "$f" != 0 ]; } && verdict=FAIL
  echo "$verdict ($p passed, $f failed, ${secs}s)"
  ROWS+=("$(printf '| %-18s | %-4s | %6s | %6s | %5ss |' "$t" "$verdict" "$p" "$f" "$secs")")
  TP=$((TP + p)); [ "$f" = "?" ] && TF=$((TF + 1)) || TF=$((TF + f))
  grep '  FAIL ' "$RESULTS/$t.txt" | sed 's/^/        /'
done
bash "$TESTS/cleanup_state.sh" keep-results
echo
echo "| test               | ok   | passed | failed |  time  |"
echo "|--------------------|------|--------|--------|--------|"
printf '%s\n' "${ROWS[@]}"
echo "| total              |      | $(printf '%6s' "$TP") | $(printf '%6s' "$TF") |        |"
echo
echo "logs: $RESULTS"
[ "$TF" = 0 ]
