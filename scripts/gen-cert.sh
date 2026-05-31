#!/usr/bin/env bash
# Generate a self-signed cert for dev. Run once.
#
#   npm run cert                       # localhost only
#   npm run cert -- 192.168.31.131     # also valid for that LAN IP / hostname
#
# Extra args are added to the cert's subjectAltName, so the cert is trusted when
# reaching the backend by IP or hostname from another machine on the network.
# IP-looking args become IP: entries, everything else becomes DNS: entries.
set -euo pipefail

dir="$(cd "$(dirname "$0")/.." && pwd)/certs"
mkdir -p "$dir"
cd "$dir"

if [[ -f cert.pem && -f key.pem ]]; then
  echo "certs already exist in $dir — delete them to regenerate"
  exit 0
fi

# Base SANs for local dev.
san="DNS:localhost,IP:127.0.0.1"
# Append any extra hosts/IPs passed as arguments.
for host in "$@"; do
  if [[ "$host" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    san="$san,IP:$host"
  else
    san="$san,DNS:$host"
  fi
done

openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout key.pem -out cert.pem \
  -subj "/CN=localhost" \
  -addext "subjectAltName=$san" >/dev/null 2>&1

chmod 600 key.pem
echo "wrote $dir/cert.pem and $dir/key.pem"
echo "subjectAltName: $san"
echo
echo "The first time you open the backend over HTTPS in a browser,"
echo "you'll see a warning — accept it once and the cert is trusted for this dev session."
