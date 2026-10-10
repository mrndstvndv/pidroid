#!/usr/bin/env bash
# Packages the agent bundle for a GitHub release: verifies it against its bundle.json, zips it, signs the zip when a key
# is configured, and writes agent-update.json. release-prepare.sh calls it with the built APK.
# Usage: package-agent-bundle.sh <apk-or-bundle-dir> <version> <out-dir>
# Env:   AGENT_BUNDLE_KEY    PEM EC P-256 private key; when unset this fails unless ALLOW_UNSIGNED=1, which gives no .sig and "sig": null
#        GITHUB_REPOSITORY   owner/repo for the download URLs (default mrndstvndv/pidroid)
#        RELEASE_NOTES       notes stored in agent-update.json (default empty)
set -euo pipefail

INPUT="${1:?usage: package-agent-bundle.sh <apk-or-bundle-dir> <version> <out-dir>}"
VERSION="${2:?usage: package-agent-bundle.sh <apk-or-bundle-dir> <version> <out-dir>}"
OUT_DIR="${3:?usage: package-agent-bundle.sh <apk-or-bundle-dir> <version> <out-dir>}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# An APK is unpacked to the same assets/agent/ tree the app extracts from; a directory is used as it is.
if [ -f "$INPUT" ]; then
  unzip -q "$INPUT" 'assets/agent/*' -d "$TMP/apk"
  BUNDLE_DIR="$TMP/apk/assets/agent"
else
  BUNDLE_DIR="$(cd "$INPUT" && pwd)"
fi
test -f "$BUNDLE_DIR/bundle.json" || { echo "$INPUT: no bundle.json in the agent bundle" >&2; exit 1; }

# Every file must match the hash bundle.json records, and nothing may be unlisted: the zip is what devices verify.
node - "$BUNDLE_DIR" "$VERSION" <<'JS'
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const [dir, version] = process.argv.slice(2);
const fail = (message) => {
  console.error(`agent bundle ${dir}: ${message}`);
  process.exit(1);
};
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(dir, "bundle.json"), "utf8"));
} catch (error) {
  fail(`unreadable bundle.json (${error.message})`);
}
if (manifest.format !== 1) fail(`unsupported format ${manifest.format}`);
if (manifest.version !== version) fail(`bundle version ${manifest.version} is not release ${version}`);
if (!Number.isInteger(manifest.code) || manifest.code < 1) fail(`bad code ${manifest.code}`);
if (!["stable", "prerelease"].includes(manifest.channel)) fail(`bad channel ${manifest.channel}`);
if (!Number.isInteger(manifest.minHostApi)) fail("minHostApi is not an integer");
if (!Number.isInteger(manifest.schemaVersion)) fail("schemaVersion is not an integer");
if (typeof manifest.commit !== "string") fail("commit is not a string");
const listed = manifest.files;
if (!listed || typeof listed !== "object" || Array.isArray(listed)) fail("files is not an object");

const present = new Map();
const walk = (rel) => {
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const name = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(name);
    else if (entry.isFile()) present.set(name, path.join(dir, name));
    else fail(`${name} is not a regular file`);
  }
};
walk("");

for (const [rel, hash] of Object.entries(listed)) {
  if (rel === "bundle.json" || rel.split("/").includes("..") || path.isAbsolute(rel)) fail(`bad entry ${rel}`);
  if (!present.has(rel)) fail(`${rel} is listed but missing`);
  if (sha256(present.get(rel)) !== hash) fail(`${rel} does not match its hash`);
}
for (const rel of present.keys()) {
  if (rel !== "bundle.json" && !Object.prototype.hasOwnProperty.call(listed, rel)) fail(`${rel} is not listed`);
}
if (!present.has("bundle.json")) fail("bundle.json is missing");
console.log(`agent bundle ${version}: ${Object.keys(listed).length} files verified`);
JS

# The zip's root is the bundle itself, so the app can extract it straight into bundles/<code>/.
ZIP_NAME="pidroid-agent-${VERSION}.zip"
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
ZIP="$OUT_DIR/$ZIP_NAME"
SIG="$ZIP.sig"
rm -f "$ZIP" "$SIG"
(cd "$BUNDLE_DIR" && zip -X -q -r "$ZIP" .)

# Raw DER ECDSA over the zip bytes, base64 as text: the form the app's BundleVerifier expects.
if [ -n "${AGENT_BUNDLE_KEY:-}" ]; then
  (umask 077 && printf '%s\n' "$AGENT_BUNDLE_KEY" > "$TMP/key.pem")
  openssl dgst -sha256 -sign "$TMP/key.pem" -out "$TMP/sig.der" "$ZIP"
  base64 < "$TMP/sig.der" | tr -d '\n' > "$SIG"
  echo "$SIG: signed"
else
  # Releases always sign (release-prepare.sh checks the keys first); only a local run may go without.
  [ "${ALLOW_UNSIGNED:-}" = "1" ] || { echo "AGENT_BUNDLE_KEY is not set; set ALLOW_UNSIGNED=1 to package an unsigned bundle" >&2; exit 1; }
  echo "AGENT_BUNDLE_KEY is not set: $ZIP_NAME is unsigned and agent-update.json has no sig"
fi

REPO="${GITHUB_REPOSITORY:-mrndstvndv/pidroid}"
RELEASE_BASE="https://github.com/${REPO}/releases/download/v${VERSION}"
ZIP_PATH="$ZIP" SIG_PATH="$SIG" BUNDLE_JSON="$BUNDLE_DIR/bundle.json" JSON_PATH="$OUT_DIR/agent-update.json" \
  RELEASE_BASE="$RELEASE_BASE" ZIP_NAME="$ZIP_NAME" VERSION="$VERSION" RELEASE_NOTES="${RELEASE_NOTES:-}" \
  node - <<'JS'
const fs = require("node:fs");
const crypto = require("node:crypto");

const env = process.env;
const bundle = JSON.parse(fs.readFileSync(env.BUNDLE_JSON, "utf8"));
const zip = fs.readFileSync(env.ZIP_PATH);
const update = {
  format: 1,
  version: env.VERSION,
  code: bundle.code,
  channel: bundle.channel,
  minHostApi: bundle.minHostApi,
  schemaVersion: bundle.schemaVersion,
  url: `${env.RELEASE_BASE}/${env.ZIP_NAME}`,
  sha256: crypto.createHash("sha256").update(zip).digest("hex"),
  size: zip.length,
  sig: fs.existsSync(env.SIG_PATH) ? fs.readFileSync(env.SIG_PATH, "utf8").trim() : null,
  apkUrl: `${env.RELEASE_BASE}/pidroid-${env.VERSION}.apk`,
  notes: env.RELEASE_NOTES,
};
fs.writeFileSync(env.JSON_PATH, JSON.stringify(update, null, 2) + "\n");
console.log(`${env.JSON_PATH}: written`);
JS
echo "$ZIP: $(stat -c %s "$ZIP") bytes"
