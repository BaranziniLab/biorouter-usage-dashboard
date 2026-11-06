# Biorouter usage dashboard

A live dashboard of Biorouter downloads from GitHub releases, published at
**https://baranzinilab.github.io/biorouter-usage-dashboard/**.

It counts every file on every release of
[BaranziniLab/biorouter](https://github.com/BaranziniLab/biorouter), and the release
downloads of the skills, extensions and workflows listed in the BAAM marketplace.

## What it shows

| Section | Contents |
| --- | --- |
| Overview | All time downloads split into new installs, Mac auto-updates and CLI packages; update checks; the latest release; data served; a calendar of downloads by day |
| Activity | Downloads per day and update checks per day for 30 days, 90 days or all time; the latest release since it shipped |
| Platforms and files | Downloads by platform and by file type; the Mac chip, Linux package and Windows package people choose |
| Releases | Downloads for each version, days it was the newest release, and downloads per day while it was |
| Every asset | A searchable, sortable table of every release file |
| Repository traffic | Page views, clones, referring sites and popular pages on github.com; stars and forks over time |
| BAAM ecosystem | Downloads of each skill and extension |

## How the numbers are counted

GitHub reports one running total per release file and keeps no daily history.

1. Once a day, a GitHub Actions workflow reads every total and stores how much each one
   rose since the previous run (`data/events.jsonl`). Those rises are the measured days.
2. Days before measuring began are estimated. The totals that already existed are spread
   evenly across the days each release was the newest one, because the download page and
   the updater both point at the newest release. Estimated days are hatched in the charts.
3. Between daily runs, the page reads the release totals from the GitHub API in the
   visitor's browser every five minutes and adds what changed, so the main numbers stay
   live.

What each file counts as:

| Kind | Files | Meaning |
| --- | --- | --- |
| New installs | `.dmg`, Windows `Setup.exe` and zip, Linux `.deb` and `.rpm` | A person downloaded the desktop app. Windows also downloads its installer to update, so some Windows updates count here. |
| Auto-updates | `Biorouter-darwin-*.zip` | A Mac app updated itself. |
| CLI packages | `biorouter-cli` `.deb` and `.rpm`, the old headless tarball and CLI binary | A terminal only install. |
| Update checks | `latest-mac.yml` | A running Mac app checked for updates. Apps check at launch and every 3 hours, so this tracks how much the Mac app is in use. These are not counted as downloads. |

Draft releases are left out.

## Files

| Path | Purpose |
| --- | --- |
| `public/` | The site: `index.html`, `styles.css`, `app.js`, `charts.js`, `classify.js` |
| `scripts/collect.mjs` | Collects once and writes `public/data/dashboard.json` |
| `scripts/preview.mjs` | Serves `public/` on http://127.0.0.1:4747 |
| `lib/` | GitHub client, collection, history store and aggregation |
| `data/` | The stored history, committed by the workflow |
| `.github/workflows/daily.yml` | Runs the collector at 01:23 UTC and publishes to GitHub Pages |

## Run it locally

Needs Node 18 or later and no packages. The collector uses `GITHUB_TOKEN`, `GH_TOKEN`
or a signed in `gh` CLI.

```bash
node scripts/collect.mjs
node scripts/preview.mjs
```

`node scripts/collect.mjs --build` rebuilds the site data from `data/` without calling
GitHub.

## Repository traffic

GitHub only shows traffic (views, clones, referrers) to people with push access to
BaranziniLab/biorouter, so the workflow's own token cannot read it. To keep the traffic
history growing, add a fine grained personal access token for BaranziniLab/biorouter with
**Administration: Read** permission as the repository secret `TRAFFIC_TOKEN`. Without
it, everything else still updates and the traffic panels keep the history collected so
far.

## Design

The page follows the Biorouter design language: the Parchment theme tokens, Arial, the
coral accent, flat filled cards with no outlines, and the app's usage heatmap. It
supports light and dark mode. Chart colors were checked for color vision deficiency and
contrast on both grounds.
