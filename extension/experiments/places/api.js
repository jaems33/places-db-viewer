/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* global ExtensionAPI, Services */

let PlacesUtils;

// Support pre and post moz-src URLs, following the same pattern as
// searchengine-devtools: these modules move between resource:// and moz-src://
// across versions.
try {
  ({ PlacesUtils } = ChromeUtils.importESModule(
    "resource://gre/modules/PlacesUtils.sys.mjs"
  ));
} catch {
  ({ PlacesUtils } = ChromeUtils.importESModule(
    "moz-src:///toolkit/components/places/PlacesUtils.sys.mjs"
  ));
}

const { ExtensionUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionUtils.sys.mjs"
);

const DEFAULT_LIMIT = 1000;

// The parameters calculate_frecency binds from StaticPrefs, with the same
// defaults as StaticPrefList.yaml. They are `mirror: once`, so the running
// browser is using the value read at startup; Services.prefs is the closest we
// can get to that from here, and it agrees unless someone changed a pref
// mid-session.
const FRECENCY_PREFS = {
  halfLifeDays: ["places.frecency.pages.halfLifeDays", 30],
  numSampledVisits: ["places.frecency.pages.numSampledVisits", 10],
  lowWeight: ["places.frecency.pages.lowWeight", 20],
  mediumWeight: ["places.frecency.pages.mediumWeight", 50],
  highWeight: ["places.frecency.pages.highWeight", 100],
  veryHighWeight: ["places.frecency.pages.veryHighWeight", 200],
  maxVisitGapSeconds: [
    "places.frecency.pages.interactions.maxVisitGapSeconds",
    120,
  ],
  viewTimeSeconds: ["places.frecency.pages.interactions.viewTimeSeconds", 60],
  manyKeypresses: ["places.frecency.pages.interactions.manyKeypresses", 50],
  viewTimeIfManyKeypressesSeconds: [
    "places.frecency.pages.interactions.viewTimeIfManyKeypressesSeconds",
    20,
  ],
};

const readFrecencyPrefs = () =>
  Object.fromEntries(
    Object.entries(FRECENCY_PREFS).map(([name, [pref, fallback]]) => [
      name,
      Services.prefs.getIntPref(pref, fallback),
    ])
  );

// BLOB columns are identified by their declared type rather than by name.
// Their contents are summarised as a byte length rather than returned, so the
// viewer does not move megabytes of icon payload across the process boundary
// per row. In current profiles the only such column is moz_icons.data.
const isBlob = column => column.type === "BLOB";

// Extra read-only columns appended to a table's real ones, for tables whose
// raw rows are hard to read on their own. Each entry supplies the JOINs it
// needs and a SELECT expression per derived column; both are constants here,
// never caller input, so they are interpolated directly.
const DERIVED_COLUMNS = {
  // moz_historyvisits stores two moz_places ids and nothing else identifying,
  // so a visit row cannot be read without cross-referencing another table.
  "main.moz_historyvisits": {
    joins: `LEFT JOIN "main"."moz_places" AS derived_place
              ON derived_place.id = "main"."moz_historyvisits".place_id
            LEFT JOIN "main"."moz_historyvisits" AS derived_from
              ON derived_from.id = "main"."moz_historyvisits".from_visit
            LEFT JOIN "main"."moz_places" AS derived_from_place
              ON derived_from_place.id = derived_from.place_id`,
    columns: {
      place_url: "derived_place.url",
      // from_visit is a visit id, not a place id, so resolving it to a URL
      // goes through moz_historyvisits first. A value of 0 means "no
      // referring visit" and matches no row, yielding NULL.
      from_visit_url: "derived_from_place.url",
    },
  },
  // moz_inputhistory pairs what was typed with a moz_places id, so without
  // the page it is unclear what a given input led to.
  "main.moz_inputhistory": {
    joins: `LEFT JOIN "main"."moz_places" AS derived_place
              ON derived_place.id = "main"."moz_inputhistory".place_id`,
    columns: {
      place_url: "derived_place.url",
      place_title: "derived_place.title",
    },
  },
};

const derivedFor = resolved =>
  DERIVED_COLUMNS[`${resolved.schema}.${resolved.name}`] ?? null;

