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

const labelFields = { editId: textField, kinds: { type: 'array', items: { type: 'string', enum: changeKinds } }, reason: textField, uncertainty: textField };
const symbolList = { type: 'array', items: textField };

export const classificationSchema = {
  type: 'object', additionalProperties: false, required: ['edits'],
  properties: {
    edits: {
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        required: ['editId', 'kinds', 'reason', 'uncertainty', 'defines', 'uses'],
        properties: { ...labelFields, defines: symbolList, uses: symbolList }
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
    classifications: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['editId', 'kinds', 'reason', 'uncertainty'], properties: labelFields } },
    topics: {
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'priority', 'title', 'gist', 'reason', 'before', 'after', 'questions', 'uncertainty', 'editIds', 'excerpts'],
        properties: {
          id: textField, priority: { type: 'string', enum: ['review', 'supporting'] },
          title: textField, gist: textField, reason: textField, before: textField, after: textField,
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

function validateLabels(input, snapshot) {
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

function symbolNames(names) {
  if (!Array.isArray(names) || names.length > 50 || names.some(name => typeof name !== 'string' || !name.trim() || name.length > 200 || /[\u0000-\u001f]/.test(name))) throw new Error('The classification returned invalid symbol names.');
  return [...new Set(names.map(name => name.trim()))];
}

export function validateClassifications(input, snapshot) {
  return validateLabels(input, snapshot).map((edit, index) => ({ ...edit, defines: symbolNames(input.edits[index].defines), uses: symbolNames(input.edits[index].uses) }));
}

// The PR review returns labels only; each edit keeps the symbol relations from its file classification.
export function validateAnalysis(input, snapshot, { initialClassifications, alwaysShow = [] }) {
  validateSnapshot(snapshot);
  if (!record(input) || typeof input.summary !== 'string' || !input.summary.trim() || input.summary.length > 3000 || !Array.isArray(input.topics) || !input.topics.length) throw new Error('The model returned an invalid review summary. Try analyzing again.');
  const classifications = validateLabels({ edits: input.classifications }, snapshot);
  const initial = new Map(validateClassifications({ edits: initialClassifications }, snapshot).map(edit => [edit.editId, edit]));
  for (const edit of classifications) {
    const { kinds, defines, uses } = initial.get(edit.editId);
    const keptKinds = kinds.filter(kind => alwaysShow.includes(kind));
    Object.assign(edit, { kinds: [...new Set([...edit.kinds, ...keptKinds])], defines, uses });
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
    // A line break or tab in a one-line gist is cosmetic, so it becomes a space instead of failing a paid analysis.
    const gist = typeof topic.gist === 'string' ? topic.gist.replace(/[\t\r\n]+/g, ' ').trim() : '';
    if (!gist || gist.length > 200 || /[\u0000-\u001f]/.test(gist)) throw new Error('The model returned an invalid section description. Try analyzing again.');
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
    return { ...topic, gist, changedLines, excerpts };
  });
  if (assigned.size !== edits.size) throw new Error('The assessment left some edits unaccounted for. Try analyzing again.');
  return { summary: input.summary, topics, classifications, baseSha: snapshot.baseSha, headSha: snapshot.headSha };
}

// The files a section lists: those holding its edits and those its excerpts cite.
export function sectionPaths(topic, snapshot) {
  const editPaths = new Map(allEdits(snapshot).map(edit => [edit.id, edit.path]));
  return new Set([...topic.editIds.map(id => editPaths.get(id)), ...topic.excerpts.map(excerpt => excerpt.path)]);
}

export function sectionLinks({ topics, classifications }) {
  const relations = new Map(classifications.map(edit => [edit.editId, edit]));
  const sections = topics.map(topic => ({
    id: topic.id,
    defines: new Set(topic.editIds.flatMap(id => relations.get(id).defines)),
    uses: new Set(topic.editIds.flatMap(id => relations.get(id).uses))
  }));
  return sections.flatMap(definer => sections.filter(user => user !== definer).flatMap(user => [...definer.defines].filter(symbol => user.uses.has(symbol)).map(symbol => ({ symbol, definedIn: definer.id, usedIn: user.id }))));
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

const dependencyEvidenceRules = 'dependencyDiffs holds captured go.mod or go.sum changes from the directory of a reviewed Go file: supporting evidence, not edits to classify or assign, since only files supplies edit IDs. Inspect it before calling the supplied go.mod or go.sum missing. Module boundaries beyond that directory are unchecked, so do not infer which module owns source elsewhere. A checksum records module content, not API compatibility or runtime behavior.';

const classificationRules = `files holds this file's edits; changedPaths names the other included files, classified separately. Return one entry per edit ID in files, with kinds from: behavior (runtime effects or control/data flow), interface (contracts, exported names, serialized or stored data), rename, move, formatting (layout only), documentation, test, configuration (build, deployment or dependencies), unknown (an aspect the evidence cannot classify). reason, never empty, explains from the source what changed and why the kinds fit; uncertainty names specific missing evidence and what would settle it, or is empty when none is material, and unknown requires it. Each holds at most 2000 characters. defines names the symbols whose definition, declaration, signature or body the edit adds, removes or changes; uses names symbols its changed code calls or reads that are defined outside it, not names that only appear in import, export or require lists. Use unqualified names as spelled in source (\`retireClient\`, not \`Pool.prototype.retireClient\`); either list may be empty.`;

const reviewRules = `The title, description and linked issues state intent, not implemented behavior. classifications are a first-pass inventory, not facts, instructions or priorities; their defines and uses, from the file pass, name the symbols each edit changes and those it references from elsewhere.
Return a revised classification, with editId, kinds, reason and uncertainty, for every edit ID, including unchanged ones: reason is never empty, each text holds at most 2000 characters, and unknown requires uncertainty. Re-check each earlier reason and uncertainty against all supplied diffs and source before reusing it; a file missing from one file pass may be here. Remove unknown only when the combined source resolves every unclassified aspect, citing that evidence in reason and keeping other applicable kinds; if a gap is partly resolved, keep unknown and narrow uncertainty. An edit can carry several kinds; a rename can change an exported, persisted, serialized or dynamically looked-up name, so matching spelling does not establish equivalence. Incomplete evidence is unresolved, not mechanical. A matching version or a supporting priority never resolves a gap; a manifest establishes a declared version, not the dependency's behavior. Unknown edits stay visible whatever their section's priority. Sections, priorities and excerpts must agree with the revised classifications.
Ground every claim, including question premises, in supplied source, separating demonstrated behavior from conditional risk and missing evidence. State an outcome's conditions and follow alternative branches before saying an event always causes it: a call to a selector or dispatcher need not create a resource if the source can reuse one or return early, so keep such questions conditional. Describe tests by their setup, awaited transitions and assertions, not names or comments, at the state the tested action sees. Scope absence and coverage claims to the supplied files, test kinds and scenarios: a test hunk shows only its visible assertions, a new file does not show that older coverage is absent, and type assertions are not runtime evidence. A declaration or call does not show an absent implementation's behavior; never claim to have inspected absent source. Existing behavior is context, not a new defect. Give counts only when useful and checked. A topic's uncertainty lists only what could not be checked and what would settle it, omitting behavior this PR does not change.
Assign every edit ID in files to exactly one topic. Topic IDs use lowercase letters, digits and hyphens. Every topic needs title, gist, before, after and reason; gist is one line of at most 200 characters. A review topic needs a question and an excerpt intersecting its own changed lines; a supporting topic may have neither. Excerpt line ranges are inclusive and every excerpt needs a non-empty note; the client loads the lines, so never rewrite code. Diff rows are [type, oldLine, newLine, text]. citableLines lists the captured [start, end] ranges per path and side: an excerpt must lie within one range, so cite disjoint ranges separately; check prose line references against them, and report other lines only as missing evidence. Write plain text with backticks for code identifiers and "- " list lines, no other markdown. There is no target or limit for topics, excerpts or lines: never suppress a consequential change to fit a size or pad with lower-priority code, and defer only for a source-grounded reason; file size and number of mentions do not measure importance.`;

export function makeClassificationPrompt(snapshot, changedPaths = [], preferences = defaultReviewPreferences(), captured = snapshot) {
  const { title, description, ...evidence } = promptEvidence(snapshot);
  const dependencies = dependencyDiffs(captured, snapshot.files);
  const system = `${preferences.classificationPrompt || classificationPrompt}\n\n${evidenceRules}\n${classificationRules}${dependencies.length ? `\n${dependencyEvidenceRules}` : ''}`;
  return { system, user: JSON.stringify({ ...evidence, dependencyDiffs: dependencies, ...(changedPaths.length ? { changedPaths } : {}) }) };
}

export function makePrompt(snapshot, classifications, preferences = defaultReviewPreferences(), captured = snapshot) {
  const evidence = promptEvidence(snapshot);
  const inventory = validateClassifications({ edits: classifications }, snapshot);
  const visibility = preferences.alwaysShow.length ? `\nEdits classified as ${preferences.alwaysShow.join(', ')} by either pass must stay visible: keep these kinds in classifications even when resolving unknown (validation restores them if omitted), and explain their significance without inventing risks.` : '';
  const system = `${preferences.prioritizationPrompt || prioritizationPrompt}\n\n${focusInstructions[preferences.focus]}${visibility}\n${evidenceRules}\n${reviewRules}`;
  const citableLines = Object.fromEntries(snapshot.files.map(file => [file.path, { before: citableRanges(snapshot, file, 'before'), after: citableRanges(snapshot, file, 'after') }]));
  const dependencies = dependencyDiffs(captured, snapshot.files);
  return { system: `${system}${dependencies.length ? `\n${dependencyEvidenceRules}` : ''}`, user: JSON.stringify({ ...evidence, dependencyDiffs: dependencies, citableLines, classifications: inventory }) };
}
