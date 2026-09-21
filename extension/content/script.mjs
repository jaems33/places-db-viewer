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

// Columns holding an enum that is shown by name, keyed by table.
const ENUM_COLUMNS = {
  moz_historyvisits: { visit_type: VISIT_TYPES },
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
};

let filterTimer = null;
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
  panel.hidden = false;
}

function selectRow(index) {
  state.selected = index;
  // Update only the selection styling rather than rebuilding every row.
  for (const [i, tr] of [...$("rows").children].entries()) {
    tr.classList.toggle("selected", i === index);
  }
  renderDetails();
}

function clearSelection() {
  state.selected = null;
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
