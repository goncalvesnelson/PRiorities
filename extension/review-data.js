import { changeKinds, classificationPrompt, prioritizationPrompt, defaultReviewPreferences, evidenceRules, focusInstructions } from './review-preferences.js';

const textField = { type: 'string' };
export const defaultFileLimit = 100;
export const maxFileLimit = 300;
// GitHub's own Changes page stops at 3,000 files (pageLimits.filesLimit).
export const maxChangedFiles = 3000;
const lockfileNames = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'Cargo.lock', 'composer.lock', 'Gemfile.lock', 'Pipfile.lock', 'poetry.lock', 'uv.lock', 'go.sum', 'packages.lock.json', 'Package.resolved', 'flake.lock', 'mix.lock']);

export function isGeneratedFile(file) {
  const name = file.path.split('/').at(-1);
  return file.isGenerated === true || lockfileNames.has(name) || name.endsWith('.pbxproj');
}

export const classificationSchema = {
  type: 'object', additionalProperties: false, required: ['edits'],
  properties: {
    edits: {
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        required: ['editId', 'kinds', 'reason', 'uncertainty'],
        properties: {
          editId: textField,
          kinds: { type: 'array', items: { type: 'string', enum: changeKinds } },
          reason: textField, uncertainty: textField
        }
      }
    }
  }
};

const excerptSchema = {
  type: 'object', additionalProperties: false,
  required: ['path', 'side', 'startLine', 'endLine', 'note'],
  properties: { path: textField, side: { type: 'string', enum: ['before', 'after'] }, startLine: { type: 'integer' }, endLine: { type: 'integer' }, note: textField }
};

export const analysisSchema = {
  type: 'object', additionalProperties: false, required: ['summary', 'topics', 'classifications'],
  properties: {
    summary: textField,
    classifications: classificationSchema.properties.edits,
    topics: {
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'priority', 'title', 'reason', 'before', 'after', 'questions', 'uncertainty', 'editIds', 'excerpts'],
        properties: {
          id: textField, priority: { type: 'string', enum: ['review', 'supporting'] },
          title: textField, reason: textField, before: textField, after: textField,
          questions: { type: 'array', items: textField }, uncertainty: textField,
          editIds: { type: 'array', items: textField }, excerpts: { type: 'array', items: excerptSchema }
        }
      }
    }
  }
};

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validPath(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= 1000 && !path.startsWith('/') && !path.split('/').includes('..') && !/[\u0000-\u001f]/.test(path);
}

function validLine(value) {
  return value === null || Number.isSafeInteger(value) && value > 0;
}

export function allEdits(snapshot) {
  return snapshot.files.flatMap(file => file.hunks.flatMap(hunk => hunk.items.filter(item => item.type === 'edit').map(edit => ({ ...edit, path: file.path }))));
}

export function validateSnapshot(input) {
  if (!record(input) || JSON.stringify(input).length > 1_800_000) throw new Error('This PR is too large for this prototype. Analyze a smaller change.');
  if (typeof input.url !== 'string' || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/.test(input.url)) throw new Error('Open a GitHub pull request before analyzing.');
  if (!/^[a-f0-9]{40}$/.test(input.baseSha) || !/^[a-f0-9]{40}$/.test(input.headSha)) throw new Error('Could not identify the commits in this diff. Refresh the Files changed page.');
  if (typeof input.title !== 'string' || typeof input.description !== 'string' || !Array.isArray(input.files) || !input.files.length || input.files.length > maxFileLimit) throw new Error(`Expected a pull request with 1–${maxFileLimit} changed files.`);
  if (input.deletedFiles !== undefined && (!Array.isArray(input.deletedFiles) || input.files.length + input.deletedFiles.length > maxChangedFiles)) throw new Error('Invalid deleted-file list.');
  if (!Array.isArray(input.context) || !Array.isArray(input.warnings) || input.warnings.some(warning => typeof warning !== 'string')) throw new Error('Invalid source context.');
  const paths = new Set();
  const ids = new Set();
  for (const file of input.files) {
    if (!record(file) || !validPath(file.path) || paths.has(file.path) || !Array.isArray(file.hunks)) throw new Error('Invalid or duplicate diff file.');
    if (file.isGenerated !== undefined && typeof file.isGenerated !== 'boolean') throw new Error('Invalid generated-file marker.');
    paths.add(file.path);
    for (const hunk of file.hunks) {
      if (!record(hunk) || !Array.isArray(hunk.items) || typeof hunk.header !== 'string') throw new Error('Invalid diff hunk.');
      for (const item of hunk.items) {
        if (!record(item)) throw new Error('Invalid diff row.');
        if (item.type === 'edit') {
          if (typeof item.id !== 'string' || !/^[\w-]{1,100}$/.test(item.id) || ids.has(item.id) || !Array.isArray(item.rows) || !item.rows.length) throw new Error('Invalid edit identifiers.');
          ids.add(item.id);
        }
        for (const row of item.type === 'edit' ? item.rows : [item]) {
          if (!record(row) || !['add', 'delete', 'context', 'marker'].includes(row.type) || typeof row.text !== 'string' || !validLine(row.oldLine) || !validLine(row.newLine)) throw new Error('Invalid source row.');
          if (row.type === 'add' && (row.newLine === null || row.oldLine !== null) || row.type === 'delete' && (row.oldLine === null || row.newLine !== null)) throw new Error('Invalid diff line references.');
        }
      }
    }
  }
  for (const source of input.context) {
    if (!record(source) || !paths.has(source.path) || !['before', 'after'].includes(source.side) || typeof source.text !== 'string') throw new Error('Invalid source context.');
  }
  for (const file of input.deletedFiles ?? []) {
    if (!record(file) || !validPath(file.path) || paths.has(file.path) || !Number.isSafeInteger(file.deletions) || file.deletions < 0) throw new Error('Invalid or duplicate deleted file.');
    paths.add(file.path);
  }
  if (!ids.size) throw new Error('No text changes were available to analyze.');
  return input;
}

