// A replaced or deleted release file keeps its downloads and its measured
// history on the release, skill, extension or workflow it belonged to.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  MAIN_REPO,
  SKILLS_REPO,
  WORKFLOWS_REPO,
  EXT_REPO,
  HOUR,
  DAY,
  T0,
  asset,
  release,
  collection,
  tempStore,
  dashboard,
  sumMeasured,
  sumEstimated,
  skill,
  extension,
} from './fixtures.mjs';

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.05, `${msg}: ${a} vs ${b}`);

// Three collections a day apart with the same files, then the caller's changes.
function skillsOnly(alpha, beta = [asset(20, 'beta.zip', 4)]) {
  return {
    // The daily series starts at the first app release, so there is one.
    [MAIN_REPO]: [release(1, 'v1.0.0', T0 - 40 * DAY, [asset(1, 'Biorouter-1.0.0-arm64.dmg', 7)])],
    [SKILLS_REPO]: [release(100, 'skill-alpha', T0 - 30 * DAY, alpha), release(200, 'skill-beta', T0 - 30 * DAY, beta)],
    [WORKFLOWS_REPO]: [],
    [EXT_REPO]: [],
  };
}

test('a clobbered skill keeps its lifetime count and measured history on its tag', async (t) => {
  const store = await tempStore(t);
  await store.ingest(collection(T0, skillsOnly([asset(10, 'alpha.zip', 10)])));
  await store.ingest(collection(T0 + DAY, skillsOnly([asset(10, 'alpha.zip', 15)])));
  const before = dashboard(store);
  assert.equal(skill(before, 'alpha').count, 15);
  close(sumMeasured(before, 'skills'), 5, 'measured before');

  // gh release upload --clobber: the old file is deleted, the new one starts at 0.
  await store.ingest(collection(T0 + 2 * DAY, skillsOnly([asset(11, 'alpha.zip', 0)])));
  const after = dashboard(store);
  assert.equal(skill(after, 'alpha').count, 15, 'the replaced file still counts');
  assert.equal(skill(after, 'alpha').fromRetired, 15);
  assert.equal(skill(after, 'alpha').name, 'Alpha skill');
  close(sumMeasured(after, 'skills'), 5, 'the measured rise is still on the chart');
  assert.equal(after.totals.ecosystem.skills, before.totals.ecosystem.skills);
  assert.deepEqual(
    { ...store.state.retired['10'], seenAt: undefined, goneAt: undefined },
    { repo: SKILLS_REPO, releaseId: 100, tag: 'skill-alpha', name: 'alpha.zip', size: 1000, count: 15, createdAt: store.state.retired['10'].createdAt, publishedAt: new Date(T0 - 30 * DAY).toISOString(), prerelease: false, seenAt: undefined, goneAt: undefined }
  );
  assert.equal(store.state.retired['10'].goneAt, T0 + 2 * DAY);
  assert.equal(store.state.retired['10'].seenAt, T0 + DAY);

  // The new file's downloads add to the same skill.
  await store.ingest(collection(T0 + 3 * DAY, skillsOnly([asset(11, 'alpha.zip', 2)])));
  const later = dashboard(store);
  assert.equal(skill(later, 'alpha').count, 17);
  close(sumMeasured(later, 'skills'), 7, 'measured after');
  // The new file's 2 downloads are spread between the third and fourth collection
  // (08:00 to 08:00 UTC), over the two days those span.
  const dayOf = (t) => later.daily.find((d) => d.date === new Date(t).toISOString().slice(0, 10))?.meas.skills || 0;
  close(dayOf(T0 + 2 * DAY) + dayOf(T0 + 3 * DAY), 2, 'the new file lands between its collections');
  close(dayOf(T0), 5 * (16 / 24), 'the old file keeps its own days');
  // The 7-day window still sees the old file's rise.
  assert.ok(skill(later, 'alpha').d7d >= 0);
});