// Every query goes through Places' read-only clone of its connection, so the
// viewer cannot modify the database even by mistake: SQLite rejects any write
// on it. mozStorage re-attaches the original's databases when cloning, so the
// `favicons` schema is available here too.
async function withDb(task) {
  const db = await PlacesUtils.promiseDBConnection();
  return task(db);
}

/**
 * Enumerate tables across every attached schema.
 *
 * Favicons live in a separate icons.sqlite that Places attaches as `favicons`
 * (Database.cpp, AttachDatabase), so moz_icons and friends are not in `main`.
 * Schemas are read from pragma_database_list rather than assumed, so any
 * future attachment shows up automatically.
 *
 * The table list is read from the live database rather than hardcoded: the
 * Places schema is not stable, and real profiles disagree with the current
 * tree in both directions (older profiles still carry dropped tables such as
 * moz_places_metadata_snapshots; newer ones add tables).
 */
async function getTables() {
  return withDb(async db => {
    const schemaRows = await db.execute("SELECT name FROM pragma_database_list");
    const schemas = schemaRows.map(row => row.getResultByName("name"));

    const tables = [];
    for (const schema of schemas) {
      // `schema` comes from pragma_database_list, not from the caller, so it is
      // safe to interpolate. It cannot be bound as a parameter.
      //
      // The LIKE pattern is bound even though it is a constant: Sqlite.sys.mjs
      // rejects any statement with a literal LIKE pattern.
      const rows = await db.execute(
        `SELECT name FROM "${schema}".sqlite_master
         WHERE type IN ('table', 'view') AND name NOT LIKE :internal
         ORDER BY name`,
        { internal: "sqlite_%" }
      );
      for (const row of rows) {
        const name = row.getResultByName("name");
        tables.push({
          schema,
          name,
          label: schema === "main" ? name : `${schema}.${name}`,
        });
      }
    }
    return tables;
  });
}

/**
 * Resolve a caller-supplied schema/table pair against the live database.
 * Identifiers cannot be bound as SQL parameters, so nothing reaches a
 * statement until it has been matched against this enumeration.
 */
async function resolveTable(schema, table) {
  const tables = await getTables();
  const match = tables.find(t => t.schema === schema && t.name === table);
  if (!match) {
    throw new Error(`Unknown table: ${schema}.${table}`);
  }
  return match;
}

async function readColumns(db, schema, table) {
  // table_info takes the table as a value here, so it can be bound.
  const rows = await db.execute(
    `SELECT name, type FROM pragma_table_info(:table, :schema)`,
    { table, schema }
  );
  return rows.map(row => ({
    name: row.getResultByName("name"),
    type: (row.getResultByName("type") || "").toUpperCase(),
  }));
}

