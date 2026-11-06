// Chart primitives for the dashboard: stacked columns, lines, a calendar
// heatmap, a segmented bar and the shared tooltip. Plain SVG and DOM, no
// library. Every label is set with textContent; nothing here uses innerHTML.

const SVG = 'http://www.w3.org/2000/svg';

export function svg(tag, attrs = {}, parent) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, v);
  if (parent) parent.appendChild(el);
  return el;
}

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return el;
}

// ── Number formats ──────────────────────────────────────────────────────────
export const fmt = {
  int: (n) => Math.round(n).toLocaleString('en-US'),
  approx: (n) => (n > 0 && n < 1 ? '<1' : Math.round(n).toLocaleString('en-US')),
  compact(n) {
    const a = Math.abs(n);
    if (a >= 1e6) return `${trim(n / 1e6)}M`;
    if (a >= 1e4) return `${trim(n / 1e3)}K`;
    return Math.round(n).toLocaleString('en-US');
  },
  bytes(b) {
    const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let i = 0;
    while (b >= 1000 && i < u.length - 1) {
      b /= 1000;
      i++;
    }
    return `${b >= 100 ? Math.round(b) : trim(b)} ${u[i]}`;
  },
  pct: (x) => (x >= 0.1 ? `${Math.round(x * 100)}%` : x > 0 ? `${(x * 100).toFixed(1)}%` : '0%'),
};
function trim(x) {
  return x.toFixed(1).replace(/\.0$/, '');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function dateLabel(iso, { year = false } = {}) {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  const s = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return year ? `${s}, ${d.getUTCFullYear()}` : s;
}

// ── Scales ──────────────────────────────────────────────────────────────────
export function niceTicks(max, count = 4) {
  if (!(max > 0)) return { max: 1, ticks: [0, 1] };
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return { max: top, ticks };
}

// ── Tooltip (one per page) ──────────────────────────────────────────────────
let tip;
export function tooltip() {
  if (tip) return tip;
  const el = h('div', { class: 'viz-tip', role: 'status', 'aria-live': 'polite' });
  document.body.appendChild(el);
  tip = {
    el,
    show(content, x, y) {
      el.replaceChildren(content);
      el.dataset.open = 'true';
      const r = el.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      let left = x + 14;
      if (left + r.width > vw - 8) left = x - r.width - 14;
      let top = y - r.height - 12;
      if (top < 8) top = y + 16;
      el.style.transform = `translate(${Math.max(8, left)}px, ${top}px)`;
    },
    hide() {
      el.dataset.open = 'false';
    },
  };
  return tip;
}

/** Tooltip body: a heading, then rows of [key colour, label, value]. Values lead. */
export function tipContent(title, rows, foot) {
  return h(
    'div',
    {},
    h('div', { class: 'viz-tip-title', text: title }),
    ...rows.map((r) =>
      h(
        'div',
        { class: 'viz-tip-row', dataset: r.muted ? { muted: 'true' } : {} },
        r.color ? h('span', { class: 'viz-tip-key', style: { background: r.color } }) : h('span', { class: 'viz-tip-key viz-tip-key-none' }),
        h('span', { class: 'viz-tip-value', text: r.value }),
        h('span', { class: 'viz-tip-label', text: r.label })
      )
    ),
    foot ? h('div', { class: 'viz-tip-foot', text: foot }) : null
  );
}

function cssVar(el, name) {
  return getComputedStyle(el).getPropertyValue(name).trim();
}

// ── Stacked columns ─────────────────────────────────────────────────────────
// data: [{ key, values: {seriesKey: n}, est: bool }]
// series: [{ key, label, color: '--css-var' }]
export function columnChart(host, opts) {
  const { data, series, height = 220, yFormat = fmt.compact, tooltipFor, marker, xLabel, xTickIndices, ariaLabel } = opts;
  host.replaceChildren();
  const width = Math.max(280, host.clientWidth);
  const m = { l: 44, r: 8, t: 14, b: 26 };
  const iw = width - m.l - m.r;
  const ih = height - m.t - m.b;
  const n = data.length;
  const totals = data.map((d) => series.reduce((s, sr) => s + (d.values[sr.key] || 0), 0));
  const { max, ticks } = niceTicks(Math.max(...totals, 0));
  const band = iw / Math.max(1, n);
  const gap = band >= 8 ? 2 : band >= 3 ? 1 : 0;
  const barW = Math.min(24, Math.max(1, band - gap));
  const stackGap = barW >= 6 ? 2 : barW >= 3 ? 1 : 0;
  const y = (v) => m.t + ih - (v / max) * ih;

  const root = svg('svg', {
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    class: 'viz',
    role: 'img',
    tabindex: 0,
    'aria-label': ariaLabel || 'Chart',
  });
  host.appendChild(root);

  // Hatch patterns for estimated columns: the series hue, lighter, with 45° lines.
  const defs = svg('defs', {}, root);
  for (const s of series) {
    const p = svg('pattern', { id: `hatch-${host.id}-${s.key}`, patternUnits: 'userSpaceOnUse', width: 5, height: 5, patternTransform: 'rotate(45)' }, defs);
    svg('rect', { width: 5, height: 5, fill: `var(${s.color})`, 'fill-opacity': 0.38 }, p);
    svg('line', { x1: 0, y1: 0, x2: 0, y2: 5, stroke: `var(${s.color})`, 'stroke-width': 2, 'stroke-opacity': 0.9 }, p);
  }

  // Grid and y ticks.
  const grid = svg('g', { class: 'viz-grid' }, root);
  for (const t of ticks) {
    svg('line', { x1: m.l, x2: width - m.r, y1: y(t), y2: y(t), class: t === 0 ? 'viz-baseline' : 'viz-gridline' }, grid);
    const lab = svg('text', { x: m.l - 8, y: y(t), class: 'viz-tick', 'text-anchor': 'end', 'dominant-baseline': 'middle' }, grid);
    lab.textContent = yFormat(t);
  }

  // Hover band, under the bars.
  const hover = svg('rect', { class: 'viz-hover', x: 0, y: m.t, width: band, height: ih, rx: 4, opacity: 0 }, root);

  const bars = svg('g', {}, root);
  data.forEach((d, i) => {
    const x = m.l + i * band + (band - barW) / 2;
    let acc = 0;
    const visible = series.filter((s) => (d.values[s.key] || 0) > 0);
    visible.forEach((s, j) => {
      const v = d.values[s.key];
      const y0 = y(acc);
      const y1 = y(acc + v);
      acc += v;
      let top = y1;
      let bottom = j === 0 ? y0 : y0 - stackGap;
      if (bottom - top < 0.6) {
        if (bottom - top <= 0) return;
      }
      const isTop = j === visible.length - 1;
      const r = isTop ? Math.min(4, barW / 2, bottom - top) : 0;
      svg('path', { d: roundedTop(x, top, barW, bottom - top, r), fill: d.est ? `url(#hatch-${host.id}-${s.key})` : `var(${s.color})` }, bars);
    });
  });

  // Marker: where measured data begins.
  if (marker && marker.index >= 0 && marker.index < n) {
    const mx = m.l + marker.index * band;
    const g = svg('g', { class: 'viz-marker' }, root);
    svg('line', { x1: mx, x2: mx, y1: m.t - 4, y2: m.t + ih }, g);
    const t = svg('text', { x: mx + 4, y: m.t + 6, class: 'viz-marker-label', 'dominant-baseline': 'middle' }, g);
    t.textContent = marker.label;
    // Keep the label inside the plot.
    requestAnimationFrame(() => {
      const bb = t.getBBox();
      if (bb.x + bb.width > width - m.r) {
        t.setAttribute('x', mx - 4);
        t.setAttribute('text-anchor', 'end');
      }
    });
  }

  // X ticks.
  const xt = svg('g', { class: 'viz-xticks' }, root);
  const picks = xTickIndices ? xTickIndices(band) : pickDateTicks(data.map((d) => d.key), band);
  for (const i of picks) {
    const lab = svg('text', { x: m.l + i * band + band / 2, y: height - 8, class: 'viz-tick', 'text-anchor': 'middle' }, xt);
    lab.textContent = xLabel ? xLabel(data[i].key, i) : dateLabel(data[i].key);
  }
  clampEdgeLabels(xt, m.l, width - m.r);

  // Interaction: the band is the hit target; arrow keys walk it.
  let active = -1;
  const t = tooltip();
  const showAt = (i, cx, cy) => {
    active = i;
    hover.setAttribute('x', m.l + i * band + (band - Math.max(barW + 6, Math.min(band, 30))) / 2);
    hover.setAttribute('width', Math.max(barW + 6, Math.min(band, 30)));
    hover.setAttribute('opacity', 1);
    t.show(tooltipFor(data[i], totals[i]), cx, cy);
  };
  const hide = () => {
    active = -1;
    hover.setAttribute('opacity', 0);
    t.hide();
  };
  root.addEventListener('pointermove', (e) => {
    const r = root.getBoundingClientRect();
    const i = Math.floor((e.clientX - r.left - m.l) / band);
    if (i < 0 || i >= n) return hide();
    showAt(i, e.clientX, e.clientY);
  });
  root.addEventListener('pointerleave', hide);
  root.addEventListener('blur', hide);
  root.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(e.key)) return;
    e.preventDefault();
    if (e.key === 'Escape') return hide();
    let i = active < 0 ? n - 1 : active;
    if (e.key === 'ArrowLeft') i = Math.max(0, i - 1);
    if (e.key === 'ArrowRight') i = Math.min(n - 1, i + 1);
    if (e.key === 'Home') i = 0;
    if (e.key === 'End') i = n - 1;
    const r = root.getBoundingClientRect();
    showAt(i, r.left + m.l + i * band + band / 2, r.top + y(totals[i]));
  });
  return root;
}

