#!/usr/bin/env node
// Collect once and write the site's data file.
//
//   node scripts/collect.mjs            collect from GitHub, update data/, write public/data/dashboard.json
//   node scripts/collect.mjs --build    rebuild public/data/dashboard.json from data/ without collecting
//
// The daily GitHub Actions workflow runs the first form and commits data/.
// Token: GITHUB_TOKEN or GH_TOKEN, else a signed-in `gh` CLI. Repository
// traffic (views, clones, referrers) needs a token with push access to
// BaranziniLab/biorouter; without one the traffic history stops growing.

import { mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitHub, resolveToken } from '../lib/github.mjs';
import { collect } from '../lib/collect.mjs';
import { Store } from '../lib/store.mjs';
import { buildDashboard } from '../lib/aggregate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const OUT = path.join(ROOT, 'public', 'data', 'dashboard.json');
const SCHEDULE_UTC = { hour: 1, minute: 23 }; // keep in step with .github/workflows/update.yml

const buildOnly = process.argv.includes('--build');
const store = new Store(DATA);
await store.load();

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

function nextRun() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), SCHEDULE_UTC.hour, SCHEDULE_UTC.minute));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime();
}
