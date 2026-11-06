// On-disk history. GitHub only reports cumulative download counts, so daily
// numbers come from comparing collections over time:
//
//   data/state.json     last known count per asset, the baseline taken on the
//                       first collection, and when measuring began
//   data/events.jsonl   one line per asset whose count rose between two
//                       collections: [epochMs, assetId, delta, previousCollectionMs]
//   data/traffic.json   repository views and clones per day, kept past GitHub's 14 days
//   data/latest.json    the most recent full collection
//   data/registry.json  the last BAAM registry that loaded

import { mkdir, readFile, writeFile, rename, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.state = null;
    this.events = [];
    this.traffic = { views: {}, clones: {}, referrers: [], paths: [], updatedAt: null };
    this.latest = null;
    this.registry = null;
  }

  file(name) {
    return path.join(this.dir, name);
  }

  async load() {
    await mkdir(this.dir, { recursive: true });
    this.state = (await readJson(this.file('state.json'))) || {
      version: 1,
      measuringSince: null,
      counts: {},
      baseline: {},
      firstSeen: {},
      collections: 0,
    };
    this.traffic = (await readJson(this.file('traffic.json'))) || this.traffic;
    this.latest = await readJson(this.file('latest.json'));
    this.registry = await readJson(this.file('registry.json'));
    this.events = [];
    if (existsSync(this.file('events.jsonl'))) {
      const text = await readFile(this.file('events.jsonl'), 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (Array.isArray(e) && e.length >= 3) this.events.push(e);
        } catch {
          // A torn last line from a crash mid-append: skip it.
        }
      }
    }
  }

  /** Fold one collection into the history. Returns how many assets moved. */
  async ingest(c) {
    const s = this.state;
    const first = !s.measuringSince;
    const fresh = [];
    // A rise is spread over the time since the previous collection, so a daily
    // run still lands each download on (about) the right day.
    const since = s.lastCollectionAt || c.at;
    for (const list of Object.values(c.releases)) {
      if (!list) continue; // a repo that failed this pass keeps its old counts
      for (const rel of list) {
        for (const a of rel.assets) {
          const key = String(a.id);
          const prev = s.counts[key];
          if (first) {
            s.baseline[key] = a.count;
          } else if (prev === undefined) {
            // An asset that appeared after measuring began: everything it has
            // was downloaded since, so all of it is measured.
            s.baseline[key] = 0;
            s.firstSeen[key] = c.at;
            if (a.count > 0) fresh.push([c.at, key, a.count, since]);
          } else if (a.count > prev) {
            fresh.push([c.at, key, a.count - prev, since]);
          }
          s.counts[key] = a.count;
        }
      }
    }
    if (first) s.measuringSince = c.at;
    s.collections = (s.collections || 0) + 1;
    s.lastCollectionAt = c.at;

    if (fresh.length) {
      await appendFile(this.file('events.jsonl'), fresh.map((e) => JSON.stringify(e)).join('\n') + '\n');
      this.events.push(...fresh);
    }

    if (c.traffic) {
      for (const d of c.traffic.views) this.traffic.views[d.date] = { count: d.count, uniques: d.uniques };
      for (const d of c.traffic.clones) this.traffic.clones[d.date] = { count: d.count, uniques: d.uniques };
      this.traffic.referrers = c.traffic.referrers;
      this.traffic.paths = c.traffic.paths;
      this.traffic.updatedAt = c.at;
      await writeJson(this.file('traffic.json'), this.traffic);
    }
    if (c.registry && c.registry.skills.length) {
      this.registry = c.registry;
      await writeJson(this.file('registry.json'), c.registry);
    }

    // Anything that failed this pass keeps its previous value in latest.json.
    if (this.latest) {
      for (const [repo, list] of Object.entries(c.releases)) {
        if (!list && this.latest.releases?.[repo]) c.releases[repo] = this.latest.releases[repo];
      }
      for (const key of ['stars', 'forks']) {
        if (c[key] != null || !this.latest[key]) continue;
        // The list could not be read (a workflow token may not list stargazers):
        // keep the stored one and date any change in the repository's own count
        // to this collection, so the timeline stays right to the day.
        const list = [...this.latest[key]].sort();
        const want = key === 'stars' ? c.repo.stars : c.repo.forks;
        while (list.length < want) list.push(new Date(c.at).toISOString());
        while (list.length > want) list.pop();
        c[key] = list;
      }
    }
    this.latest = c;
    await writeJson(this.file('latest.json'), c);
    await writeJson(this.file('state.json'), s);
    return fresh.length;
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value));
  await rename(tmp, file);
}
