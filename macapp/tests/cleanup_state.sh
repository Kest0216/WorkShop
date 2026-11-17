#!/bin/bash
# Removes everything the scenario tests wrote outside their temp folders, then the temp folders.
# The app under test uses its own bundle id (local.workshop.app.test), so the real app's state is untouched.
# Per bundle id, the app writes:
#   ~/Library/Preferences/<id>.plist                window frame, page zoom
#   ~/Library/WebKit/<id>/                          localStorage, cookies, web data
#   ~/Library/Caches/<id>/, ~/Library/HTTPStorages/<id>/   WebKit HTTP cache and cookie store
#   ~/Library/Saved Application State/<id>.savedState
#   <per-user cache dir>/<id>, <per-user temp dir>/<id>
# Test copies of the app are unregistered from LaunchServices.
. "$(dirname "$0")/lib.sh"
ID="$TEST_ID"
case "$ID" in local.workshop.app.test) ;; *) echo "refusing: unexpected test id $ID"; exit 1 ;; esac

pkill -9 -f "$WS_TMP_ROOT/.*/WorkShop.app/Contents/MacOS/WorkShop" 2>/dev/null
pkill -9 -f "$WS_TMP_ROOT/.*/server/index.js" 2>/dev/null
if [ -d "$WS_TMP_ROOT" ]; then
  find "$WS_TMP_ROOT" -maxdepth 4 -name 'WorkShop.app' -type d 2>/dev/null | while read -r a; do "$LSREG" -u "$a" 2>/dev/null; done
fi
defaults delete "$ID" 2>/dev/null
for d in "$HOME/Library/WebKit/$ID" "$HOME/Library/Caches/$ID" "$HOME/Library/HTTPStorages/$ID" \
         "$HOME/Library/Saved Application State/$ID.savedState" "$(getconf DARWIN_USER_CACHE_DIR)$ID" "$(getconf DARWIN_USER_TEMP_DIR)$ID"; do
  rm -rf "$d"
done
sleep 1                                   # cfprefsd may write the file back once; remove it after that
rm -f "$HOME/Library/Preferences/$ID.plist"
KEEP="${1:-}"                             # "keep-results": keep the results folder (logs of the last run)
if [ "$KEEP" = keep-results ]; then
  find "$WS_TMP_ROOT" -mindepth 1 -maxdepth 1 ! -name results -exec rm -rf {} +
else
  rm -rf "$WS_TMP_ROOT"
fi
left=$(pgrep -fl "$WS_TMP_ROOT" | wc -l | tr -d ' ')
echo "cleanup: done (test processes left: $left)"
