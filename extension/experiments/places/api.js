/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* global ExtensionAPI */

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

const DEFAULT_LIMIT = 1000;

// BLOB columns are identified by their declared type rather than by name.
// Their contents are summarised as a byte length rather than returned, so the
// viewer does not move megabytes of icon payload across the process boundary
// per row. In current profiles the only such column is moz_icons.data.
const isBlob = column => column.type === "BLOB";

function withDb(name, task) {
  return PlacesUtils.withConnectionWrapper(`PlacesDBViewer: ${name}`, task);
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
  return withDb("getTables", async db => {
    const schemaRows = await db.execute("SELECT name FROM pragma_database_list");
    const schemas = schemaRows.map(row => row.getResultByName("name"));

    const tables = [];
    for (const schema of schemas) {
      // `schema` comes from pragma_database_list, not from the caller, so it is
      // safe to interpolate. It cannot be bound as a parameter.
      const rows = await db.execute(
        `SELECT name FROM "${schema}".sqlite_master
         WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
         ORDER BY name`
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

  return withDb("getRows", async db => {
    const columns = await readColumns(db, resolved.schema, resolved.name);
    const columnNames = columns.map(c => c.name);
    const quotedTable = `"${resolved.schema}"."${resolved.name}"`;

    // `orderBy` is interpolated, so it must exactly match a real column.
    let orderClause = "";
    if (orderBy) {
      if (!columnNames.includes(orderBy)) {
        throw new Error(`Unknown column on ${resolved.label}: ${orderBy}`);
      }
      orderClause = ` ORDER BY "${orderBy}" ${descending ? "DESC" : "ASC"}`;
    }

    // The filter is user input, so it is bound. It is applied across every
    // column that can sensibly hold text; BLOB columns are skipped so we do
    // not pattern-match against icon payloads.
    const params = {};
    let whereClause = "";
    if (filter) {
      const searchable = columns.filter(c => !isBlob(c));
      if (searchable.length) {
        const conditions = searchable.map(
          c => `IFNULL(CAST("${c.name}" AS TEXT), '') LIKE :filter ESCAPE '/'`
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
    const selectList = columns
      .map(c =>
        isBlob(c) ? `LENGTH("${c.name}") AS "${c.name}"` : `"${c.name}"`
      )
      .join(", ");

    const sql = `SELECT ${selectList} FROM ${quotedTable}${whereClause}${orderClause}${limitClause}`;
    const rows = await db.execute(sql, params);

    const countRow = await db.execute(
      `SELECT COUNT(*) AS count FROM ${quotedTable}`
    );
    const total = countRow[0].getResultByName("count");

    const blobColumns = columns.filter(isBlob).map(c => c.name);

    return {
      columns: columnNames,
      blobColumns,
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

var places = class extends ExtensionAPI {
  getAPI() {
    return {
      experiments: {
        places: {
          getTables,
          getRows,
        },
      },
    };
  }
};
