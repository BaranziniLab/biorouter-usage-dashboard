// One collection pass: everything the dashboard reads from GitHub and the
// BAAM registry, trimmed to the fields the aggregates use.

export const MAIN_REPO = 'BaranziniLab/biorouter';
export const SKILLS_REPO = 'BaranziniLab/biorouter-skills';
export const WORKFLOWS_REPO = 'BaranziniLab/biorouter-workflows';
export const REGISTRY_URL = 'https://biorouter.ucsf.edu/registry.json';

export async function collect(gh, { cachedRegistry } = {}) {
  const started = Date.now();
  const warnings = [];

  const registry = await fetchRegistry().catch((err) => {
    warnings.push(`Registry unreachable, using the last copy: ${err.message}`);
    return cachedRegistry || { extensions: [], skills: [] };
  });

  // Extension repos come from the registry's download links, so a new BAAM
  // extension is counted the day it is listed.
  const extensionRepos = new Map();
  for (const ext of registry.extensions || []) {
    const m = String(ext.download || '').match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/download\//);
    if (m) extensionRepos.set(m[1], ext);
  }

  const repos = [MAIN_REPO, SKILLS_REPO, WORKFLOWS_REPO, ...extensionRepos.keys()];
  const releases = {};
  await pool(repos, 6, async (repo) => {
    try {
      const list = await gh.paginate(`/repos/${repo}/releases?per_page=100`, { allow404: true });
      releases[repo] = list ? list.map(trimRelease) : [];
      if (!list) warnings.push(`${repo}: not found`);
    } catch (err) {
      releases[repo] = null;
      warnings.push(`${repo}: ${err.message}`);
    }
  });
  if (!releases[MAIN_REPO]) throw new Error(`Could not read ${MAIN_REPO} releases`);

  const [repoInfo, traffic, stars, forks] = await Promise.all([
    gh.get(`/repos/${MAIN_REPO}`).then((r) => r.body),
    collectTraffic(gh).catch((err) => {
      warnings.push(`Traffic: ${err.message}`);
      return null;
    }),
    gh
      .paginate(`/repos/${MAIN_REPO}/stargazers?per_page=100`, { accept: 'application/vnd.github.star+json' })
      .then((list) => (list || []).map((s) => s.starred_at).filter(Boolean))
      .catch((err) => {
        warnings.push(`Stars: ${err.message}`);
        return null;
      }),
    gh
      .paginate(`/repos/${MAIN_REPO}/forks?per_page=100&sort=oldest`)
      .then((list) => (list || []).map((f) => f.created_at).filter(Boolean))
      .catch((err) => {
        warnings.push(`Forks: ${err.message}`);
        return null;
      }),
  ]);

  return {
    at: Date.now(),
    durationMs: Date.now() - started,
    warnings,
    repo: {
      name: repoInfo.full_name,
      url: repoInfo.html_url,
      stars: repoInfo.stargazers_count,
      forks: repoInfo.forks_count,
      watchers: repoInfo.subscribers_count,
      openIssues: repoInfo.open_issues_count,
      createdAt: repoInfo.created_at,
      pushedAt: repoInfo.pushed_at,
    },
    registry: {
      extensions: (registry.extensions || []).map((e) => ({
        id: e.id,
        name: e.name,
        privacy: e.privacy || 'public',
        organization: e.organization || '',
        download: e.download,
        github: e.github,
      })),
      skills: (registry.skills || []).map((s) => ({
        id: s.id,
        name: s.name,
        category: s.category || 'Other',
        download: s.download,
        filename: s.filename,
      })),
    },
    releases,
    traffic,
    stars,
    forks,
  };
}

async function fetchRegistry() {
  const res = await fetch(REGISTRY_URL, {
    headers: { 'User-Agent': 'biorouter-dashboard', Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body.extensions) || !Array.isArray(body.skills)) throw new Error('unexpected shape');
  return body;
}

async function collectTraffic(gh) {
  const base = `/repos/${MAIN_REPO}/traffic`;
  const [views, clones, referrers, paths] = await Promise.all([
    gh.get(`${base}/views?per=day`).then((r) => r.body),
    gh.get(`${base}/clones?per=day`).then((r) => r.body),
    gh.get(`${base}/popular/referrers`).then((r) => r.body),
    gh.get(`${base}/popular/paths`).then((r) => r.body),
  ]);
  return {
    views: (views.views || []).map((d) => ({ date: d.timestamp.slice(0, 10), count: d.count, uniques: d.uniques })),
    clones: (clones.clones || []).map((d) => ({ date: d.timestamp.slice(0, 10), count: d.count, uniques: d.uniques })),
    referrers: referrers || [],
    paths: (paths || []).map((p) => ({ path: p.path, title: p.title, count: p.count, uniques: p.uniques })),
  };
}

function trimRelease(r) {
  return {
    id: r.id,
    tag: r.tag_name,
    name: r.name,
    draft: !!r.draft,
    prerelease: !!r.prerelease,
    createdAt: r.created_at,
    publishedAt: r.published_at,
    url: r.html_url,
    assets: (r.assets || []).map((a) => ({
      id: a.id,
      name: a.name,
      size: a.size,
      count: a.download_count,
      createdAt: a.created_at,
    })),
  };
}

async function pool(items, size, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
}
