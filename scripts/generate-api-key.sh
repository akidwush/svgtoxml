#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "❌ Node.js belum terpasang. Jalankan: pkg install nodejs-lts -y" >&2
  exit 1
fi

LABEL="${1:-default}"
KEY="$(node --input-type=module -e "import crypto from 'node:crypto'; console.log('amx_live_' + crypto.randomBytes(32).toString('base64url'))")"

echo "API key baru untuk: $LABEL"
echo "$KEY"
echo
echo "Vercel env (single key):"
echo "SVG2XML_API_KEY=$KEY"
echo
echo "Atau multi-key entry:"
echo "SVG2XML_API_KEYS=$LABEL=$KEY"
