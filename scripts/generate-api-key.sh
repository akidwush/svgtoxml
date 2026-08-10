#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "❌ Node.js belum terpasang. Jalankan: pkg install nodejs-lts -y" >&2
  exit 1
fi

node --input-type=module -e "import crypto from 'node:crypto'; console.log('amx_' + crypto.randomBytes(32).toString('base64url'))"
