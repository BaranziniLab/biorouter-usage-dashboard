// A small GitHub REST client: token discovery, conditional requests (ETag),
// pagination and rate-limit bookkeeping. No dependencies.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

const API = 'https://api.github.com';
const UA = 'biorouter-dashboard';

/** Find a token without ever writing it to disk: env first, then `gh auth token`. */
export async function resolveToken() {
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (fromEnv && fromEnv.trim()) return { token: fromEnv.trim(), source: 'environment' };
  const candidates = ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'];
  for (const bin of candidates) {
    if (bin !== 'gh' && !existsSync(bin)) continue;
    const token = await new Promise((resolve) => {
      execFile(bin, ['auth', 'token'], { timeout: 10_000 }, (err, stdout) => {
        resolve(err ? null : String(stdout).trim() || null);
      });
    });
    if (token) return { token, source: 'gh auth token' };
  }
  return { token: null, source: 'none' };
}

export class GitHub {
  constructor(token) {
    this.token = token;
    this.cache = new Map(); // url -> { etag, body, link }
    this.rate = { limit: null, remaining: null, reset: null };
    this.requests = 0;
    this.notModified = 0;
  }

  headers(accept, etag) {
    const h = {
      Accept: accept || 'application/vnd.github+json',
      'User-Agent': UA,
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    if (etag) h['If-None-Match'] = etag;
    return h;
  }

  /** GET one URL. Returns { status, body, link }. A 304 answers from the cache. */
  async get(pathOrUrl, { accept, allow404 = false } = {}) {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : API + pathOrUrl;
    const key = `${accept || ''} ${url}`;
    const cached = this.cache.get(key);
    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetch(url, {
          headers: this.headers(accept, cached?.etag),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        if (attempt < 2) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
        throw new Error(`GitHub request failed for ${url}: ${err.message}`);
      }
      if (res.status >= 500 && attempt < 2) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      break;
    }
    this.requests++;
    this.trackRate(res.headers);
    const link = res.headers.get('link');
    if (res.status === 304 && cached) {
      this.notModified++;
      return { status: 200, body: cached.body, link: cached.link };
    }
    if (res.status === 404 && allow404) return { status: 404, body: null, link: null };
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`GitHub ${res.status} for ${url}: ${text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    const body = await res.json();
    const etag = res.headers.get('etag');
    if (etag) this.cache.set(key, { etag, body, link });
    return { status: res.status, body, link };
  }

  /** Follow `Link: rel="next"` and concatenate array pages. */
  async paginate(path, opts = {}) {
    const out = [];
    let next = path;
    let guard = 0;
    while (next && guard++ < 50) {
      const { body, link, status } = await this.get(next, opts);
      if (status === 404) return null;
      if (Array.isArray(body)) out.push(...body);
      next = nextLink(link);
    }
    return out;
  }

  trackRate(h) {
    const limit = h.get('x-ratelimit-limit');
    const remaining = h.get('x-ratelimit-remaining');
    const reset = h.get('x-ratelimit-reset');
    if (h.get('x-ratelimit-resource') && h.get('x-ratelimit-resource') !== 'core') return;
    if (limit) this.rate.limit = Number(limit);
    if (remaining) this.rate.remaining = Number(remaining);
    if (reset) this.rate.reset = Number(reset) * 1000;
  }
}

function nextLink(link) {
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
