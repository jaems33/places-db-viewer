# Places DB Viewer

A debugging WebExtension for inspecting the contents of `places.sqlite` from
inside Firefox. It uses a privileged `experiment_apis` experiment to run real
SQL against the live Places connection. Every table is browsable, and every
column is visible — including `moz_places.frecency`, `hidden`, and `guid`,
none of which the public `browser.history` API exposes.

Not published to addons.mozilla.org. See **Install** below.

## Install

### Temporary install (Nightly / DevEdition)

This is the supported path today.

1. Open Nightly or Developer Edition
2. Go to `about:config` and set **`extensions.experiments.enabled`** to `true`
   (see below — this step is required, and the add-on will refuse to install
   without it)
3. Go to `about:debugging#/runtime/this-firefox`
4. **Load Temporary Add-on…** → select `extension/manifest.json`
5. Click the toolbar button to open the viewer in a tab

### Why `extensions.experiments.enabled` is needed

Being on Nightly is necessary but *not* sufficient. The pref has two competing
defaults in the tree, and the Firefox-specific one wins:

| Defaults file | Value |
| --- | --- |
| `modules/libpref/init/all.js:3110` | `true` (Gecko-wide) |
| `browser/app/profile/firefox.js:2873` | `false` (**Firefox overrides**) |

So it ships **off** in Nightly and has to be turned on by hand.

What the channel check controls is only whether the pref is *consultable* at
all (`toolkit/mozapps/extensions/internal/AddonSettings.sys.mjs`):

```js
if (
  !AppConstants.MOZ_REQUIRE_SIGNING ||
  AppConstants.NIGHTLY_BUILD ||
  AppConstants.MOZ_DEV_EDITION ||
  Cu.isInAutomation
) {
  XPCOMUtils.defineLazyPreferenceGetter(
    AddonSettings, "EXPERIMENTS_ENABLED", PREF_ALLOW_EXPERIMENTS, true
  );
} else {
  makeConstant("EXPERIMENTS_ENABLED", false);   // official releases ignore the pref
}
```

On Nightly/DevEdition the pref is read; on Release it is hardcoded to `false`
and flipping it does nothing. Per the comment in that file, the pref toggles
exactly the two things this add-on depends on: loading an unprivileged
extension containing an experimental API, and letting a temporarily-loaded
unsigned extension gain privilege.

`EXPERIMENTS_ENABLED` then feeds the last clause of
`ExtensionData.getIsPrivileged` in `toolkit/components/extensions/Extension.sys.mjs`:

```js
static getIsPrivileged({ signedState, builtIn, temporarilyInstalled }) {
  return (
    signedState === lazy.AddonManager.SIGNEDSTATE_PRIVILEGED ||
    signedState === lazy.AddonManager.SIGNEDSTATE_SYSTEM ||
    builtIn ||
    (lazy.AddonSettings.EXPERIMENTS_ENABLED && temporarilyInstalled)
  );
}
```

The add-on is removed on restart. The pref persists in the profile, so step 2
is only needed once per profile.

