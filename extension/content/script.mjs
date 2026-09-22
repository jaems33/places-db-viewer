/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Columns holding a PRTime (microseconds since epoch) rather than a plain
// integer, keyed by table. These are rendered as dates with the raw value in
// a tooltip. Anything not listed is shown verbatim.
const DATE_COLUMNS = {
  moz_places: ["last_visit_date"],
  moz_historyvisits: ["visit_date"],
  moz_bookmarks: ["dateAdded", "lastModified"],
  moz_bookmarks_deleted: ["dateRemoved"],
};

// Columns stored in milliseconds rather than microseconds. moz_places_metadata
// timestamps are milliseconds: SQLFunctions.cpp selects `created_at * 1000 AS
// visit_date`, and visit_date is a microsecond PRTime.
const MILLISECOND_COLUMNS = {
  moz_places_metadata: ["created_at", "updated_at"],
  moz_icons: ["expire_ms"],
};

// moz_historyvisits.visit_type holds an nsINavHistoryService TRANSITION_*
// constant. The names mirror the interface so a value here can be matched
// against the IDL and against telemetry that reports the same numbers.
const VISIT_TYPES = {
  1: "LINK",
  2: "TYPED",
  3: "BOOKMARK",
  4: "EMBED",
  5: "REDIRECT_PERMANENT",
  6: "REDIRECT_TEMPORARY",
  7: "DOWNLOAD",
  8: "FRAMED_LINK",
  9: "RELOAD",
};

// moz_historyvisits.source holds an nsINavHistoryService VISIT_SOURCE_*
// constant. Frecency treats SPONSORED and SEARCHED as reasons to withhold the
// typed bonus, and BOOKMARKED as a reason to grant it.
const VISIT_SOURCES = {
  0: "ORGANIC",
  1: "SPONSORED",
  2: "BOOKMARKED",
  3: "SEARCHED",
};

// Columns holding an enum that is shown by name, keyed by table.
const ENUM_COLUMNS = {
  moz_historyvisits: { visit_type: VISIT_TYPES, source: VISIT_SOURCES },
};

const DEFAULT_TABLE = { schema: "main", name: "moz_places" };

const $ = id => document.getElementById(id);

let state = {
  tables: [],
  current: DEFAULT_TABLE,
  columns: [],
  blobColumns: new Set(),
  // Columns the API synthesised (resolved URLs and the like) rather than read
  // from the table. Marked in the header so the grid does not imply they are
  // stored.
  derivedColumns: new Set(),
  rows: [],
  orderBy: null,
  descending: false,
  total: null,
  // Index into state.rows of the row shown in the detail sidebar, or null.
  selected: null,
  // Result of getFrecencyBreakdown for the selected moz_places row, or null
  // when the selection is not a place or the query has not returned yet.
  frecency: null,
};

let filterTimer = null;
// Same guard as `requestId`, for the breakdown: selecting rows quickly must
// not let an earlier row's breakdown land under a later row's detail panel.
let frecencyRequestId = 0;
// Guards against out-of-order responses when the user switches tables or
// types quickly: only the newest request is allowed to render.
let requestId = 0;

