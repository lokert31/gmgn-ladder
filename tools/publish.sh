#!/bin/bash
# Выкладывает версию в открытый репозиторий: тот же код, но без истории
# разработки и без личной почты в коммитах (там свой автор — скрытая почта
# GitHub). Приватный репозиторий остаётся полным архивом версий.
#
#   ./tools/publish.sh 3.28.4 "что изменилось"
set -euo pipefail
cd "$(dirname "$0")/.."

VER="${1:-}"
MSG="${2:-}"
PUB="${PUBLIC_DIR:-$HOME/Desktop/claude/gmgn-ladder}"

[[ -n "$VER" ]] || { echo "нужна версия: ./tools/publish.sh 3.28.4 \"что изменилось\""; exit 1; }
if [[ ! -d "$PUB/.git" ]]; then
  echo "Открытого репозитория нет в $PUB — пропускаю"
  exit 0
fi
if ! ./tools/secrets-check.sh; then
  echo "Нашёлся ключ — в открытый репозиторий НЕ публикую"
  exit 1
fi

# Содержимое тега, кроме старой папки v0.3.0: в открытом репозитории ей не место.
TMP="$(mktemp -d)"
git archive "v$VER" | tar -x -C "$TMP"
rm -rf "$TMP/v0.3.0"
rsync -a --delete --exclude .git "$TMP/" "$PUB/"
rm -rf "$TMP"

cd "$PUB"
if git diff --quiet && git diff --cached --quiet; then
  echo "В открытом репозитории уже та же версия"
  exit 0
fi
git add -A
git commit -q -m "$VER: $MSG"
git tag -a "v$VER" -m "$MSG" 2>/dev/null || true
if git push -q origin HEAD --follow-tags; then
  ZIP="$(mktemp -d)/gmgn-ladder-v$VER.zip"
  git archive --format=zip -o "$ZIP" "v$VER" manifest.json src icons rules
  if gh release create "v$VER" "$ZIP" --title "v$VER" --notes "$MSG" >/dev/null 2>&1; then
    echo "Открытый репозиторий: версия $VER и архив расширения выложены"
  else
    echo "Открытый репозиторий: запушено, релиз не создался — gh release create v$VER вручную"
  fi
else
  echo "Открытый репозиторий не принял push — отправь позже: cd $PUB && git push --follow-tags"
fi
