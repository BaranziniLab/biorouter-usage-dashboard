// Counts read just before files are replaced keep the downloads a file gained
// after the last collection, whichever order the snapshot and the next
// collection arrive in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSnapshot } from '../lib/store.mjs';
import { MAIN_REPO, SKILLS_REPO, DAY, HOUR, T0, asset, release, collection, tempStore, dashboard, sumMeasured, skill } from './fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.05, `${msg}: ${a} vs ${b}`);
const skills = (alpha) => ({
  [MAIN_REPO]: [release(1, 'v1.0.0', T0 - 40 * DAY, [asset(1, 'Biorouter-1.0.0-arm64.dmg', 7)])],
  [SKILLS_REPO]: [release(100, 'skill-alpha', T0 - 30 * DAY, alpha)],
});
// What `gh api ... --jq '... | [$t, .id, .name, .download_count] | @tsv'` prints.
const tsv = (rows) => rows.map((r) => r.join('\t')).join('\n') + '\n';

test('parseSnapshot reads the gh @tsv output and refuses anything else', () => {
  const rows = parseSnapshot('# counts before the refresh\n\nskill-alpha\t10\talpha.zip\t17\nskill-beta\t20\tbeta.zip\t4\t2026-11-23T10:00:00Z\n');
  assert.deepEqual(rows, [
    { tag: 'skill-alpha', id: '10', name: 'alpha.zip', count: 17, at: null },
    { tag: 'skill-beta', id: '20', name: 'beta.zip', count: 4, at: Date.parse('2026-11-23T10:00:00Z') },
  ]);
  assert.throws(() => parseSnapshot('skill-alpha\tten\talpha.zip\t17\n'), /lines 1 /);
  assert.throws(() => parseSnapshot('ok\t1\ta\t1\nskill-alpha 10 alpha.zip 17\n'), /lines 2 /);
  assert.throws(() => parseSnapshot('skill-alpha\t10\talpha.zip\t-1\n'), /lines 1 /);
  assert.throws(() => parseSnapshot('skill-alpha\t10\talpha.zip\t1\tyesterday\n'), /lines 1 /);
  assert.deepEqual(parseSnapshot(''), []);
});

test('a snapshot taken before the clobber keeps the downloads since the last collection', async (t) => {
  const store = await tempStore(t);
  await store.ingest(collection(T0, skills([asset(10, 'alpha.zip', 10)])));
  // 3 more downloads after the collection, read just before the upload.
  const rose = await store.foldSnapshot(parseSnapshot(tsv([['skill-alpha', 10, 'alpha.zip', 13]])), { repo: SKILLS_REPO, at: T0 + 6 * HOUR });
  assert.equal(rose, 1);
  assert.deepEqual(store.events.at(-1), [T0 + 6 * HOUR, '10', 3, T0]);
  await store.ingest(collection(T0 + DAY, skills([asset(11, 'alpha.zip', 1)])));
  const d = dashboard(store);
  assert.equal(skill(d, 'alpha').count, 14, '13 on the old file, 1 on the new one');
  assert.equal(store.state.retired['10'].count, 13);
  close(sumMeasured(d, 'skills'), 4, 'both rises are measured');
});

test('a snapshot folded in after the next collection still lands on the retired file', async (t) => {
  const store = await tempStore(t);
  await store.ingest(collection(T0, skills([asset(10, 'alpha.zip', 10)])));
  await store.ingest(collection(T0 + DAY, skills([asset(11, 'alpha.zip', 0)])));
  assert.equal(skill(dashboard(store), 'alpha').count, 10, 'the collection only saw 10');
  const rows = parseSnapshot(tsv([['skill-alpha', 10, 'alpha.zip', 13, new Date(T0 + 6 * HOUR).toISOString()]]));
  assert.equal(await store.foldSnapshot(rows, { repo: SKILLS_REPO }), 1);
  assert.equal(skill(dashboard(store), 'alpha').count, 13);
  assert.deepEqual(store.events.at(-1), [T0 + 6 * HOUR, '10', 3, T0]);
  // Folding the same snapshot again changes nothing, and an older snapshot
  // never lowers a count (the next collection would count the gap twice).
  assert.equal(await store.foldSnapshot(rows, { repo: SKILLS_REPO }), 0);
  assert.equal(await store.foldSnapshot(parseSnapshot(tsv([['skill-alpha', 10, 'alpha.zip', 11]])), { repo: SKILLS_REPO, at: T0 + 2 * HOUR }), 0);
  assert.equal(store.state.counts['10'], 13);
  assert.equal(skill(dashboard(store), 'alpha').count, 13);
});