function capturedSide(snapshot, file, side) {
  const key = side === 'before' ? 'oldLine' : 'newLine';
  const rows = file.hunks.flatMap(hunk => hunk.items.flatMap(item => item.type === 'edit' ? item.rows : [item])).filter(row => row[key] !== null);
  const lines = snapshot.context.find(source => source.path === file.path && source.side === side)?.text.split('\n') ?? [];
  const lineCount = lines.length - (lines.at(-1) === '' ? 1 : 0);
  return { key, rows, lines, lineCount };
}

function citableRanges(snapshot, file, side) {
  const { key, rows, lineCount } = capturedSide(snapshot, file, side);
  const ranges = rows.map(row => [row[key], row[key]]);
  if (lineCount > 0) ranges.push([1, lineCount]);
  const merged = [];
  for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

export function sourceRows(snapshot, excerpt) {
  const file = snapshot.files.find(file => file.path === excerpt.path);
  if (!file) throw new Error(`The assessment references an unknown file: ${excerpt.path}`);
  const { key, rows, lines, lineCount } = capturedSide(snapshot, file, excerpt.side);
  const result = [];
  for (let line = excerpt.startLine; line <= excerpt.endLine; line++) {
    const row = rows.find(row => row[key] === line);
    if (row) result.push({ ...row });
    else if (line <= lineCount) result.push({ type: 'context', text: lines[line - 1], oldLine: excerpt.side === 'before' ? line : null, newLine: excerpt.side === 'after' ? line : null });
    else throw new Error(`The assessment cites source that was not read: ${excerpt.path}:${line}`);
  }
  return result;
}

export function validateClassifications(input, snapshot) {
  validateSnapshot(snapshot);
  const editIds = new Set(allEdits(snapshot).map(edit => edit.id));
  if (!record(input) || !Array.isArray(input.edits) || input.edits.length !== editIds.size) throw new Error('The classification did not account for every edit.');
  const assigned = new Set();
  return input.edits.map(edit => {
    if (!record(edit) || typeof edit.editId !== 'string' || !editIds.has(edit.editId) || assigned.has(edit.editId)) throw new Error('The classification must identify each edit exactly once.');
    if (!Array.isArray(edit.kinds) || !edit.kinds.length || edit.kinds.some(kind => !changeKinds.includes(kind)) || new Set(edit.kinds).size !== edit.kinds.length) throw new Error('The classification returned invalid change kinds.');
    if (typeof edit.reason !== 'string' || !edit.reason.trim() || edit.reason.length > 2000 || typeof edit.uncertainty !== 'string' || edit.uncertainty.length > 2000) throw new Error('The classification did not explain a change.');
    if (edit.kinds.includes('unknown') && !edit.uncertainty.trim()) throw new Error('An unresolved classification did not explain the missing evidence.');
    assigned.add(edit.editId);
    return { editId: edit.editId, kinds: [...edit.kinds], reason: edit.reason.trim(), uncertainty: edit.uncertainty.trim() };
  });
}

export function validateAnalysis(input, snapshot, initialClassifications = [], alwaysShow = []) {
  validateSnapshot(snapshot);
  if (!record(input) || typeof input.summary !== 'string' || !input.summary.trim() || input.summary.length > 3000 || !Array.isArray(input.topics) || !input.topics.length) throw new Error('The model returned an invalid review summary. Try analyzing again.');
  const classifications = validateClassifications({ edits: input.classifications }, snapshot);
  const initialKinds = new Map(initialClassifications.map(edit => [edit.editId, edit.kinds]));
  for (const edit of classifications) {
    const keptKinds = (initialKinds.get(edit.editId) ?? []).filter(kind => alwaysShow.includes(kind));
    edit.kinds = [...new Set([...edit.kinds, ...keptKinds])];
  }
  const edits = new Map(allEdits(snapshot).map(edit => [edit.id, edit]));
  const assigned = new Set();
  const topicIds = new Set();
  const topics = input.topics.map(topic => {
    const fields = ['id', 'title', 'reason', 'before', 'after', 'uncertainty'];
    if (!record(topic) || fields.some(field => typeof topic[field] !== 'string' || topic[field].length > 5000) || !/^[\w-]{1,100}$/.test(topic.id) || topicIds.has(topic.id)) throw new Error('The model returned invalid review topics. Try analyzing again.');
    topicIds.add(topic.id);
    if (!['review', 'supporting'].includes(topic.priority) || !Array.isArray(topic.editIds) || !topic.editIds.length || !Array.isArray(topic.excerpts)) throw new Error('The model returned invalid topic evidence. Try analyzing again.');
    if (!Array.isArray(topic.questions) || topic.questions.some(question => typeof question !== 'string' || !question.trim() || question.length > 1000)) throw new Error('The model returned invalid review questions. Try analyzing again.');
    if (['title', 'reason', 'before', 'after'].some(field => !topic[field].trim()) || topic.priority === 'review' && !topic.questions.length) throw new Error('The assessment did not explain a review decision. Try analyzing again.');
    let changedLines = 0;
    for (const id of topic.editIds) {
      if (typeof id !== 'string' || !edits.has(id) || assigned.has(id)) throw new Error('The assessment does not map each edit exactly once. Try analyzing again.');
      assigned.add(id);
      changedLines += edits.get(id).rows.filter(row => row.type === 'add' || row.type === 'delete').length;
    }
    const excerpts = topic.excerpts.map(excerpt => {
      if (!record(excerpt) || !validPath(excerpt.path) || !['before', 'after'].includes(excerpt.side) || !Number.isSafeInteger(excerpt.startLine) || !Number.isSafeInteger(excerpt.endLine) || excerpt.startLine < 1 || excerpt.endLine < excerpt.startLine) throw new Error('The model returned an invalid source excerpt. Try analyzing again.');
      if (typeof excerpt.note !== 'string' || !excerpt.note.trim() || excerpt.note.length > 500) throw new Error('A source excerpt is missing its note. Try analyzing again.');
      const rows = sourceRows(snapshot, excerpt);
      return { ...excerpt, rows };
    });
    if (topic.priority === 'review') {
      const citesOwnChange = excerpts.some(excerpt => topic.editIds.some(id => {
        const edit = edits.get(id);
        const lineKey = excerpt.side === 'before' ? 'oldLine' : 'newLine';
        return edit.path === excerpt.path && edit.rows.some(row => row[lineKey] !== null && row[lineKey] >= excerpt.startLine && row[lineKey] <= excerpt.endLine);
      }));
      if (!citesOwnChange) throw new Error('A review decision does not cite its changed code. Try analyzing again.');
    }
    return { ...topic, changedLines, excerpts };
  });
  if (assigned.size !== edits.size) throw new Error('The assessment left some edits unaccounted for. Try analyzing again.');
  return { summary: input.summary, topics, classifications, baseSha: snapshot.baseSha, headSha: snapshot.headSha };
}

function promptEvidence(snapshot) {
  validateSnapshot(snapshot);
  const files = snapshot.files.map(file => ({
    path: file.path,
    hunks: file.hunks.map(hunk => ({
      header: hunk.header,
      items: hunk.items.map(item => item.type === 'edit'
        ? { id: item.id, rows: item.rows.map(row => [row.type, row.oldLine, row.newLine, row.text]) }
        : [item.type, item.oldLine, item.newLine, item.text])
    }))
  }));
  return { title: snapshot.title, description: snapshot.description, baseSha: snapshot.baseSha, headSha: snapshot.headSha, files, context: snapshot.context, evidenceLimits: snapshot.warnings };
}

function dependencyDiffs(snapshot, reviewedFiles) {
  const relatedPaths = new Set();
  for (const file of reviewedFiles) {
    if (!/\.go$|(^|\/)go\.(mod|sum)$/.test(file.path)) continue;
    const directory = file.path.slice(0, file.path.lastIndexOf('/') + 1);
    relatedPaths.add(`${directory}go.mod`);
    relatedPaths.add(`${directory}go.sum`);
  }
  const reviewedPaths = new Set(reviewedFiles.map(file => file.path));
  return snapshot.files.filter(file => relatedPaths.has(file.path) && !reviewedPaths.has(file.path) && (!isGeneratedFile(file) || /(^|\/)go\.sum$/.test(file.path))).map(file => ({
    path: file.path,
    hunks: file.hunks.map(hunk => ({
      header: hunk.header,
      rows: hunk.items.flatMap(item => item.type === 'edit' ? item.rows : [item]).map(row => [row.type, row.oldLine, row.newLine, row.text])
    }))
  }));
}

const dependencyEvidenceRules = 'dependencyDiffs contains captured go.mod or go.sum changes from the same directory as a reviewed Go file. Module boundaries outside that directory have not been checked; do not infer ownership of source in other directories. Inspect this evidence before claiming the supplied go.mod or go.sum is missing. These are supporting diffs, not extra edits to classify or assign to topics; only files supplies the edit IDs in scope. A checksum entry records module content, not API compatibility or runtime behavior.';

export function makeClassificationPrompt(snapshot, changedPaths = [], preferences = defaultReviewPreferences(), captured = snapshot) {
  const { title, description, ...evidence } = promptEvidence(snapshot);
  const dependencies = dependencyDiffs(captured, snapshot.files);
  const system = `${preferences.classificationPrompt || classificationPrompt}\n\n${evidenceRules}${dependencies.length ? `\n${dependencyEvidenceRules}` : ''}`;
  return { system, user: JSON.stringify({ ...evidence, dependencyDiffs: dependencies, ...(changedPaths.length ? { changedPaths } : {}) }) };
}

export function makePrompt(snapshot, classifications, preferences = defaultReviewPreferences(), captured = snapshot) {
  const evidence = promptEvidence(snapshot);
  const inventory = validateClassifications({ edits: classifications }, snapshot);
  const system = `${preferences.prioritizationPrompt || prioritizationPrompt}\n\n${focusInstructions[preferences.focus]}\n${preferences.alwaysShow.length ? `The user requires edits classified as ${preferences.alwaysShow.join(', ')} by either pass to remain visible. Retain these kinds from the supplied classifications even when resolving unknown. Validation preserves them if omitted. Explain these changes and their significance without inventing risks.` : ''}\n${evidenceRules}\nReturn a complete revised classifications array with exactly one entry for every supplied edit ID, including unchanged classifications. Use the same change-kind vocabulary and fields (editId, kinds, reason, uncertainty); keep reason and uncertainty at most 2000 characters each. Reconcile each earlier reason and uncertainty against all supplied diffs and context before choosing priorities, including descriptions of which state or branch a test actually exercises. Test names and comments are not proof of the behavior asserted after setup and awaited transitions. Remove unknown only when the combined source resolves every unclassified aspect, and explain that evidence in reason. If a gap is partly resolved, retain unknown and rewrite uncertainty to name only what is still missing. A file missing from one classification request may be present here: check the supplied files before repeating that it was not included. A dependency manifest can establish a declared version without establishing the external dependency behavior; do not treat the PR description, a matching version, or a supporting priority as proof that an evidence gap is resolved. Do not drop other applicable change kinds when resolving unknown. Final explanations, priorities and excerpts must agree with these revised classifications.\nOrganize topics as coherent explanations of changed behaviors. Assign a complete runtime mechanism's defining code, changed callers and tests to one topic; introduce the shared prerequisite before the callers within that explanation. Different consequences of the same mechanism are not separate independently understandable behaviors. Separate topics need distinct behaviors or contracts, not merely different review concerns, lifecycle stages or file types. Order every topic for comprehension, introducing prerequisites before their uses regardless of review or supporting priority. Within each topic, order editIds so the first occurrence of each file introduces required contracts or configuration, implementation, then its callers and validating tests where appropriate. Explain the mechanism before its consequences and review questions. Select source that lets the reader verify these explanations, preserving consequential uncertainty and stating the scope of absence or coverage claims. Keep the premises of questions as conditional as the source: inspect alternative branches before stating that every event causes a particular outcome. There is no target number of topics, excerpts, or lines. Do not suppress consequential changes to meet a size target or add lower-priority code to fill space. Defer changes only for a source-grounded reason; file size and the number of mentions are not measures of importance.\ncitableLines lists, for each path and side, the inclusive [start, end] line ranges that were captured. Every excerpt must lie entirely within one of those ranges for its path and side. Use separate excerpts for disjoint captured ranges; do not bridge a gap between hunks. Check prose line references against the same captured ranges. Other lines were not captured and cannot be cited; record them as missing evidence instead.`;
  const citableLines = Object.fromEntries(snapshot.files.map(file => [file.path, { before: citableRanges(snapshot, file, 'before'), after: citableRanges(snapshot, file, 'after') }]));
  const dependencies = dependencyDiffs(captured, snapshot.files);
  return { system: `${system}${dependencies.length ? `\n${dependencyEvidenceRules}` : ''}`, user: JSON.stringify({ ...evidence, dependencyDiffs: dependencies, citableLines, classifications: inventory }) };
}
