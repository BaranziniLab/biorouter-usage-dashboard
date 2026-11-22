// A dry run over a copy of the real data/: replace every skill, extension and
// workflow file at once, as the BAAM refresh does with `gh release upload
// --clobber`, and check that nothing the dashboard showed before goes down.
// Runs before every collection in the workflow, so it follows the live history.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAIN_REPO, SKILLS_REPO, tempStore, dashboard, sumMeasured, sumEstimated } from './fixtures.mjs';

const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const ready = existsSync(path.join(DATA, 'state.json')) && existsSync(path.join(DATA, 'latest.json'));
const KINDS = ['install', 'update', 'cli', 'check', 'other', 'skills', 'extensions', 'workflows'];

function view(d) {
  return {
    binaries: d.totals.binaries,
    checks: d.totals.byKind.check,
    ecosystem: { ...d.totals.ecosystem },
    skills: new Map(d.ecosystem.skills.map((s) => [s.id, s.count])),
    extensions: new Map(d.ecosystem.extensions.map((x) => [x.id, x.count])),
    workflows: d.ecosystem.workflows.reduce((n, w) => n + w.count, 0),
    measured: Object.fromEntries(KINDS.map((k) => [k, sumMeasured(d, k)])),
    estimated: Object.fromEntries(['install', 'update', 'cli', 'check', 'other'].map((k) => [k, sumEstimated(d, k)])),
  };
}

test('replacing every ecosystem file keeps every total of the real history', { skip: !ready && 'no data/ yet' }, async (t) => {
  const store = await tempStore(t, DATA);
  const before = view(dashboard(store));
  const last = store.latest;
  let id = 9_000_000_000;
  const replaced = new Map(); // old id -> new id
  const clobbered = structuredClone(last);
  for (const [repo, list] of Object.entries(clobbered.releases)) {
    if (repo === MAIN_REPO || !list) continue;
    for (const rel of list) {
      if (rel.draft) continue;
      rel.assets = rel.assets.map((a) => {
        const next = { ...a, id: id++, count: 0 };
        replaced.set(String(a.id), String(next.id));
        return next;
      });
    }
  }
  assert.ok(replaced.size > 100, `expected the skills and extensions to have files, got ${replaced.size}`);

  // Two downloads per skill file between the last collection and the upload,
  // read with the gh command the refresh plan uses, then folded in.
  const at = last.at + 60_000;
  const rows = [];
  for (const rel of last.releases[SKILLS_REPO] || []) {
    if (rel.draft) continue;
    for (const a of rel.assets) rows.push({ tag: rel.tag, id: String(a.id), name: a.name, count: a.count + 2, at: null });
  }
  await store.foldSnapshot(rows, { repo: SKILLS_REPO, at });

  clobbered.at = last.at + 120_000;
  await store.ingest(clobbered);
  const after = view(dashboard(store));

  assert.equal(after.binaries, before.binaries, 'the app downloads are untouched');
  assert.equal(after.checks, before.checks);
  for (const [k, v] of Object.entries(before.ecosystem)) assert.ok(after.ecosystem[k] >= v, `${k} total fell from ${v} to ${after.ecosystem[k]}`);
  for (const [k, v] of Object.entries(before.measured)) assert.ok(after.measured[k] >= v - 0.05, `measured ${k} fell from ${v} to ${after.measured[k]}`);
  for (const [k, v] of Object.entries(before.estimated)) assert.ok(Math.abs(after.estimated[k] - v) < 0.05, `estimated ${k} moved from ${v} to ${after.estimated[k]}`);
  for (const [k, v] of before.extensions) assert.ok(after.extensions.get(k) >= v, `extension ${k} fell from ${v} to ${after.extensions.get(k)}`);
  assert.ok(after.workflows >= before.workflows, 'workflow total fell');

  // Every skill keeps what it had plus the two downloads per file the snapshot read.
  const files = new Map();
  for (const rel of last.releases[SKILLS_REPO] || []) {
    if (rel.draft) continue;
    const sid = rel.tag.replace(/^skill-/, '');
    files.set(sid, (files.get(sid) || 0) + rel.assets.length);
  }
  for (const [sid, v] of before.skills) {
    assert.equal(after.skills.get(sid), v + 2 * (files.get(sid) || 0), `skill ${sid}`);
  }
  assert.equal(after.ecosystem.skills, before.ecosystem.skills + 2 * rows.length);

  // The measured history of every replaced file is still attached: no event
  // of the real history is dropped by the aggregation.
  const d = dashboard(store);
  assert.ok(d.meta.retired.files >= replaced.size - [...replaced.keys()].filter((k) => !(store.state.counts[k] > 0)).length);

  // A day later the new files have downloads of their own, and they add.
  const next = structuredClone(clobbered);
  next.at = clobbered.at + 60_000;
  for (const rel of next.releases[SKILLS_REPO] || []) for (const a of rel.assets) a.count = 1;
  await store.ingest(next);
  const later = view(dashboard(store));
  for (const [sid, v] of after.skills) assert.equal(later.skills.get(sid), v + (files.get(sid) || 0), `skill ${sid} after new downloads`);
});
