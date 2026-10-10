#!/usr/bin/env bash
# Creates the EC P-256 key that signs agent bundles, for the repository secrets
#   AGENT_BUNDLE_KEY           the PEM private key (signs pidroid-agent-<version>.zip in release-prepare.sh)
#   AGENT_BUNDLE_PUBLIC_KEY    the base64 DER public key (built into the app to verify the signature)
#
# Usage:
#   generate-bundle-key.sh --set-secrets [owner/repo]   store both secrets with the gh CLI; nothing is printed or kept
#   generate-bundle-key.sh                              print both values to add by hand
# Nothing is written to the repository, and the key lives only in a temporary directory that is removed on exit.
# Works with the macOS and Linux versions of openssl and base64.
set -euo pipefail

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

(umask 077 && openssl ecparam -name prime256v1 -genkey -noout -out "$TMP/key.pem")
PUBLIC="$(openssl ec -in "$TMP/key.pem" -pubout -outform DER 2>/dev/null | base64 | tr -d '\n')"

if [ "${1:-}" = "--set-secrets" ]; then
  REPO="${2:-mrndstvndv/pidroid}"
  gh secret set AGENT_BUNDLE_KEY -R "$REPO" < "$TMP/key.pem"
  printf '%s' "$PUBLIC" | gh secret set AGENT_BUNDLE_PUBLIC_KEY -R "$REPO"
  echo "Set AGENT_BUNDLE_KEY and AGENT_BUNDLE_PUBLIC_KEY on $REPO"
  exit 0
fi

echo "=== AGENT_BUNDLE_KEY (private key, keep secret) ==="
cat "$TMP/key.pem"
echo
echo "=== AGENT_BUNDLE_PUBLIC_KEY (base64 DER) ==="
echo "$PUBLIC"