function formatTime(value, divisor) {
  if (value === null || value === undefined || value === "") {
    return "";
  }
  const ms = Number(value) / divisor;
  if (!Number.isFinite(ms) || ms <= 0) {
    return String(value);
  }
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

/**
 * Produce the display form of a cell value, shared by the grid and the detail
 * sidebar so both render a column identically.
 *
 * Returns { text, raw, className }, where `raw` is the underlying stored value
 * when it differs from what is displayed (timestamps), and null otherwise.
 */
function formatValue(column, value) {
  if (value === null || value === undefined) {
    return { text: "NULL", raw: null, className: "null" };
  }

  const table = state.current.name;

  if (state.blobColumns.has(column)) {
    // The API replaces blob contents with their byte length.
    return { text: `<blob ${value} bytes>`, raw: null, className: "blob" };
  }

  if (DATE_COLUMNS[table]?.includes(column)) {
    return { text: formatTime(value, 1000), raw: String(value), className: "" };
  }

  if (MILLISECOND_COLUMNS[table]?.includes(column)) {
    return { text: formatTime(value, 1), raw: String(value), className: "" };
  }

  const names = ENUM_COLUMNS[table]?.[column];
  if (names) {
    // An unrecognised value is shown as-is rather than hidden behind a
    // placeholder: new transition types get added over time.
    const name = names[value];
    return name
      ? { text: name, raw: String(value), className: "" }
      : { text: String(value), raw: null, className: "" };
  }

  return { text: String(value), raw: null, className: "" };
}

function formatCell(td, column, value) {
  const { text, raw, className } = formatValue(column, value);
  // textContent, never innerHTML: page titles and URLs are attacker-controlled.
  td.textContent = text;
  if (className) {
    td.classList.add(className);
  }
  td.title = raw ?? text;
}

function renderTablePicker() {
  const select = $("table");
  select.textContent = "";
  for (const table of state.tables) {
    const option = document.createElement("option");
    option.value = `${table.schema}.${table.name}`;
    option.textContent = table.label;
    option.selected =
      table.schema === state.current.schema &&
      table.name === state.current.name;
    select.appendChild(option);
  }
}

function renderHeader() {
  const headerRow = $("headerRow");
  headerRow.textContent = "";

  for (const column of state.columns) {
    const th = document.createElement("th");
    th.textContent = column;
    if (state.derivedColumns.has(column)) {
      th.classList.add("derived");
      th.title = `${column} is derived by the viewer, not stored in this table`;
    }
    if (column === state.orderBy) {
      th.classList.add("sorted");
      th.dataset.direction = state.descending ? "desc" : "asc";
    }
    th.addEventListener("click", () => {
      // Sorting happens in SQL, so it covers the whole table rather than only
      // the rows fetched under the current limit.
      state.descending = state.orderBy === column ? !state.descending : false;
      state.orderBy = column;
      load();
    });
    headerRow.appendChild(th);
  }
}

function renderRows() {
  const tbody = $("rows");
  tbody.textContent = "";
  const fragment = document.createDocumentFragment();

  for (const [index, row] of state.rows.entries()) {
    const tr = document.createElement("tr");
    tr.tabIndex = 0;
    if (index === state.selected) {
      tr.classList.add("selected");
    }
    for (const column of state.columns) {
      const td = document.createElement("td");
      formatCell(td, column, row[column]);
      tr.appendChild(td);
    }
    tr.addEventListener("click", () => selectRow(index));
    tr.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectRow(index);
      }
    });
    fragment.appendChild(tr);
  }

  tbody.appendChild(fragment);
}

// Round for display without pretending to more precision than the number
// carries. Scores and decay factors are the interesting ones.
const round = (value, places = 2) =>
  value === null || value === undefined || !Number.isFinite(Number(value))
    ? "—"
    : String(Number(Number(value).toFixed(places)));

function enumName(names, value) {
  if (value === null || value === undefined) {
    return "—";
  }
  return names[value] ? `${names[value]} (${value})` : String(value);
}

/**
 * Explain, in the terms the SQL uses, why a sample got the weight it did.
 * The three tiers come from the CASE in calculate_frecency: a bookmark-ish or
 * typed visit gets high/veryHigh, an ordinary non-redirect visit gets
 * medium/high, and everything else gets low.
 */
function describeWeight(sample, prefs) {
  if (sample.isBookmarkFallback) {
    return "no visits; bookmark dateAdded used as the only sample";
  }

  const type = sample.effectiveVisitType;
  const reasons = [];

  if (type === 3) {
    reasons.push("visit came from a bookmark (type BOOKMARK)");
  } else if (sample.source === 2) {
    reasons.push("visit source is BOOKMARKED");
  } else if (type === 2 && sample.weight >= prefs.highWeight) {
    reasons.push("typed visit, not search/sponsored, not a redirect");
  } else if (sample.weight === prefs.lowWeight) {
    if (sample.isRedirectSource) {
      reasons.push("visit redirects onward, so it is a redirect hop");
    } else if ([4, 8, 9].includes(type)) {
      reasons.push(`visit type ${enumName(VISIT_TYPES, type)} is not credited`);
    } else if (sample.source === 1) {
      reasons.push("visit source is SPONSORED");
    } else {
      reasons.push("treated as a redirect");
    }
  } else {
    reasons.push("ordinary visit, not a redirect");
  }

  if (sample.isRedirectTarget) {
    reasons.push("redirect target, so the source visit's type was used");
  }
  if (sample.isInteresting) {
    reasons.push("interesting (enough view time or keypresses), so upgraded");
  }

  return reasons.join("; ");
}

