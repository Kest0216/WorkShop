#!/bin/bash
# Builds WorkShop.app: swiftc -> bundle -> pixel-art icon (node + sips + iconutil) -> ad-hoc codesign.
# No Xcode project, no npm, no Electron. Needs Xcode or the Command Line Tools (swiftc) and Node.js (icon only).
#
#   macapp/build.sh                 build <WorkShop folder>/WorkShop.app (the folder that holds macapp/)
#   macapp/build.sh <folder>        build <folder>/WorkShop.app (the tests use this)
#   macapp/build.sh --force [...]   rebuild even when nothing changed
#
# The app must sit next to server/, ui/ and data/: it starts <its folder>/server/index.js.
#
# Layout of macapp/:
#   src/main.swift       app delegate, window, menus, startup, quit       src/Support.swift   log, redactor, spawn, process table
#   src/Hub.swift        hub process, lock file, startup plan             src/Node.swift      node lookup, login PATH
#   src/Web.swift        web view delegates, navigation lock, downloads   src/Bridge.swift    window.webkit.messageHandlers.workshop
#   src/StatusView.swift native status and error view                     src/SelfTest.swift  test hooks (inert unless set)
#   src/Info.plist       bundle settings                                  tools/make_icon.js  draws the icon
#   stub/                a stub hub that speaks the contract (tests)      tests/              scenario tests, run_all.sh
#   build/               build cache (safe to delete)
#
# Tests (each launches real windows, in the background, from temp folders; never against ../data):
#   bash macapp/tests/run_all.sh [t_name ...]   all scenario tests, one at a time, then a pass/fail table
#   bash macapp/tests/cleanup_state.sh          removes the test app's preferences, web data and temp folders
#   t_launch (Finder-like launch, ready line, session)   t_node (node lookup, noisy/missing shell, odd node path)
#   t_missing_server (error views)   t_paths (spaces + non-ASCII folder, read-only folder)
#   t_second_launch, t_attach (one hub per data folder, simultaneous starts)  t_window (close/reopen, menus, frame)
#   t_page (dialogs, files, downloads, links, bridge, hostile page)  t_quit (live job question, pause route, log out)
#   t_orphans (kill -9, stubborn hub, hub crash with children, quit during startup)  t_crash (hub crash, restart, wake)
#   t_flood (20 MB of hub output)   t_secrets (owner key never kept)
# Test helper scripts (slowshell.sh, junkshell.sh) are copied into the temp folder before use: the app under
# test must never read anything under ~/Desktop, or macOS asks the owner for Desktop access in its name.
# The app under test is built with WORKSHOP_BUNDLE_ID=local.workshop.app.test, so the real app's state is untouched.
#
# Launcher -> hub contract (docs/ARCHITECTURE.md 3b and 6; details in src/Hub.swift and src/Bridge.swift):
#   <node> <base>/server/index.js, cwd <base>, stdin = a pipe the launcher never writes (EOF = launcher gone),
#   stdout line "WORKSHOP_READY http://127.0.0.1:<port>/#k=<ownerKey>", lock <base>/data/run/hub.lock {pid,port},
#   env: clean base + PATH (node dir, login PATH, known dirs) + WORKSHOP_PATH (login PATH) + WORKSHOP_LAUNCHER_PID.
#   The launcher itself holds data/run/launcher.lock (flock, its pid as text) for its whole life: the hub
#   must leave that file alone.
#
# Why "skip when nothing changed": an ad-hoc signature has no stable identity. macOS privacy permissions
# (TCC) are tied to the app's code hash (cdhash). A rebuild that changes the bundle makes macOS ask again
# for the Desktop folder. The build is reproducible: the same sources give the same cdhash.
#
# Environment:
#   WORKSHOP_BUNDLE_ID      CFBundleIdentifier (default: the one in src/Info.plist, local.workshop.app)
#   WORKSHOP_SIGN_IDENTITY  codesign identity (default "-" = ad-hoc)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="WorkShop"
MIN_OS="14.0"
FORCE=0
OUT_DIR=""
for a in "$@"; do
  case "$a" in
    --force) FORCE=1 ;;
    -*) echo "build: unknown option $a" >&2; exit 2 ;;
    *) OUT_DIR="$a" ;;
  esac
done
[ -n "$OUT_DIR" ] || OUT_DIR="$(dirname "$HERE")"
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
APP="$OUT_DIR/$APP_NAME.app"
BUILD="$HERE/build"
SIGN_ID="${WORKSHOP_SIGN_IDENTITY:--}"
BUNDLE_ID="${WORKSHOP_BUNDLE_ID:-$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$HERE/src/Info.plist")}"

say() { printf 'build: %s\n' "$*"; }
die() { printf 'build: ERROR: %s\n' "$*" >&2; exit 1; }
sha() { shasum -a 256 | awk '{print $1}'; }

xcrun --sdk macosx --find swiftc >/dev/null 2>&1 || die "swiftc not found. Install Xcode or run: xcode-select --install"
# Always go through xcrun: it exports SDKROOT. Calling the toolchain's swiftc directly stamps the binary
# with the deployment target as its SDK, and AppKit/WebKit then run it in old-SDK compatibility mode.
swiftc_x() { xcrun --sdk macosx swiftc "$@"; }

