import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateAnalysis, validateSnapshot } from '../../extension/review-data.js';

const args = process.argv.slice(2);
if (args.length !== 5) {
  throw new Error('Usage: node output/guide-evaluation/generate.mjs A-snapshot.json A-analysis.json B-snapshot.json B-analysis.json output.html');
}

const cases = [];
for (const [index, label] of ['A', 'B'].entries()) {
  const snapshot = validateSnapshot(JSON.parse(await readFile(resolve(args[index * 2]), 'utf8')));
  const rawAnalysis = JSON.parse(await readFile(resolve(args[index * 2 + 1]), 'utf8'));
  if (rawAnalysis.baseSha !== snapshot.baseSha || rawAnalysis.headSha !== snapshot.headSha) {
    throw new Error(`Case ${label}: analysis and snapshot commit pairs differ.`);
  }
  const analysis = validateAnalysis(rawAnalysis, snapshot);
  cases.push({ label, snapshot, analysis });
}
if (cases[0].snapshot.url === cases[1].snapshot.url) throw new Error('The reading comparison requires two different pull requests.');

const data = { version: 1, cases };
data.id = createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16);
const template = await readFile(new URL('./template.html', import.meta.url), 'utf8');
const serialized = JSON.stringify(data).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
await writeFile(resolve(args[4]), template.replace('EVALUATION_DATA_PLACEHOLDER', () => serialized));
console.log(`Wrote ${resolve(args[4])}`);