function addDetailRow(fragment, label, value, extra) {
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = value;
  if (extra) {
    const note = document.createElement("span");
    note.className = "raw";
    note.textContent = extra;
    dd.appendChild(note);
  }
  fragment.appendChild(dt);
  fragment.appendChild(dd);
}

/**
 * Render the frecency breakdown for a moz_places row: one line per sampled
 * visit showing its weight and decay, then the aggregation that turns those
 * scores into the stored integer.
 *
 * The stored value is not the score itself. calculate_frecency stores
 * `reference.days + ln(mean_score * count_multiplier) / lambda`, which is the
 * day number on which the decaying score would fall to 1 — that is why
 * frecency is a five-digit number that creeps upward over time rather than a
 * raw score, and why comparing two pages only means anything on the same day.
 */
function renderFrecency(container) {
  container.textContent = "";
  const data = state.frecency;
  if (!data) {
    return;
  }

  const section = document.createElement("section");
  section.className = "frecency";

  const heading = document.createElement("h3");
  heading.textContent = "Frecency breakdown";
  section.appendChild(heading);

  if (data.pending || data.error) {
    const note = document.createElement("p");
    note.className = "frecency-note";
    note.textContent = data.error ?? "Computing…";
    section.appendChild(note);
    container.appendChild(section);
    return;
  }

  const { prefs } = data;

  const summary = document.createElement("dl");
  summary.className = "frecency-summary";

  if (data.isPlaceUri) {
    addDetailRow(
      summary,
      "place: URI",
      "0",
      "calculate_frecency returns 0 for place: URIs before any sampling"
    );
  }

  addDetailRow(
    summary,
    "stored frecency",
    String(data.storedFrecency),
    data.recalcFrecency
      ? "recalc_frecency is set: the stored value is stale and pending recalculation"
      : null
  );

  // Recomputing here can disagree with the stored value when visits have been
  // recorded since the last recalculation, which is worth seeing rather than
  // hiding.
  addDetailRow(
    summary,
    "recomputed now",
    String(data.computedFrecency ?? "—"),
    data.computedFrecency !== data.storedFrecency
      ? "differs from the stored value"
      : null
  );

  section.appendChild(summary);

  if (!data.samples.length) {
    const note = document.createElement("p");
    note.className = "frecency-note";
    note.textContent =
      "No sampled visits and no bookmark, so there is nothing to score.";
    section.appendChild(note);
    container.appendChild(section);
    return;
  }

  // Per-sample table: the weight column is the CASE result, decay is
  // exp(-lambda * age), and score is their product.
  const table = document.createElement("table");
  table.className = "frecency-samples";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of [
    "visit date",
    "type",
    "source",
    "weight",
    "age (d)",
    "decay",
    "score",
  ]) {
    const th = document.createElement("th");
    th.textContent = label;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const sample of data.samples) {
    const tr = document.createElement("tr");
    // The weight rule is long, so it lives in the row tooltip rather than a
    // column of its own.
    tr.title = describeWeight(sample, prefs);

    const cells = [
      formatTime(sample.visitDate, 1000),
      sample.isBookmarkFallback
        ? "BOOKMARK dateAdded"
        : enumName(VISIT_TYPES, sample.effectiveVisitType),
      sample.isBookmarkFallback ? "—" : enumName(VISIT_SOURCES, sample.source),
      String(sample.weight),
      round(sample.ageDays, 0),
      round(sample.decay, 3),
      round(sample.score),
    ];
    for (const [i, text] of cells.entries()) {
      const td = document.createElement("td");
      td.textContent = text;
      if (i >= 3) {
        td.classList.add("num");
      }
      tr.appendChild(td);
    }

    if (sample.isInteresting) {
      tr.classList.add("interesting");
    }
    if (sample.visitId === null && !sample.isBookmarkFallback) {
      // A virtual visit: an interaction with no matching moz_historyvisits row.
      tr.classList.add("virtual");
    }

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  section.appendChild(table);

  const meanScore = data.samplesCount ? data.scoreSum / data.samplesCount : 0;
  const scaled = meanScore * data.countMultiplier;

  const math = document.createElement("dl");
  math.className = "frecency-summary";

  addDetailRow(
    math,
    "sum of scores",
    round(data.scoreSum),
    `over ${data.samplesCount} sample${data.samplesCount === 1 ? "" : "s"}`
  );
  addDetailRow(math, "mean score", round(meanScore), "sum / samples_count");
  addDetailRow(
    math,
    "count multiplier",
    String(data.countMultiplier),
    `MAX(visit_count ${data.visitCount}, samples_count ${data.samplesCount})`
  );
  addDetailRow(
    math,
    "scaled score",
    round(scaled),
    "mean score × count multiplier"
  );
  addDetailRow(
    math,
    "half-life",
    `${prefs.halfLifeDays} days`,
    `lambda = ln(2) / ${prefs.halfLifeDays} = ${round(data.lambda, 5)}`
  );
  addDetailRow(
    math,
    "reference day",
    String(data.referenceDays),
    `${formatTime(data.referenceDays * 86400000000, 1000)} — the newest sample, which everything decays toward`
  );
  addDetailRow(
    math,
    "frecency",
    String(data.computedFrecency ?? "—"),
    `reference_days + ln(${round(scaled)}) / lambda — the day the score decays to 1, not the score itself`
  );

  section.appendChild(math);

  const weights = document.createElement("p");
  weights.className = "frecency-note";
  weights.textContent =
    `Weights: low ${prefs.lowWeight}, medium ${prefs.mediumWeight}, ` +
    `high ${prefs.highWeight}, veryHigh ${prefs.veryHighWeight}. ` +
    `Sampling the ${prefs.numSampledVisits} most recent visits. ` +
    `A visit counts as interesting at ${prefs.viewTimeSeconds}s of view time, ` +
    `or ${prefs.viewTimeIfManyKeypressesSeconds}s with ${prefs.manyKeypresses}+ keypresses.`;
  section.appendChild(weights);

  container.appendChild(section);
}