/** Tick times on UTC day or month boundaries, at most `max` of them. */
function timeTicks(t0, t1, max) {
  const DAY = 86_400_000;
  const span = (t1 - t0) / DAY;
  const out = [];
  if (span <= 120) {
    const steps = [1, 2, 7, 14, 28];
    const step = steps.find((s) => span / s <= max) || 28;
    let t = Math.ceil(t0 / DAY) * DAY;
    if (step === 7 || step === 14) {
      while (new Date(t).getUTCDay() !== 1) t += DAY; // Mondays
    }
    for (; t <= t1; t += step * DAY) out.push(t);
    return out;
  }
  const months = [1, 2, 3, 6, 12];
  const every = months.find((mm) => span / 30.4 / mm <= max) || 12;
  const d = new Date(t0);
  let y = d.getUTCFullYear();
  let mo = d.getUTCMonth() + 1;
  for (;;) {
    if (mo > 11) {
      y += Math.floor(mo / 12);
      mo %= 12;
    }
    const t = Date.UTC(y, mo, 1);
    if (t > t1) break;
    if (mo % every === 0 || every === 1) out.push(t);
    mo += 1;
  }
  return out;
}

function roundedTop(x, y, w, hgt, r) {
  if (r <= 0.5) return `M${x},${y}h${w}v${hgt}h${-w}Z`;
  return `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`;
}

