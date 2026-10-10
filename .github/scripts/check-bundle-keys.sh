#!/usr/bin/env bash
# Fails unless AGENT_BUNDLE_KEY (PEM private key) and AGENT_BUNDLE_PUBLIC_KEY (base64 DER public key) are both set and
# are the same key pair. Generate a pair with generate-bundle-key.sh.
set -euo pipefail

fail() { echo "::error title=Agent bundle signing::$1"; echo "$1" >&2; exit 1; }

[ -n "${AGENT_BUNDLE_KEY:-}" ] || fail "Secret AGENT_BUNDLE_KEY is not set. Run .github/scripts/generate-bundle-key.sh and add both secrets."
[ -n "${AGENT_BUNDLE_PUBLIC_KEY:-}" ] || fail "Secret AGENT_BUNDLE_PUBLIC_KEY is not set. Run .github/scripts/generate-bundle-key.sh and add both secrets."

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
(umask 077 && printf '%s\n' "$AGENT_BUNDLE_KEY" > "$TMP/key.pem")

# The public key derived from the private one must be exactly what the app will be built with.
DERIVED="$(openssl ec -in "$TMP/key.pem" -pubout -outform DER 2>/dev/null | base64 | tr -d '\n')" \
  || fail "AGENT_BUNDLE_KEY is not a valid EC private key in PEM form."
GIVEN="$(printf '%s' "$AGENT_BUNDLE_PUBLIC_KEY" | tr -d '[:space:]')"
[ "$DERIVED" = "$GIVEN" ] || fail "AGENT_BUNDLE_PUBLIC_KEY is not the public half of AGENT_BUNDLE_KEY; the app would reject every signed bundle."
echo "Bundle signing keys: ok"
