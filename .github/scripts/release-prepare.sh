#!/usr/bin/env bash
# Called by semantic-release (@semantic-release/exec prepareCmd) once the next version is known.
# Builds and verifies the signed release APK and the agent bundle that get attached to the GitHub release.
set -euo pipefail

VERSION="${1:?usage: release-prepare.sh <version>}"

# Stamp the version into gradle.properties; @semantic-release/git commits it afterwards.
sed -i.bak -E "s/^version[[:space:]]*=.*/version = ${VERSION}/" gradle.properties
rm -f gradle.properties.bak
grep -Eq "^version[[:space:]]*=[[:space:]]*${VERSION}[[:space:]]*$" gradle.properties

# Signing config comes from keystore.properties, which the workflow writes from secrets.
test -f keystore.properties

# The app's update channel: main ships stable builds, every other release branch (dev) ships prereleases.
if [ "${GITHUB_REF_NAME:-}" = "main" ]; then CHANNEL=stable; else CHANNEL=prerelease; fi
# The public key is the one the agent bundle is verified with on the phone; AGENT_BUNDLE_KEY signs the zip (see
# package-agent-bundle.sh). A release without a matching pair would ship an app that rejects every bundle.
.github/scripts/check-bundle-keys.sh
PUBLIC_KEY="$(printf '%s' "${AGENT_BUNDLE_PUBLIC_KEY}" | tr -d '[:space:]')"

# versionCode must grow with every release, prereleases included; the run number does.
./gradlew assembleRelease --no-daemon \
  "-PversionCode=${GITHUB_RUN_NUMBER:?must run in CI}" \
  "-PbundleChannel=${CHANNEL}" \
  "-PbundleCommit=${GITHUB_SHA:?must run in CI}" \
  "-PbundlePublicKey=${PUBLIC_KEY}"

APK="$(ls app/build/outputs/apk/release/*.apk | head -n 1)"

# The APK embeds the agent and its native runtime; a missing piece means a silently broken app.
LISTING="$(unzip -l "$APK")"
for entry in classes.dex assets/agent/server.ts assets/agent/vendor/ assets/agent/bundle.json lib/arm64-v8a/libbun.so lib/arm64-v8a/libopenssh_ssh.so; do
  grep -qF " ${entry}" <<<"$LISTING" || { echo "$APK: missing ${entry}" >&2; exit 1; }
done
# arm64 only: a stray x86_64 libbun.so would add ~80 MB for nothing.
! grep -qF " lib/x86_64/" <<<"$LISTING" || { echo "$APK: unexpected lib/x86_64/" >&2; exit 1; }
echo "$APK: built"

rm -rf release-assets
mkdir release-assets
cp "$APK" "release-assets/pidroid-${VERSION}.apk"

# The agent zip is cut from the APK's own assets/agent/, so it is byte-identical to the embedded bundle; the script
# also checks the bundle's hashes and writes agent-update.json. Release notes are left empty for now.
.github/scripts/package-agent-bundle.sh "$APK" "$VERSION" release-assets