function pickDateTicks(keys, band) {
  const n = keys.length;
  if (!n) return [];
  const minGap = 64;
  const every = Math.max(1, Math.ceil(minGap / band));
  const out = [];
  if (n <= 45) {
    // Weekly: Mondays.
    keys.forEach((k, i) => {
      if (new Date(`${k}T00:00:00Z`).getUTCDay() === 1) out.push(i);
    });
    return thin(out, every);
  }
  keys.forEach((k, i) => {
    const d = k.slice(8, 10);
    if (d === '01' || (n <= 120 && d === '15')) out.push(i);
  });
  return thin(out, every);
}

function thin(idx, every) {
  const out = [];
  let last = -Infinity;
  for (const i of idx) {
    if (i - last >= every) {
      out.push(i);
      last = i;
    }
  }
  return out;
}

function clampEdgeLabels(g, left, right) {
  requestAnimationFrame(() => {
    for (const t of g.querySelectorAll('text')) {
      const bb = t.getBBox();
      if (bb.x < left - 30) t.setAttribute('text-anchor', 'start');
      if (bb.x + bb.width > right) t.setAttribute('text-anchor', 'end');
    }
  });
}

// ── Lines over time ─────────────────────────────────────────────────────────
// points: [{ t: ms, values: {key: n}, faint?: bool }]  series: [{key,label,color,area?}]
export function lineChart(host, opts) {
  const { points, series, height = 200, yFormat = fmt.compact, tooltipFor, step = false, xFormat, ariaLabel, faintBefore } = opts;
  host.replaceChildren();
  const width = Math.max(260, host.clientWidth);
  const m = { l: 44, r: 14, t: 14, b: 26 };
  const iw = width - m.l - m.r;
  const ih = height - m.t - m.b;
  if (!points.length) {
    host.appendChild(h('p', { class: 'empty', text: 'No data yet.' }));
    return;
  }
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t === t0 ? t0 + 86_400_000 : points[points.length - 1].t;
  const x = (t) => m.l + ((t - t0) / (t1 - t0)) * iw;
  const vmax = Math.max(...points.flatMap((p) => series.map((s) => p.values[s.key] || 0)), 0);
  const { max, ticks } = niceTicks(vmax);
  const y = (v) => m.t + ih - (v / max) * ih;

  const root = svg('svg', { width, height, viewBox: `0 0 ${width} ${height}`, class: 'viz', role: 'img', tabindex: 0, 'aria-label': ariaLabel || 'Chart' });
  host.appendChild(root);
  const grid = svg('g', { class: 'viz-grid' }, root);
  for (const tk of ticks) {
    svg('line', { x1: m.l, x2: width - m.r, y1: y(tk), y2: y(tk), class: tk === 0 ? 'viz-baseline' : 'viz-gridline' }, grid);
    const lab = svg('text', { x: m.l - 8, y: y(tk), class: 'viz-tick', 'text-anchor': 'end', 'dominant-baseline': 'middle' }, grid);
    lab.textContent = yFormat(tk);
  }

  const path = (s, from, to) => {
    let d = '';
    for (let i = from; i <= to; i++) {
      const p = points[i];
      const px = x(p.t);
      const py = y(p.values[s.key] || 0);
      if (i === from) d += `M${px},${py}`;
      else if (step) d += `H${px}V${py}`;
      else d += `L${px},${py}`;
    }
    return d;
  };

  const split = faintBefore != null ? points.findIndex((p) => p.t >= faintBefore) : -1;
  for (const s of series) {
    if (s.area) {
      const d = path(s, 0, points.length - 1) + `V${y(0)}H${x(points[0].t)}Z`;
      svg('path', { d, fill: `var(${s.color})`, 'fill-opacity': 0.1 }, root);
    }
    if (split > 0) {
      svg('path', { d: path(s, 0, split), class: 'viz-line', stroke: `var(${s.color})`, 'stroke-opacity': 0.45 }, root);
      svg('path', { d: path(s, split, points.length - 1), class: 'viz-line', stroke: `var(${s.color})` }, root);
    } else {
      svg('path', { d: path(s, 0, points.length - 1), class: 'viz-line', stroke: `var(${s.color})` }, root);
    }
    const last = points[points.length - 1];
    svg('circle', { cx: x(last.t), cy: y(last.values[s.key] || 0), r: 4, fill: `var(${s.color})`, class: 'viz-dot' }, root);
  }

  // X ticks on whole UTC days or months, about one per 90px.
  const xt = svg('g', { class: 'viz-xticks' }, root);
  for (const tt of timeTicks(t0, t1, Math.max(2, Math.floor(iw / 90)))) {
    const px = x(tt);
    const lab = svg('text', { x: px, y: height - 8, class: 'viz-tick', 'text-anchor': 'middle' }, xt);
    lab.textContent = xFormat ? xFormat(tt) : dateLabel(new Date(tt).toISOString());
  }
  clampEdgeLabels(xt, m.l, width - m.r);

  // Crosshair snapping to the nearest point.
  const cross = svg('line', { class: 'viz-cross', y1: m.t, y2: m.t + ih, opacity: 0 }, root);
  const dots = series.map((s) => svg('circle', { r: 4, fill: `var(${s.color})`, class: 'viz-dot', opacity: 0 }, root));
  const tt = tooltip();
  let active = -1;
  const showAt = (i, cx, cy) => {
    active = i;
    const p = points[i];
    const px = x(p.t);
    cross.setAttribute('x1', px);
    cross.setAttribute('x2', px);
    cross.setAttribute('opacity', 1);
    series.forEach((s, j) => {
      dots[j].setAttribute('cx', px);
      dots[j].setAttribute('cy', y(p.values[s.key] || 0));
      dots[j].setAttribute('opacity', 1);
    });
    tt.show(tooltipFor(p), cx, cy);
  };
  const hide = () => {
    active = -1;
    cross.setAttribute('opacity', 0);
    dots.forEach((d) => d.setAttribute('opacity', 0));
    tt.hide();
  };
  const nearest = (px) => {
    let best = 0;
    let bd = Infinity;
    points.forEach((p, i) => {
      const dd = Math.abs(x(p.t) - px);
      if (dd < bd) {
        bd = dd;
        best = i;
      }
    });
    return best;
  };
  root.addEventListener('pointermove', (e) => {
    const r = root.getBoundingClientRect();
    const px = e.clientX - r.left;
    if (px < m.l - 10 || px > width - m.r + 10) return hide();
    showAt(nearest(px), e.clientX, e.clientY);
  });
  root.addEventListener('pointerleave', hide);
  root.addEventListener('blur', hide);
  root.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(e.key)) return;
    e.preventDefault();
    if (e.key === 'Escape') return hide();
    let i = active < 0 ? points.length - 1 : active;
    if (e.key === 'ArrowLeft') i = Math.max(0, i - 1);
    if (e.key === 'ArrowRight') i = Math.min(points.length - 1, i + 1);
    if (e.key === 'Home') i = 0;
    if (e.key === 'End') i = points.length - 1;
    const r = root.getBoundingClientRect();
    showAt(i, r.left + x(points[i].t), r.top + m.t + 20);
  });
  return root;
}

