#!/usr/bin/env bash
# Creates the EC P-256 key that signs agent bundles, and prints what to store as repository secrets:
#   AGENT_BUNDLE_KEY           the PEM private key (signs pidroid-agent-<version>.zip in release-prepare.sh)
#   AGENT_BUNDLE_PUBLIC_KEY    the base64 DER public key (built into the app to verify the signature)
# Nothing is written to the repository; keep the private key out of it.
set -euo pipefail

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

(umask 077 && openssl ecparam -name prime256v1 -genkey -noout -out "$TMP/key.pem")

echo "=== AGENT_BUNDLE_KEY (private key, keep secret) ==="
cat "$TMP/key.pem"
echo
echo "=== AGENT_BUNDLE_PUBLIC_KEY (base64 DER) ==="
openssl ec -in "$TMP/key.pem" -pubout -outform DER 2>/dev/null | base64 -w0
echo
