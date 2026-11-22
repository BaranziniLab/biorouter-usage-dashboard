// Small builders for collections shaped like lib/collect.mjs returns them, and
// a throwaway Store directory per test. No network.

import { mkdtemp, rm, cp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { buildDashboard } from '../lib/aggregate.mjs';
import { MAIN_REPO, SKILLS_REPO, WORKFLOWS_REPO } from '../lib/collect.mjs';

export { MAIN_REPO, SKILLS_REPO, WORKFLOWS_REPO };
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
export const T0 = Date.UTC(2026, 9, 1, 8); // 2026-10-01 08:00 UTC
export const EXT_REPO = 'BaranziniLab/ExampleAgent';

export const iso = (t) => new Date(t).toISOString();

export function asset(id, name, count, size = 1000) {
  return { id, name, size, count, createdAt: iso(T0) };
}

export function release(id, tag, publishedAt, assets, extra = {}) {
  return { id, tag, name: tag, draft: false, prerelease: false, createdAt: iso(publishedAt), publishedAt: iso(publishedAt), url: `https://example.test/${tag}`, assets, ...extra };
}

export const REGISTRY = {
  extensions: [
    {
      id: 'exampleagent',
      name: 'ExampleAgent',
      privacy: 'public',
      organization: 'BaranziniLab',
      download: `https://github.com/${EXT_REPO}/releases/download/v0.1.0/exampleagent.brxt`,
      github: `https://github.com/${EXT_REPO}`,
    },
  ],
  skills: [
    { id: 'alpha', name: 'Alpha skill', category: 'Core', download: '', filename: 'alpha.zip' },
    { id: 'beta', name: 'Beta skill', category: 'Biomedical', download: '', filename: 'beta.zip' },
  ],
};

/** A collection at `at`. `releases` maps repo -> list (or null for a failed read). */
export function collection(at, releases, { registry = REGISTRY } = {}) {
  return {
    at,
    durationMs: 1,
    warnings: [],
    repo: { name: MAIN_REPO, url: 'https://example.test', stars: 0, forks: 0, watchers: 0, openIssues: 0, createdAt: iso(T0), pushedAt: iso(T0) },
    registry: structuredClone(registry),
    releases: structuredClone(releases),
    traffic: null,
    stars: [],
    forks: [],
  };
}

export async function tempStore(t, seedDir) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'usage-dashboard-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  if (seedDir) await cp(seedDir, dir, { recursive: true });
  const store = new Store(dir);
  await store.load();
  return store;
}

export function dashboard(store) {
  return buildDashboard(store, { intervalMs: DAY, nextCollectionAt: null, lastError: null, rate: null, tokenSource: 'test' });
}

export const sumMeasured = (d, kind) => d.daily.reduce((n, day) => n + (day.meas[kind] || 0), 0);
export const sumEstimated = (d, kind) => d.daily.reduce((n, day) => n + (day.est[kind] || 0), 0);
export const skill = (d, id) => d.ecosystem.skills.find((s) => s.id === id);
export const extension = (d, id) => d.ecosystem.extensions.find((x) => x.id === id);
