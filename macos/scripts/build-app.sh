#!/bin/sh
set -eu
GAUGE_MACOS_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
GAUGE_PROXY_HOST=""
if [ "$#" -gt 0 ]; then
    if [ "$#" -ne 2 ] || [ "$1" != "--proxy-host" ]; then
        echo 'Usage: build-app.sh [--proxy-host SSH_HOST]' >&2
        exit 2
    fi
    GAUGE_PROXY_HOST=$2
fi
swift build --package-path "$GAUGE_MACOS_DIR" -c release
GAUGE_BINARY_DIR=$(swift build --package-path "$GAUGE_MACOS_DIR" -c release --show-bin-path)
GAUGE_BUNDLE="$GAUGE_MACOS_DIR/dist/Gauge.app"
mkdir -p "$GAUGE_BUNDLE/Contents/MacOS" "$GAUGE_BUNDLE/Contents/Helpers"
cp "$GAUGE_BINARY_DIR/GaugeMenuBar" "$GAUGE_BUNDLE/Contents/MacOS/GaugeMenuBar"
cp "$GAUGE_BINARY_DIR/gauge-proxy-usage" "$GAUGE_BUNDLE/Contents/Helpers/gauge-proxy-usage"
cp "$GAUGE_MACOS_DIR/Resources/Info.plist" "$GAUGE_BUNDLE/Contents/Info.plist"
GAUGE_SOURCE_REVISION=$(git -C "$GAUGE_MACOS_DIR" rev-parse HEAD)
/usr/libexec/PlistBuddy -c "Add :GaugeSourceRevision string $GAUGE_SOURCE_REVISION" "$GAUGE_BUNDLE/Contents/Info.plist"
if [ -n "$(git -C "$GAUGE_MACOS_DIR" status --porcelain -- .)" ]; then
    /usr/libexec/PlistBuddy -c 'Add :GaugeSourceDirty bool true' "$GAUGE_BUNDLE/Contents/Info.plist"
fi
if [ -n "$GAUGE_PROXY_HOST" ]; then
    /usr/libexec/PlistBuddy -c "Add :GaugeDefaultProxyHost string $GAUGE_PROXY_HOST" "$GAUGE_BUNDLE/Contents/Info.plist"
fi
codesign --force --sign - --timestamp=none "$GAUGE_BUNDLE/Contents/Helpers/gauge-proxy-usage"
codesign --force --sign - --timestamp=none "$GAUGE_BUNDLE"
ditto -c -k --keepParent "$GAUGE_BUNDLE" "$GAUGE_MACOS_DIR/dist/Gauge-macOS-$(uname -m).zip"
echo "$GAUGE_BUNDLE"