async function getRows(options) {
  const {
    schema,
    table,
    limit = DEFAULT_LIMIT,
    orderBy,
    descending = false,
    filter,
  } = options;

  const resolved = await resolveTable(schema, table);

  return withDb(async db => {
    const columns = await readColumns(db, resolved.schema, resolved.name);
    const derived = derivedFor(resolved);
    const derivedNames = derived ? Object.keys(derived.columns) : [];
    const columnNames = [...columns.map(c => c.name), ...derivedNames];
    const quotedTable = `"${resolved.schema}"."${resolved.name}"`;

    // `orderBy` is interpolated, so it must exactly match a real column.
    let orderClause = "";
    if (orderBy) {
      if (!columnNames.includes(orderBy)) {
        throw new Error(`Unknown column on ${resolved.label}: ${orderBy}`);
      }
      // Derived columns are expressions rather than columns of the table, and
      // a bare name would be ambiguous once the joins are in play.
      const orderExpr = derived?.columns[orderBy] ?? `${quotedTable}."${orderBy}"`;
      orderClause = ` ORDER BY ${orderExpr} ${descending ? "DESC" : "ASC"}`;
    }

    // The filter is user input, so it is bound. It is applied across every
    // column that can sensibly hold text; BLOB columns are skipped so we do
    // not pattern-match against icon payloads.
    const params = {};
    let whereClause = "";
    if (filter) {
      const searchable = [
        ...columns.filter(c => !isBlob(c)).map(c => `${quotedTable}."${c.name}"`),
        ...derivedNames.map(name => derived.columns[name]),
      ];
      if (searchable.length) {
        const conditions = searchable.map(
          expr => `IFNULL(CAST(${expr} AS TEXT), '') LIKE :filter ESCAPE '/'`
        );
        whereClause = ` WHERE ${conditions.join(" OR ")}`;
        // Escape LIKE wildcards so a literal % or _ is matched literally.
        const escaped = filter.replace(/[/%_]/g, c => `/${c}`);
        params.filter = `%${escaped}%`;
      }
    }

    let limitClause = "";
    if (limit > 0) {
      limitClause = " LIMIT :limit";
      params.limit = limit;
    }

    // Select columns explicitly so BLOBs can be reduced to a length summary
    // instead of being copied across the process boundary.
    const selectList = [
      ...columns.map(c =>
        isBlob(c)
          ? `LENGTH(${quotedTable}."${c.name}") AS "${c.name}"`
          : `${quotedTable}."${c.name}"`
      ),
      ...derivedNames.map(name => `${derived.columns[name]} AS "${name}"`),
    ].join(", ");

    const joinClause = derived ? ` ${derived.joins}` : "";
    const sql = `SELECT ${selectList} FROM ${quotedTable}${joinClause}${whereClause}${orderClause}${limitClause}`;
    const rows = await db.execute(sql, params);

    const countRow = await db.execute(
      `SELECT COUNT(*) AS count FROM ${quotedTable}`
    );
    const total = countRow[0].getResultByName("count");

    const blobColumns = columns.filter(isBlob).map(c => c.name);

    return {
      columns: columnNames,
      blobColumns,
      derivedColumns: derivedNames,
      total,
      // INTEGER columns arrive as doubles (mozStorageStatementRow.cpp reads
      // both INTEGER and FLOAT via GetDouble), so values above 2^53 would lose
      // precision. The widest column in play is url_hash, a 48 bit value built
      // as (prefixHash << 32) + strHash in Helpers.cpp, so Places values stay
      // inside the safe integer range.
      rows: rows.map(row => {
        const result = {};
        for (const column of columnNames) {
          result[column] = row.getResultByName(column);
        }
        return result;
      }),
    };
  });
}

