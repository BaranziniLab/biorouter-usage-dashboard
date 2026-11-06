// Biorouter usage dashboard. Renders data/dashboard.json (written once a day by
// the collector), then keeps the main repository's numbers live by reading
// GitHub's public releases API from the browser every few minutes and adding
// whatever was downloaded since the daily snapshot.

import { h, fmt, dateLabel, columnChart, lineChart, heatmap, segBar, legend, tooltip, tipContent } from './charts.js';
import { classifyAsset, PLATFORM_LABEL } from './classify.js';

const MAIN = 'BaranziniLab/biorouter';
const LIVE_EVERY_MS = 5 * 60_000;
const SNAPSHOT_EVERY_MS = 30 * 60_000;
const DAY = 86_400_000;
const KINDS = ['install', 'update', 'cli'];
const COLOR = { install: '--series-1', update: '--series-2', cli: '--series-3', check: '--series-2', other: '--text-subtle' };
const LABEL = { install: 'New installs', update: 'Auto-updates', cli: 'CLI packages', check: 'Update checks', other: 'Other' };

const ui = {
  range: store('range') || '90',
  assetQuery: '',
  assetKind: 'install',
  assetSort: { key: 'count', dir: 'desc' },
  releaseSort: { key: 'publishedAt', dir: 'desc' },
  assetsShown: 20,
  skillsShown: 12,
  extShown: 12,
  releasesShown: 15,
};

let base = null; // the snapshot as fetched
let data = null; // the snapshot plus live deltas
const live = { at: null, ok: false, error: null, releases: null, retryAt: null };
const previous = new Map(); // element id -> last rendered text, for the change flash

// ── Boot ────────────────────────────────────────────────────────────────────
init();

async function init() {
  wireChrome();
  try {
    await loadSnapshot();
  } catch (err) {
    showNotice('danger', `The dashboard data could not be loaded (${err.message}).`);
    setLive('error', 'Offline', '');
    return;
  }
  render();
  await pollLive();
  setInterval(pollLive, LIVE_EVERY_MS);
  setInterval(async () => {
    const before = base?.generatedAt;
    try {
      await loadSnapshot();
      if (base.generatedAt !== before) {
        data = applyLive(base, live);
        render();
      }
    } catch {
      // Keep showing what is loaded.
    }
  }, SNAPSHOT_EVERY_MS);
  setInterval(updateLiveLabel, 30_000);
  let rt;
  new ResizeObserver(() => {
    clearTimeout(rt);
    rt = setTimeout(() => data && renderCharts(), 120);
  }).observe(document.getElementById('page'));
}

async function loadSnapshot() {
  const res = await fetch(`data/dashboard.json?t=${Math.floor(Date.now() / 60000)}`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  base = await res.json();
  if (!base.ready) throw new Error('no collection yet');
  data = applyLive(base, live);
}

async function pollLive(force = false) {
  if (!force && live.retryAt && Date.now() < live.retryAt) return;
  const btn = document.getElementById('refresh');
  btn.setAttribute('aria-busy', 'true');
  setLive('checking', 'Checking', '');
  try {
    const res = await fetch(`https://api.github.com/repos/${MAIN}/releases?per_page=100`, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store',
    });
    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
      live.retryAt = reset || Date.now() + 15 * 60_000;
      throw new Error('rate');
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    live.releases = await res.json();
    live.at = Date.now();
    live.ok = true;
    live.error = null;
    live.retryAt = null;
    data = applyLive(base, live);
    render();
  } catch (err) {
    live.ok = false;
    live.error = err.message;
  } finally {
    btn.removeAttribute('aria-busy');
    updateLiveLabel();
    renderNotice();
  }
}

// ── Live layer ──────────────────────────────────────────────────────────────
function applyLive(snapshot, lv) {
  const d = structuredClone(snapshot);
  d.live = { at: lv.at, delta: { install: 0, update: 0, cli: 0, check: 0, other: 0 }, newAssets: 0 };
  extendDaily(d, Date.now());
  if (!lv.releases) return d;

  const byId = new Map(d.assets.map((a) => [String(a.id), a]));
  const from = d.meta.lastCollectionAt;
  const now = lv.at || Date.now();
  const fresh = [];
  for (const r of lv.releases) {
    if (r.draft) continue;
    for (const a of r.assets) {
      let rec = byId.get(String(a.id));
      if (!rec) {
        const c = classifyAsset(a.name);
        rec = {
          id: a.id,
          tag: r.tag_name,
          name: a.name,
          size: a.size,
          count: 0,
          ...c,
          platformLabel: PLATFORM_LABEL[c.platform] || c.platform,
          prerelease: r.prerelease,
          publishedAt: r.published_at,
          d24h: 0,
          d7d: 0,
        };
        d.assets.push(rec);
        byId.set(String(a.id), rec);
        ensureRelease(d, r);
        d.live.newAssets++;
      }
      const delta = a.download_count - rec.count;
      if (delta > 0) fresh.push([rec, delta]);
    }
  }

  for (const [rec, delta] of fresh) {
    const k = rec.kind;
    rec.count += delta;
    rec.live = (rec.live || 0) + delta;
    rec.d24h += delta;
    rec.d7d += delta;
    d.live.delta[k] += delta;
    d.totals.byKind[k] += delta;
    d.totals.bytes += delta * rec.size;
    if (k !== 'check') d.totals.binaries += delta;
    for (const p of ['last7', 'last30']) {
      d.totals[p][k] += delta;
      if (k !== 'check') d.totals[p].binaries += delta;
    }
    d.totals.recent.h24[k] = (d.totals.recent.h24[k] || 0) + delta;
    spreadInto(d, from, now, k, delta);

    if (k !== 'check') {
      let p = d.byPlatform.find((x) => x.platform === rec.platform);
      if (!p) d.byPlatform.push((p = { platform: rec.platform, label: rec.platformLabel, install: 0, update: 0, cli: 0, other: 0, total: 0 }));
      p[k] += delta;
      p.total += delta;
    }
    let f = d.byFormat.find((x) => x.kind === k && x.label === rec.label);
    if (!f) d.byFormat.push((f = { label: rec.label, kind: k, format: rec.format, platform: rec.platform, count: 0, files: 0, bytes: 0 }));
    f.count += delta;
    f.bytes += delta * rec.size;

    const row = d.releases.find((x) => x.tag === rec.tag);
    if (row) {
      row[k] += delta;
      if (k !== 'check') {
        row.total += delta;
        row.d24h += delta;
        row.byPlatform[rec.platform] = (row.byPlatform[rec.platform] || 0) + delta;
      }
    }
    if (d.totals.latest && rec.tag === d.totals.latest.tag) {
      d.totals.latest[k] = (d.totals.latest[k] || 0) + delta;
      if (k !== 'check') d.totals.latest.total += delta;
    }
  }

  // The latest release's adoption curve gets a live end point.
  if (d.adoption) {
    const last = { ...d.adoption.points[d.adoption.points.length - 1] };
    const cum = { install: 0, update: 0, cli: 0, check: 0, other: 0 };
    for (const a of d.assets) if (a.tag === d.adoption.tag) cum[a.kind] += a.count;
    d.adoption.points.push({ ...last, ...cum, t: now, measured: true });
  }
  d.byFormat.sort((a, b) => b.count - a.count);
  return d;
}

