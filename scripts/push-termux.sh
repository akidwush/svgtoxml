#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

REPO_URL="${1:-${REPO_URL:-}}"
COMMIT_MSG="${2:-feat: add SVG to Alight Motion XML converter}"
BRANCH="${BRANCH:-main}"

if ! command -v git >/dev/null 2>&1; then
  echo "❌ git belum terpasang. Jalankan: pkg install git -y"
  exit 1
fi

if [ ! -f package.json ]; then
  echo "❌ Jalankan script ini dari root proyek (package.json tidak ditemukan)."
  exit 1
fi

if [ ! -d .git ]; then
  git init
fi

git checkout -B "$BRANCH"

if [ -n "$REPO_URL" ]; then
  if git remote get-url origin >/dev/null 2>&1; then
    CURRENT="$(git remote get-url origin)"
    if [ "$CURRENT" != "$REPO_URL" ]; then
      git remote set-url origin "$REPO_URL"
    fi
  else
    git remote add origin "$REPO_URL"
  fi
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "❌ Remote origin belum ada."
  echo "Gunakan: bash scripts/push-termux.sh https://github.com/USER/REPO.git"
  exit 1
fi

echo "▶ Menjalankan pengecekan…"
npm install --no-audit --no-fund
npm run check
npm test

echo "▶ Commit…"
git add -A
if git diff --cached --quiet; then
  echo "ℹ️ Tidak ada perubahan baru untuk di-commit."
else
  git commit -m "$COMMIT_MSG"
fi

echo "▶ Push ke origin/$BRANCH…"
git push -u origin "$BRANCH"

echo "✅ Selesai"
git log -1 --oneline