// The CTE chain from CalculateFrecencyFunction::OnFunctionCall in
// toolkit/components/places/SQLFunctions.cpp, copied verbatim down to
// `samples` so the breakdown describes what the real function did rather than
// a re-derivation of it. Keep this in sync with that function.
//
// The one deliberate difference: `visits` also selects the columns that
// explain each weight (visit type, source, redirect status, interestingness),
// which the browser's version has no reason to carry.
const FRECENCY_SAMPLES_CTE = `
  WITH
  lambda (lambda) AS (
    SELECT ln(2) / :halfLifeDays
  ),
  interactions AS (
    SELECT place_id, created_at * 1000 AS visit_date
    FROM moz_places_metadata
    WHERE place_id = :pageId
      AND (total_view_time >= :viewTimeSeconds * 1000
        OR (total_view_time >= :viewTimeIfManyKeypressesSeconds * 1000
          AND key_presses >= :manyKeypresses))
    ORDER BY created_at DESC
    LIMIT :numSampledVisits
  ),
  sampled_visits AS (
    SELECT vs.id, vs.from_visit, vs.place_id, vs.visit_date, vs.visit_type,
      vs.source,
      (SELECT EXISTS (
        SELECT 1 FROM interactions i
        WHERE vs.visit_date BETWEEN
          i.visit_date - :maxVisitGapSeconds * 1000000
          AND i.visit_date + :maxVisitGapSeconds * 1000000
      )) AS is_interesting
    FROM moz_historyvisits vs
    WHERE place_id = :pageId
      AND vs.visit_type NOT IN (7, 8, 9)
  ),
  virtual_visits AS (
    SELECT NULL AS id, 0 AS from_visit, i.place_id, i.visit_date,
      1 AS visit_type, 0 AS source, 1 AS is_interesting
    FROM interactions i
    WHERE NOT EXISTS (
      SELECT 1 FROM moz_historyvisits vs
      WHERE place_id = :pageId
        AND vs.visit_date BETWEEN
          i.visit_date - :maxVisitGapSeconds * 1000000
          AND i.visit_date + :maxVisitGapSeconds * 1000000
    )
  ),
  visit_interaction AS (
    SELECT * FROM sampled_visits
    UNION ALL
    SELECT * FROM virtual_visits
    ORDER BY visit_date DESC
    LIMIT :numSampledVisits
  ),
  visits (days, weight, visit_id, visit_date, visit_type, effective_visit_type,
          source, is_interesting, is_redirect_target, is_redirect_source) AS (
    SELECT
      v.visit_date / 86400000000,
      (SELECT CASE
        WHEN IFNULL(s.visit_type, v.visit_type) = 3
          OR v.source = 2
          OR ( IFNULL(s.visit_type, v.visit_type) = 2
            AND v.source NOT IN (1, 3)
            AND t.id IS NULL AND NOT :isRedirect
          )
        THEN
          CASE WHEN v.is_interesting = 1 THEN :veryHighWeight
               ELSE :highWeight END
        WHEN t.id IS NULL AND NOT :isRedirect
         AND IFNULL(s.visit_type, v.visit_type) NOT IN (4, 8, 9)
         AND v.source <> 1
        THEN
          CASE WHEN v.is_interesting = 1 THEN :highWeight
               ELSE :mediumWeight END
        ELSE :lowWeight
       END),
      v.id,
      v.visit_date,
      v.visit_type,
      IFNULL(s.visit_type, v.visit_type),
      v.source,
      v.is_interesting,
      s.id IS NOT NULL,
      t.id IS NOT NULL
    FROM visit_interaction v
    LEFT JOIN moz_historyvisits s ON s.id = v.from_visit
                                 AND v.visit_type IN (5,6)
    LEFT JOIN moz_historyvisits t ON t.from_visit = v.id
                                 AND t.visit_type IN (5,6)
  ),
  bookmark (days, weight, visit_id, visit_date, visit_type,
            effective_visit_type, source, is_interesting, is_redirect_target,
            is_redirect_source) AS (
    SELECT max(dateAdded) / 86400000000, :highWeight, NULL, max(dateAdded),
      NULL, NULL, NULL, 0, 0, 0
    FROM moz_bookmarks
    WHERE fk = :pageId
    HAVING count(*) > 0
  ),
  samples AS (
    SELECT 1 AS is_bookmark_fallback, * FROM bookmark
      WHERE (SELECT count(*) FROM visits) = 0
    UNION ALL
    SELECT 0 AS is_bookmark_fallback, * FROM visits
  ),
  reference (days, samples_count) AS (
    SELECT max(samples.days), count(*) FROM samples
  )
`;

/**
 * Re-run calculate_frecency's query for one page, exposing the intermediate
 * values instead of only the final score.
 *
 * Two queries rather than one: the per-sample rows and the aggregate both come
 * from `samples`, and SQLite cannot return a row per sample and the aggregate
 * in the same statement without re-aggregating. They run on the same
 * connection back to back, so they see the same data.
 */
