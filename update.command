#!/bin/bash
# Обновление расширения в один двойной клик (macOS: Finder запускает .command).
#
# Работает, если папка взята через git clone — тогда достаточно git pull, и
# Chrome подхватит новые файлы после перезапуска расширения (кнопка
# «перезапустить» в настройках расширения или ⟳ в chrome://extensions).
cd "$(dirname "$0")"

if [[ ! -d .git ]]; then
  echo "Эта папка не из git — обновиться сама не может."
  echo "Скачай архив: https://github.com/lokert31/gmgn-ladder/releases/latest"
  echo "и распакуй его поверх этой папки, заменив файлы."
  echo
  echo "Чтобы в следующий раз обновляться одним кликом, возьми расширение так:"
  echo "  git clone https://github.com/lokert31/gmgn-ladder.git"
  read -r -p "Enter — закрыть"
  exit 1
fi

WAS="$(git rev-parse --short HEAD)"
if ! git pull --ff-only; then
  echo
  echo "git pull не прошёл. Если правил файлы у себя — сохрани их и повтори:"
  echo "  git stash && git pull --ff-only"
  read -r -p "Enter — закрыть"
  exit 1
fi
NOW="$(git rev-parse --short HEAD)"

VER="$(sed -n 's/.*"version"[^"]*"\([^"]*\)".*/\1/p' manifest.json | head -1)"
if [[ "$WAS" == "$NOW" ]]; then
  echo
  echo "Уже последняя версия: $VER"
else
  echo
  echo "Обновлено до версии $VER"
  echo "Осталось перезапустить расширение: значок расширения → «я заменил файлы — перезапустить»."
  echo "Или chrome://extensions → ⟳ на карточке расширения."
fi
read -r -p "Enter — закрыть"
