#!/usr/bin/env node
// Collect once and write the site's data file.
//
//   node scripts/collect.mjs            collect from GitHub, update data/, write public/data/dashboard.json
//   node scripts/collect.mjs --build    rebuild public/data/dashboard.json from data/ without collecting
//   node scripts/collect.mjs --snapshot counts.tsv [--snapshot-repo owner/repo] [--snapshot-at ISO]
//                                       fold in counts read just before files were replaced, then collect
//
// The snapshot can also come from the environment (SNAPSHOT_TSV, SNAPSHOT_REPO,
// SNAPSHOT_AT), which is how the workflow's manual run passes it. The repository
// defaults to BaranziniLab/biorouter-skills; see parseSnapshot in lib/store.mjs.
//
// The daily GitHub Actions workflow runs the first form and commits data/.
// Token: GITHUB_TOKEN or GH_TOKEN, else a signed-in `gh` CLI. Repository
// traffic (views, clones, referrers) needs a token with push access to
// BaranziniLab/biorouter; without one the traffic history stops growing.

import { mkdir, writeFile, rename, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitHub, resolveToken } from '../lib/github.mjs';
import { collect, MAIN_REPO, SKILLS_REPO, WORKFLOWS_REPO } from '../lib/collect.mjs';
import { Store, parseSnapshot } from '../lib/store.mjs';
import { buildDashboard } from '../lib/aggregate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const OUT = path.join(ROOT, 'public', 'data', 'dashboard.json');
const SCHEDULE_UTC = { hour: 1, minute: 23 }; // keep in step with .github/workflows/daily.yml

const buildOnly = process.argv.includes('--build');
const store = new Store(DATA);
await store.load();

const snapshotFile = arg('--snapshot');
const snapshotText = snapshotFile ? await readFile(snapshotFile, 'utf8') : process.env.SNAPSHOT_TSV || '';
if (snapshotText.trim()) {
  const repo = arg('--snapshot-repo') || process.env.SNAPSHOT_REPO || SKILLS_REPO;
  const known = new Set([MAIN_REPO, SKILLS_REPO, WORKFLOWS_REPO, ...Object.keys(store.latest?.releases || {})]);
  if (!known.has(repo)) throw new Error(`Snapshot repository ${repo} is not one the dashboard collects.`);
  const when = arg('--snapshot-at') || process.env.SNAPSHOT_AT || '';
  const at = when ? Date.parse(when) : Date.now();
  if (!Number.isFinite(at)) throw new Error(`Snapshot time ${when} is not an ISO time.`);
  const rows = parseSnapshot(snapshotText);
  const rose = await store.foldSnapshot(rows, { repo, at });
  console.log(`Folded in a snapshot of ${rows.length} files from ${repo}: ${rose} counts rose.`);
}

let gh = null;
let tokenSource = 'none';
if (!buildOnly) {
  const { token, source } = await resolveToken();
  tokenSource = source;
  gh = new GitHub(token);
  const c = await collect(gh, { cachedRegistry: store.registry });
  const moved = await store.ingest(c);
  console.log(`Collected in ${c.durationMs} ms with ${gh.requests} requests: ${moved} asset counts rose.`);
  for (const w of c.warnings) console.log(`warning: ${w}`);
}

const d = buildDashboard(store, {
  intervalMs: 86_400_000,
  nextCollectionAt: nextRun(),
  lastError: null,
  rate: gh ? gh.rate : null,
  tokenSource,
});
await mkdir(path.dirname(OUT), { recursive: true });
const tmp = `${OUT}.tmp`;
await writeFile(tmp, JSON.stringify(d));
await rename(tmp, OUT);
console.log(
  `Wrote ${path.relative(ROOT, OUT)}: ${d.totals.binaries} downloads, ${d.totals.byKind.check} update checks,`,
  `${d.totals.releases} releases, measuring since ${new Date(d.meta.measuringSince).toISOString()}.`
);

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
}

function nextRun() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), SCHEDULE_UTC.hour, SCHEDULE_UTC.minute));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime();
}