test('totals never drop when files disappear, across every kind of repository', async (t) => {
  const store = await tempStore(t);
  const rel = (n) => T0 - n * DAY;
  // One of everything: a main release with an installer and an update check,
  // two skills, an extension bundle and a workflow file.
  const state = {
    main: [
      { id: 1, name: 'Biorouter-1.0.0-arm64.dmg', count: 50 },
      { id: 2, name: 'latest-mac.yml', count: 300 },
      { id: 3, name: 'Biorouter-darwin-arm64-1.0.0.zip', count: 40 },
    ],
    alpha: [{ id: 10, name: 'alpha.zip', count: 9 }],
    beta: [{ id: 20, name: 'beta.zip', count: 4 }],
    ext: [{ id: 30, name: 'exampleagent.brxt', count: 12 }],
    wf: [{ id: 40, name: 'flow.yaml', count: 6 }],
  };
  let nextId = 1000;
  const releases = () => ({
    [MAIN_REPO]: [release(1, 'v1.0.0', rel(20), state.main.map((a) => asset(a.id, a.name, a.count)))],
    [SKILLS_REPO]: [release(100, 'skill-alpha', rel(30), state.alpha.map((a) => asset(a.id, a.name, a.count))), ...(state.beta ? [release(200, 'skill-beta', rel(30), state.beta.map((a) => asset(a.id, a.name, a.count)))] : [])],
    [WORKFLOWS_REPO]: [release(300, 'wf-1', rel(30), state.wf.map((a) => asset(a.id, a.name, a.count)))],
    [EXT_REPO]: [release(400, 'v0.1.0', rel(30), state.ext.map((a) => asset(a.id, a.name, a.count)))],
  });
  const replace = (list, name) => list.map((a) => (a.name === name ? { id: nextId++, name, count: 0 } : a));
  const bump = (list, n) => list.forEach((a) => (a.count += n));

  const snapshot = (d) => ({
    binaries: d.totals.binaries,
    checks: d.totals.byKind.check,
    install: d.totals.byKind.install,
    update: d.totals.byKind.update,
    release: d.releases.find((r) => r.tag === 'v1.0.0')?.total ?? 0,
    latestTotal: d.totals.latest?.total ?? 0,
    adoption: (() => {
      const p = d.adoption?.points?.at(-1) || {};
      return (p.install || 0) + (p.update || 0) + (p.check || 0);
    })(),
    skills: d.totals.ecosystem.skills,
    extensions: d.totals.ecosystem.extensions,
    workflows: d.totals.ecosystem.workflows,
    alpha: skill(d, 'alpha')?.count ?? 0,
    beta: skill(d, 'beta')?.count ?? 0,
    ext: extension(d, 'exampleagent').count,
    bundle: extension(d, 'exampleagent').bundleCount,
    flow: d.ecosystem.workflows.filter((w) => w.name === 'flow.yaml').reduce((n, w) => n + w.count, 0),
    measured: ['install', 'update', 'check', 'skills', 'extensions', 'workflows'].reduce((n, k) => n + sumMeasured(d, k), 0),
    estimated: ['install', 'update', 'check'].reduce((n, k) => n + sumEstimated(d, k), 0),
  });
  const steps = [
    () => {},
    () => (bump(state.main, 3), bump(state.alpha, 2), bump(state.ext, 1), bump(state.wf, 1)),
    () => (state.main = replace(state.main, 'Biorouter-1.0.0-arm64.dmg')),
    () => (state.main = replace(state.main, 'latest-mac.yml'), bump(state.main, 1)),
    () => (state.alpha = replace(state.alpha, 'alpha.zip')),
    () => (state.ext = replace(state.ext, 'exampleagent.brxt')),
    () => (state.wf = replace(state.wf, 'flow.yaml')),
    () => (state.beta = null), // the whole skill release is deleted
    () => (bump(state.main, 2), bump(state.alpha, 5), bump(state.ext, 3), bump(state.wf, 2)),
    () => (state.alpha = replace(state.alpha, 'alpha.zip'), state.main = replace(state.main, 'Biorouter-1.0.0-arm64.dmg')),
  ];
  let prev = null;
  for (let i = 0; i < steps.length; i++) {
    steps[i]();
    await store.ingest(collection(T0 + i * DAY, releases()));
    const now = snapshot(dashboard(store));
    if (prev) {
      for (const [k, v] of Object.entries(now)) assert.ok(v >= prev[k] - 0.05, `step ${i}: ${k} fell from ${prev[k]} to ${v}`);
    }
    prev = now;
  }
  // Every download ever seen is still counted: 50+3, then 1+2, dmg (three files), 300+3+1+2 checks,
  // 40+3+1+2 zip; 9+2+5 alpha; 4 beta; 12+1+3 ext; 6+1+2 workflow.
  assert.equal(prev.install, 56);
  assert.equal(prev.checks, 306);
  assert.equal(prev.update, 46);
  assert.equal(prev.alpha, 16);
  assert.equal(prev.beta, 4);
  assert.equal(prev.ext, 16);
  assert.equal(prev.bundle, 16);
  assert.equal(prev.flow, 9);
  const d = dashboard(store);
  assert.equal(d.totals.assets, 3, 'files on the release now, not every file it ever had');
  assert.equal(d.ecosystem.workflows.length, 1, 'a replaced workflow file adds to the row of its replacement');
  assert.ok(d.assets.some((a) => a.retired && a.name === 'Biorouter-1.0.0-arm64.dmg'));
  assert.equal(d.byFormat.reduce((n, f) => n + f.files, 0), 3);
  assert.equal(d.meta.retired.files, Object.keys(store.state.retired).length);
});

