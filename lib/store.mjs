// On-disk history. GitHub only reports cumulative download counts, so daily
// numbers come from comparing collections over time:
//
//   data/state.json     last known count per asset, the baseline taken on the
//                       first collection, when measuring began, the files that
//                       left their release (state.retired), when each repository
//                       was last read in full (state.repoReadAt), and the name and
//                       category of every skill any registry listed (state.skillMeta)
//   data/events.jsonl   one line per asset whose count rose between two
//                       collections: [epochMs, assetId, delta, previousCollectionMs]
//   data/traffic.json   repository views and clones per day, kept past GitHub's 14 days
//   data/latest.json    the most recent full collection
//   data/registry.json  the last BAAM registry that loaded

import { mkdir, readFile, writeFile, rename, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

// GitHub keeps no trace of a deleted release file. Replacing a file
// (`gh release upload --clobber`) deletes it and uploads a new one with a new
// id and a count of 0, so the old file's downloads exist only in this history.
// When a file that was on a release in the previous collection is missing from
// a repository that was read in full, its last count is kept in state.retired,
// with the repository, release, tag and name it belonged to, and the dashboard
// keeps adding it to that release, skill, extension or workflow. A retired file
// that shows up again is simply current again.

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
    this.state.retired ||= {};
    this.state.repoReadAt ||= {};
    this.state.skillMeta ||= {};
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
    const prev = this.latest;
    for (const [repo, list] of Object.entries(c.releases)) {
      if (!list) continue; // a repo that failed this pass keeps its old counts
      // A rise is spread over the time since this repository was last read, so
      // a daily run still lands each download on (about) the right day.
      const since = s.repoReadAt[repo] || s.lastCollectionAt || c.at;
      const present = new Set();
      for (const rel of list) {
        for (const a of rel.assets) {
          const key = String(a.id);
          present.add(key);
          const before = s.counts[key];
          if (first) {
            s.baseline[key] = a.count;
          } else if (before === undefined) {
            // An asset that appeared after measuring began: everything it has
            // was downloaded since, so all of it is measured.
            s.baseline[key] = 0;
            s.firstSeen[key] = c.at;
            if (a.count > 0) fresh.push([c.at, key, a.count, since]);
          } else if (a.count > before) {
            fresh.push([c.at, key, a.count - before, since]);
          }
          s.counts[key] = Math.max(a.count, before || 0);
          delete s.retired[key]; // back on its release, so current again
        }
      }
      if (!first) this.retireMissing(repo, prev?.releases?.[repo], present, since, c.at);
      s.repoReadAt[repo] = c.at;
    }
    if (first) s.measuringSince = c.at;
    s.collections = (s.collections || 0) + 1;
    s.lastCollectionAt = c.at;
    for (const sk of c.registry?.skills || []) {
      if (sk.id) s.skillMeta[sk.id] = { name: sk.name || sk.id, category: sk.category || 'Other' };
    }

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

  /**
   * Keep every file that was on a published release of `repo` in the previous
   * collection and is gone from this one. Drafts are left out, as everywhere
   * else, and a file nobody downloaded leaves nothing to keep.
   */
  retireMissing(repo, before, present, seenAt, at) {
    const s = this.state;
    for (const rel of before || []) {
      if (rel.draft) continue;
      for (const a of rel.assets) {
        const key = String(a.id);
        if (present.has(key) || s.retired[key]) continue;
        const count = Math.max(s.counts[key] ?? 0, a.count || 0);
        if (count <= 0) continue;
        s.retired[key] = {
          repo,
          releaseId: rel.id,
          tag: rel.tag,
          name: a.name,
          size: a.size,
          count,
          createdAt: a.createdAt,
          publishedAt: rel.publishedAt,
          prerelease: !!rel.prerelease,
          seenAt,
          goneAt: at,
        };
      }
    }
  }

  /**
   * Fold in counts read straight from GitHub between two collections, so the
   * downloads a file gained after the last collection are kept even if the
   * file is replaced before the next one. Rows are { id, tag, name, count, at },
   * all for `repo` (the TSV `parseSnapshot` reads). A count at or below the one
   * already known changes nothing, so a snapshot can be folded in twice.
   * Returns how many counts rose.
   */
  async foldSnapshot(rows, { repo, at = Date.now() } = {}) {
    const s = this.state;
    if (!s.measuringSince) throw new Error('No collection yet: collect once before folding in a snapshot.');
    if (!repo) throw new Error('A snapshot needs the repository its files belong to.');
    const fresh = [];
    for (const row of rows) {
      const key = String(row.id);
      const t = row.at || at;
      const known = s.counts[key];
      const gone = s.retired[key];
      if (gone && gone.repo !== repo) throw new Error(`Asset ${key} belongs to ${gone.repo}, not ${repo}.`);
      if (known !== undefined && row.count <= known) continue;
      const since = Math.min(t, gone?.seenAt || s.repoReadAt[repo] || s.lastCollectionAt);
      if (known === undefined) {
        // Never collected: uploaded and replaced between two collections, or
        // uploaded since the last one. Either way all of it is measured.
        s.baseline[key] = 0;
        s.firstSeen[key] = t;
      }
      if (row.count - (known || 0) > 0) fresh.push([t, key, row.count - (known || 0), since]);
      s.counts[key] = row.count;
      if (gone) {
        gone.count = row.count;
        gone.seenAt = Math.max(gone.seenAt || 0, t);
      } else if (row.count > 0 && !this.isCurrent(repo, key)) {
        // Not on its release in the last collection: keep it as retired until
        // a collection shows it (the next ingest un-retires a current file).
        s.retired[key] = { repo, releaseId: null, tag: row.tag, name: row.name, size: 0, count: row.count, createdAt: null, publishedAt: null, prerelease: false, seenAt: t, goneAt: t };
      }
    }
    if (fresh.length) {
      await appendFile(this.file('events.jsonl'), fresh.map((e) => JSON.stringify(e)).join('\n') + '\n');
      this.events.push(...fresh);
    }
    await writeJson(this.file('state.json'), s);
    return fresh.length;
  }

  isCurrent(repo, key) {
    for (const rel of this.latest?.releases?.[repo] || []) {
      for (const a of rel.assets) if (String(a.id) === key) return true;
    }
    return false;
  }
}

/**
 * Read a snapshot of release files, one per line, tab separated:
 *   tag, asset id, file name, download count[, ISO time it was read]
 * which is what
 *   gh api repos/<owner>/<repo>/releases --paginate \
 *     --jq '.[] | .tag_name as $t | .assets[] | [$t, .id, .name, .download_count] | @tsv'
 * prints. Blank lines and lines starting with # are skipped; anything else
 * that does not parse is an error, so a damaged snapshot never half applies.
 */
export function parseSnapshot(text) {
  const rows = [];
  const bad = [];
  String(text || '')
    .split(/\r?\n/)
    .forEach((line, i) => {
      if (!line.trim() || line.startsWith('#')) return;
      const [tag, id, name, count, when] = line.split('\t');
      const at = when ? Date.parse(when) : null;
      if (!tag || !/^\d+$/.test(id || '') || !name || !/^\d+$/.test(count || '') || (when && !Number.isFinite(at))) {
        bad.push(i + 1);
        return;
      }
      rows.push({ tag, id: id, name, count: Number(count), at });
    });
  if (bad.length) throw new Error(`Snapshot lines ${bad.slice(0, 10).join(', ')}${bad.length > 10 ? ', ...' : ''} are not tag, id, name, count[, time].`);
  return rows;
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