// ── Calendar heatmap (the app's usage heatmap, by week columns) ─────────────
// days: [{ date: 'YYYY-MM-DD', value, est }]
export function heatmap(host, { days, label = 'downloads', weeks = 53 }) {
  host.replaceChildren();
  const byDate = new Map(days.map((d) => [d.date, d]));
  const today = new Date(`${days[days.length - 1].date}T00:00:00Z`);
  const end = new Date(today);
  end.setUTCDate(end.getUTCDate() + (6 - end.getUTCDay())); // through Saturday
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - weeks * 7 + 1);

  const nonzero = days.map((d) => d.value).filter((v) => v > 0).sort((a, b) => a - b);
  const q = (p) => nonzero[Math.min(nonzero.length - 1, Math.floor(p * nonzero.length))] || 0;
  const cuts = [q(0.25), q(0.5), q(0.75)];
  const level = (v) => (v <= 0 ? 0 : v <= cuts[0] ? 1 : v <= cuts[1] ? 2 : v <= cuts[2] ? 3 : 4);

  const wrap = h('div', { class: 'heatmap', style: { '--heat-weeks': weeks } });
  const months = h('div', { class: 'heatmap-months', 'aria-hidden': 'true' });
  const grid = h('div', { class: 'heatmap-grid', role: 'grid', 'aria-label': `Daily ${label}` });
  const rows = Array.from({ length: 7 }, () => h('div', { class: 'heatmap-row', role: 'row' }));
  let lastMonth = -1;
  const t = tooltip();
  for (let w = 0; w < weeks; w++) {
    const colStart = new Date(start);
    colStart.setUTCDate(start.getUTCDate() + w * 7);
    const mth = colStart.getUTCMonth();
    const firstOfMonthInCol = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(colStart);
      d.setUTCDate(colStart.getUTCDate() + i);
      return d;
    }).find((d) => d.getUTCDate() === 1);
    const mm = firstOfMonthInCol ? firstOfMonthInCol.getUTCMonth() : w === 0 ? mth : -1;
    months.appendChild(h('span', { text: mm >= 0 && mm !== lastMonth ? MONTHS[mm] : '' }));
    if (mm >= 0) lastMonth = mm;
    for (let r = 0; r < 7; r++) {
      const d = new Date(colStart);
      d.setUTCDate(colStart.getUTCDate() + r);
      const key = d.toISOString().slice(0, 10);
      const rec = byDate.get(key);
      const future = d > today;
      const v = rec ? rec.value : 0;
      const cell = h('span', {
        class: 'heatmap-cell',
        role: future ? 'presentation' : 'gridcell',
        dataset: { level: future ? 'none' : String(level(v)) },
        tabindex: future ? null : -1,
        'aria-label': future ? null : `${dateLabel(key, { year: true })}: ${fmt.approx(v)} ${label}${rec?.est ? ', estimated' : ''}`,
      });
      if (!future) {
        const show = (cx, cy) =>
          t.show(
            tipContent(dateLabel(key, { year: true }), [
              { value: rec?.est ? `≈ ${fmt.approx(v)}` : fmt.int(v), label, color: null },
            ], rec?.est ? 'Estimated from release windows' : rec ? 'Measured' : null),
            cx,
            cy
          );
        cell.addEventListener('pointerenter', (e) => show(e.clientX, e.clientY));
        cell.addEventListener('pointerleave', () => t.hide());
        cell.addEventListener('focus', () => {
          const b = cell.getBoundingClientRect();
          show(b.right, b.top);
        });
        cell.addEventListener('blur', () => t.hide());
      }
      rows[r].appendChild(cell);
    }
  }
  // Roving focus: the grid is one tab stop, arrows move between days.
  const cells = () => [...grid.querySelectorAll('[role="gridcell"]')];
  grid.tabIndex = 0;
  grid.addEventListener('focus', (e) => {
    if (e.target !== grid) return;
    const all = cells();
    all[all.length - 1]?.focus();
  });
  grid.addEventListener('keydown', (e) => {
    const all = rows.map((row) => [...row.children]);
    const cur = document.activeElement;
    let r = all.findIndex((row) => row.includes(cur));
    if (r < 0) return;
    let c = all[r].indexOf(cur);
    if (e.key === 'ArrowLeft') c--;
    else if (e.key === 'ArrowRight') c++;
    else if (e.key === 'ArrowUp') r--;
    else if (e.key === 'ArrowDown') r++;
    else return;
    e.preventDefault();
    const next = all[r]?.[c];
    if (next && next.getAttribute('role') === 'gridcell') next.focus();
  });
  rows.forEach((row) => grid.appendChild(row));
  wrap.append(months, grid);
  host.appendChild(wrap);
  return { cuts };
}