function ensureRelease(d, r) {
  if (d.releases.some((x) => x.tag === r.tag_name)) return;
  d.releases.push({
    tag: r.tag_name,
    url: r.html_url,
    publishedAt: r.published_at,
    prerelease: r.prerelease,
    latest: false,
    daysAsLatest: null,
    open: true,
    install: 0,
    update: 0,
    cli: 0,
    check: 0,
    other: 0,
    d24h: 0,
    total: 0,
    byPlatform: {},
    assets: r.assets.length,
  });
  d.totals.releases++;
  if (!r.prerelease && (!d.totals.latest || Date.parse(r.published_at) > Date.parse(d.totals.latest.publishedAt))) {
    for (const x of d.releases) x.latest = x.tag === r.tag_name;
    d.totals.latest = { tag: r.tag_name, publishedAt: r.published_at, url: r.html_url, total: 0, check: 0, install: 0, update: 0, cli: 0 };
    d.adoption = { tag: r.tag_name, publishedAt: r.published_at, url: r.html_url, points: [{ t: Date.parse(r.published_at), install: 0, update: 0, cli: 0, check: 0, other: 0, measured: true }] };
  }
}

function extendDaily(d, now) {
  const today = new Date(now).toISOString().slice(0, 10);
  let last = d.daily[d.daily.length - 1]?.date;
  while (last && last < today) {
    const next = new Date(Date.parse(`${last}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
    d.daily.push({ date: next, est: {}, meas: {} });
    last = next;
  }
}

function spreadInto(d, from, to, kind, amount) {
  if (!(to > from)) from = to - 1;
  const total = to - from;
  let t = from;
  while (t < to) {
    const dayStart = Math.floor(t / DAY) * DAY;
    const segEnd = Math.min(to, dayStart + DAY);
    const key = new Date(dayStart).toISOString().slice(0, 10);
    const row = d.daily.find((x) => x.date === key);
    if (row) row.meas[kind] = (row.meas[kind] || 0) + (amount * (segEnd - t)) / total;
    t = segEnd;
  }
}

// ── Rendering ───────────────────────────────────────────────────────────────
function render() {
  document.getElementById('page').setAttribute('aria-busy', 'false');
  renderIntro();
  renderOverview();
  renderPlatforms();
  renderReleaseTable();
  renderAssets();
  renderTrafficLists();
  renderEcosystem();
  renderFoot();
  renderCharts();
  renderNotice();
  updateLiveLabel();
}

function renderCharts() {
  renderHeatmap();
  renderDownloadsChart();
  renderChecksChart();
  renderAdoption();
  renderReleaseChart();
  renderTrafficCharts();
}

function renderIntro() {
  const m = data.meta;
  const el = document.getElementById('intro-meta');
  el.replaceChildren(
    'Every download from the GitHub releases of ',
    h('a', { href: m.repo.url, text: m.repo.name }),
    ' and the BAAM ecosystem, by day, platform, release and file. Days are in UTC.'
  );
}

function renderOverview() {
  const t = data.totals;
  const el = document.getElementById('overview');
  const share = (k) => t.byKind[k];
  const d30 = t.last30.binaries;
  const p30 = t.prev30.binaries;
  const checksPerDay = t.last7.check / 7;
  const latest = t.latest;
  const latestDays = latest ? Math.max(1, Math.round((Date.now() - Date.parse(latest.publishedAt)) / DAY)) : 0;
  const views14 = (data.traffic.views || []).slice(-14).reduce((s, v) => s + v.count, 0);

  const left = h(
    'div',
    { class: 'hero' },
    h('div', { class: 'hero-label' }, 'Downloads, all time', info('Installers, Mac auto-updates and CLI packages from every Biorouter release. Update checks are counted on their own.')),
    h('div', { class: 'hero-value', id: 'kpi-total', text: fmt.int(t.binaries) }),
    h('div', { class: 'hero-note' }, `${fmt.int(d30)} in the last 30 days `, deltaSpan(d30, p30, 'previous 30 days')),
    h(
      'div',
      { class: 'hero-split' },
      segBar(KINDS.map((k) => ({ label: LABEL[k], value: share(k), color: COLOR[k] }))),
      h(
        'ul',
        { class: 'legend legend-stack' },
        ...KINDS.map((k) =>
          h(
            'li',
            {},
            h('span', { class: 'legend-key', style: { background: `var(${COLOR[k]})` } }),
            h('span', { class: 'legend-label' }, LABEL[k], ' ', info(KIND_HELP[k])),
            h('span', { class: 'legend-value', id: `kpi-${k}`, text: fmt.int(share(k)) }),
            h('span', { class: 'legend-share', text: fmt.pct(share(k) / Math.max(1, t.binaries)) })
          )
        )
      )
    )
  );

  const stat = (id, label, value, note, help) =>
    h(
      'div',
      { class: 'stat' },
      h('div', { class: 'stat-label' }, label, help ? info(help) : null),
      h('div', { class: 'stat-value', id }, ...(Array.isArray(value) ? value : [value])),
      note ? h('div', { class: 'stat-note' }, ...(Array.isArray(note) ? note : [note])) : null
    );

  const right = h(
    'div',
    { class: 'stats' },
    stat('kpi-checks', 'Update checks', fmt.int(t.byKind.check), `About ${fmt.int(checksPerDay)} a day lately`, KIND_HELP.check),
    stat(
      'kpi-latest',
      'Latest release',
      latest ? latest.tag : 'None',
      latest ? `${fmt.int(latest.total)} downloads in ${latestDays} ${latestDays === 1 ? 'day' : 'days'}` : ''
    ),
    stat('kpi-7d', 'Last 7 days', fmt.int(t.last7.binaries), [deltaSpan(t.last7.binaries, t.prev7.binaries, 'previous 7 days', true)], 'Downloads in the last seven UTC days, today included. Days before measuring began are estimated.'),
    stat('kpi-bytes', 'Data served', fmt.bytes(t.bytes), `${fmt.int(t.assets)} files in ${t.releases} releases`),
    stat('kpi-eco', 'BAAM downloads', fmt.int(t.ecosystem.skills + t.ecosystem.extensions + t.ecosystem.workflows), 'Skills, extensions and workflows', 'Release downloads of the skills, extensions and workflows listed in the BAAM marketplace.'),
    stat('kpi-stars', 'GitHub stars', fmt.int(data.stars ? data.stars.length : data.meta.repo.stars), `${fmt.int(data.forks ? data.forks.length : data.meta.repo.forks)} forks, ${fmt.int(views14)} page views in 14 days`)
  );

  const heat = h(
    'div',
    { class: 'full heat-block' },
    h(
      'div',
      {},
      h(
        'div',
        { class: 'panel-head' },
        h('div', {}, h('h3', { class: 'panel-title' }, 'Downloads by day', info('Each square is one UTC day: installers, auto-updates and CLI packages. Before measuring began, a day shows the average for the release that was newest then.')), h('p', { class: 'panel-sub', id: 'heat-sub', text: 'The last 12 months' }))
      ),
      h('div', { id: 'heatmap', class: 'chart' }),
      h('div', { class: 'heat-foot' }, h('span', { id: 'heat-note' }), h('span', { class: 'heat-scale', 'aria-hidden': 'true' }, 'Less ', ...[0, 1, 2, 3, 4].map((i) => h('span', { class: 'sw', style: { background: `var(--heat-${i})` } })), ' More'))
    ),
    heatAside()
  );

  el.replaceChildren(left, right, heat);
  flashChanges(['kpi-total', 'kpi-install', 'kpi-update', 'kpi-cli', 'kpi-checks', 'kpi-latest', 'kpi-7d', 'kpi-bytes']);
}

function heatAside() {
  const daySum = (d) => KINDS.reduce((a, k) => a + (d.est[k] || 0) + (d.meas[k] || 0), 0);
  const months = new Map();
  const weeks = new Map();
  for (const d of data.daily) {
    const v = daySum(d);
    const m = d.date.slice(0, 7);
    months.set(m, (months.get(m) || 0) + v);
    const t = Date.parse(`${d.date}T00:00:00Z`);
    const monday = new Date(t - ((new Date(t).getUTCDay() + 6) % 7) * DAY).toISOString().slice(0, 10);
    weeks.set(monday, (weeks.get(monday) || 0) + v);
  }
  const top = (map) => [...map.entries()].sort((a, b) => b[1] - a[1])[0] || ['', 0];
  const [bm, bmv] = top(months);
  const [bw, bwv] = top(weeks);
  const last90 = data.daily.slice(-90);
  const avg = last90.reduce((s2, d) => s2 + daySum(d), 0) / Math.max(1, last90.length);
  const mDay = new Date(data.meta.measuringSince).toISOString().slice(0, 10);
  const measured = data.daily.filter((d) => d.date >= mDay).length;
  const monthName = (ym) => new Date(`${ym}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const item = (label, value, note) => h('div', { class: 'stat' }, h('div', { class: 'stat-label', text: label }), h('div', { class: 'stat-value stat-value-sm', text: value }), h('div', { class: 'stat-note', text: note }));
  return h(
    'div',
    { class: 'heat-aside' },
    item('Busiest month', fmt.int(bmv), bm ? monthName(bm) : ''),
    item('Busiest week', fmt.int(bwv), bw ? `Week of ${dateLabel(bw)}` : ''),
    item('Daily average', trim1(avg), 'Over the last 90 days'),
    item('Days measured', fmt.int(measured), `Since ${dateLabel(mDay, { year: true })}`)
  );
}

const KIND_HELP = {
  install: 'Mac .dmg, Windows installer and zip, Linux .deb and .rpm. Windows also downloads its installer to update, so some Windows updates count here.',
  update: 'The signed app zips the Mac app downloads to update itself in one click.',
  cli: 'Terminal only packages: biorouter-cli .deb and .rpm, the old headless tarball and CLI binary.',
  check: 'Every running Mac app reads latest-mac.yml at launch and every 3 hours, so this tracks how much the Mac app is in use.',
};

function renderHeatmap() {
  const host = document.getElementById('heatmap');
  if (!host) return;
  const M = data.meta.measuringSince;
  const mDay = new Date(M).toISOString().slice(0, 10);
  const days = data.daily.map((d) => ({
    date: d.date,
    value: KINDS.reduce((s, k) => s + (d.est[k] || 0) + (d.meas[k] || 0), 0),
    est: d.date < mDay,
  }));
  // About 14px a week, so a phone shows fewer weeks rather than specks.
  const weeks = Math.max(18, Math.min(53, Math.floor(host.clientWidth / 14)));
  heatmap(host, { days, label: 'downloads', weeks });
  document.getElementById('heat-note').textContent = `Estimated before ${dateLabel(mDay, { year: true })}, measured since.`;
  document.getElementById('heat-sub').textContent = weeks >= 52 ? 'The last 12 months' : `The last ${weeks} weeks`;
}

function rangeSlice() {
  const n = ui.range === 'all' ? data.daily.length : Number(ui.range);
  return data.daily.slice(-n);
}

function dayValues(d, kinds) {
  const v = {};
  let est = 0;
  let meas = 0;
  for (const k of kinds) {
    const e = d.est[k] || 0;
    const m = d.meas[k] || 0;
    v[k] = e + m;
    est += e;
    meas += m;
  }
  return { values: v, est: est > meas, mixed: est > 0 && meas > 0 };
}

function renderDownloadsChart() {
  const el = document.getElementById('panel-downloads');
  const days = rangeSlice();
  const rows = days.map((d) => ({ key: d.date, ...dayValues(d, KINDS) }));
  const sum = rows.reduce((s, r) => s + KINDS.reduce((a, k) => a + r.values[k], 0), 0);
  const mDay = new Date(data.meta.measuringSince).toISOString().slice(0, 10);
  const series = KINDS.map((k) => ({ key: k, label: LABEL[k], color: COLOR[k] }));
  const chart = h('div', { class: 'chart', id: 'chart-downloads' });
  el.replaceChildren(
    panelHead('Downloads per day', 'New installs, auto-updates and CLI packages', 'Hatched days are estimated: GitHub keeps only running totals, so each release’s downloads before measuring began are spread across the days it was newest.', fmt.int(sum), `in ${days.length} days`),
    legend([...series.map((s) => ({ label: s.label, color: s.color })), { label: 'Estimated', hatch: true }]),
    chart,
    dataTable(
      ['Day', ...KINDS.map((k) => LABEL[k]), 'Source'],
      [...rows].reverse().map((r) => [dateLabel(r.key, { year: true }), ...KINDS.map((k) => fmt.approx(r.values[k])), r.mixed ? 'Partly estimated' : r.est ? 'Estimated' : 'Measured'])
    )
  );
  chart.style.marginTop = '8px';
  columnChart(chart, {
    data: rows,
    series,
    height: 240,
    ariaLabel: `Downloads per day over ${days.length} days, ${fmt.int(sum)} in total. Use the arrow keys to read each day.`,
    marker: { index: rows.findIndex((r) => r.key === mDay), label: 'Measured from here' },
    tooltipFor: (r, total) =>
      tipContent(
        dateLabel(r.key, { year: true }),
        [
          ...[...KINDS].reverse().map((k) => ({ value: (r.est ? '≈ ' : '') + fmt.approx(r.values[k]), label: LABEL[k], color: `var(${COLOR[k]})` })),
          { value: (r.est ? '≈ ' : '') + fmt.approx(total), label: 'Total', muted: true },
        ],
        r.mixed ? 'Partly estimated' : r.est ? 'Estimated from release windows' : 'Measured'
      ),
  });
}

function renderChecksChart() {
  const el = document.getElementById('panel-checks');
  const days = rangeSlice();
  const rows = days.map((d) => ({ key: d.date, ...dayValues(d, ['check']) }));
  const sum = rows.reduce((s, r) => s + r.values.check, 0);
  const mDay = new Date(data.meta.measuringSince).toISOString().slice(0, 10);
  const chart = h('div', { class: 'chart' });
  el.replaceChildren(panelHead('Update checks per day', 'How much the Mac app is running', KIND_HELP.check, fmt.int(sum / Math.max(1, days.length)), 'a day on average'), chart);
  chart.id = 'chart-checks';
  chart.style.marginTop = '8px';
  columnChart(chart, {
    data: rows,
    series: [{ key: 'check', label: 'Update checks', color: '--series-2' }],
    height: 200,
    ariaLabel: `Update checks per day over ${days.length} days.`,
    marker: { index: rows.findIndex((r) => r.key === mDay), label: 'Measured' },
    tooltipFor: (r) => tipContent(dateLabel(r.key, { year: true }), [{ value: (r.est ? '≈ ' : '') + fmt.approx(r.values.check), label: 'update checks', color: 'var(--series-2)' }], r.mixed ? 'Partly estimated' : r.est ? 'Estimated from release windows' : 'Measured'),
  });
}

function renderAdoption() {
  const el = document.getElementById('panel-adoption');
  const a = data.adoption;
  if (!a) {
    el.replaceChildren(panelHead('Latest release', '', null), h('p', { class: 'empty', text: 'No release yet.' }));
    return;
  }
  const last = a.points[a.points.length - 1];
  const total = KINDS.reduce((s, k) => s + last[k], 0);
  const chart = h('div', { class: 'chart' });
  chart.id = 'chart-adoption';
  el.replaceChildren(
    panelHead(`${a.tag} since release`, `Shipped ${dateLabel(a.publishedAt, { year: true })}`, 'Running total of each kind of download for the newest release. The faint part of each line is interpolated: it joins the release date to the count found when measuring began.', fmt.int(total), 'downloads'),
    legend(KINDS.map((k) => ({ label: LABEL[k], color: COLOR[k], shape: 'line' }))),
    chart
  );
  chart.style.marginTop = '8px';
  const points = a.points.map((p) => ({ t: p.t, values: { install: p.install, update: p.update, cli: p.cli } }));
  lineChart(chart, {
    points,
    series: KINDS.map((k) => ({ key: k, label: LABEL[k], color: COLOR[k] })),
    height: 200,
    faintBefore: data.meta.measuringSince > Date.parse(a.publishedAt) ? data.meta.measuringSince : null,
    xFormat: (t) => dateLabel(new Date(t).toISOString()),
    ariaLabel: `Downloads of ${a.tag} since it shipped.`,
    tooltipFor: (p) =>
      tipContent(
        new Date(p.t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
        [...KINDS].reverse().map((k) => ({ value: fmt.int(p.values[k]), label: LABEL[k], color: `var(${COLOR[k]})` }))
      ),
  });
}

function renderPlatforms() {
  const rows = data.byPlatform.filter((p) => p.total > 0);
  const max = Math.max(...rows.map((p) => p.total), 1);
  const total = rows.reduce((s, p) => s + p.total, 0);
  document.getElementById('panel-platform').replaceChildren(
    panelHead('By platform', 'Split into new installs, auto-updates and CLI packages', 'Update checks are left out: they are not downloads of the app.'),
    legend(KINDS.map((k) => ({ label: LABEL[k], color: COLOR[k] }))),
    h(
      'ul',
      { class: 'rows', style: { marginTop: '10px' } },
      ...rows.map((p) =>
        rowItem(
          h('span', { class: 'row-name', text: p.label }),
          stackTrack(KINDS.map((k) => ({ value: p[k], color: COLOR[k], label: LABEL[k] })), p.total / max, p.label),
          fmt.int(p.total),
          fmt.pct(p.total / total)
        )
      )
    ),
    choices()
  );

  const files = data.byFormat;
  const fmax = Math.max(...files.filter((f) => f.kind !== 'check').map((f) => f.count), 1);
  document.getElementById('panel-format').replaceChildren(
    panelHead('By file', 'Each kind of release file, all versions combined', 'The update manifest is read by running apps, so its bar is drawn to its own scale.'),
    h(
      'ul',
      { class: 'rows' },
      ...files.map((f) =>
        rowItem(
          h('span', { class: 'row-label' }, h('span', { text: f.label }), f.format ? h('span', { class: 'chip', text: `.${f.format}` }) : null),
          stackTrack([{ value: f.count, color: COLOR[f.kind], label: LABEL[f.kind] }], f.kind === 'check' ? 1 : f.count / fmax, f.label),
          fmt.int(f.count),
          f.kind === 'check' ? '' : fmt.pct(f.count / Math.max(1, data.totals.binaries))
        )
      )
    )
  );
}

function choices() {
  const plat = (id) => data.byPlatform.find((p) => p.platform === id) || { install: 0, update: 0, cli: 0, total: 0 };
  const fmtCount = (label) => data.byFormat.filter((f) => f.label === label).reduce((a, f) => a + f.count, 0);
  const deb = fmtCount('Linux .deb') + fmtCount('CLI .deb');
  const rpm = fmtCount('Linux .rpm') + fmtCount('CLI .rpm');
  const linux = plat('linux');
  // Compare like with like: only releases that shipped both Windows files.
  const exeTags = new Set(data.assets.filter((a) => a.label === 'Windows installer').map((a) => a.tag));
  const exeSince = [...exeTags].sort(cmpTag)[0];
  const exeCount = (exe) => data.assets.filter((a) => exeTags.has(a.tag) && a.label === (exe ? 'Windows installer' : 'Windows zip')).reduce((a, x) => a + x.count, 0);
  const groups = [
    ['Mac chip', 'Every Mac download, installers and updates', [['Apple silicon', plat('mac-arm64').total], ['Intel', plat('mac-x64').total]]],
    ['Linux app', 'Desktop app or terminal only', [['Desktop app', linux.install], ['CLI only', linux.cli]]],
    ['Linux package', 'Desktop and CLI packages together', [['.deb', deb], ['.rpm', rpm]]],
    ['Windows package', exeSince ? `Since the installer shipped in ${exeSince}` : 'Installer or zip', [['Installer', exeCount(true)], ['Zip', exeCount(false)]]],
  ];
  return h(
    'div',
    { class: 'choices' },
    h('h4', { class: 'caps', text: 'Choices people make' }),
    ...groups.map(([title, help, parts]) => {
      const total = parts.reduce((a, p) => a + p[1], 0) || 1;
      return h(
        'div',
        { class: 'choice' },
        h('div', { class: 'choice-head' }, h('span', { class: 'choice-title', text: title }), h('span', { class: 'choice-help', text: help })),
        segBar(parts.map(([label, value], i) => ({ label, value, color: i ? '--series-2' : '--series-1' }))),
        h(
          'div',
          { class: 'choice-legend' },
          ...parts.map(([label, value], i) => h('span', {}, h('span', { class: 'legend-key', style: { background: `var(${i ? '--series-2' : '--series-1'})` } }), h('span', { class: 'legend-label', text: label }), h('span', { class: 'legend-value', text: `${fmt.pct(value / total)}` }), h('span', { class: 'choice-n', text: fmt.int(value) })))
        )
      );
    })
  );
}

function renderReleaseChart() {
  const el = document.getElementById('panel-release-chart');
  const rels = [...data.releases].sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt));
  const rows = rels.map((r) => ({ key: r.tag, values: { install: r.install, update: r.update, cli: r.cli }, est: false, rel: r }));
  const chart = h('div', { class: 'chart' });
  chart.id = 'chart-releases';
  const best = rels.reduce((b, r) => (r.total > (b?.total || 0) ? r : b), null);
  el.replaceChildren(
    panelHead('Downloads by release', 'Every published version, oldest to newest', 'Counts every download of a version’s files, whenever it happened. Auto-updates show how many Mac apps moved to that version.', best ? best.tag : '', best ? `most downloaded, ${fmt.int(best.total)}` : ''),
    legend(KINDS.map((k) => ({ label: LABEL[k], color: COLOR[k] }))),
    chart
  );
  chart.style.marginTop = '8px';
  columnChart(chart, {
    data: rows,
    series: KINDS.map((k) => ({ key: k, label: LABEL[k], color: COLOR[k] })),
    height: 240,
    ariaLabel: `Downloads for each of ${rows.length} releases.`,
    xTickIndices: (band) => {
      const every = Math.max(1, Math.ceil(64 / band));
      const out = [];
      for (let i = rows.length - 1; i >= 0; i -= every) out.unshift(i);
      return out;
    },
    xLabel: (key) => key.replace(/^v/, ''),
    tooltipFor: (r, total) => {
      const rel = r.rel;
      const days = rel.daysAsLatest;
      return tipContent(
        `${rel.tag}, ${dateLabel(rel.publishedAt, { year: true })}`,
        [
          ...[...KINDS].reverse().map((k) => ({ value: fmt.int(r.values[k]), label: LABEL[k], color: `var(${COLOR[k]})` })),
          { value: fmt.int(total), label: 'Total', muted: true },
          { value: fmt.int(rel.check), label: 'Update checks' },
        ],
        rel.prerelease ? 'Prerelease' : days != null ? `${rel.open ? 'Latest for' : 'Was latest for'} ${days < 1 ? `${Math.max(1, Math.round(days * 24))} hours` : `${fmt.int(days)} ${Math.round(days) === 1 ? 'day' : 'days'}`}` : null
      );
    },
  });
}

function renderReleaseTable() {
  const el = document.getElementById('panel-release-table');
  const cols = [
    { key: 'tag', label: 'Version', get: (r) => r.tag, sort: (a, b) => cmpTag(a.tag, b.tag) },
    { key: 'publishedAt', label: 'Published', get: (r) => Date.parse(r.publishedAt) },
    { key: 'daysAsLatest', label: 'Days as latest', num: true, get: (r) => r.daysAsLatest ?? -1 },
    { key: 'install', label: 'New installs', num: true },
    { key: 'update', label: 'Auto-updates', num: true },
    { key: 'cli', label: 'CLI', num: true },
    { key: 'total', label: 'Downloads', num: true },
    { key: 'perDay', label: 'Per day as latest', num: true, get: (r) => (r.daysAsLatest ? r.total / Math.max(r.daysAsLatest, 1 / 24) : -1) },
    { key: 'check', label: 'Update checks', num: true },
  ];
  const sorted = sortRows(data.releases, cols, ui.releaseSort);
  const shown = sorted.slice(0, ui.releasesShown);
  const max = Math.max(...data.releases.map((r) => r.total), 1);
  const table = h(
    'table',
    { class: 'data' },
    tableHead(cols, ui.releaseSort, (key) => {
      ui.releaseSort = nextSort(ui.releaseSort, key);
      renderReleaseTable();
    }),
    h(
      'tbody',
      {},
      ...shown.map((r) =>
        h(
          'tr',
          {},
          h('td', {}, h('a', { href: r.url, text: r.tag }), r.latest ? h('span', { class: 'chip chip-accent', style: { marginLeft: '8px' }, text: 'Latest' }) : null, r.prerelease ? h('span', { class: 'chip', style: { marginLeft: '8px' }, text: 'Prerelease' }) : null),
          h('td', { class: 'dim', text: dateLabel(r.publishedAt, { year: true }) }),
          h('td', { class: 'num dim', text: r.daysAsLatest == null ? '' : r.daysAsLatest < 1 ? '<1' : fmt.int(r.daysAsLatest) }),
          h('td', { class: 'num', text: fmt.int(r.install) }),
          h('td', { class: 'num', text: fmt.int(r.update) }),
          h('td', { class: 'num', text: fmt.int(r.cli) }),
          h('td', { class: 'num' }, h('span', { class: 'bar-cell', style: { width: `${Math.max(2, (r.total / max) * 60)}px`, marginRight: '8px' } }), fmt.int(r.total)),
          h('td', { class: 'num', text: r.daysAsLatest ? trim1(r.total / Math.max(r.daysAsLatest, 1)) : '' }),
          h('td', { class: 'num dim', text: fmt.int(r.check) })
        )
      )
    )
  );
  el.replaceChildren(
    panelHead('All releases', `${data.releases.length} published versions`, 'Per day as latest divides a version’s downloads by the days it was the newest release, a rough measure of momentum.'),
    h('div', { class: 'table-wrap' }, table),
    sorted.length > shown.length ? h('button', { class: 'more', type: 'button', onclick: () => ((ui.releasesShown = sorted.length), renderReleaseTable()), text: `Show all ${sorted.length}` }) : null
  );
}

function renderAssets() {
  const el = document.getElementById('panel-assets');
  const kinds = [
    ['all', 'All'],
    ['install', 'Installers'],
    ['update', 'Auto-updates'],
    ['cli', 'CLI'],
    ['check', 'Update checks'],
  ];
  const q = ui.assetQuery.trim().toLowerCase();
  const list = data.assets.filter((a) => (ui.assetKind === 'all' || a.kind === ui.assetKind) && (!q || `${a.name} ${a.tag} ${a.platformLabel} ${a.label}`.toLowerCase().includes(q)));
  const cols = [
    { key: 'name', label: 'File', get: (a) => a.name.toLowerCase() },
    { key: 'tag', label: 'Release', sort: (a, b) => cmpTag(a.tag, b.tag) },
    { key: 'platformLabel', label: 'Platform' },
    { key: 'kind', label: 'Kind', get: (a) => LABEL[a.kind] },
    { key: 'size', label: 'Size', num: true },
    { key: 'count', label: 'Downloads', num: true },
    { key: 'd24h', label: 'Last 24 hours', num: true },
  ];
  const sorted = sortRows(list, cols, ui.assetSort);
  const shown = sorted.slice(0, ui.assetsShown);
  const sum = list.reduce((s, a) => s + a.count, 0);

  let input = el.querySelector('input[type="search"]');
  const hadFocus = input && document.activeElement === input;
  const caret = hadFocus ? input.selectionStart : null;

  const seg = h(
    'div',
    { class: 'seg', role: 'radiogroup', 'aria-label': 'Kind' },
    ...kinds.map(([k, label]) =>
      h('button', {
        type: 'button',
        role: 'radio',
        'aria-checked': String(ui.assetKind === k),
        text: label,
        onclick: () => {
          ui.assetKind = k;
          ui.assetsShown = 20;
          renderAssets();
        },
      })
    )
  );
  input = h('input', {
    type: 'search',
    placeholder: 'Filter',
    'aria-label': 'Filter files',
    value: ui.assetQuery,
    oninput: (e) => {
      ui.assetQuery = e.target.value;
      ui.assetsShown = 20;
      renderAssets();
    },
  });
  const table = h(
    'table',
    { class: 'data' },
    tableHead(cols, ui.assetSort, (key) => {
      ui.assetSort = nextSort(ui.assetSort, key);
      renderAssets();
    }),
    h(
      'tbody',
      {},
      ...shown.map((a) =>
        h(
          'tr',
          {},
          h('td', {}, h('span', { class: 'mono', text: a.name })),
          h('td', { class: 'dim', text: a.tag }),
          h('td', { class: 'dim', text: a.platformLabel }),
          h('td', {}, h('span', { class: 'legend-key', style: { background: `var(${COLOR[a.kind]})`, marginRight: '6px', verticalAlign: '-1px' } }), LABEL[a.kind]),
          h('td', { class: 'num dim', text: fmt.bytes(a.size) }),
          h('td', { class: 'num', text: fmt.int(a.count) }),
          h('td', { class: 'num', text: a.d24h ? fmt.approx(a.d24h) : '' })
        )
      )
    )
  );
  el.replaceChildren(
    panelHead('Every release file', 'Search by file name, version or platform', 'Last 24 hours is measured, so it fills in once the collector has a day of history.'),
    h(
      'div',
      { class: 'table-tools' },
      h('label', { class: 'filter' }, h('span', { class: 'sr' }), searchIcon(), input),
      seg,
      h('span', { class: 'count-note', text: `${fmt.int(list.length)} files, ${fmt.int(sum)} downloads` })
    ),
    h('div', { class: 'table-wrap' }, table),
    sorted.length > shown.length ? h('button', { class: 'more', type: 'button', onclick: () => ((ui.assetsShown += 50), renderAssets()), text: `Show ${Math.min(50, sorted.length - shown.length)} more of ${fmt.int(sorted.length - shown.length)}` }) : null
  );
  if (hadFocus) {
    input.focus();
    input.setSelectionRange(caret, caret);
  }
}

function renderTrafficCharts() {
  const tr = data.traffic;
  const make = (id, title, sub, help, rows, a, b) => {
    const el = document.getElementById(id);
    const chart = h('div', { class: 'chart' });
    chart.id = `chart-${id}`;
    const total = rows.reduce((s, r) => s + r.count, 0);
    el.replaceChildren(
      panelHead(title, sub, help, fmt.int(total), `in ${rows.length} days`),
      legend([
        { label: a, color: '--series-2', shape: 'line' },
        { label: b, color: '--series-1', shape: 'line' },
      ]),
      chart
    );
    chart.style.marginTop = '8px';
    if (!rows.length) {
      chart.appendChild(h('p', { class: 'empty', text: 'No traffic recorded yet.' }));
      return;
    }
    lineChart(chart, {
      points: rows.map((r) => ({ t: Date.parse(`${r.date}T00:00:00Z`), values: { count: r.count, uniques: r.uniques } })),
      series: [
        { key: 'count', label: a, color: '--series-2', area: true },
        { key: 'uniques', label: b, color: '--series-1' },
      ],
      height: 180,
      ariaLabel: `${title} per day`,
      tooltipFor: (p) =>
        tipContent(dateLabel(new Date(p.t).toISOString(), { year: true }), [
          { value: fmt.int(p.values.count), label: a, color: 'var(--series-2)' },
          { value: fmt.int(p.values.uniques), label: b, color: 'var(--series-1)' },
        ]),
    });
  };
  const since = tr.views.length ? dateLabel(tr.views[0].date, { year: true }) : '';
  make('panel-views', 'Repository page views', since ? `Daily since ${since}` : '', 'From GitHub’s traffic API, which keeps 14 days. The collector stores each day, so the history grows past that.', tr.views, 'Views', 'Unique visitors');
  make('panel-clones', 'Git clones', since ? `Daily since ${since}` : '', 'Clones of the source repository, mostly automation such as CI. Unique counts distinct cloners.', tr.clones, 'Clones', 'Unique cloners');

  const stars = data.stars || [];
  const forks = data.forks || [];
  const el = document.getElementById('panel-stars');
  const chart = h('div', { class: 'chart' });
  chart.id = 'chart-stars';
  el.replaceChildren(panelHead('Stars and forks', 'Running totals since the repository was created', null, `${fmt.int(stars.length)} ★`, `${fmt.int(forks.length)} forks`), legend([{ label: 'Stars', color: '--series-1', shape: 'line' }, { label: 'Forks', color: '--series-2', shape: 'line' }]), chart);
  chart.style.marginTop = '8px';
  const created = Date.parse(data.meta.repo.createdAt);
  const times = [...new Set([created, ...stars.map((s) => s.t), ...forks.map((f) => f.t), Date.now()])].sort((a, b) => a - b);
  const countAt = (list, t) => list.filter((x) => x.t <= t).length;
  lineChart(chart, {
    points: times.map((t) => ({ t, values: { stars: countAt(stars, t), forks: countAt(forks, t) } })),
    series: [
      { key: 'stars', label: 'Stars', color: '--series-1' },
      { key: 'forks', label: 'Forks', color: '--series-2' },
    ],
    step: true,
    height: 160,
    ariaLabel: 'Stars and forks over time',
    tooltipFor: (p) =>
      tipContent(dateLabel(new Date(p.t).toISOString(), { year: true }), [
        { value: fmt.int(p.values.stars), label: 'Stars', color: 'var(--series-1)' },
        { value: fmt.int(p.values.forks), label: 'Forks', color: 'var(--series-2)' },
      ]),
  });
}

function renderTrafficLists() {
  const tr = data.traffic;
  const refMax = Math.max(...tr.referrers.map((r) => r.count), 1);
  document.getElementById('panel-referrers').replaceChildren(
    panelHead('Where visitors come from', 'Top referring sites, last 14 days', 'Views of the GitHub repository by the site that linked to it. Unique visitors in the second column.'),
    tr.referrers.length
      ? h('ul', { class: 'rows' }, ...tr.referrers.map((r) => rowItem(h('span', { class: 'row-name', text: r.referrer }), stackTrack([{ value: r.count, color: '--series-2', label: 'Views' }], r.count / refMax, r.referrer), fmt.int(r.count), fmt.int(r.uniques))))
      : h('p', { class: 'empty', text: 'No referrers in the last 14 days.' })
  );
  const pMax = Math.max(...tr.paths.map((r) => r.count), 1);
  document.getElementById('panel-paths').replaceChildren(
    panelHead('Most viewed pages', 'On github.com, last 14 days', 'Views of each repository page, with unique visitors in the second column.'),
    tr.paths.length
      ? h(
          'ul',
          { class: 'rows' },
          ...tr.paths.map((p) => {
            const short = p.path.replace(/^\/BaranziniLab\/biorouter/i, '') || '/';
            return rowItem(h('a', { class: 'row-name', href: `https://github.com${p.path}`, text: short === '/' ? 'Repository home' : short, title: p.path }), stackTrack([{ value: p.count, color: '--series-2', label: 'Views' }], p.count / pMax, short), fmt.int(p.count), fmt.int(p.uniques));
          })
        )
      : h('p', { class: 'empty', text: 'No page views in the last 14 days.' })
  );
}

function renderEcosystem() {
  const e = data.ecosystem;
  const t = data.totals.ecosystem;
  const cats = Object.entries(e.skillCategories).sort((a, b) => b[1] - a[1]);
  const catColor = ['--series-1', '--series-2', '--series-3'];
  const stat = (label, value, note) => h('div', { class: 'stat' }, h('div', { class: 'stat-label', text: label }), h('div', { class: 'stat-value', text: value }), note ? h('div', { class: 'stat-note', text: note }) : null);
  document.getElementById('eco-overview').replaceChildren(
    h(
      'div',
      {},
      h('div', { class: 'hero-label' }, 'Skill downloads by category', info('Skills are zip files on BaranziniLab/biorouter-skills, one release per skill. Categories come from the BAAM registry.')),
      h('div', { class: 'hero-value', style: { fontSize: '40px', lineHeight: '48px' }, text: fmt.int(t.skills) }),
      h(
        'div',
        { class: 'hero-split', style: { marginTop: '12px' } },
        segBar(cats.slice(0, 3).map(([c, v], i) => ({ label: c, value: v, color: catColor[i] }))),
        h(
          'ul',
          { class: 'legend legend-stack' },
          ...cats.slice(0, 3).map(([c, v], i) => h('li', {}, h('span', { class: 'legend-key', style: { background: `var(${catColor[i]})` } }), h('span', { class: 'legend-label', text: c }), h('span', { class: 'legend-value', text: fmt.int(v) }), h('span', { class: 'legend-share', text: fmt.pct(v / Math.max(1, t.skills)) })))
        )
      )
    ),
    h(
      'div',
      { class: 'stats' },
      stat('Extension downloads', fmt.int(t.extensions), `${e.extensions.filter((x) => x.count > 0).length} of ${e.registryExtensions} extensions downloaded`),
      stat('Skills published', fmt.int(e.skills.length), `${e.registrySkills} listed in BAAM`),
      stat('Workflow downloads', fmt.int(t.workflows), `${e.workflows.length} workflow files`),
      stat('Most downloaded skill', e.skills[0]?.name || 'None', e.skills[0] ? `${fmt.int(e.skills[0].count)} downloads` : ''),
      stat('Most downloaded extension', e.extensions[0]?.name || 'None', e.extensions[0] ? `${fmt.int(e.extensions[0].count)} downloads` : ''),
      stat('Ecosystem total', fmt.int(t.skills + t.extensions + t.workflows), 'All BAAM release downloads')
    )
  );

  const sMax = Math.max(...e.skills.map((s) => s.count), 1);
  const skills = e.skills.slice(0, ui.skillsShown);
  document.getElementById('panel-skills').replaceChildren(
    panelHead('Skills', `${e.skills.length} skills, most downloaded first`, null),
    h(
      'ul',
      { class: 'rows' },
      ...skills.map((s) => {
        const ci = cats.findIndex(([c]) => c === s.category);
        return rowItem(h('span', { class: 'row-label' }, h('span', { text: s.name }), h('span', { class: 'chip', text: s.category })), stackTrack([{ value: s.count, color: catColor[ci] || '--text-subtle', label: s.category }], s.count / sMax, s.name), fmt.int(s.count), fmt.pct(s.count / Math.max(1, t.skills)));
      })
    ),
    e.skills.length > skills.length ? h('button', { class: 'more', type: 'button', onclick: () => ((ui.skillsShown = e.skills.length), renderEcosystem()), text: `Show all ${e.skills.length}` }) : null
  );

  const xMax = Math.max(...e.extensions.map((s) => s.count), 1);
  const exts = e.extensions.slice(0, ui.extShown);
  document.getElementById('panel-extensions').replaceChildren(
    panelHead('Extensions', `${e.extensions.length} BAAM extensions, most downloaded first`, 'Counts every file on each extension’s GitHub releases, mostly its .brxt bundle. Private extensions reach institutional data and need credentials.'),
    h(
      'ul',
      { class: 'rows' },
      ...exts.map((x) =>
        rowItem(
          h('span', { class: 'row-label' }, x.repo ? h('a', { href: `https://github.com/${x.repo}`, text: x.name }) : h('span', { text: x.name }), x.privacy === 'private' ? h('span', { class: 'chip', text: 'Private' }) : null),
          stackTrack([{ value: x.count, color: '--series-2', label: 'Downloads' }], x.count / xMax, x.name),
          fmt.int(x.count),
          fmt.pct(x.count / Math.max(1, t.extensions))
        )
      )
    ),
    e.extensions.length > exts.length ? h('button', { class: 'more', type: 'button', onclick: () => ((ui.extShown = e.extensions.length), renderEcosystem()), text: `Show all ${e.extensions.length}` }) : null
  );
}

function renderFoot() {
  const m = data.meta;
  const when = (t) => (t ? new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }) : 'Not yet');
  document.getElementById('foot').replaceChildren(
    h(
      'div',
      {},
      h('h3', { text: 'How these numbers are counted' }),
      h(
        'ul',
        {},
        h('li', { text: 'GitHub reports a running download total for each release file and keeps no daily history. A collector reads every total once a day and records how much each one rose; those rises are the measured days.' }),
        h('li', { text: 'Days before measuring began are estimated: the totals that already existed are spread evenly across the days each release was the newest one, when the download page and the updater pointed at it.' }),
        h('li', { text: 'Between daily runs, this page reads the release totals from GitHub every five minutes and adds what changed, so the main numbers are live.' }),
        h('li', { text: 'Update checks are reads of latest-mac.yml by running Mac apps, not downloads of the app. Windows updates download the installer, so they count as new installs. Draft releases are left out.' }),
        h('li', {}, 'Source: ', h('a', { href: 'https://github.com/BaranziniLab/biorouter-usage-dashboard', text: 'BaranziniLab/biorouter-usage-dashboard' }), '.')
      )
    ),
    h(
      'div',
      {},
      h('h3', { text: 'Data' }),
      h(
        'dl',
        {},
        h('dt', { text: 'Daily snapshot' }),
        h('dd', { text: when(m.lastCollectionAt) }),
        h('dt', { text: 'Next snapshot' }),
        h('dd', { text: when(m.nextCollectionAt) }),
        h('dt', { text: 'Live check' }),
        h('dd', { id: 'foot-live', text: live.at ? when(live.at) : live.error === 'rate' ? 'Paused by rate limit' : 'Waiting' }),
        h('dt', { text: 'Measuring since' }),
        h('dd', { text: when(m.measuringSince) }),
        h('dt', { text: 'Snapshots taken' }),
        h('dd', { text: fmt.int(m.collections) })
      )
    )
  );
}

