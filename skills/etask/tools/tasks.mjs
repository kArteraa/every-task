import { createHash } from 'node:crypto';

export const labels = { todo: 'К выполнению', 'in-progress': 'Выполняется', testing: 'Тестируется', done: 'Выполнено' };

function maskFences(markdown) {
  let fence;
  return markdown.split(/(\r?\n)/).map(line => {
    if (/^\r?\n$/.test(line)) return line;
    if (fence) {
      if (new RegExp(`^ {0,3}${fence.character}{${fence.length},}[ \\t]*$`).test(line)) fence = null;
      return line.replace(/[^\r\n]/g, ' ');
    }
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (opening && !(opening[1][0] === '`' && opening[2].includes('`'))) {
      fence = { character: opening[1][0], length: opening[1].length };
      return line.replace(/[^\r\n]/g, ' ');
    }
    return line;
  }).join('');
}

export function withTaskState(task, state) {
  return task.block.slice(0, task.stateStart) + `- Состояние — ${state}` + task.block.slice(task.stateEnd);
}

export function taskDefinition(task) {
  return createHash('sha256').update(withTaskState(task, '<state>').replace(/\r\n/g, '\n').trim()).digest('hex');
}

export function isCompleted(task, saved) {
  return task.state === 'done' && task.criteria.every(criterion => criterion.done) && saved?.completion?.definition === taskDefinition(task);
}

export function parseTasks(markdown) {
  const visible = maskFences(markdown);
  const sections = [...visible.matchAll(/^## (ET-[1-9]\d*) — (.+)\r?$/gm)];
  const taskHeadings = [...visible.matchAll(/^## ET-[^\r\n]*/gm)];
  if (sections.length !== taskHeadings.length) throw new Error('Invalid task heading or ID');
  return sections.map((match, index) => {
    const start = match.index;
    const end = sections[index + 1]?.index ?? markdown.length;
    const block = markdown.slice(start, end);
    const visibleBlock = visible.slice(start, end);
    const fieldMatch = label => {
      const matches = [...visibleBlock.matchAll(new RegExp(`^- ${label} — ([^\\r\\n]+)`, 'gm'))];
      if (matches.length !== 1) throw new Error(`${match[1]}: missing or duplicate ${label}`);
      return matches[0];
    };
    const field = label => fieldMatch(label)[1].trim();
    const state = field('Состояние');
    const stateField = fieldMatch('Состояние');
    if (!Object.hasOwn(labels, state)) throw new Error(`${match[1]}: invalid state ${state}`);
    const dependencies = field('Зависимости');
    if (dependencies !== 'нет' && !/^ET-[1-9]\d*(?:,\s*ET-[1-9]\d*)*$/.test(dependencies)) throw new Error(`${match[1]}: invalid dependencies`);
    const criteria = [...visibleBlock.matchAll(/^- \[([ xX])\] (.+)$/gm)].map(entry => ({ done: entry[1].toLowerCase() === 'x', text: entry[2].trim() }));
    if (!criteria.length) throw new Error(`${match[1]}: acceptance criteria required`);
    return { id: match[1], title: match[2].trim(), state, owner: field('Исполнитель'), type: field('Тип'),
      dependencies: dependencies === 'нет' ? [] : dependencies.split(/,\s*/), criteria, start, end, block,
      stateStart: stateField.index, stateEnd: stateField.index + stateField[0].length };
  });
}

export function validateTasks(tasks) {
  const byId = new Map();
  for (const task of tasks) {
    if (byId.has(task.id)) throw new Error(`Duplicate task ${task.id}`);
    byId.set(task.id, task);
  }
  const visited = new Set();
  const active = new Set();
  function visit(id) {
    if (!byId.has(id)) throw new Error(`Unknown dependency ${id}`);
    if (active.has(id)) throw new Error(`Dependency cycle at ${id}`);
    if (visited.has(id)) return;
    active.add(id);
    for (const dependency of byId.get(id).dependencies) visit(dependency);
    active.delete(id);
    visited.add(id);
  }
  tasks.forEach(task => visit(task.id));
  return tasks;
}

function escapeCell(value) {
  return value.replace(/[|<>\r\n]/g, character => ({ '|': '&#124;', '<': '&lt;', '>': '&gt;', '\r': ' ', '\n': ' ' })[character]);
}

export function renderBoard(tasks) {
  validateTasks(tasks);
  const columns = Object.keys(labels).map(state => tasks.filter(task => task.state === state));
  const lines = ['# Доска задач', '', '| ' + Object.values(labels).join(' | ') + ' |', '| --- | --- | --- | --- |'];
  for (let index = 0; index < Math.max(1, ...columns.map(column => column.length)); index++) {
    lines.push('| ' + columns.map(column => {
      const task = column[index];
      return task ? `**${task.id}** ${escapeCell(task.title)}${task.dependencies.length ? ` (зависит от ${task.dependencies.join(', ')})` : ''}` : '—';
    }).join(' | ') + ' |');
  }
  lines.push('', 'Источник статусов — бэклог проекта. Эта доска обновляется командой etask board.', '');
  return lines.join('\n');
}
