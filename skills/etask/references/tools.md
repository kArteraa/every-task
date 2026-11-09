# Переносимые инструменты

Нужен Node.js 22 или новее. Runtime использует встроенные модули Node.js;
пользователь установленного архива не выполняет npm install.
Команды запускаются из tools/etask.mjs установленного навыка.
Всегда передавай `--root` с явным путём целевого проекта.

```text
node <skill>/tools/etask.mjs doctor --root <project>
node <skill>/tools/etask.mjs board --root <project>
node <skill>/tools/etask.mjs board --save --root <github-project>
node <skill>/tools/etask.mjs status ET-1 --root <project>
node <skill>/tools/etask.mjs resume ET-1 --root <project>
node <skill>/tools/etask.mjs move ET-1 in-progress --root <project>
node <skill>/tools/etask.mjs checkpoint ET-1 review --note "Что проверено" --root <project>
node <skill>/tools/etask.mjs checkpoint ET-1 sanitize --note "Что очищено и проверено" --root <project>
node <skill>/tools/etask.mjs move ET-1 testing --root <project>
node <skill>/tools/etask.mjs check ET-1 unit --root <project>
```

Повтори check для test, integration, e2e, lint, build. Check реально исполняет
согласованную команду и записывает exit code; таймаут 10 минут считается ошибкой.
Лог сохраняется в .etask/runs/ET-1/. Команды и вывод могут содержать приватные
данные, поэтому каталог не коммитится и не публикуется.
Doctor проверяет профиль, цель, задачи, пути, Node.js, доступность первого
исполняемого файла каждой команды и выбранные Git-инструменты;
команды checks показывает для проверки, не выполняя их автоматически.
Doctor/status/resume не изменяют проект и не обращаются к Jira/MCP.

Checkpoint фиксирует **заявление агента о выполненной проверке**.
Это не независимое ревью и не доказательство того, что модель действительно
проверила каждый пункт. Агент сначала читает diff и выполняет чек-лист.
Файлы состояния не являются защитой от пользователя, вручную меняющего данные.

Snapshot учитывает файлы проекта, цель, критерии, профиль и инструменты.
Исключены .git, node_modules, dist, .superpowers, .etask/runs, .etask/state.json,
генерируемая доска и ручной журнал. В бэклоге нормализуется только строка статуса.
Исходный код нельзя хранить в исключённых каталогах. Symlink в снимке — блокер.
Изменение содержимого во время check отменяет успешность проверки.
Перенос между ОС может потребовать повторных проверок из-за окончаний строк.

Для local `move ET-1 done` требует всех свидетельств и отмеченных критериев.
После переноса без state можно повторить проверки и эту команду для уже done
задачи: она восстанавливает свидетельство завершения, не переоткрывая задачу.
Для github добавь `--pr N`: проверяются marker, база, MERGED, HEAD и чистое
дерево. После мержа статус показывается по PR без коммита done в integration.
Команды не делают push, merge и не получают разрешений из файла.

Если атомарная запись заблокирована sandbox, используй штатное разрешение
среды. Не заменяй её потенциально частичной перезаписью.
