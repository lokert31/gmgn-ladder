#!/bin/bash
# Не пускает ключи в коммит и на GitHub: ключи узлов и API, токены GitHub,
# приватные ключи кошельков. Проверяет все файлы, которые попадут в репозиторий
# (отслеживаемые и новые, кроме игнорируемых), и ищет ещё точные значения из
# личных .env — сами ключи не печатает, только где нашёл.
#
#   ./tools/secrets-check.sh        # 0 — чисто, 1 — нашёл
set -uo pipefail
cd "$(dirname "$0")/.."

PATTERNS='api_key=[A-Za-z0-9_-]{8,}|alchemy\.com/v2/[A-Za-z0-9_-]{10,}|ORBIT-[A-Z0-9]{4,}-[0-9]{3,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY|(MAIN|PRIVATE)_KEY=[^ "]+'
# Личные .env с ключами — ищем их значения дословно.
ENVS="${SECRETS_ENVS:-$HOME/Desktop/claude/lp-screener/.env $HOME/Desktop/claude/pons-autolaunch/.env}"

found=0
FILES=()
# Тесты проверяем отдельно: в них ключи выдуманные, на них же и проверяется,
# что журнал их вырезает. Настоящий ключ там не живёт.
while IFS= read -r f; do [[ -f "$f" && "$f" != test/* ]] && FILES+=("$f"); done < <(git ls-files -co --exclude-standard)
[[ ${#FILES[@]} -eq 0 ]] && exit 0

hits=$(grep -EIl -- "$PATTERNS" "${FILES[@]}" 2>/dev/null | grep -v '^tools/secrets-check.sh$' || true)
if [[ -n "$hits" ]]; then
  echo "Похоже на ключ (шаблон) в файлах:"; echo "$hits" | sed 's/^/  /'
  found=1
fi

for env in $ENVS; do
  [[ -f "$env" ]] || continue
  while IFS='=' read -r name value; do
    [[ -z "$name" || "$name" == \#* || -z "$value" ]] && continue
    # Сверяем только то, что похоже на ключ. Публичный адрес узла — не ключ:
    # он есть и в гайде, и в настройках по умолчанию.
    if [[ "$value" == *api_key=* ]]; then
      secret="${value##*api_key=}"
    elif [[ "$value" =~ ^[A-Za-z0-9_-]{20,}$ ]]; then
      secret="$value"
    else
      continue
    fi
    secret="${secret%%&*}"
    [[ ${#secret} -lt 12 ]] && continue
    hits=$(grep -FIl -- "$secret" "${FILES[@]}" 2>/dev/null || true)
    if [[ -n "$hits" ]]; then
      echo "Значение $name из $(basename "$(dirname "$env")")/.env найдено в:"; echo "$hits" | sed 's/^/  /'
      found=1
    fi
  done < "$env"
done
exit $found
