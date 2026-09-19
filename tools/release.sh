#!/bin/bash
# Выпуск версии одной командой: тесты → проверка на ключи → номер → папка Chrome
# → коммит и тег → GitHub (если подключён origin).
#
#   ./tools/release.sh 3.12.0 "что изменилось"
#
# Упали тесты — ничего не сохраняется и в Chrome не уходит: сломанная версия
# не должна попасть ни в историю, ни в браузер.
set -euo pipefail
cd "$(dirname "$0")/.."

VER="${1:-}"
MSG="${2:-}"
CHROME_DIR="$HOME/Desktop/gmgn trader"

if [[ ! "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Нужна версия вида 3.12.0 и описание: ./tools/release.sh 3.12.0 \"что изменилось\""
  exit 1
fi
if [[ -z "$MSG" ]]; then
  echo "Нужно описание: что изменилось в этой версии"
  exit 1
fi
if git rev-parse -q --verify "refs/tags/v$VER" >/dev/null; then
  echo "Версия v$VER уже сохранена — возьми следующий номер"
  exit 1
fi

echo "1/5 тесты…"
LOG="$(mktemp)"
if ! npm test --silent >"$LOG" 2>&1; then
  grep -E "^not ok|^# (pass|fail)" "$LOG" || tail -20 "$LOG"
  echo "Тесты упали — версия НЕ сохранена, в Chrome НЕ отправлена"
  exit 1
fi
grep -E "^# (pass|fail)" "$LOG"

echo "2/5 проверка на ключи…"
if ! ./tools/secrets-check.sh; then
  echo "Нашёлся ключ — версия НЕ сохранена и никуда не отправлена. Убери его из файла и повтори."
  exit 1
fi

echo "3/5 номер версии → $VER"
python3 - "$VER" <<'PY'
import json, re, sys
ver = sys.argv[1]
for f in ("manifest.json", "package.json"):
    s = open(f, encoding="utf-8").read()
    s = re.sub(r'"version":\s*"[^"]*"', f'"version": "{ver}"', s, count=1)
    open(f, "w", encoding="utf-8").write(s)
PY

echo "4/5 в папку Chrome: $CHROME_DIR"
rsync -a --delete \
  --exclude .git --exclude .gitignore --exclude node_modules --exclude test \
  --exclude tools --exclude v0.3.0 --exclude LICENSE --exclude README.md \
  --exclude package.json --exclude package-lock.json \
  ./ "$CHROME_DIR/"

echo "5/5 коммит и тег"
git add -A
if [[ -n "${RELEASE_TRAILER:-}" ]]; then
  git commit -q -m "$VER: $MSG" -m "$RELEASE_TRAILER"
else
  git commit -q -m "$VER: $MSG"
fi
git tag -a "v$VER" -m "$MSG"
echo "Сохранено: v$VER — перезагрузи расширение в Chrome"

# GitHub: пушим коммит с тегом и выкладываем zip расширения. Архив — прямо из
# тега и только из файлов расширения: в папке Chrome могут жить старые
# исключённые папки (rsync их не удаляет), им в релизе не место. Сеть или вход
# в gh подвели — версия всё равно сохранена локально: git push --follow-tags.
if git remote get-url origin >/dev/null 2>&1; then
  if git push -q origin HEAD --follow-tags; then
    ZIP="$(mktemp -d)/gmgn-holder-entries-v$VER.zip"
    git archive --format=zip -o "$ZIP" "v$VER" manifest.json src icons rules
    if gh release create "v$VER" "$ZIP" --title "v$VER" --notes "$MSG" >/dev/null 2>&1; then
      echo "GitHub: запушено, релиз v$VER с архивом расширения"
    else
      echo "GitHub: запушено, но релиз не создался — gh release create v$VER вручную"
    fi
  else
    echo "GitHub не принял push — версия сохранена локально, отправь позже: git push --follow-tags"
  fi
fi