test('a file uploaded and replaced between two collections is counted from the snapshot', async (t) => {
  const store = await tempStore(t);
  await store.ingest(collection(T0, skills([asset(10, 'alpha.zip', 10)])));
  // File 10 is replaced by 11, 11 gets 2 downloads and is replaced by 12; the
  // snapshot read 11 just before its replacement.
  await store.foldSnapshot(parseSnapshot(tsv([['skill-alpha', 11, 'alpha.zip', 2]])), { repo: SKILLS_REPO, at: T0 + 12 * HOUR });
  await store.ingest(collection(T0 + DAY, skills([asset(12, 'alpha.zip', 0)])));
  const d = dashboard(store);
  assert.equal(skill(d, 'alpha').count, 12, '10 on the first file, 2 on the second');
  close(sumMeasured(d, 'skills'), 2, 'the second file was measured');
  // A snapshot row for a file that turns out to be current is not double counted.
  await store.foldSnapshot(parseSnapshot(tsv([['skill-alpha', 13, 'alpha.zip', 1]])), { repo: SKILLS_REPO, at: T0 + 30 * HOUR });
  await store.ingest(collection(T0 + 2 * DAY, skills([asset(12, 'alpha.zip', 0), asset(13, 'alpha-extra.zip', 3)])));
  assert.equal(store.state.retired['13'], undefined, 'current again once a collection shows it');
  assert.equal(skill(dashboard(store), 'alpha').count, 15);
});

test('a snapshot refuses rows that belong to another repository and stores without a collection', async (t) => {
  const store = await tempStore(t);
  await assert.rejects(store.foldSnapshot([], { repo: SKILLS_REPO }), /No collection yet/);
  await store.ingest(collection(T0, skills([asset(10, 'alpha.zip', 10)])));
  await store.ingest(collection(T0 + DAY, skills([])));
  await assert.rejects(store.foldSnapshot(parseSnapshot(tsv([['v1.0.0', 10, 'alpha.zip', 11]])), { repo: MAIN_REPO }), /belongs to BaranziniLab\/biorouter-skills/);
  await assert.rejects(store.foldSnapshot([], {}), /needs the repository/);
});

test('the collector script folds a snapshot from the environment before it builds', async (t) => {
  const store = await tempStore(t);
  await store.ingest(collection(T0, skills([asset(10, 'alpha.zip', 10)])));
  // Run the real script with --build (no network) against a copy of the data.
  const file = path.join(store.dir, 'counts.tsv');
  await writeFile(file, tsv([['skill-alpha', 10, 'alpha.zip', 12]]));
  const script = path.join(ROOT, 'scripts', 'collect.mjs');
  // The script writes into its own data/ folder, so point a copy of it at ours.
  const { cp, mkdtemp, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const root = await mkdtemp(path.join(os.tmpdir(), 'usage-dashboard-script-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['lib', 'scripts', 'public']) await cp(path.join(ROOT, dir), path.join(root, dir), { recursive: true });
  await cp(store.dir, path.join(root, 'data'), { recursive: true });
  const run = promisify(execFile);
  const env = { ...process.env, SNAPSHOT_TSV: tsv([['skill-alpha', 10, 'alpha.zip', 12]]), SNAPSHOT_AT: new Date(T0 + HOUR).toISOString(), GITHUB_TOKEN: '', GH_TOKEN: '' };
  const out = await run(process.execPath, [path.join(root, 'scripts', 'collect.mjs'), '--build'], { env, cwd: root });
  assert.match(out.stdout, /Folded in a snapshot of 1 files from BaranziniLab\/biorouter-skills: 1 counts rose/);
  const { readFile } = await import('node:fs/promises');
  const built = JSON.parse(await readFile(path.join(root, 'public', 'data', 'dashboard.json'), 'utf8'));
  assert.equal(skill(built, 'alpha').count, 10, 'the current file count is what the last collection saw');
  const state = JSON.parse(await readFile(path.join(root, 'data', 'state.json'), 'utf8'));
  assert.equal(state.counts['10'], 12);
  // An unknown repository is refused before anything is written.
  await assert.rejects(run(process.execPath, [path.join(root, 'scripts', 'collect.mjs'), '--build', '--snapshot', file, '--snapshot-repo', 'someone/else'], { env: { ...env, SNAPSHOT_TSV: '' }, cwd: root }), /not one the dashboard collects/);
  void script;
});