function renderNotice() {
  const el = document.getElementById('notice');
  if (!data) return;
  const notes = [];
  if (live.error === 'rate') {
    notes.push(['warning', `GitHub limits how often one browser can read its API, so live numbers resume at ${new Date(live.retryAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}. The daily snapshot is shown until then.`]);
  }
  const tAge = Date.now() - (data.traffic.updatedAt || 0);
  if (data.traffic.updatedAt && tAge > 3 * DAY) {
    notes.push(['warning', `Repository traffic was last collected ${dateLabel(new Date(data.traffic.updatedAt).toISOString(), { year: true })}. The daily job needs a token with access to the repository's traffic.`]);
  }
  el.replaceChildren(...notes.map(([kind, text]) => h('div', { class: `note note-${kind}`, role: 'status', text })));
}

// ── Live status in the band ─────────────────────────────────────────────────
function setLive(state, word, meta) {
  const el = document.getElementById('live');
  el.dataset.state = state;
  document.getElementById('live-word').textContent = word;
  document.getElementById('live-meta').textContent = meta;
}

function updateLiveLabel() {
  if (!data) return;
  const ago = (t) => {
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < DAY / 1000) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
  };
  if (live.ok && live.at) {
    const added = KINDS.reduce((s, k) => s + data.live.delta[k], 0);
    setLive('live', 'Live', `checked ${ago(live.at)}${added ? `, ${fmt.int(added)} new since the daily snapshot` : ''}`);
  } else if (live.error === 'rate') {
    setLive('paused', 'Daily snapshot', `from ${ago(data.meta.lastCollectionAt)}`);
  } else {
    setLive('paused', 'Daily snapshot', `from ${ago(data.meta.lastCollectionAt)}`);
  }
  const fl = document.getElementById('foot-live');
  if (fl && live.at) fl.textContent = new Date(live.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
}