SOURCES=("$HERE"/src/*.swift)
CODE_HASH="$( { shasum -a 256 "${SOURCES[@]}" | awk '{print $1}'; swiftc_x --version 2>&1; echo "$MIN_OS"; } | sha)"
ICON_HASH="$(shasum -a 256 "$HERE/tools/make_icon.js" | awk '{print $1}')"
INPUT_HASH="$( { echo "$CODE_HASH $ICON_HASH $BUNDLE_ID $SIGN_ID"; shasum -a 256 "$HERE/src/Info.plist" "$HERE/build.sh" | awk '{print $1}'; } | sha)"
mkdir -p "$BUILD"
# The stamp lives OUTSIDE the bundle: the bundle's code hash must depend only on what the app contains.
STAMP="$BUILD/stamp-$(printf '%s' "$APP" | sha | cut -c1-16)"

# ---- 1. skip when nothing changed (keeps the code hash, and with it the macOS privacy grants)
if [ "$FORCE" = 0 ] && [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$INPUT_HASH" ] && [ -d "$APP" ] && codesign --verify --strict "$APP" 2>/dev/null; then
  say "up to date ($APP). Nothing rebuilt, signature unchanged."
  codesign -dvvv "$APP" 2>&1 | grep -E '^CDHash=' | sed 's/^/build: /'
  exit 0
fi

# ---- 2. compile (one swiftc call; the binary is cached by the hash of the sources)
BIN="$BUILD/bin-${CODE_HASH:0:16}/$APP_NAME"
if [ "$FORCE" = 1 ] || [ ! -x "$BIN" ]; then
  say "compiling ${#SOURCES[@]} Swift files ($(swiftc_x --version 2>&1 | head -1))"
  mkdir -p "$(dirname "$BIN")"
  swiftc_x -O -swift-version 5 -target "arm64-apple-macos$MIN_OS" -module-name "$APP_NAME" -o "$BIN.tmp" "${SOURCES[@]}"
  mv "$BIN.tmp" "$BIN"
  find "$BUILD" -maxdepth 1 -type d -name 'bin-*' ! -name "bin-${CODE_HASH:0:16}" -exec rm -rf {} +
else
  say "compiled binary is up to date"
fi

# ---- 3. icon: generated pixel art -> iconset (sips) -> .icns (iconutil), cached by the hash of the generator
find_node() {
  if command -v node >/dev/null 2>&1; then command -v node; return; fi
  local c
  for c in $(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V -r) "$HOME/.volta/bin/node" /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -x "$c" ] && { echo "$c"; return; }
  done
  return 1
}
ICNS="$BUILD/AppIcon-${ICON_HASH:0:16}.icns"
if [ "$FORCE" = 1 ] || [ ! -f "$ICNS" ]; then
  NODE="$(find_node)" || die "node not found (needed to draw the icon)"
  ICONSET="$BUILD/AppIcon.iconset"
  rm -rf "$ICONSET"; mkdir -p "$ICONSET"
  "$NODE" "$HERE/tools/make_icon.js" "$BUILD/icon_1024.png" 1024 >/dev/null
  for spec in "16 icon_16x16" "32 icon_16x16@2x" "32 icon_32x32" "64 icon_32x32@2x" "128 icon_128x128" \
              "256 icon_128x128@2x" "256 icon_256x256" "512 icon_256x256@2x" "512 icon_512x512"; do
    set -- $spec
    "$NODE" "$HERE/tools/make_icon.js" "$ICONSET/$2.png" "$1" >/dev/null       # drawn at each size: crisp cells, no resampling
  done
  cp "$BUILD/icon_1024.png" "$ICONSET/icon_512x512@2x.png"
  iconutil -c icns "$ICONSET" -o "$ICNS"
  find "$BUILD" -maxdepth 1 -type f -name 'AppIcon-*.icns' ! -name "AppIcon-${ICON_HASH:0:16}.icns" -delete
  rm -rf "$ICONSET"
fi

# ---- 4. stage the bundle, sign it (ad-hoc unless WORKSHOP_SIGN_IDENTITY is set), verify
STAGE_ROOT="$BUILD/stage-$$"
STAGE="$STAGE_ROOT/$APP_NAME.app"
rm -rf "$STAGE_ROOT"
mkdir -p "$STAGE/Contents/MacOS" "$STAGE/Contents/Resources"
cp "$BIN" "$STAGE/Contents/MacOS/$APP_NAME"
cp "$ICNS" "$STAGE/Contents/Resources/AppIcon.icns"
cp "$HERE/src/Info.plist" "$STAGE/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $BUNDLE_ID" "$STAGE/Contents/Info.plist"
plutil -lint "$STAGE/Contents/Info.plist" >/dev/null || die "Info.plist is not valid"
printf 'APPL????' > "$STAGE/Contents/PkgInfo"
xattr -cr "$STAGE"
codesign --force --sign "$SIGN_ID" --identifier "$BUNDLE_ID" "$STAGE"
codesign --verify --strict --verbose=2 "$STAGE" 2>&1 | sed 's/^/build: /'

# ---- 5. swap into place (new files, new inodes: a running copy keeps its old binary)
if pgrep -f "$APP/Contents/MacOS/$APP_NAME" >/dev/null 2>&1; then say "note: $APP_NAME is running; quit and reopen it to use the new build"; fi
if [ -e "$APP" ]; then mv "$APP" "$STAGE_ROOT/previous.app"; fi
mv "$STAGE" "$APP"
rm -rf "$STAGE_ROOT"
touch "$APP"
echo "$INPUT_HASH" > "$STAMP"

say "built $APP"
codesign -dvvv "$APP" 2>&1 | grep -E '^(Identifier|Format|Signature|CDHash)' | sed 's/^/build: /'
say "$(vtool -show-build "$APP/Contents/MacOS/$APP_NAME" | awk '/minos/{m=$2} / sdk/{s=$2} END{print "min macOS " m ", built with SDK " s}')"
