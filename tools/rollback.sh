#!/bin/bash
# Вернуть в Chrome одну из сохранённых версий. Исходники и история не
# трогаются — меняется только папка, которую грузит браузер.
#
#   ./tools/rollback.sh            — список версий
#   ./tools/rollback.sh 3.10.0     — поставить в Chrome v3.10.0
set -euo pipefail
cd "$(dirname "$0")/.."
CHROME_DIR="$HOME/Desktop/gmgn trader"

if [[ -z "${1:-}" ]]; then
  echo "Сохранённые версии (новые сверху):"
  git tag -l 'v*' --sort=-v:refname --format='%(refname:short)  %(creatordate:format:%d.%m %H:%M)  %(subject)'
  exit 0
fi
TAG="v${1#v}"
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || { echo "Нет версии $TAG"; exit 1; }

TMP="$(mktemp -d)"
git archive "$TAG" | tar -x -C "$TMP"
rsync -a --delete \
  --exclude test --exclude tools --exclude v0.3.0 --exclude LICENSE --exclude README.md \
  --exclude package.json --exclude package-lock.json --exclude .gitignore \
  "$TMP/" "$CHROME_DIR/"
rm -rf "$TMP"
echo "В Chrome стоит $TAG — перезагрузи расширение. Вернуть свежую: ./tools/rollback.sh $(git tag -l 'v*' --sort=-v:refname | head -1)"
