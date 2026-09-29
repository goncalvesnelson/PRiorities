import { changeKinds, classificationPrompt, prioritizationPrompt, defaultReviewPreferences, evidenceRules, focusInstructions } from './review-preferences.js';

const textField = { type: 'string' };
const lockfileNames = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'Cargo.lock', 'composer.lock', 'Gemfile.lock', 'Pipfile.lock', 'poetry.lock', 'uv.lock', 'go.sum', 'packages.lock.json', 'Package.resolved', 'flake.lock', 'mix.lock']);

export function isGeneratedFile(file) {
  return file.isGenerated === true || lockfileNames.has(file.path.split('/').at(-1));
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
  required: ['path', 'side', 'startLine', 'endLine'],
  properties: { path: textField, side: { type: 'string', enum: ['before', 'after'] }, startLine: { type: 'integer' }, endLine: { type: 'integer' } }
};

export const analysisSchema = {
  type: 'object', additionalProperties: false, required: ['summary', 'topics'],
  properties: {
    summary: textField,
    topics: {
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'priority', 'title', 'reason', 'before', 'after', 'question', 'uncertainty', 'evidenceSummary', 'editIds', 'excerpts'],
        properties: {
          id: textField, priority: { type: 'string', enum: ['review', 'supporting'] },
          title: textField, reason: textField, before: textField, after: textField,
          question: textField, uncertainty: textField, evidenceSummary: textField,
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
  if (typeof input.title !== 'string' || typeof input.description !== 'string' || !Array.isArray(input.files) || !input.files.length || input.files.length > 100) throw new Error('Expected a pull request with 1–100 changed files.');
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
  if (!ids.size) throw new Error('No text changes were available to analyze.');
  return input;
}

export function sourceRows(snapshot, excerpt) {
  const file = snapshot.files.find(file => file.path === excerpt.path);
  if (!file) throw new Error(`The assessment references an unknown file: ${excerpt.path}`);
  const key = excerpt.side === 'before' ? 'oldLine' : 'newLine';
  const rows = file.hunks.flatMap(hunk => hunk.items.flatMap(item => item.type === 'edit' ? item.rows : [item]));
  const source = snapshot.context.find(source => source.path === excerpt.path && source.side === excerpt.side);
  const lines = source?.text.split('\n');
  const result = [];
  for (let line = excerpt.startLine; line <= excerpt.endLine; line++) {
    const row = rows.find(row => row[key] === line);
    if (row) result.push({ ...row });
    else if (lines && line <= lines.length - (lines.at(-1) === '' ? 1 : 0)) result.push({ type: 'context', text: lines[line - 1], oldLine: excerpt.side === 'before' ? line : null, newLine: excerpt.side === 'after' ? line : null });
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

export function validateAnalysis(input, snapshot) {
  validateSnapshot(snapshot);
  if (!record(input) || typeof input.summary !== 'string' || !input.summary.trim() || input.summary.length > 3000 || !Array.isArray(input.topics) || !input.topics.length) throw new Error('The model returned an invalid review summary. Try analyzing again.');
  const edits = new Map(allEdits(snapshot).map(edit => [edit.id, edit]));
  const assigned = new Set();
  const topicIds = new Set();
  const topics = input.topics.map(topic => {
    const fields = ['id', 'title', 'reason', 'before', 'after', 'question', 'uncertainty', 'evidenceSummary'];
    if (!record(topic) || fields.some(field => typeof topic[field] !== 'string' || topic[field].length > 5000) || !/^[\w-]{1,100}$/.test(topic.id) || topicIds.has(topic.id)) throw new Error('The model returned invalid review topics. Try analyzing again.');
    topicIds.add(topic.id);
    if (!['review', 'supporting'].includes(topic.priority) || !Array.isArray(topic.editIds) || !topic.editIds.length || !Array.isArray(topic.excerpts)) throw new Error('The model returned invalid topic evidence. Try analyzing again.');
    if (['title', 'reason', 'before', 'after', 'evidenceSummary'].some(field => !topic[field].trim()) || topic.priority === 'review' && !topic.question.trim()) throw new Error('The assessment did not explain a review decision. Try analyzing again.');
    let changedLines = 0;
    for (const id of topic.editIds) {
      if (typeof id !== 'string' || !edits.has(id) || assigned.has(id)) throw new Error('The assessment does not map each edit exactly once. Try analyzing again.');
      assigned.add(id);
      changedLines += edits.get(id).rows.filter(row => row.type === 'add' || row.type === 'delete').length;
    }
    const excerpts = topic.excerpts.map(excerpt => {
      if (!record(excerpt) || !validPath(excerpt.path) || !['before', 'after'].includes(excerpt.side) || !Number.isSafeInteger(excerpt.startLine) || !Number.isSafeInteger(excerpt.endLine) || excerpt.startLine < 1 || excerpt.endLine < excerpt.startLine) throw new Error('The model returned an invalid source excerpt. Try analyzing again.');
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
  return { summary: input.summary, topics, baseSha: snapshot.baseSha, headSha: snapshot.headSha };
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

export function makeClassificationPrompt(snapshot, changedPaths = [], preferences = defaultReviewPreferences()) {
  const evidence = promptEvidence(snapshot);
  const system = `${preferences.classificationPrompt || classificationPrompt}\n\n${evidenceRules}`;
  return { system, user: JSON.stringify({ ...evidence, ...(changedPaths.length ? { changedPaths } : {}) }) };
}

export function makePrompt(snapshot, classifications, preferences = defaultReviewPreferences()) {
  const evidence = promptEvidence(snapshot);
  const inventory = validateClassifications({ edits: classifications }, snapshot);
  const system = `${preferences.prioritizationPrompt || prioritizationPrompt}\n\n${focusInstructions[preferences.focus]}\n${preferences.alwaysShow.length ? `The user requires edits classified as ${preferences.alwaysShow.join(', ')} to remain visible. Explain these changes and their significance without inventing risks.` : ''}\n${evidenceRules}\nSelect decisions and source by consequence and evidence, without a target number of topics, excerpts, or lines. Do not suppress consequential changes to meet a size target or add lower-priority code to fill space. Show the source needed to assess each decision and preserve consequential uncertainty. Defer changes only for a source-grounded reason.`;
  return { system, user: JSON.stringify({ ...evidence, classifications: inventory }) };
}
