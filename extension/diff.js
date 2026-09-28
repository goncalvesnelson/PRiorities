export function parseDiff(diff) {
  const files = [];
  let file;
  let hunk;
  let group;
  let oldLine = 0;
  let newLine = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = { path: '', hunks: [], additions: 0, deletions: 0 };
      files.push(file);
      hunk = undefined;
      group = undefined;
      continue;
    }
    if (line.startsWith('+++ b/')) {
      file.path = line.slice(6);
      continue;
    }
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      hunk = { header: line, oldStart: oldLine, newStart: newLine, items: [] };
      file.hunks.push(hunk);
      group = undefined;
      continue;
    }
    if (!hunk) continue;
    const prefix = line[0];
    if (prefix === '+' || prefix === '-') {
      if (!group) {
        group = { type: 'edit', id: `${files.length - 1}-${file.hunks.length - 1}-${hunk.items.length}`, oldStart: oldLine, newStart: newLine, rows: [] };
        hunk.items.push(group);
      }
      const addition = prefix === '+';
      group.rows.push({ type: addition ? 'add' : 'delete', text: line.slice(1), oldLine: addition ? null : oldLine++, newLine: addition ? newLine++ : null });
      if (addition) file.additions++;
      else file.deletions++;
      continue;
    }
    if (prefix === ' ') {
      group = undefined;
      hunk.items.push({ type: 'context', text: line.slice(1), oldLine: oldLine++, newLine: newLine++ });
      continue;
    }
    if (prefix === '\\') {
      const row = { type: 'marker', text: line, oldLine: null, newLine: null };
      if (group) group.rows.push(row);
      else hunk.items.push(row);
    }
  }
  return files;
}

