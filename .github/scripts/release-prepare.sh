#!/usr/bin/env bash
# Called by semantic-release (@semantic-release/exec prepareCmd) once the next version is known.
# Builds and verifies the signed release APK that gets attached to the GitHub release.
set -euo pipefail

VERSION="${1:?usage: release-prepare.sh <version>}"

# Stamp the version into gradle.properties; @semantic-release/git commits it afterwards.
sed -i.bak -E "s/^version[[:space:]]*=.*/version = ${VERSION}/" gradle.properties
rm -f gradle.properties.bak
grep -Eq "^version[[:space:]]*=[[:space:]]*${VERSION}[[:space:]]*$" gradle.properties

# Signing config comes from keystore.properties, which the workflow writes from secrets.
test -f keystore.properties

# versionCode must grow with every release, prereleases included; the run number does.
./gradlew assembleRelease --no-daemon "-PversionCode=${GITHUB_RUN_NUMBER:?must run in CI}"

APK="$(ls app/build/outputs/apk/release/*.apk | head -n 1)"

# The APK embeds the agent and its native runtime; a missing piece means a silently broken app.
LISTING="$(unzip -l "$APK")"
for entry in classes.dex assets/agent/server.ts assets/agent/vendor/ lib/arm64-v8a/libbun.so lib/arm64-v8a/libopenssh_ssh.so; do
  grep -qF " ${entry}" <<<"$LISTING" || { echo "$APK: missing ${entry}" >&2; exit 1; }
done
# arm64 only: a stray x86_64 libbun.so would add ~80 MB for nothing.
! grep -qF " lib/x86_64/" <<<"$LISTING" || { echo "$APK: unexpected lib/x86_64/" >&2; exit 1; }
echo "$APK: built"

rm -rf release-assets
mkdir release-assets
cp "$APK" "release-assets/pidroid-${VERSION}.apk"