async function getFrecencyBreakdown({ pageId, isRedirect = false }) {
  const prefs = readFrecencyPrefs();
  const params = { ...prefs, pageId, isRedirect: isRedirect ? 1 : 0 };

  return withDb(async db => {
    const placeRows = await db.execute(
      `SELECT url, title, visit_count, frecency, recalc_frecency
       FROM moz_places WHERE id = :pageId`,
      { pageId }
    );
    if (!placeRows.length) {
      throw new Error(`No moz_places row with id ${pageId}`);
    }
    const url = placeRows[0].getResultByName("url");
    const visitCount = placeRows[0].getResultByName("visit_count");
    const storedFrecency = placeRows[0].getResultByName("frecency");
    const recalcFrecency = placeRows[0].getResultByName("recalc_frecency");

    // Frecency is 0 by definition for place: URIs, and the query below would
    // still report samples for one, so short-circuit the same way the final
    // SELECT's CASE does.
    const isPlaceUri = typeof url === "string" && url.startsWith("place:");

    const sampleRows = await db.execute(
      `${FRECENCY_SAMPLES_CTE}
       SELECT s.*,
         reference.days AS reference_days,
         reference.samples_count AS samples_count,
         (reference.days - s.days) AS age_days,
         exp(-lambda.lambda * (reference.days - s.days)) AS decay,
         (s.weight * exp(-lambda.lambda * (reference.days - s.days))) AS score
       FROM samples s, reference, lambda
       ORDER BY s.days DESC`,
      params
    );

    const totals = await db.execute(
      `${FRECENCY_SAMPLES_CTE},
       scores (score) AS (
         SELECT (weight * exp(-lambda * (reference.days - samples.days)))
         FROM samples, reference, lambda
       )
       SELECT
         lambda.lambda AS lambda,
         reference.days AS reference_days,
         reference.samples_count AS samples_count,
         sum(score) AS score_sum,
         CASE WHEN (substr(url, 0, 7) = 'place:') THEN 0
         ELSE
           reference.days + CAST ((
             ln(sum(score) / samples_count * MAX(visit_count, samples_count))
             / lambda
           ) AS INTEGER)
         END AS frecency
       FROM moz_places h, reference, lambda, scores
       WHERE h.id = :pageId`,
      params
    );

    const total = totals[0];
    const scoreSum = total?.getResultByName("score_sum") ?? null;
    const samplesCount = total?.getResultByName("samples_count") ?? 0;

    return {
      pageId,
      url,
      title: placeRows[0].getResultByName("title"),
      visitCount,
      storedFrecency,
      recalcFrecency,
      isPlaceUri,
      isRedirect,
      prefs,
      lambda: total?.getResultByName("lambda") ?? null,
      referenceDays: total?.getResultByName("reference_days") ?? null,
      samplesCount,
      scoreSum,
      // The multiplier in the final formula: a page visited more often than we
      // sampled is scaled up by the ratio the sampling left out.
      countMultiplier: Math.max(visitCount, samplesCount),
      computedFrecency: total?.getResultByName("frecency") ?? null,
      samples: sampleRows.map(row => ({
        isBookmarkFallback: !!row.getResultByName("is_bookmark_fallback"),
        visitId: row.getResultByName("visit_id"),
        visitDate: row.getResultByName("visit_date"),
        visitType: row.getResultByName("visit_type"),
        effectiveVisitType: row.getResultByName("effective_visit_type"),
        source: row.getResultByName("source"),
        isInteresting: !!row.getResultByName("is_interesting"),
        isRedirectTarget: !!row.getResultByName("is_redirect_target"),
        isRedirectSource: !!row.getResultByName("is_redirect_source"),
        days: row.getResultByName("days"),
        ageDays: row.getResultByName("age_days"),
        weight: row.getResultByName("weight"),
        decay: row.getResultByName("decay"),
        score: row.getResultByName("score"),
      })),
    };
  });
}

// The benchmark samples mostly at random, which in a real profile is mostly
// pages with a visit or two, so the pages with the most visits are added on
// top: they are where the cost of the query shows.
const BENCHMARK_TOP_FRACTION = 0.1;

async function sampleBenchmarkPages(sampleSize) {
  const top = Math.ceil(sampleSize * BENCHMARK_TOP_FRACTION);
  return withDb(async db => {
    // `visits` counts what sampled_visits reads for the page, which is what the
    // query's cost follows. visit_count only counts some visit types and is
    // used here just to find the busiest pages through its index.
    const rows = await db.execute(
      `WITH picked AS (
         SELECT id FROM (
           SELECT id FROM moz_places ORDER BY visit_count DESC LIMIT :top
         )
         UNION
         SELECT id FROM (
           SELECT id FROM moz_places ORDER BY random() LIMIT :random
         )
       )
       SELECT h.id, h.url, h.visit_count,
         (SELECT count(*) FROM moz_historyvisits v
          WHERE v.place_id = h.id) AS visits
       FROM picked JOIN moz_places h USING (id)`,
      { top, random: Math.max(sampleSize - top, 0) }
    );
    const countRow = await db.execute(
      "SELECT COUNT(*) AS count FROM moz_places"
    );
    return {
      totalPages: countRow[0].getResultByName("count"),
      pages: rows.map(row => ({
        pageId: row.getResultByName("id"),
        url: row.getResultByName("url"),
        visitCount: row.getResultByName("visit_count"),
        visits: row.getResultByName("visits"),
      })),
    };
  });
}

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// Hand the main thread back between pages, so a long run does not freeze the
// browser.
const yieldToEventLoop = () =>
  new Promise(resolve => Services.tm.dispatchToMainThread(resolve));