test('a file that comes back is current again and is not counted twice', async (t) => {
  const store = await tempStore(t);
  await store.ingest(collection(T0, skillsOnly([asset(10, 'alpha.zip', 10)])));
  // A transient read without the file, then the file again with more downloads.
  await store.ingest(collection(T0 + DAY, skillsOnly([])));
  assert.equal(skill(dashboard(store), 'alpha').count, 10);
  await store.ingest(collection(T0 + 2 * DAY, skillsOnly([asset(10, 'alpha.zip', 13)])));
  assert.equal(store.state.retired['10'], undefined);
  const d = dashboard(store);
  assert.equal(skill(d, 'alpha').count, 13);
  close(sumMeasured(d, 'skills'), 3, 'only the rise is measured');
});

test('drafts and files nobody downloaded leave nothing behind', async (t) => {
  const store = await tempStore(t);
  const draft = (assets) => ({
    [MAIN_REPO]: [release(9, 'v2.0.0', T0, assets, { draft: true, publishedAt: null })],
    [SKILLS_REPO]: [release(100, 'skill-alpha', T0, [asset(10, 'alpha.zip', 0)])],
  });
  await store.ingest(collection(T0, draft([asset(1, 'Biorouter-2.0.0-arm64.dmg', 3)])));
  await store.ingest(collection(T0 + DAY, draft([asset(1, 'Biorouter-2.0.0-arm64.dmg', 5)])));
  await store.ingest(collection(T0 + 2 * DAY, { [MAIN_REPO]: [], [SKILLS_REPO]: [release(100, 'skill-alpha', T0, [])] }));
  assert.deepEqual(store.state.retired, {});
});

test('a repository that failed to read retires nothing, and its next rise spans the gap', async (t) => {
  const store = await tempStore(t);
  await store.ingest(collection(T0, skillsOnly([asset(10, 'alpha.zip', 10)])));
  await store.ingest(collection(T0 + DAY, { ...skillsOnly([]), [SKILLS_REPO]: null }));
  assert.deepEqual(store.state.retired, {});
  assert.equal(skill(dashboard(store), 'alpha').count, 10, 'the failed read keeps the last list');
  await store.ingest(collection(T0 + 2 * DAY, skillsOnly([asset(10, 'alpha.zip', 14)])));
  const rise = store.events.find((e) => e[1] === '10');
  assert.deepEqual(rise, [T0 + 2 * DAY, '10', 4, T0], 'spread from the last read, not the failed pass');
});