> If the pref is off, installing fails with
> `Using 'experiment_apis' requires a privileged add-on.` — the hard-error
> branch of the `manifest.experiment_apis` block in `Extension.sys.mjs`. The
> error links to
> [Adding experimental APIs in privileged extensions](https://firefox-source-docs.mozilla.org/toolkit/components/extensions/webextensions/basics.html#adding-experimental-apis-in-privileged-extensions).
>
> On Release or Beta the same error appears and **no pref fixes it**, because
> `EXPERIMENTS_ENABLED` is a hardcoded `false` there. Release needs a
> privileged signature instead — see below.

### Distributing to QA on Release

Release needs a **privileged signature** (`SIGNEDSTATE_PRIVILEGED`), which
means going through Mozilla's add-on signing pipeline rather than just building
an `.xpi` locally. The pattern to copy is
[searchengine-devtools](https://github.com/mozilla-extensions/searchengine-devtools):

- the repo lives under the `mozilla-extensions` org
- `.taskcluster.yml` sets `xpiSigningType: "privileged"`
- releases publish a signed `.xpi` users install directly

That is an infrastructure/sign-off step, not a code change. Until then, QA
needs to be on Nightly or DevEdition **with
`extensions.experiments.enabled` flipped to `true`** — worth noting when
handing this to people, since it is a manual `about:config` step and the
failure mode is an install error rather than anything obviously
pref-related.

## What it shows

A dropdown lists every table and view in the Places database, and the grid
shows all columns of whichever one is selected.

Both the table list and the column list are read from the live database at
runtime rather than hardcoded, because the Places schema is not stable —
`PlacesUtils.sys.mjs` warns:

> Keep in mind the Places DB schema is by no means frozen or even stable.
> Your custom queries can - and will - break overtime.

That is not theoretical. A profile used while building this returned 16
columns for `moz_places` rather than the 19 in the current tree, and still
carried `moz_places_metadata_snapshots*` tables that have since been dropped.
Reading from the database means old and new profiles both just work.

### Favicon tables

Favicons live in a separate `favicons.sqlite`, which Places attaches to the
same connection as the `favicons` schema (`Database.cpp`, `AttachDatabase`).
So `moz_icons`, `moz_icons_to_pages`, and `moz_pages_w_icons` are not in
`main`; they appear in the dropdown prefixed as `favicons.moz_icons` and are
queried as such. Attached schemas are discovered via `pragma_database_list`,
so anything Places attaches in future shows up on its own.

### Timestamps

Places mixes time units, so columns are converted per table:

| Unit | Columns |
| --- | --- |
| Microseconds (PRTime) | `moz_places.last_visit_date`, `moz_historyvisits.visit_date`, `moz_bookmarks.dateAdded` / `.lastModified`, `moz_bookmarks_deleted.dateRemoved` |
| Milliseconds | `moz_places_metadata.created_at` / `.updated_at`, `moz_icons.expire_ms` |

The metadata columns really are milliseconds despite sitting next to
microsecond columns: `SQLFunctions.cpp` selects `created_at * 1000 AS
visit_date`, and `visit_date` is a PRTime. Hovering any timestamp shows the
raw stored value.

### Row detail sidebar

Wide tables such as `moz_places` truncate badly in a grid. Clicking a row (or
focusing it and pressing Enter/Space) opens a sidebar listing every column of
that row in full, with values wrapped rather than clipped. Close it with the
✕ button or Esc.

Timestamps show the readable form with the raw stored value underneath, so the
panel never hides what is actually in the database. The grid and the sidebar
share one formatting function, so a column renders identically in both.

The selection clears whenever the underlying rows change — sorting, filtering,
changing the limit, reloading, or switching tables — because row positions
refer to different records afterwards.

### BLOBs

`moz_icons.data` holds raw image bytes. Blob columns are detected by their
declared type and replaced with a byte count (`<blob 462 bytes>`) rather than
being copied into the extension process, and they are excluded from filtering.

Sorting and filtering are pushed into SQL, so they apply to the whole table
rather than only the rows currently fetched under the row limit. Filtering
matches against every non-blob column of the selected table.

## Layout

    extension/
      manifest.json                    experiment_apis registration
      background.js                    opens the viewer tab
      content/                         the viewer UI
      experiments/places/
        schema.json                    getTables / getRows
        api.js                         privileged code, runs the SQL

`api.js` runs with full chrome privileges and talks to the database through
`PlacesUtils.promiseDBConnection`, Places' shared read-only clone of its
connection. Places owns that connection and closes it at shutdown.

## Safety notes

- The add-on only ever issues `SELECT` and `PRAGMA` statements, and runs them
  on a read-only connection, so SQLite itself rejects any write.
- Table and column names cannot be bound as SQL parameters, so every
  identifier is validated against the live database before being interpolated:
  the schema/table pair must match a row from `sqlite_master`, and `orderBy`
  must match a column from `pragma_table_info`.
- The user-supplied filter is bound as a parameter, with `LIKE` wildcards
  escaped so a literal `%` or `_` is matched literally.
- The UI builds cells with `textContent`, never `innerHTML`: page titles and
  URLs are attacker-controlled content.
- The manifest's content security policy restricts the viewer page and
  background script to the add-on's own files and forbids every network
  connection (`connect-src 'none'`), so they cannot send data anywhere. CSP
  does not apply to `api.js`, which runs with chrome privileges; it is the one
  file to audit for what the add-on can reach, and it imports nothing beyond
  `PlacesUtils` and touches nothing but the database and `Services.prefs`
  reads.

## Other options

For one-off queries with no add-on at all, run SQL directly in the Browser
Toolbox console:

```js
await PlacesUtils.withConnectionWrapper("scratch", db =>
  db.execute("SELECT id, url, frecency FROM moz_places ORDER BY frecency DESC LIMIT 10")
).then(rows => rows.map(r => r.getResultByName("url")));
```

To inspect a profile outside the browser, copy `places.sqlite` first (the live
file is locked and WAL-backed) and open the copy with `sqlite3`.
