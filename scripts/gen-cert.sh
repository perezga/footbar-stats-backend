#!/usr/bin/env bash
# Generate a self-signed cert for localhost dev. Run once.
#
#   npm run cert -w backend
set -euo pipefail

dir="$(cd "$(dirname "$0")/.." && pwd)/certs"
mkdir -p "$dir"
cd "$dir"

if [[ -f cert.pem && -f key.pem ]]; then
  echo "certs already exist in $dir — delete them to regenerate"
  exit 0
fi

openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout key.pem -out cert.pem \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1

chmod 600 key.pem
echo "wrote $dir/cert.pem and $dir/key.pem"
echo
echo "The first time you hit https://localhost:4000/ in your browser,"
echo "you'll see a warning — accept it once and the cert is trusted for this dev session."
