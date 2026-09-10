#!/usr/bin/env bash
set -euo pipefail

# Ensures a self-signed TLS cert/key pair exists under certs/ca/, covering
# localhost/127.0.0.1 and (when given) a LAN IP. run_frontend.sh calls this
# in --host mode so Vite can serve HTTPS — phone browsers don't grant the
# localhost secure-context exemption desktop browsers do, so plain HTTP over
# a LAN IP silently disables navigator.mediaDevices.getUserMedia (mic
# button). Reuses the existing cert unless it's missing, expiring soon, or
# covers a different IP than requested, so a phone that already clicked
# through the self-signed warning doesn't have to again on every restart.
#
# Usage: ensure_dev_cert.sh [lan-ip]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CERT_DIR="$PROJECT_DIR/certs/ca"
CERT_FILE="$CERT_DIR/dev-cert.pem"
KEY_FILE="$CERT_DIR/dev-key.pem"
IP_STAMP_FILE="$CERT_DIR/dev-cert.ip"

LAN_IP="${1:-}"

mkdir -p "$CERT_DIR"

needs_regen=0
if [ ! -f "$CERT_FILE" ] || [ ! -f "$KEY_FILE" ]; then
  needs_regen=1
elif [ "$(cat "$IP_STAMP_FILE" 2>/dev/null || true)" != "$LAN_IP" ]; then
  needs_regen=1
elif ! openssl x509 -checkend 86400 -noout -in "$CERT_FILE" >/dev/null 2>&1; then
  needs_regen=1
fi

if [ "$needs_regen" -eq 1 ]; then
  echo "Generating self-signed dev TLS cert for localhost, 127.0.0.1${LAN_IP:+, $LAN_IP}..."
  SAN="DNS:localhost,IP:127.0.0.1"
  if [ -n "$LAN_IP" ]; then
    SAN="$SAN,IP:$LAN_IP"
  fi
  openssl req -x509 -nodes -newkey rsa:2048 \
    -keyout "$KEY_FILE" -out "$CERT_FILE" \
    -days 825 \
    -subj "/CN=huri-atp-dev" \
    -addext "subjectAltName=$SAN" \
    2>/dev/null
  chmod 600 "$KEY_FILE"
  printf '%s' "$LAN_IP" > "$IP_STAMP_FILE"
  echo "Cert is self-signed — phones will show an untrusted-certificate warning"
  echo "the first time they open the site. That's expected; tap through it"
  echo "(e.g. Advanced -> Proceed / visit site) to accept it once."
fi