// ── Chrome: range, theme, refresh, hints ────────────────────────────────────
function wireChrome() {
  const range = document.getElementById('range');
  const sync = () => range.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.range === ui.range)));
  sync();
  range.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    ui.range = b.dataset.range;
    store('range', ui.range);
    sync();
    if (data) {
      renderDownloadsChart();
      renderChecksChart();
    }
  });
  range.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const bs = [...range.querySelectorAll('button')];
    const i = bs.findIndex((b) => b.dataset.range === ui.range);
    const n = bs[(i + (e.key === 'ArrowRight' ? 1 : bs.length - 1)) % bs.length];
    n.click();
    n.focus();
  });

  document.getElementById('theme').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    store('theme', next, 'br-dashboard-theme');
    if (data) renderCharts();
  });
  document.getElementById('refresh').addEventListener('click', () => pollLive(true));

  // Hints for icon buttons and InfoTips: one floating label, on hover and focus.
  const hint = h('div', { class: 'hint', role: 'tooltip', id: 'hint' });
  document.body.appendChild(hint);
  const show = (target) => {
    const text = target.getAttribute('data-tip');
    if (!text) return;
    hint.textContent = text;
    hint.dataset.open = 'true';
    const r = target.getBoundingClientRect();
    const hr = hint.getBoundingClientRect();
    let left = r.left + r.width / 2 - hr.width / 2;
    left = Math.max(8, Math.min(left, document.documentElement.clientWidth - hr.width - 8));
    let top = r.bottom + 8;
    if (top + hr.height > innerHeight - 8) top = r.top - hr.height - 8;
    hint.style.transform = `translate(${left}px, ${top}px)`;
  };
  const hide = () => (hint.dataset.open = 'false');
  document.addEventListener('pointerover', (e) => {
    const t = e.target.closest('[data-tip]');
    if (t) show(t);
  });
  document.addEventListener('pointerout', (e) => {
    if (e.target.closest('[data-tip]')) hide();
  });
  document.addEventListener('focusin', (e) => {
    const t = e.target.closest('[data-tip]');
    if (t) show(t);
  });
  document.addEventListener('focusout', hide);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hide();
      tooltip().hide();
    }
  });
  addEventListener('scroll', () => {
    hide();
    tooltip().hide();
  }, { passive: true });
}