/**
 * Time the real calculate_frecency for a sample of pages.
 *
 * This is the one place the viewer leaves the read-only clone. The function is
 * copied to clones, but it runs its query through Database::GetStatement, i.e.
 * on Places' main connection: on the main thread that uses the main-thread
 * statement cache, and on any other thread it uses the cache that belongs to
 * Places' own async thread. The clone's queries run on the clone's thread, so
 * calling it there would use that cache from a thread it was not built for.
 * Calling it synchronously on the main thread, through the main connection,
 * is how Places itself can call it safely.
 *
 * Only SELECT calculate_frecency(...) is run on that connection, and the
 * function only reads.
 *
 * Each call is timed on its own with ChromeUtils.now(), which is not clamped
 * in the parent process. Every page gets one untimed warm-up call first, so
 * compiling the inner statement and loading its pages into the cache do not
 * count, then `iterations` timed ones, of which the median is reported. The
 * main connection is shared with Places' async thread, so a call can wait on
 * a lock Places is holding; the median ignores most of that.
 */
async function benchmarkFrecency({ sampleSize = 200, iterations = 5 }) {
  const { totalPages, pages } = await sampleBenchmarkPages(sampleSize);

  const conn = PlacesUtils.history.DBConnection;
  const stmt = conn.createStatement(
    "SELECT calculate_frecency(:pageId, 0) AS frecency"
  );
  // The same round trip minus the function, to show what part of each
  // timing is mozStorage rather than calculate_frecency.
  const baselineStmt = conn.createStatement("SELECT :pageId AS frecency");

  const time = (statement, pageId) => {
    statement.params.pageId = pageId;
    const start = ChromeUtils.now();
    statement.executeStep();
    const frecency = statement.row.frecency;
    const elapsed = ChromeUtils.now() - start;
    statement.reset();
    return { elapsed, frecency };
  };

  const started = ChromeUtils.now();
  try {
    const baselineRuns = [];
    for (let i = 0; i < 200; i++) {
      baselineRuns.push(time(baselineStmt, 1).elapsed);
    }

    const results = [];
    for (const page of pages) {
      const { frecency } = time(stmt, page.pageId);
      const runs = [];
      for (let i = 0; i < iterations; i++) {
        runs.push(time(stmt, page.pageId).elapsed);
      }
      results.push({
        ...page,
        frecency,
        medianMs: median(runs),
        minMs: Math.min(...runs),
        maxMs: Math.max(...runs),
      });
      await yieldToEventLoop();
    }

    return {
      totalPages,
      iterations,
      baselineMs: median(baselineRuns),
      elapsedMs: ChromeUtils.now() - started,
      results,
    };
  } finally {
    stmt.finalize();
    baselineStmt.finalize();
  }
}

// WebExtensions replaces any error thrown from here that is not an
// ExtensionError with "An unexpected error occurred", leaving the real one only
// in the Browser Console. Rewrapping passes the message through to the viewer,
// which is only ever shown to the person debugging their own profile.
const exposeErrors =
  fn =>
  async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      throw new ExtensionUtils.ExtensionError(e?.message ?? String(e));
    }
  };

var places = class extends ExtensionAPI {
  getAPI() {
    return {
      experiments: {
        places: {
          getTables: exposeErrors(getTables),
          getRows: exposeErrors(getRows),
          getFrecencyBreakdown: exposeErrors(getFrecencyBreakdown),
          benchmarkFrecency: exposeErrors(benchmarkFrecency),
        },
      },
    };
  }
};
