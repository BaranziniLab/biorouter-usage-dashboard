# Biorouter usage dashboard

A live dashboard of Biorouter downloads from GitHub releases, published at
**https://baranzinilab.github.io/biorouter-usage-dashboard/**.

This is an internal tracking page. It is not linked from the Biorouter website and asks
search engines not to index it; keep it that way.

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
4. A file that leaves its release keeps counting. Replacing a release file
   (`gh release upload --clobber`) deletes it and uploads a new one with a new id and a
   count of 0, and GitHub keeps no trace of the old one. The collector notices a file
   that was on a published release in the previous run and is gone from a repository it
   read in full, keeps its last count in `data/state.json` (`retired`), and keeps adding
   it and its measured days to the release, skill, extension or workflow it belonged to.
   A skill the registry stops listing keeps the name and category it was listed with.

What each file counts as:

| Kind | Files | Meaning |
| --- | --- | --- |
| New installs | `.dmg`, Windows `Setup.exe` and zip, Linux `.deb` and `.rpm` | A person downloaded the desktop app. Windows also downloads its installer to update, so some Windows updates count here. |
| Auto-updates | `Biorouter-darwin-*.zip` | A Mac app updated itself. |
| CLI packages | `biorouter-cli` `.deb` and `.rpm`, the old headless tarball and CLI binary | A terminal only install. |
| Update checks | `latest-mac.yml` | A running Mac app checked for updates. Apps check at launch and every 3 hours, so this tracks how much the Mac app is in use. These are not counted as downloads. |

Draft releases are left out.

## Before replacing release files

The collector only sees a file's count once a day, so downloads a file gets between the
last run and its replacement would be lost. Read the counts just before replacing files
and pass them to a manual run, which folds them in before it collects:

```bash
gh api repos/BaranziniLab/biorouter-skills/releases --paginate \
  --jq '.[] | .tag_name as $t | .assets[] | [$t, .id, .name, .download_count] | @tsv' > counts.tsv
# ... replace the files ...
gh workflow run daily.yml -R BaranziniLab/biorouter-usage-dashboard -f snapshot="$(cat counts.tsv)"
```

Each line is tag, asset id, file name and count, tab separated, with an optional fifth
column for the ISO time it was read (otherwise `snapshot_at`, otherwise the run time).
`snapshot_repo` names the repository for a snapshot of anything other than
BaranziniLab/biorouter-skills. Folding the same snapshot twice, or an older one, changes
nothing. Locally: `node scripts/collect.mjs --snapshot counts.tsv`.

## Files

| Path | Purpose |
| --- | --- |
| `public/` | The site: `index.html`, `styles.css`, `app.js`, `charts.js`, `classify.js` |
| `scripts/collect.mjs` | Collects once and writes `public/data/dashboard.json` |
| `scripts/preview.mjs` | Serves `public/` on http://127.0.0.1:4747 |
| `lib/` | GitHub client, collection, history store and aggregation |
| `test/` | `npm test`: the history rules on fixtures, and a dry run over a copy of `data/` that replaces every ecosystem file |
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
GitHub. `npm test` runs the tests (no network); the workflow runs them before every
collection.

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