// ── Small builders ──────────────────────────────────────────────────────────
function info(text) {
  return h(
    'button',
    { class: 'infotip', type: 'button', 'aria-label': text, 'data-tip': text },
    (() => {
      const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      s.setAttribute('viewBox', '0 0 16 16');
      s.setAttribute('aria-hidden', 'true');
      s.innerHTML = '<circle cx="8" cy="8" r="6.25"/><path d="M8 7.25v3.75" stroke-linecap="round"/><circle cx="8" cy="5" r="0.4" fill="currentColor"/>';
      return s;
    })()
  );
}

function panelHead(title, sub, help, figure, figureNote) {
  return h(
    'div',
    { class: 'panel-head' },
    h('div', {}, h('h3', { class: 'panel-title' }, title, help ? info(help) : null), sub ? h('p', { class: 'panel-sub', text: sub }) : null),
    figure ? h('div', { class: 'panel-figure' }, figure, figureNote ? h('small', { text: figureNote }) : null) : null
  );
}

function rowItem(label, track, value, share) {
  return h('li', { class: 'row' }, label, track, h('span', { class: 'row-value', text: value }), h('span', { class: 'row-share', text: share }));
}

function stackTrack(parts, frac, name) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  const wrap = h('div', { class: 'track-wrap' });
  const inner = h('div', { class: 'track', style: { width: `${Math.max(1.5, frac * 100)}%` } });
  const t = tooltip();
  for (const p of parts) {
    if (p.value <= 0) continue;
    const seg = h('span', { style: { flexGrow: p.value, flexBasis: 0, background: `var(${p.color})` } });
    const tipBody = () => tipContent(name, parts.filter((x) => x.value > 0).map((x) => ({ value: fmt.int(x.value), label: x.label, color: `var(${x.color})` })));
    seg.addEventListener('pointermove', (e) => t.show(tipBody(), e.clientX, e.clientY));
    seg.addEventListener('pointerleave', () => t.hide());
    inner.appendChild(seg);
  }
  if (!total) inner.style.width = '0';
  wrap.appendChild(inner);
  return wrap;
}