/**
 * Fetch the breakdown for the selected moz_places row and re-render the panel
 * when it lands. Other tables have no frecency, so nothing is requested.
 */
async function loadFrecency(row) {
  const id = ++frecencyRequestId;
  state.frecency = null;

  if (state.current.name !== "moz_places" || typeof row?.id !== "number") {
    return;
  }

  state.frecency = { pending: true };

  try {
    const data = await browser.experiments.places.getFrecencyBreakdown({
      pageId: row.id,
    });
    if (id !== frecencyRequestId) {
      return;
    }
    state.frecency = data;
  } catch (e) {
    if (id !== frecencyRequestId) {
      return;
    }
    state.frecency = { error: `Could not compute breakdown: ${e.message}` };
    console.error(e);
  }

  renderFrecency($("frecency"));
}

/**
 * Render every column of the selected row into the sidebar. Unlike the grid,
 * nothing here is truncated: values wrap, which is the point of the panel for
 * wide tables such as moz_places.
 */
function renderDetails() {
  const panel = $("details");
  const body = $("detailsBody");
  body.textContent = "";

  if (state.selected === null || !state.rows[state.selected]) {
    panel.hidden = true;
    $("frecency").textContent = "";
    return;
  }

  const row = state.rows[state.selected];
  const fragment = document.createDocumentFragment();

  for (const column of state.columns) {
    const dt = document.createElement("dt");
    dt.textContent = column;

    const dd = document.createElement("dd");
    const { text, raw, className } = formatValue(column, row[column]);
    // textContent, never innerHTML: values are attacker-controlled.
    dd.textContent = text;
    if (className) {
      dd.classList.add(className);
    }

    // For timestamps, show the stored value underneath the readable form so
    // the panel does not hide what is actually in the database.
    if (raw !== null && raw !== text) {
      const rawLine = document.createElement("span");
      rawLine.className = "raw";
      rawLine.textContent = raw;
      dd.appendChild(rawLine);
    }

    fragment.appendChild(dt);
    fragment.appendChild(dd);
  }

  body.appendChild(fragment);
  renderFrecency($("frecency"));
  panel.hidden = false;
}

