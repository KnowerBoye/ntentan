#!/usr/bin/env bash
#
# Build the Ntentan Live Android APK with EAS (Expo Application Services).
#
# Usage:
#   ./scripts/build-android-apk.sh                 # cloud build, "preview" profile (APK)
#   ./scripts/build-android-apk.sh production       # cloud build, "production" profile (AAB)
#   ./scripts/build-android-apk.sh preview --local  # build on this machine instead of EAS cloud
#
# Prereqs (one time):
#   - An Expo account. The script logs you in if you are not already.
#   - For --local builds: Android SDK + JDK 17 on PATH.
#
set -euo pipefail

# Always operate from the mobile-live project root regardless of where this is invoked.
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

PROFILE="${1:-preview}"
LOCAL_FLAG=""
for arg in "$@"; do
  if [ "$arg" = "--local" ]; then
    LOCAL_FLAG="--local"
  fi
done

EAS="npx eas-cli@latest"

echo "▶ Ntentan Live — Android APK build"
echo "  project : $PROJECT_DIR"
echo "  profile : $PROFILE"
echo "  mode    : ${LOCAL_FLAG:+local}${LOCAL_FLAG:-EAS cloud}"
echo

# 1. Authenticate (interactive only the first time; the token persists afterwards).
if ! $EAS whoami >/dev/null 2>&1; then
  echo "▶ Not logged in to Expo — starting login..."
  $EAS login
fi
echo "✔ Logged in as: $($EAS whoami)"

# 2. Ensure the project is registered with EAS (writes extra.eas.projectId to app.json).
if ! grep -q '"projectId"' app.json; then
  echo "▶ Linking this project to EAS..."
  $EAS init
fi

# 3. Build.
echo "▶ Starting Android build (profile: $PROFILE)..."
$EAS build --platform android --profile "$PROFILE" $LOCAL_FLAG

echo
echo "✔ Build submitted."
echo "  Cloud builds: download the APK from the URL above or run '$EAS build:list'."
echo "  Local builds: the .apk/.aab is written into this directory."
