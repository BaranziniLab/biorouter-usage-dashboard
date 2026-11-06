// Turns the stored history into the one JSON document the page renders.
//
// Two kinds of daily numbers, never mixed up:
//   measured   the rise in an asset's count between two collections, bucketed
//              by the UTC day it was seen. Exact to the collection interval.
//   estimated  GitHub keeps no history, so the counts that already existed
//              when measuring began are spread evenly across the days each
//              release was the newest one. A release is downloaded mostly while
//              it is the latest (the download page and the updater both point
//              there), so this is a fair shape but not a record.

import { classifyAsset, compareTags, KIND_LABEL, PLATFORM_LABEL } from './classify.mjs';
import { MAIN_REPO, SKILLS_REPO, WORKFLOWS_REPO } from './collect.mjs';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const BIN_KINDS = ['install', 'update', 'cli', 'other'];

export function buildDashboard(store, { intervalMs, nextCollectionAt, lastError, rate, tokenSource }) {
  const now = Date.now();
  const latest = store.latest;
  const state = store.state;
  if (!latest) {
    return { ready: false, generatedAt: now, lastError: lastError || null, tokenSource };
  }
  const M = state.measuringSince;

  // ── Main repository assets ────────────────────────────────────────────────
  const all = (latest.releases[MAIN_REPO] || []).filter((r) => r.publishedAt || r.draft);
  const drafts = all.filter((r) => r.draft);
  const releases = all.filter((r) => !r.draft && r.publishedAt).sort((a, b) => ts(a.publishedAt) - ts(b.publishedAt));
  const stable = releases.filter((r) => !r.prerelease);

  const windowOf = new Map();
  for (const r of releases) {
    const start = ts(r.publishedAt);
    const next = stable.find((s) => ts(s.publishedAt) > start);
    windowOf.set(r.id, { start, end: next ? ts(next.publishedAt) : now, open: !next });
  }
  const latestStable = stable[stable.length - 1] || null;

  const assetIndex = new Map(); // id -> asset record
  const assets = [];
  for (const r of releases) {
    for (const a of r.assets) {
      const c = classifyAsset(a.name);
      const rec = {
        id: a.id,
        tag: r.tag,
        releaseId: r.id,
        prerelease: r.prerelease,
        name: a.name,
        size: a.size,
        count: a.count,
        createdAt: a.createdAt,
        publishedAt: r.publishedAt,
        ...c,
        platformLabel: PLATFORM_LABEL[c.platform] || c.platform,
        d24h: 0,
        d7d: 0,
      };
      assetIndex.set(String(a.id), rec);
      assets.push(rec);
    }
  }

  // ── Ecosystem assets (BAAM) ───────────────────────────────────────────────
  const reg = latest.registry || store.registry || { skills: [], extensions: [] };
  const ecoIndex = new Map(); // id -> { group, item }
  const skillMeta = new Map(reg.skills.map((s) => [s.id, s]));
  const skills = new Map();
  for (const r of latest.releases[SKILLS_REPO] || []) {
    if (r.draft) continue;
    const id = r.tag.replace(/^skill-/, '');
    const meta = skillMeta.get(id);
    const item = skills.get(id) || {
      id,
      name: meta?.name || id,
      category: meta?.category || 'Unlisted',
      listed: !!meta,
      count: 0,
      d24h: 0,
      d7d: 0,
      publishedAt: r.publishedAt,
    };
    for (const a of r.assets) {
      item.count += a.count;
      ecoIndex.set(String(a.id), { group: 'skills', item });
    }
    skills.set(id, item);
  }

  const extensions = [];
  for (const ext of reg.extensions) {
    const m = String(ext.download || '').match(/github\.com\/([^/]+\/[^/]+)\/releases\/download\//);
    const repo = m ? m[1] : null;
    const rels = repo ? latest.releases[repo] : null;
    const item = {
      id: ext.id,
      name: ext.name,
      repo,
      privacy: ext.privacy,
      organization: ext.organization,
      count: 0,
      bundleCount: 0,
      releases: 0,
      d24h: 0,
      d7d: 0,
      available: Array.isArray(rels),
    };
    for (const r of rels || []) {
      if (r.draft) continue;
      item.releases++;
      for (const a of r.assets) {
        item.count += a.count;
        if (a.name.endsWith('.brxt')) item.bundleCount += a.count;
        ecoIndex.set(String(a.id), { group: 'extensions', item });
      }
    }
    extensions.push(item);
  }

  const workflows = [];
  for (const r of latest.releases[WORKFLOWS_REPO] || []) {
    if (r.draft) continue;
    for (const a of r.assets) {
      const item = { name: a.name, tag: r.tag, count: a.count, d24h: 0, d7d: 0 };
      ecoIndex.set(String(a.id), { group: 'workflows', item });
      workflows.push(item);
    }
  }

  // ── Measured events ───────────────────────────────────────────────────────
  const meas = new Map(); // day -> { install, update, cli, check, other, skills, extensions, workflows }
  const recent = { h1: zero(), h24: zero(), d7: zero() };
  for (const [t, key, d, tPrev] of store.events) {
    const a = assetIndex.get(key);
    const e = a ? null : ecoIndex.get(key);
    const kind = a ? a.kind : e ? e.group : null;
    if (!kind) continue;
    // The rise happened somewhere between the two collections: spread it.
    const from = tPrev && tPrev < t ? tPrev : t;
    if (t - from > HOUR) spread(meas, from, t, d, kind);
    else bump(meas, dayKey(t), kind, d);
    const share = (w) => (t - from > 0 ? overlap(from, t, now - w, now) / (t - from) : t > now - w ? 1 : 0);
    const h1 = d * share(HOUR);
    const h24 = d * share(DAY);
    const d7 = d * share(7 * DAY);
    if (h1) recent.h1[kind] = (recent.h1[kind] || 0) + h1;
    if (h24) {
      recent.h24[kind] = (recent.h24[kind] || 0) + h24;
      if (a) a.d24h += h24;
      if (e) e.item.d24h += h24;
    }
    if (d7) {
      recent.d7[kind] = (recent.d7[kind] || 0) + d7;
      if (a) a.d7d += d7;
      if (e) e.item.d7d += d7;
    }
  }

  // ── Estimated history from release windows ────────────────────────────────
  const est = new Map();
  for (const a of assets) {
    const base = state.baseline[String(a.id)] || 0;
    if (base <= 0 || !M) continue;
    const w = windowOf.get(a.releaseId);
    spread(est, w.start, Math.min(w.end, M), base, a.kind);
  }

  const firstDay = releases.length ? dayStart(ts(releases[0].publishedAt)) : dayStart(now);
  const daily = [];
  for (let t = firstDay; t <= now; t += DAY) {
    const k = dayKey(t);
    const e = est.get(k) || {};
    const m = meas.get(k) || {};
    daily.push({
      date: k,
      est: pick(e, ['install', 'update', 'cli', 'check', 'other']),
      meas: pick(m, ['install', 'update', 'cli', 'check', 'other', 'skills', 'extensions', 'workflows']),
    });
  }

  // ── Totals ────────────────────────────────────────────────────────────────
  const byKind = { install: 0, update: 0, cli: 0, check: 0, other: 0 };
  let bytes = 0;
  for (const a of assets) {
    byKind[a.kind] += a.count;
    bytes += a.count * a.size;
  }
  const binaries = BIN_KINDS.reduce((s, k) => s + byKind[k], 0);

  const platforms = new Map();
  for (const a of assets) {
    if (a.kind === 'check') continue;
    const p = platforms.get(a.platform) || {
      platform: a.platform,
      label: a.platformLabel,
      install: 0,
      update: 0,
      cli: 0,
      other: 0,
      total: 0,
    };
    p[a.kind] += a.count;
    p.total += a.count;
    platforms.set(a.platform, p);
  }
  const order = ['mac-arm64', 'mac-x64', 'windows', 'linux', 'mac', 'other'];
  const byPlatform = [...platforms.values()].sort((a, b) => order.indexOf(a.platform) - order.indexOf(b.platform));

  const formats = new Map();
  for (const a of assets) {
    const key = `${a.kind}|${a.label}`;
    const f = formats.get(key) || { label: a.label, kind: a.kind, format: a.format, platform: a.platform, count: 0, files: 0, bytes: 0 };
    f.count += a.count;
    f.files++;
    f.bytes += a.count * a.size;
    formats.set(key, f);
  }
  const byFormat = [...formats.values()].sort((a, b) => b.count - a.count);

  // ── Per release ───────────────────────────────────────────────────────────
  const releaseRows = releases.map((r) => {
    const w = windowOf.get(r.id);
    const row = {
      tag: r.tag,
      url: r.url,
      publishedAt: r.publishedAt,
      prerelease: r.prerelease,
      latest: latestStable && r.id === latestStable.id,
      daysAsLatest: r.prerelease ? null : (w.end - w.start) / DAY,
      open: w.open,
      install: 0,
      update: 0,
      cli: 0,
      check: 0,
      other: 0,
      d24h: 0,
      byPlatform: {},
      assets: r.assets.length,
    };
    for (const a of assets) {
      if (a.releaseId !== r.id) continue;
      row[a.kind] += a.count;
      if (a.kind !== 'check') {
        row.d24h += a.d24h;
        row.byPlatform[a.platform] = (row.byPlatform[a.platform] || 0) + a.count;
      }
    }
    row.total = BIN_KINDS.reduce((s, k) => s + row[k], 0);
    return row;
  });

  // ── Latest release adoption, cumulative since it shipped ──────────────────
  let adoption = null;
  if (latestStable) {
    const ids = new Set(latestStable.assets.map((a) => String(a.id)));
    const pub = ts(latestStable.publishedAt);
    const cum = { install: 0, update: 0, cli: 0, check: 0, other: 0 };
    const points = [{ t: pub, ...cum, measured: false }];
    if (M && M > pub) {
      for (const a of latestStable.assets) {
        const rec = assetIndex.get(String(a.id));
        cum[rec.kind] += state.baseline[String(a.id)] || 0;
      }
      points.push({ t: M, ...cum, measured: false });
    }
    for (const [t, key, d] of store.events) {
      if (!ids.has(key)) continue;
      cum[assetIndex.get(key).kind] += d;
      points.push({ t, ...cum, measured: true });
    }
    points.push({ t: now, ...cum, measured: true });
    adoption = { tag: latestStable.tag, publishedAt: latestStable.publishedAt, url: latestStable.url, points };
  }

  // ── Period sums (estimate + measured) ─────────────────────────────────────
  const period = (days, offset = 0) => {
    const end = daily.length - offset;
    const slice = daily.slice(Math.max(0, end - days), end);
    const out = { install: 0, update: 0, cli: 0, check: 0, other: 0, estimated: false };
    for (const d of slice) {
      for (const k of ['install', 'update', 'cli', 'check', 'other']) {
        const e = d.est[k] || 0;
        out[k] += e + (d.meas[k] || 0);
        if (e > 0) out.estimated = true;
      }
    }
    out.binaries = BIN_KINDS.reduce((s, k) => s + out[k], 0);
    return out;
  };

  // ── Traffic ───────────────────────────────────────────────────────────────
  const tr = store.traffic;
  const series = (obj) =>
    Object.entries(obj || {})
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, v]) => ({ date, count: v.count, uniques: v.uniques }));

  const cumulative = (dates) => {
    if (!dates) return null;
    return dates
      .map(ts)
      .sort((a, b) => a - b)
      .map((t, i) => ({ t, n: i + 1 }));
  };

  // ── Ecosystem totals ──────────────────────────────────────────────────────
  for (const x of [...skills.values(), ...extensions, ...workflows]) {
    x.d24h = r2(x.d24h);
    x.d7d = r2(x.d7d);
  }
  for (const r of releaseRows) r.d24h = r2(r.d24h);
  for (const w of Object.values(recent)) for (const k of Object.keys(w)) w[k] = r2(w[k]);
  const skillList = [...skills.values()].sort((a, b) => b.count - a.count);
  const extList = extensions.sort((a, b) => b.count - a.count);
  const skillCategories = {};
  for (const s of skillList) skillCategories[s.category] = (skillCategories[s.category] || 0) + s.count;

  return {
    ready: true,
    generatedAt: now,
    tokenSource,
    meta: {
      repo: latest.repo,
      measuringSince: M,
      collections: state.collections,
      lastCollectionAt: latest.at,
      lastCollectionMs: latest.durationMs,
      warnings: latest.warnings || [],
      lastError: lastError || null,
      intervalMs,
      nextCollectionAt,
      rate,
      draftsExcluded: drafts.map((d) => ({ tag: d.tag, downloads: d.assets.reduce((s, a) => s + a.count, 0) })),
      kindLabels: KIND_LABEL,
    },
    totals: {
      binaries,
      byKind,
      bytes,
      releases: releases.length,
      stableReleases: stable.length,
      assets: assets.length,
      latest: latestStable
        ? (() => {
            const row = releaseRows.find((r) => r.tag === latestStable.tag);
            return { tag: latestStable.tag, publishedAt: latestStable.publishedAt, url: latestStable.url, total: row.total, check: row.check, install: row.install, update: row.update, cli: row.cli };
          })()
        : null,
      last30: period(30),
      prev30: period(30, 30),
      last7: period(7),
      prev7: period(7, 7),
      recent,
      ecosystem: {
        skills: skillList.reduce((s, x) => s + x.count, 0),
        extensions: extList.reduce((s, x) => s + x.count, 0),
        workflows: workflows.reduce((s, x) => s + x.count, 0),
      },
    },
    daily,
    byPlatform,
    byFormat,
    releases: releaseRows,
    assets: assets
      .map((a) => ({
        id: a.id,
        tag: a.tag,
        name: a.name,
        size: a.size,
        count: a.count,
        kind: a.kind,
        platform: a.platform,
        platformLabel: a.platformLabel,
        format: a.format,
        label: a.label,
        prerelease: a.prerelease,
        publishedAt: a.publishedAt,
        d24h: r2(a.d24h),
        d7d: r2(a.d7d),
      }))
      .sort((a, b) => b.count - a.count),
    adoption,
    traffic: {
      views: series(tr.views),
      clones: series(tr.clones),
      referrers: tr.referrers || [],
      paths: tr.paths || [],
      updatedAt: tr.updatedAt,
    },
    stars: cumulative(latest.stars),
    forks: cumulative(latest.forks),
    ecosystem: {
      skills: skillList,
      skillCategories,
      extensions: extList,
      workflows: workflows.sort((a, b) => b.count - a.count),
      registrySkills: reg.skills.length,
      registryExtensions: reg.extensions.length,
    },
  };
}

function spread(target, start, end, amount, kind) {
  if (end - start < HOUR) end = start + HOUR;
  const total = end - start;
  let t = start;
  while (t < end) {
    const segEnd = Math.min(end, dayStart(t) + DAY);
    bump(target, dayKey(t), kind, (amount * (segEnd - t)) / total);
    t = segEnd;
  }
}

function overlap(a0, a1, b0, b1) {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

function bump(map, day, kind, n) {
  const row = map.get(day) || {};
  row[kind] = (row[kind] || 0) + n;
  map.set(day, row);
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k]) out[k] = Math.round(obj[k] * 100) / 100;
  return out;
}

const r2 = (x) => Math.round(x * 100) / 100;

function zero() {
  return {};
}

const ts = (s) => (typeof s === 'number' ? s : Date.parse(s));
const dayStart = (t) => Math.floor(t / DAY) * DAY;
const dayKey = (t) => new Date(dayStart(t)).toISOString().slice(0, 10);

export { compareTags };
