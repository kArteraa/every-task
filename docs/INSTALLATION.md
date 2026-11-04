# Установка etask

## Preview из рабочей ветки

До мержа первой версии исходники доступны в `feat/etask-plugin`.
Склонируй рабочую ветку через GitHub CLI в отдельную папку.

```sh
gh repo clone kArteraa/every-task -- --branch feat/etask-plugin
cd every-task
```

После мержа в dev для интеграционной версии используй `--branch dev`.
Публичный выпуск из main выполняется владельцем отдельной задачей.
Запускай команды установки ниже из корня выбранной копии.

## Codex

Добавь локальный каталог плагинов.

```sh
codex plugin marketplace add .
```

В приложении открой каталог Plugins, выбери источник Every Task и установи
etask. В Codex CLI 0.166.0 после регистрации каталога доступна команда
`codex plugin add etask@every-task`. В версиях с установкой через `/plugins`
выбери etask из этого же источника. Перезапусти сессию после установки.

Репозиторий содержит `.agents/plugins/marketplace.json` и совместимый
манифест `.codex-plugin/plugin.json`. Если версия CLI поддерживает только
Agent Skills, скопируй папку `skills/etask` целиком в `~/.agents/skills/etask`.
При уже существующей папке сначала сравни версии и сохрани локальные изменения.
Используй один способ установки, чтобы навык обнаруживался однократно.

Проверь, что `$etask setup` доступен в целевом проекте.
Для обновления каталога сначала обнови локальную копию через Git,
затем выполни `codex plugin marketplace upgrade every-task`
и обнови/переустанови плагин средствами текущего хоста.
Удаление выполняется в Plugins. Каталог удаляется командой
`codex plugin marketplace remove every-task`.
При ручной установке удали только созданную папку навыка.

## Claude Code

Добавь локальный marketplace и установи плагин.

```text
/plugin marketplace add ./
/plugin install etask@every-task
```

Открой новую сессию в целевом проекте и вызови `/etask:etask setup`.
Для проверки исходников без установки можно запустить `claude --plugin-dir .`
из каталога плагина, затем явно указать агенту целевой проект.

Обнови локальные исходники через Git, затем в `/plugin` обнови marketplace
и плагин. Удаление выполняется через `/plugin uninstall etask@every-task`.

## Gemini CLI

Установи расширение из локальной копии.

```sh
gemini extensions install .
```

Перезапусти Gemini CLI в целевом проекте и вызови `/etask setup`.
Команда активирует встроенный skill etask. При конфликте имени команды
хост может показать её как `/etask.etask`, точное имя видно в `/commands list`.

После обновления исходников выполни `gemini extensions update etask`.
Удаление выполняется через `gemini extensions uninstall etask`.

## Архивы и область установки

Для сборки архивов нужны Node.js 22 и команды разработки из README.
Распакуй архив нужного хоста в отдельную папку и установи её локально.
В архиве Codex есть каталог marketplace, в архиве Claude Code его собственный
marketplace, а в архиве Gemini CLI — манифест расширения и команда.
После переноса папки локальный источник установки потребуется обновить.

Параметры `.etask/config.json` и документы задач принадлежат целевому проекту.
После удаления плагина они остаются доступными для продолжения работы.

## Официальные форматы

- [Codex plugin packages](https://developers.openai.com/plugins/build/plugins)
- [Claude Code plugin manifests](https://code.claude.com/docs/en/plugins-reference)
- [Gemini CLI extension reference](https://geminicli.com/docs/extensions/reference/)
