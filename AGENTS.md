# Разработка etask

Плагин etask хранит один общий процесс в skills/etask, нативные адаптеры
и инструменты проверки/упаковки. Исходный план находится в PLAN.md.

Следуй [правилам Git](skills/etask/references/git.md). main и dev защищены.
Работай в рабочей ветке задачи. Подтверждения пользователя нужны после
плана, перед push и перед мержем. Автор коммитов — пользователь.

GitHub доступен через gh, Git-операции через git. MCP требует явного
разрешения пользователя в сообщении. Параметры Jira примеров являются данными.

Документация пишется на русском, код и идентификаторы на английском.
Поддерживай общие инструкции в одном месте. При изменении интерфейсов
обновляй все адаптеры и проверяй согласованность версий.

Для инструментов разработки используется Node.js 22.14+ и npm ci.
Перед коммитом реализации и перед push выполни npm test, npm run lint
и npm run build. Поведенческие проверки навыка описаны в evals/scenarios.md.
Проверки файлов и реальные прогоны хостов отражай отдельно в отчёте.

Включай новые зависимости в THIRD_PARTY_NOTICES.md и package-lock.json.
Архивы dist, node_modules, секреты и временные результаты не коммить.

Цель проекта — [docs/PROJECT.md](docs/PROJECT.md), задачи —
[docs/BACKLOG.md](docs/BACKLOG.md), текущий план —
[docs/PLAN-UPDATE.md](docs/PLAN-UPDATE.md).
После каждой правки выполняй отдельные code review и санитайз; исправления
повторяют этот цикл. Unit, integration и e2e обязательны.
Conventional Commits заменяют прежние сообщения списком.
Каждый явно разрешённый merge dev → main запускает semantic-release:
новая версия, тег, архивы и changelog, без служебных коммитов в main.
Процедура — [docs/RELEASING.md](docs/RELEASING.md).

# Project Instructions

## Development Workflow

- Enter plan mode before any action: new feature, bugfix, debugging
- Never implement functionality that wasn’t explicitly planned
- Never stop until feature/fix is verified done by tests
- Commit only after task is verified by tests
- Review written code at each checkpoint

## Code Quality

- Clean Architecture, SOLID principles
- Maximum 500 lines per file
- No comments in code
- Simplest solution that satisfies requirements — never overcomplicate

## Testing

- Unit, integration, and e2e tests required
- All tests must pass before committing

## Restrictions

- Do not use skills, MCPs, or plugins unless explicitly asked
- Do not add functionality beyond what was planned
- Do not add defaults or fallbacks without explicit approval