function deltaSpan(cur, prev, against, short = false) {
  if (!(prev > 0)) return h('span', {});
  const pct = (cur - prev) / prev;
  const up = pct >= 0;
  const text = `${up ? '↑' : '↓'} ${Math.abs(Math.round(pct * 100))}%${short ? ' vs the 7 days before' : ` vs the ${against}`}`;
  return h('span', { class: up ? 'delta-up' : 'delta-down', text });
}

function dataTable(head, rows) {
  return h(
    'details',
    { class: 'data-table' },
    h('summary', { text: 'Data table' }),
    h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, h('thead', {}, h('tr', {}, ...head.map((x, i) => h('th', { class: i ? 'num' : '', text: x })))), h('tbody', {}, ...rows.map((r) => h('tr', {}, ...r.map((c, i) => h('td', { class: i ? 'num' : '', text: c })))))))
  );
}

function tableHead(cols, sort, onSort) {
  return h(
    'thead',
    {},
    h(
      'tr',
      {},
      ...cols.map((c) =>
        h(
          'th',
          { class: c.num ? 'num' : '', 'aria-sort': sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : null },
          h('button', { type: 'button', text: c.label, onclick: () => onSort(c.key) })
        )
      )
    )
  );
}

function sortRows(rows, cols, sort) {
  const col = cols.find((c) => c.key === sort.key) || cols[0];
  const get = col.get || ((r) => r[col.key]);
  const dir = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (col.sort) return dir * col.sort(a, b);
    const x = get(a);
    const y = get(b);
    if (typeof x === 'number' && typeof y === 'number') return dir * (x - y);
    return dir * String(x).localeCompare(String(y));
  });
}

function nextSort(sort, key) {
  if (sort.key === key) return { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: ['name', 'platformLabel', 'kind'].includes(key) ? 'asc' : 'desc' };
}

function cmpTag(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

function trim1(x) {
  return x >= 10 ? fmt.int(x) : x.toFixed(1).replace(/\.0$/, '');
}

function searchIcon() {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 16 16');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14" stroke-linecap="round"/>';
  return s;
}

function showNotice(kind, text) {
  document.getElementById('notice').replaceChildren(h('div', { class: `note note-${kind}`, role: 'alert', text }));
}

function flashChanges(ids) {
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    const text = el.textContent;
    if (previous.has(id) && previous.get(id) !== text) {
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
    }
    previous.set(id, text);
  }
}

function store(key, value, fullKey) {
  const k = fullKey || `br-dashboard-${key}`;
  try {
    if (value === undefined) return localStorage.getItem(k);
    localStorage.setItem(k, value);
  } catch {
    return null;
  }
  return value;
}