test('a main-release file that is replaced keeps its estimate, its release row and the adoption curve', async (t) => {
  const store = await tempStore(t);
  const main = (assets) => ({ [MAIN_REPO]: [release(1, 'v1.0.0', T0 - 20 * DAY, assets)], [SKILLS_REPO]: [] });
  await store.ingest(collection(T0, main([asset(1, 'Biorouter-1.0.0-arm64.dmg', 40), asset(2, 'latest-mac.yml', 100)])));
  await store.ingest(collection(T0 + DAY, main([asset(1, 'Biorouter-1.0.0-arm64.dmg', 44), asset(2, 'latest-mac.yml', 120)])));
  const before = dashboard(store);
  await store.ingest(collection(T0 + 2 * DAY, main([asset(3, 'Biorouter-1.0.0-arm64.dmg', 1), asset(2, 'latest-mac.yml', 130)])));
  const after = dashboard(store);
  close(sumEstimated(after, 'install'), sumEstimated(before, 'install'), 'the estimate of the replaced file is kept');
  close(sumMeasured(after, 'install'), 5, 'its measured rise plus the new file');
  assert.equal(after.releases[0].install, 45);
  assert.equal(after.totals.latest.install, 45);
  assert.equal(after.adoption.points.at(-1).install, 45);
  const gone = after.assets.find((a) => a.id === 1);
  assert.equal(gone.retired, true);
  assert.equal(gone.count, 44);
  assert.equal(after.totals.assets, 2);
  // Counts read before the replacement and folded in afterwards land earlier
  // than the last collection; the adoption curve still never steps back in time.
  await store.foldSnapshot([{ tag: 'v1.0.0', id: '1', name: 'Biorouter-1.0.0-arm64.dmg', count: 46, at: T0 + 1.5 * DAY }], { repo: MAIN_REPO });
  const folded = dashboard(store);
  assert.equal(folded.adoption.points.at(-1).install, 47);
  const times = folded.adoption.points.map((p) => p.t);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  const installs = folded.adoption.points.map((p) => p.install);
  assert.deepEqual(installs, [...installs].sort((a, b) => a - b), 'the curve only rises');
});

test('a skill the registry stops listing keeps its name and category', async (t) => {
  const store = await tempStore(t);
  await store.ingest(collection(T0, skillsOnly([asset(10, 'alpha.zip', 10)])));
  const moved = { ...structuredClone((await import('./fixtures.mjs')).REGISTRY) };
  moved.skills = moved.skills.filter((s) => s.id !== 'beta');
  await store.ingest(collection(T0 + DAY, skillsOnly([asset(10, 'alpha.zip', 10)]), { registry: moved }));
  const beta = skill(dashboard(store), 'beta');
  assert.equal(beta.name, 'Beta skill');
  assert.equal(beta.category, 'Biomedical');
  assert.equal(beta.listed, false);
  assert.equal(beta.count, 4);
});

test('the stored state stays readable by the page and the collector', async (t) => {
  const store = await tempStore(t);
  await store.ingest(collection(T0, skillsOnly([asset(10, 'alpha.zip', 10)])));
  await store.ingest(collection(T0 + DAY, skillsOnly([asset(11, 'alpha.zip', 0)])));
  const onDisk = JSON.parse(await readFile(store.file('state.json'), 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.retired['10'].count, 10);
  assert.equal(onDisk.repoReadAt[SKILLS_REPO], T0 + DAY);
  assert.deepEqual(onDisk.skillMeta.alpha, { name: 'Alpha skill', category: 'Core' });
  // A store that predates these fields loads with them empty.
  const { Store } = await import('../lib/store.mjs');
  const old = { ...onDisk };
  delete old.retired;
  delete old.repoReadAt;
  delete old.skillMeta;
  const { writeFile } = await import('node:fs/promises');
  await writeFile(store.file('state.json'), JSON.stringify(old));
  const again = new Store(store.dir);
  await again.load();
  assert.deepEqual(again.state.retired, {});
  assert.deepEqual(again.state.repoReadAt, {});
  // Without the record, the old file is simply not counted (the behaviour before this change).
  assert.equal(skill(dashboard(again), 'alpha').count, 0);
  void HOUR;
});
