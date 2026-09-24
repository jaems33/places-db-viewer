/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const $ = id => document.getElementById(id);

const SVG_NS = "http://www.w3.org/2000/svg";

const CHART_HEIGHT = 360;
const MARGIN = { top: 12, right: 16, bottom: 40, left: 64 };
const DOT_RADIUS = 4;
// The pointer snaps to the nearest dot within this distance, so small dots do
// not need pixel-perfect aim.
const HIT_RADIUS = 24;
const SLOWEST_COUNT = 10;

let running = false;
let lastResult = null;

function svg(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, value);
  }
  return element;
}

// Timings run from a few microseconds to tens of milliseconds, so the unit
// follows the value.
function formatDuration(ms) {
  if (ms < 1) {
    return `${Number((ms * 1000).toPrecision(3))} µs`;
  }
  return `${Number(ms.toPrecision(3))} ms`;
}

const formatCount = value => Number(value).toLocaleString();

function percentile(sorted, p) {
  if (!sorted.length) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(index, 0)];
}

// A 1, 2 or 5 step giving about `count` ticks between 0 and max.
function niceStep(max, count) {
  const rough = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].find(m => m * magnitude >= rough) * magnitude;
  return step;
}

/**
 * Visit counts are heavy-tailed, with most pages at one or two and a few in the
 * thousands, so the x axis is logarithmic. Pages with no visits (bookmarks
 * only) are real samples too, hence log(visits + 1) rather than log(visits).
 */
function makeXScale(maxVisits, width) {
  const domainMax = Math.log10(Math.max(maxVisits, 9) + 1);
  const scale = visits => (Math.log10(visits + 1) / domainMax) * width;
  const ticks = [0];
  for (let t = 1; t <= Math.max(maxVisits, 10); t *= 10) {
    ticks.push(t);
  }
  return { scale, ticks };
}

function makeYScale(maxMs, height) {
  const step = niceStep(maxMs || 1, 5);
  const top = Math.ceil((maxMs || 1) / step) * step;
  const ticks = [];
  for (let t = 0; t <= top + step / 2; t += step) {
    ticks.push(t);
  }
  return { scale: ms => height - (ms / top) * height, ticks };
}

function renderSummary(result) {
  const summary = $("benchmarkSummary");
  summary.textContent = "";
  const sorted = result.results.map(r => r.medianMs).sort((a, b) => a - b);
  const items = [
    ["pages timed", formatCount(result.results.length)],
    ["median", formatDuration(percentile(sorted, 0.5))],
    ["p95", formatDuration(percentile(sorted, 0.95))],
    ["slowest", formatDuration(sorted.at(-1) ?? 0)],
    ["mozStorage overhead", formatDuration(result.baselineMs)],
    ["run took", formatDuration(result.elapsedMs)],
  ];
  for (const [label, value] of items) {
    const item = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    item.append(dt, dd);
    summary.appendChild(item);
  }
}

