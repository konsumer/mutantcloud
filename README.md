# mutant.cloud

Every firmware and tool for the M-VAVE FM1, SMK-37 and friends. It's self-serve: makers sign in with GitHub and manage their own listings. Nobody has to email anybody.

- **Site:** https://mutant.cloud
- **JSON:** https://mutant.cloud/firmware.json (everything, CORS on, same filters as the site's links)
- **Hub-format JSON:** https://mutant.cloud/catalog.json (The Firmware Hub's `catalog.json` shape with one row per verified package, which is what fm1buddy reads)
- **RSS:** https://mutant.cloud/feed.xml (every new listing and version, newest first, same filters; also at `/rss.xml`, `/feed` and `/rss`)

## Links

Every view of the list is a link, and filters combine:

- `/?author=konsumer&device=fm1`: FM1 firmware by konsumer (`author` is the GitHub login, or the name as a slug for makers without a repo, e.g. `baud-girl`)
- `/?device=smk37`: everything for the SMK-37
- `/?base=felucca&tag=drums`: drum firmware built on Felucca
- `/?kind=tool`, `/?kind=all`, `&q=search words`, `&sort=added`
- The site opens on FM1 firmware. `?device=all` shows every device.
- `/fomajam`: one listing's own page. Link previews (Reddit, Discord, Mastodon, X…) show its name, maker, description and picture (the owner's, else the maker's, else its screenshot), so makers can share it as theirs. **Copy link** on a listing gives this address; `/#/p/fomajam` still works too.
- IDs are only lowercase letters, digits and hyphens, and can't be any of the site's own paths (`RESERVED` in `src/entry.js`, enforced by the server whenever it picks an ID, and when it serves `/<id>`).

Authors, devices, tags and "built on" are clickable all over the site, and a filtered view shows **Copy link** and **Clear** buttons.

The JSON endpoints take the same filters, so the same query works for apps:

- `/firmware.json?author=konsumer&device=fm1`
- `/catalog.json?device=smk37`: only SMK-37 packages. The catalog filters per package, so a firmware's FM1 build isn't included.
- `/catalog.json?author=konsumer&device=fm1`
- `/feed.xml?device=smk37`: RSS of new SMK-37 firmware: a timeline with one item per version (pre-releases too) and per new listing (titled `New:`), with the version's first verified `.fwsc` as the enclosure. It defaults to `kind=firmware`; pass `kind=tool` or `kind=all` for tools. The site's **RSS** link follows its filters, and each listing's page advertises a feed of its maker's work.

One difference: the site opens on FM1 firmware, but the JSON returns every `kind` and every device unless you pass `kind=` or `device=`. Filtered responses echo the `filter` they used and have their own ETag. The matching rules live in `matches()` in `src/entry.js`, which both the worker and the site's links follow.

Other pages: `/#/make` (the "Make your own" guide for makers), `/#/new` (add a listing), `/#/mine` (your listings).

## How it works

```
other hubs + GitHub ──collect.js──▶ D1 "auto" column ┐
                                                     ├─▶ effective entry ─▶ /firmware.json + site
makers (GitHub login, CI action) ─▶ D1 "data" column ┘   (data wins over auto)
every version ever seen ─▶ D1 releases table (links to the makers' files)
```

