// What each Biorouter release asset is, read from its file name. Used by the
// collector (Node) and by the page (browser), so it imports nothing.
//
// kind      install  a desktop installer a person downloads (dmg, exe, deb, rpm, Windows zip)
//           update   an auto-update payload the Mac app fetches itself (darwin-*.zip)
//           check    the update manifest every running Mac app reads (latest-mac.yml)
//           cli      a terminal-only package (biorouter-cli deb/rpm, headless tarball, CLI binary)
//           other    anything else
// platform  mac-arm64 | mac-x64 | windows | linux | mac (both) | other

export const KINDS = ['install', 'update', 'cli', 'check', 'other'];

export const KIND_LABEL = {
  install: 'New installs',
  update: 'Auto-updates',
  cli: 'CLI packages',
  check: 'Update checks',
  other: 'Other',
};

export const PLATFORM_LABEL = {
  'mac-arm64': 'macOS, Apple silicon',
  'mac-x64': 'macOS, Intel',
  mac: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
  other: 'Other',
};

export function classifyAsset(name) {
  const n = name.toLowerCase();
  const r = (kind, platform, format, label) => ({ kind, platform, format, label });

  if (n === 'latest-mac.yml') return r('check', 'mac', 'yml', 'Update manifest');
  if (n.startsWith('latest') && n.endsWith('.yml')) return r('check', 'other', 'yml', 'Update manifest');

  // Auto-update payloads: the signed app zips electron-updater downloads.
  if (/darwin-arm64-.*\.zip$/.test(n)) return r('update', 'mac-arm64', 'zip', 'Mac update, Apple silicon');
  if (/darwin-x64-.*\.zip$/.test(n)) return r('update', 'mac-x64', 'zip', 'Mac update, Intel');

  // CLI-only packages.
  if (/^biorouter-cli[_-].*\.deb$/.test(n)) return r('cli', 'linux', 'deb', 'CLI .deb');
  if (/^biorouter-cli-.*\.rpm$/.test(n)) return r('cli', 'linux', 'rpm', 'CLI .rpm');
  if (/headless.*linux.*\.tar\.gz$/.test(n)) return r('cli', 'linux', 'tar.gz', 'Headless tarball');
  if (/^biorouter-cli-macos-arm64$/.test(n)) return r('cli', 'mac-arm64', 'binary', 'CLI binary, Apple silicon');
  if (/^biorouter-cli/.test(n)) return r('cli', 'other', ext(n), 'CLI package');

  // Desktop installers.
  if (/-arm64\.dmg$/.test(n)) return r('install', 'mac-arm64', 'dmg', 'Mac installer, Apple silicon');
  if (/-x64\.dmg$/.test(n)) return r('install', 'mac-x64', 'dmg', 'Mac installer, Intel');
  if (n === 'biorouter.zip') return r('install', 'mac-arm64', 'zip', 'Mac app zip, Apple silicon');
  if (n === 'biorouter_intel_mac.zip') return r('install', 'mac-x64', 'zip', 'Mac app zip, Intel');
  if (/setup.*\.exe$/.test(n)) return r('install', 'windows', 'exe', 'Windows installer');
  if (/win32-x64-.*\.zip$/.test(n)) return r('install', 'windows', 'zip', 'Windows zip');
  if (/_amd64\.deb$/.test(n)) return r('install', 'linux', 'deb', 'Linux .deb');
  if (/\.x86_64\.rpm$/.test(n)) return r('install', 'linux', 'rpm', 'Linux .rpm');

  return r('other', 'other', ext(n), 'Other');
}

function ext(n) {
  const m = n.match(/\.([a-z0-9]+)$/);
  return m ? m[1] : 'file';
}

/** Compare two version tags numerically: v1.89.10 > v1.89.9. */
export function compareTags(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map((x) => (isNaN(+x) ? x : +x));
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map((x) => (isNaN(+x) ? x : +x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x).localeCompare(String(y));
  }
  return 0;
}