function renderChart(result) {
  const container = $("benchmarkChart");
  container.textContent = "";

  const points = result.results;
  if (!points.length) {
    container.textContent = "No pages to time.";
    return;
  }

  const width = Math.max(container.clientWidth, 320);
  const plotWidth = width - MARGIN.left - MARGIN.right;
  const plotHeight = CHART_HEIGHT - MARGIN.top - MARGIN.bottom;

  const x = makeXScale(Math.max(...points.map(p => p.visits)), plotWidth);
  const y = makeYScale(Math.max(...points.map(p => p.medianMs)), plotHeight);

  const root = svg("svg", {
    width,
    height: CHART_HEIGHT,
    role: "img",
    "aria-label":
      "Scatter plot of calculate_frecency median time against visits per page",
  });
  const plot = svg("g", {
    transform: `translate(${MARGIN.left},${MARGIN.top})`,
  });
  root.appendChild(plot);

  const grid = svg("g", { class: "grid" });
  const axes = svg("g", { class: "axis" });
  plot.append(grid, axes);

  for (const tick of y.ticks) {
    const ty = y.scale(tick);
    grid.appendChild(svg("line", { x1: 0, x2: plotWidth, y1: ty, y2: ty }));
    const label = svg("text", { x: -8, y: ty, "text-anchor": "end" });
    label.setAttribute("dominant-baseline", "middle");
    label.textContent = tick === 0 ? "0" : formatDuration(tick);
    axes.appendChild(label);
  }
  for (const tick of x.ticks) {
    const tx = x.scale(tick);
    grid.appendChild(svg("line", { x1: tx, x2: tx, y1: 0, y2: plotHeight }));
    const label = svg("text", {
      x: tx,
      y: plotHeight + 16,
      "text-anchor": "middle",
    });
    label.textContent = formatCount(tick);
    axes.appendChild(label);
  }

  const xTitle = svg("text", {
    class: "axis-title",
    x: plotWidth / 2,
    y: plotHeight + 34,
    "text-anchor": "middle",
  });
  xTitle.textContent = "moz_historyvisits rows for the page (log scale)";
  const yTitle = svg("text", {
    class: "axis-title",
    transform: `translate(${-MARGIN.left + 12},${plotHeight / 2}) rotate(-90)`,
    "text-anchor": "middle",
  });
  yTitle.textContent = "median time per call";
  axes.append(xTitle, yTitle);

  const dots = svg("g", { class: "dots" });
  const positions = points.map(point => ({
    point,
    cx: x.scale(point.visits),
    cy: y.scale(point.medianMs),
  }));
  for (const { cx, cy } of positions) {
    dots.appendChild(svg("circle", { cx, cy, r: DOT_RADIUS }));
  }
  plot.appendChild(dots);

  const highlight = svg("circle", {
    class: "highlight",
    r: DOT_RADIUS + 2,
    visibility: "hidden",
  });
  plot.appendChild(highlight);

  // One transparent layer catches the pointer for the whole plot and snaps to
  // the nearest dot, rather than a listener per circle.
  const hitArea = svg("rect", {
    class: "hit-area",
    width: plotWidth,
    height: plotHeight,
  });
  plot.appendChild(hitArea);
  container.appendChild(root);

  const tooltip = document.createElement("div");
  tooltip.className = "benchmark-tooltip";
  tooltip.hidden = true;
  container.appendChild(tooltip);

  hitArea.addEventListener("pointermove", event => {
    const bounds = hitArea.getBoundingClientRect();
    const px = event.clientX - bounds.left;
    const py = event.clientY - bounds.top;
    let nearest = null;
    let nearestDistance = HIT_RADIUS;
    for (const position of positions) {
      const distance = Math.hypot(position.cx - px, position.cy - py);
      if (distance <= nearestDistance) {
        nearest = position;
        nearestDistance = distance;
      }
    }
    if (!nearest) {
      highlight.setAttribute("visibility", "hidden");
      tooltip.hidden = true;
      return;
    }

    highlight.setAttribute("cx", nearest.cx);
    highlight.setAttribute("cy", nearest.cy);
    highlight.setAttribute("visibility", "visible");

    const { point } = nearest;
    // textContent, never innerHTML: URLs are attacker-controlled.
    tooltip.textContent = "";
    const url = document.createElement("div");
    url.className = "url";
    url.textContent = point.url;
    const detail = document.createElement("div");
    detail.textContent =
      `${formatDuration(point.medianMs)} median ` +
      `(${formatDuration(point.minMs)}–${formatDuration(point.maxMs)}) · ` +
      `${formatCount(point.visits)} visits · frecency ${point.frecency} · ` +
      `id ${point.pageId}`;
    tooltip.append(url, detail);
    tooltip.hidden = false;

    // Positioned through CSSOM, which the CSP allows where a style attribute
    // would not be.
    const left = MARGIN.left + nearest.cx + 12;
    const flip = left + tooltip.offsetWidth > container.clientWidth;
    tooltip.style.left = `${
      flip ? MARGIN.left + nearest.cx - 12 - tooltip.offsetWidth : left
    }px`;
    tooltip.style.top = `${MARGIN.top + nearest.cy + 12}px`;
  });
  hitArea.addEventListener("pointerleave", () => {
    highlight.setAttribute("visibility", "hidden");
    tooltip.hidden = true;
  });
}