- `scripts/collect.js` pulls [The Firmware Hub](https://thefirmwarehub.com/catalog.json), [FMDB](https://stanleygurvich.github.io/FMDB_FM1_FirmwareDatabase/feed.json) and [FM1 Editor](https://fm1-editor.com/firmware/) (the last one is scraped from HTML). It merges them by GitHub repo, following renamed repos, and pulls the full release history from GitHub. Output is `data/auto.sql`, which only ever writes the `auto` column and adds to `releases`. Hand edits are never overwritten.
- Entries without a repo (like Baud Girl) are merged across sources by website host and name.
- Every `.fwsc` in a latest release is checked the way fm1buddy checks it: sha256, size, and the device ID in the package header (`src/pkg.js` is a port of fm1buddy's `pkgHead`). GitHub supplies the sha256 (`digest`), so usually only the first 3 KB are fetched. Packages outside GitHub releases are found on the maker's own site (via FMDB) or committed in the repo (linked at that commit). Which devices a firmware supports is read from its packages too.
- There are no stars or download counts. Links go straight to the maker's files, so there's nothing reliable to count.
- Every entry has `added` (first seen anywhere) and `updated` (last release or commit), and every version has its own date, so people can judge how fresh or beta something is.
- `src/worker.js` is one Cloudflare Worker: API, GitHub OAuth, the OIDC publish endpoint, and static files from `public/`.
- `src/entry.js` holds the data model (devices, tags, bases, validation, permissions), shared by the worker and the collector.

### Tags

`TAGS` in `src/entry.js` is the suggested list (groovebox, synth, drums… for firmware; editor, installer, emulator… for tools). These are one click in the form and always in the filter bar. Makers can also add their own (up to 10 per listing, cleaned to lowercase slugs like `lo-fi`). Custom tags are searchable and work in links (`?tag=lo-fi`) right away, and join the site's filter bar once two or more listings use them, so one-offs don't clutter it.

Each listing has a **main tag** (`primaryTag`): the owner's pick, else the first tag its sources gave (the other hubs list their main category first). It leads on the card and in `tags`, and decides the order of `kind` in `/catalog.json`.

### Try it in the browser

Firmware the [FM-1 emulator](https://github.com/joakimeriksson/fm1-emu) (MIT) has in its own lists gets a **▶ Try** button. It opens `/#/try/<id>`, a popup with the emulator embedded (`?fw=<its id>&embed=1`), with FM1 and SMK-37 tabs when it has both. The site reads the emulator's lists live (`firmwares.json`, `smk37/firmwares.json`) and matches them to listings by repo, so firmware the emulator adds later gets the button with nobody doing anything. If the emulator's copy is older than the latest release, the popup says so.

Owners can turn it off ("▶ Try in the emulator" in the edit form, `"emulator": false` in the API) if they'd rather send people to their own website or demo; their own "Try it" link then shows instead.

The emulator can't load a firmware from a URL yet, only from its own lists. So firmware it doesn't have can't be tried here until it adds it (or gains a URL option).

### Device IDs

Every package carries a device ID (like `FM-1_745`): what the device reports, and how installers and apps tell which firmware is running. Listings show it ("Device ID", and next to each file), and it's searchable (`?q=FM-1_745`). When other listings use the same ID, the listing gets a muted note naming them, since those firmwares can't be told apart. Many Felucca forks share Felucca's `FM-1_900`, for example.

Existing collisions are makers' real released files, so they aren't blocked. New makers can pick a free ID first: the "Make your own" guide has a checker, backed by `GET /api/ids?check=FM-1_745`. It checks against every version of every listing, including old ones, and suggests free IDs nearby. It accepts `FM-1_745`, `fm-1 745`, plain `745` (FM-1), or the SMK-37 Pro / Elite and MKE-P37 forms.

### Built on

`BASE_INFO` in `src/entry.js` lists the firmwares others build on (Felucca, SLOOP, Dinghy, fm1-base, FOMA, Melodee, FoMni, X0X, M-VAVE stock), each with its repo. A repo created from one of them as a GitHub template, or forked from it, is marked "built on" it automatically on the next collect, using GitHub's own record of the template or fork. That lineage wins over what the other hubs say. Owners can also pick a base by hand in the edit form. Adding a line to `BASE_INFO` adds it to the detection, the form, the "Make your own" guide and the JSON's `bases`.

### Who can edit what

- **Adding a GitHub repo** needs push access to it, checked live with GitHub when you submit, so nobody can take over someone else's project. Private repos are refused.
- **Adding something without a repo** (closed firmware, M-VAVE's own builds) is open to anyone signed in. They have to tick "I made this, or have the maker's permission", and the listing shows "Listed by @them".
- **Managing a listing:** the repo's owner, anyone who can push to it, the listing's `managers`, and admins (`ADMINS` in `wrangler.jsonc`). The public `author` is separate from who manages it, so `konsumer` can manage Baud Girl while the site still credits "Baud Girl".
- **A listing's repo is fixed.** Managers can't repoint it, so a listing can't be moved to misrepresent its source. Renames and transfers on GitHub are followed by the sync automatically. Anything else is an admin change.
- **Admins can lock a listing** (🔒 Lock in its edit form). While it's locked, only admins can edit it, its versions or its visibility, and CI publishes are refused. Every change is in the audit log (`GET /api/entries/:id/history`).

Deleting an entry that only exists here removes it. Deleting a collected entry hides it instead, so the sync doesn't bring it back. Removing a version leaves a tombstone, for the same reason.

## For makers: update your listing from CI

Add `.github/workflows/mutant.yml` to your repo:

```yaml
name: mutant.cloud
on:
  release:
    types: [published]
permissions:
  id-token: write
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: konsumer/mutantcloud@main
        # first run only (if your repo isn't listed yet):
        # with:
        #   name: My Synth
        #   devices: fm1,smk37
```

No secrets are needed, on either side:

- The action gets a GitHub OIDC token (audience `mutant.cloud`) that proves which repo the run belongs to. The worker checks its signature against GitHub's keys.
- The worker then reads that repo's releases from GitHub itself, so nothing in the request body is trusted for GitHub-hosted files. It reads them with the run's own `github.token` (sent as `X-GitHub-Token`), which only covers that repo and expires with the job, so the hub stores no GitHub token of its own.
- If the repo isn't listed yet, the first publish lists it. Private repos are refused, and so are publishes to a locked listing.

Not on GitHub? Sign in and add versions by hand on the site (open your entry, then **Versions**).

## API

| Method | Path                                 | Who                 | What                                                                                                                |
| ------ | ------------------------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| GET    | `/firmware.json`                     | anyone              | everything (cached 5 min, ETag); filters: `device`, `kind`, `tag`, `author`, `base`, `q`                            |
| GET    | `/catalog.json`                      | anyone              | The Firmware Hub format: `firmwares[]` (`pkg` is a direct URL) + `stock`; same filters                              |
| GET    | `/feed.xml`                          | anyone              | RSS 2.0 timeline of new listings and versions (50 newest, ETag); same filters, `kind` defaults to `firmware`        |
| GET    | `/api/entries/:id`                   | anyone              | one entry plus `history` (all versions)                                                                             |
| GET    | `/dl/:id/:file`                      | anyone              | a package one of the listing's versions names, with CORS on, for browser apps (GitHub's downloads have no CORS)     |
| GET    | `/api/entries/:id/releases`          | anyone              | version history                                                                                                     |
| GET    | `/api/ids`                           | anyone              | every device ID in use and which listings use it; `?check=FM-1_745` says whether one is free and suggests free ones |
| GET    | `/api/me`                            | session             | you, plus entries you can manage                                                                                    |
| POST   | `/api/entries`                       | session             | add an entry; needs `"confirm": true`, and push access if it has a `repo`                                           |
| PATCH  | `/api/entries/:id`                   | manager             | edit (only the fields you send); `{"hidden": true}` hides it; `repo` and `{"locked": true}` are admin-only          |
| DELETE | `/api/entries/:id`                   | manager             | delete (user-added) or hide (collected)                                                                             |
| POST   | `/api/entries/:id/refresh`           | manager             | re-read the repo from GitHub now                                                                                    |
| POST   | `/api/entries/:id/releases`          | manager             | add a version `{version, date, url, assets: [{name, url}], prerelease}`                                             |
| DELETE | `/api/entries/:id/releases/:version` | manager             | remove a version                                                                                                    |
| GET    | `/api/entries/:id/history`           | manager             | audit log                                                                                                           |
| POST   | `/api/publish`                       | GitHub Actions OIDC | refresh from a release (see above)                                                                                  |
| POST   | `/api/admin/watch`                   | admin               | run the release watcher now (it runs by itself every 10 minutes)                                                    |

Writes from browsers must come from the same origin.

### Entry fields

Each item in `/firmware.json`'s `entries` (and `/api/entries/:id`):

| Field                                                  | What                                                                                                                        |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `id`                                                   | stable ID, used in `/#/p/:id`                                                                                               |
| `kind`                                                 | `firmware` or `tool`                                                                                                        |
| `name`, `author`, `authorUrl`                          | the public credit (the real maker, not necessarily who listed it)                                                           |
| `github`, `repo`                                       | the repo's owner and `owner/name`; follows renames and transfers                                                            |
| `description`, `tags`, `primaryTag`, `devices`, `base` | what it is (`tags` starts with the main tag), which devices it runs on (`fm1`, `smk37`), what it's built on (a `bases` key) |
| `homepage`, `links[]`                                  | `{label, url}`; an `Install` link becomes the main button                                                                   |
| `cover`, `coverIsScreen`, `screen`, `card`, `image`    | the card picture and where it came from (see Pictures)                                                                      |
| `release`, `prerelease`                                | latest `{version, date, url, assets[]}`; checked `.fwsc` assets have `sha256`, `size`, `product`                            |
| `versions`                                             | how many versions are kept (the full list is at `/api/entries/:id/releases`)                                                |
| `license`, `beta`, `archived`, `stock`, `hid`          | as named                                                                                                                    |
| `emulator`                                             | `false` when the owner turned off the ▶ Try button                                                                          |
| `added`, `updated`                                     | first seen anywhere, and the last release or commit                                                                         |
| `managers`, `listedBy`, `locked`                       | who can edit besides the repo's owner, who added it here, and the admin lock                                                |
| `sources`                                              | where it was collected from (`firmwarehub`, `fmdb`, `fm1-editor`, `user`, `action`)                                         |

The top level also has `devices`, `kinds`, `tags` and `bases` (`{key: {name, repo}}`), so clients can label things the same way the site does. `/catalog.json` rows follow The Firmware Hub's format, plus `entry` (the `id` above), `tags`, `primaryTag`, `devices`, `added`, `updated`, `versions` and `image`.

## Setup

Everything deploys from your machine. There's no CI.

```sh
npm i
npm run init
```

`init` is safe to run again; it skips whatever is already done. It:

1. logs in to Cloudflare (`wrangler login`)
2. creates the D1 database `mutantcloud` and the KV namespace `mutantcloud-sessions`, and writes their IDs into `wrangler.jsonc`
3. fills the database with everything the other hubs list, with GitHub details (an `npm run sync` on an empty database), then deploys
4. walks you through creating the GitHub OAuth app (callback `https://mutant.cloud/auth/callback`) and saves its ID and secret as Worker secrets
5. optionally writes `.dev.vars` so you can log in on `npm run start`, using a second OAuth app with callback `http://localhost:8787/auth/callback` (each GitHub OAuth app allows only one callback, so production and local need one each)

Commit `wrangler.jsonc` after `init`. The IDs in it aren't secret.

## Keeping it up to date

Mostly, it keeps itself up to date:

- **New versions arrive automatically.** A cron job in the worker (`triggers` in `wrangler.jsonc`, `watch()` in `src/worker.js`) checks 20 listed repos every 10 minutes, oldest-checked first, so every repo is seen every few hours. It reads each repo's public releases feed (`github.com/OWNER/REPO/releases.atom`): no API, no token, and a "nothing new" check is a cheap 304. Only a tag it hasn't seen costs more: that release's page and file list, plus a check of its `.fwsc` packages. Removed versions stay removed, and locked or hidden listings are skipped. Admins can run it now with `POST /api/admin/watch`.
- **Every `.fwsc` is checked when it arrives** (watcher, CI publish, a version added by hand, a new listing or a refresh): it must be a real FM-1/SMK-37 package, and its device ID, sha256 and size are recorded. Only files that pass go into `/catalog.json` for installers like fm1buddy. A file that isn't a package is marked `invalid`; one that couldn't be downloaded is marked `unchecked` and retried.
- **Downloads are re-checked later, too,** because makers can change a file without a new version. Each run re-checks some listings' current files (and their newest release, if that isn't the one shown), oldest first:
  - **Files on makers' own sites, and M-VAVE's:** a conditional request; an unchanged file costs a 304.
  - **GitHub release files:** checked in full once; after that, one request (no download) shows whether the file was re-uploaded under the same name, since its download link then points to a new stored file.
  - **Files whose check failed:** download errors are retried every pass; files that weren't valid packages, weekly.
  - **Files in a repo at a fixed commit** can't change, so they're skipped.
    A replaced file gets its sha256 updated (so installers work again) and a dated note. A missing or invalid file gets a muted "Might not install right now" warning on its card and in its details. When a listing's newest version doesn't check out, the site shows the latest one that does and says why.
- **Makers' CI publishes land instantly** (see "For makers" above), and makers can list themselves on the site.
- **New listings from the other hubs:** run `npm run sync` now and then. It only adds firmware that isn't listed yet, asks GitHub about just those, and writes straight to the database, so no deploy is needed. It says what it skipped and why (for example, a repo listed already under its new GitHub name). `npm run sync -- --full` re-reads everything the old way; you should rarely need it.

```sh
npm run deploy   # ship code changes: database migrations + the worker. No data collecting.
npm run sync     # add new listings from the other hubs
```

Sync uses `GITHUB_TOKEN` if it's set, otherwise your `gh auth token`, and only on your machine. The site's lists refresh within 5 minutes of a sync or a new version (the cache is keyed by deploy, so a deploy shows fresh lists right away).

### Pictures

Each card's picture is, in order:

1. the one the owner set on the site
2. the maker's own: the `image` in their repo's `fmhub.json` (the same file The Firmware Hub reads), else a picture from their repo or site (README image, GitHub social preview)
3. a screenshot of the firmware's own screen, from the FM-1 emulator

Screenshots come from [fm1-emu](https://github.com/joakimeriksson/fm1-emu) (MIT). `npm run shots` downloads its latest release into `.cache/`, boots each firmware's checked package headlessly for 8 emulated seconds, keeps the last screen that isn't blank (a blank one gets one longer try in the same run), and writes `public/shots/<id>.png` (240×240, scaled up with crisp pixels by CSS) plus `public/shots/index.json`. Commit them, then `npm run deploy`. A screenshot that failed shows as a muted note in the listing's details. A hash mismatch says installers will refuse the file until it's re-checked, and that note goes away by itself once the watcher has re-checked it. The worker reads the index straight from the deployed files, so nothing needs re-collecting.

```sh
npm run shots                    # only firmwares with no picture at all: not ones already shot, ones with the maker's picture, or ones that failed before
npm run shots -- --update        # also re-shoot ones whose package changed, and retry failures
npm run shots -- --only fomajam  # just these (comma-separated)
npm run shots -- --ms 12000      # run longer before the snapshot
FM1_EMU=~/src/fm1-emu/target/release/fm1-emu npm run shots   # your own build
```

### Share image

`public/og.png` (1200×630) is what link previews show. Its source is `design/poster.html`. Edit that, then run `npm run poster` (it needs Chrome; set `CHROME=` if it isn't found).

### Local server

```sh
npm run start
```

This runs the worker and site on http://localhost:8787 against the **real** D1 database and sessions (`"remote": true` in `wrangler.jsonc`). Edits you make there are live. To log in locally, let `init` write `.dev.vars` for a second OAuth app.

## fm1buddy

`/catalog.json` is a drop-in replacement for `https://thefirmwarehub.com/catalog.json`. Every `pkg` is a whole `https://` URL, which fm1buddy already handles for its SMK-37 list. SMK-37 and MKE-P37 packages are in the same list, each with its own `product`, so `tools/smk37.py` isn't needed against this hub. To switch, set `HUB_SITE` to `https://mutant.cloud/`.

## Adding a device

Add it to `DEVICES` in `src/entry.js`. Every list and form picks it up from there.

## Problems

Every listing has a **Report a problem with this listing** link. It opens a GitHub issue form (`.github/ISSUE_TEMPLATE/listing.yml`) with the listing filled in. The footer links to all the forms, including one for site bugs. Makers can fix most things themselves by signing in; the issues are for what they can't change (like the repo a listing points to), missing firmware, and bugs.

## License

MIT (see [LICENSE](LICENSE)) for the code here. The listings themselves belong to their makers: each firmware has its own license, shown on its listing. The screenshots come from [fm1-emu](https://github.com/joakimeriksson/fm1-emu) running each firmware.