function selectRow(index) {
  state.selected = index;
  // Update only the selection styling rather than rebuilding every row.
  for (const [i, tr] of [...$("rows").children].entries()) {
    tr.classList.toggle("selected", i === index);
  }
  // Kick off the breakdown first so renderDetails paints the pending state,
  // then let it repaint when the query returns.
  loadFrecency(state.rows[index]);
  renderDetails();
}

function clearSelection() {
  state.selected = null;
  // Invalidate any in-flight breakdown so it cannot render into a closed panel.
  frecencyRequestId++;
  state.frecency = null;
  for (const tr of $("rows").children) {
    tr.classList.remove("selected");
  }
  renderDetails();
}

function renderStatus() {
  const shown = state.rows.length;
  let text = `${shown} row${shown === 1 ? "" : "s"}`;
  if (state.total !== null && shown < state.total) {
    text += ` of ${state.total}`;
  }
  $("status").textContent = text;
}

async function load() {
  const id = ++requestId;
  $("status").textContent = "Loading…";

  try {
    const result = await browser.experiments.places.getRows({
      schema: state.current.schema,
      table: state.current.name,
      limit: Number($("limit").value),
      orderBy: state.orderBy ?? undefined,
      descending: state.descending,
      filter: $("filter").value.trim(),
    });

    if (id !== requestId) {
      return;
    }

    state.columns = result.columns;
    state.blobColumns = new Set(result.blobColumns);
    state.derivedColumns = new Set(result.derivedColumns ?? []);
    state.rows = result.rows;
    state.total = result.total;
    // Row indices refer to different records after a sort, filter or table
    // change, so a carried-over selection would point at the wrong row.
    state.selected = null;
    frecencyRequestId++;
    state.frecency = null;

    $("title").textContent = state.current.label ?? state.current.name;
    renderHeader();
    renderRows();
    renderDetails();
    renderStatus();
  } catch (e) {
    if (id !== requestId) {
      return;
    }
    $("status").textContent = `Query failed: ${e.message}`;
    console.error(e);
  }
}

async function init() {
  try {
    state.tables = await browser.experiments.places.getTables();
  } catch (e) {
    $("status").textContent = `Could not list tables: ${e.message}`;
    console.error(e);
    return;
  }

  // Prefer moz_places, but fall back to whatever exists: the set of tables
  // varies between profiles.
  const preferred = state.tables.find(
    t => t.schema === DEFAULT_TABLE.schema && t.name === DEFAULT_TABLE.name
  );
  state.current = preferred ?? state.tables[0];

  if (!state.current) {
    $("status").textContent = "No tables found.";
    return;
  }

  renderTablePicker();
  load();
}

$("table").addEventListener("change", event => {
  const [schema, ...rest] = event.target.value.split(".");
  const name = rest.join(".");
  state.current = state.tables.find(
    t => t.schema === schema && t.name === name
  );
  // Column names differ per table, so a sort column carried over from the
  // previous table would be rejected by the API.
  state.orderBy = null;
  state.descending = false;
  load();
});

$("closeDetails").addEventListener("click", clearSelection);

document.addEventListener("keydown", event => {
  if (event.key === "Escape" && state.selected !== null) {
    clearSelection();
  }
});

$("reload").addEventListener("click", load);
$("limit").addEventListener("change", load);
$("filter").addEventListener("input", () => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(load, 200);
});

init();