// The table view of the chart's most interesting points.
function renderSlowest(result) {
  const container = $("benchmarkSlowest");
  container.textContent = "";
  const slowest = [...result.results]
    .sort((a, b) => b.medianMs - a.medianMs)
    .slice(0, SLOWEST_COUNT);
  if (!slowest.length) {
    return;
  }

  const heading = document.createElement("h3");
  heading.textContent = "Slowest pages";
  container.appendChild(heading);

  const table = document.createElement("table");
  table.className = "benchmark-slowest";
  const headRow = document.createElement("tr");
  for (const label of ["id", "url", "visits", "median", "min", "max"]) {
    const th = document.createElement("th");
    th.textContent = label;
    headRow.appendChild(th);
  }
  const thead = document.createElement("thead");
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const point of slowest) {
    const tr = document.createElement("tr");
    const cells = [
      String(point.pageId),
      point.url,
      formatCount(point.visits),
      formatDuration(point.medianMs),
      formatDuration(point.minMs),
      formatDuration(point.maxMs),
    ];
    for (const [i, text] of cells.entries()) {
      const td = document.createElement("td");
      td.textContent = text;
      td.title = text;
      if (i !== 1) {
        td.classList.add("num");
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);
}

function render(result) {
  renderSummary(result);
  renderChart(result);
  renderSlowest(result);
}

/**
 * Download every measured page as CSV. Timings are in milliseconds at full
 * precision, rather than the rounded, unit-switching form the page shows, so
 * the file can go straight into a spreadsheet or notebook.
 */
function exportCsv() {
  if (!lastResult) {
    return;
  }
  // Every field is a number, so nothing needs quoting.
  const lines = ["visits,median_ms,min_ms,max_ms"];
  for (const r of lastResult.results) {
    lines.push([r.visits, r.medianMs, r.minMs, r.maxMs].join(","));
  }
  const blob = new Blob([lines.join("\n") + "\n"], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `frecency-benchmark-${new Date()
    .toISOString()
    .slice(0, 19)
    .replace(/:/g, "-")}.csv`;
  link.click();
  // The download resolves the URL asynchronously, so revoking it straight away
  // can cancel it.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function run() {
  if (running) {
    return;
  }
  running = true;
  $("runBenchmark").disabled = true;
  $("exportBenchmark").disabled = true;
  $("benchmarkStatus").textContent = "Running…";

  try {
    lastResult = await browser.experiments.places.benchmarkFrecency({
      sampleSize: Number($("benchmarkSize").value),
      iterations: Number($("benchmarkIterations").value),
    });
    $("benchmarkStatus").textContent =
      `${formatCount(lastResult.results.length)} of ` +
      `${formatCount(lastResult.totalPages)} pages, ` +
      `${lastResult.iterations} timed run${lastResult.iterations === 1 ? "" : "s"} each`;
    render(lastResult);
  } catch (e) {
    $("benchmarkStatus").textContent = `Benchmark failed: ${e.message}`;
    console.error(e);
  } finally {
    running = false;
    $("runBenchmark").disabled = false;
    $("exportBenchmark").disabled = !lastResult;
  }
}

export function initBenchmark() {
  $("runBenchmark").addEventListener("click", run);
  $("exportBenchmark").addEventListener("click", exportCsv);
  // The chart is laid out to the container's width, so redraw it when that
  // changes, which includes the section being unhidden.
  new ResizeObserver(() => {
    if (lastResult && !$("benchmark").hidden) {
      renderChart(lastResult);
    }
  }).observe($("benchmarkChart"));
}