// ── Segmented bar: one whole split into parts ───────────────────────────────
export function segBar(parts, { thin = true } = {}) {
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  const bar = h('div', { class: thin ? 'segbar segbar-thin' : 'segbar', role: 'img', 'aria-label': parts.map((p) => `${p.label} ${fmt.int(p.value)} (${fmt.pct(p.value / total)})`).join(', ') });
  const t = tooltip();
  for (const p of parts) {
    if (p.value <= 0) continue;
    const seg = h('span', { class: 'segbar-part', style: { flexGrow: p.value, background: `var(${p.color})` } });
    seg.addEventListener('pointerenter', (e) => t.show(tipContent(p.label, [{ value: fmt.int(p.value), label: fmt.pct(p.value / total), color: `var(${p.color})` }]), e.clientX, e.clientY));
    seg.addEventListener('pointermove', (e) => t.show(tipContent(p.label, [{ value: fmt.int(p.value), label: fmt.pct(p.value / total), color: `var(${p.color})` }]), e.clientX, e.clientY));
    seg.addEventListener('pointerleave', () => t.hide());
    bar.appendChild(seg);
  }
  return bar;
}

/** Legend: rect keys for bars and areas, line keys for lines. */
export function legend(items) {
  return h(
    'ul',
    { class: 'legend' },
    ...items.map((it) =>
      h(
        'li',
        {},
        h('span', { class: `legend-key legend-key-${it.shape || 'rect'}`, style: it.color ? { background: `var(${it.color})` } : {}, dataset: it.hatch ? { hatch: 'true' } : {} }),
        h('span', { class: 'legend-label', text: it.label }),
        it.value != null ? h('span', { class: 'legend-value', text: it.value }) : null
      )
    )
  );
}

export { cssVar };
