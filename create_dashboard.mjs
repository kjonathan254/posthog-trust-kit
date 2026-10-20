#!/usr/bin/env node
/**
 * Trust Kit: dashboard-as-code for PostHog.
 *
 * Rebuilds a complete dashboard (text tile + funnel + conversion signals +
 * breakdowns + guardrails) from ONE config file. Apply is destructive by
 * design: it soft-deletes any dashboard with the config's name and creates
 * a fresh one, so the config in git is always the single source of truth.
 *
 * Usage:
 *   export POSTHOG_PERSONAL_API_KEY=phx_...   # needs dashboard:write + insight:write
 *   node create_dashboard.mjs --config config.json          # apply + verify
 *   node create_dashboard.mjs --config config.json --verify # read back only (read-only key OK)
 *
 * Env: POSTHOG_HOST (default https://us.posthog.com). Project id comes from
 * the config. The key is read from the environment only - never commit it.
 *
 * API quirks this script already fought for you (do not re-fight):
 *  - there is no /tiles/ sub-endpoint; PATCH-ing a dashboard with inline
 *    insight objects SILENTLY DROPS them (text tiles are fine);
 *  - the supported route for insight tiles is POST /insights/ with
 *    dashboards:[id], which auto-creates the tiles;
 *  - the dashboards LIST omits tiles - GET the dashboard DETAIL for tiles;
 *  - fresh insights have no cached result - verify runs each stored query
 *    via POST /query/ and reads the `results` key;
 *  - soft-delete = PATCH {deleted:true} (HTTP DELETE returns 405);
 *  - transient 429/5xx (e.g. 503 clickhouse_at_capacity) happen in the wild:
 *    every call retries with backoff.
 */

const HOST = (process.env.POSTHOG_HOST || "https://us.posthog.com").replace(/\/+$/, "");
const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const CONFIG_PATH = arg("--config", "config.json");
const VERIFY_ONLY = process.argv.includes("--verify");

const { readFileSync } = await import("fs");
const CFG = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));

if (!process.env.POSTHOG_PERSONAL_API_KEY) {
  console.error("POSTHOG_PERSONAL_API_KEY is not set");
  process.exit(1);
}
if (!CFG.project_id || CFG.project_id === "0") {
  console.error("Set config.project_id (PostHog project numeric id, from the URL /project/<id>/)");
  process.exit(1);
}

// ---------------------------------------------------------------------------
function fail(context, status, body) {
  console.error(`FAIL ${context}: HTTP ${status}`);
  try { console.error(JSON.stringify(body).slice(0, 400)); } catch { console.error(String(body).slice(0, 400)); }
  process.exit(1);
}

async function api(path, opts = {}) {
  const url = `${HOST}/api/projects/${CFG.project_id}${path}`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(url, {
      ...opts,
      headers: {
        Authorization: `Bearer ${process.env.POSTHOG_PERSONAL_API_KEY}`,
        "Content-Type": "application/json",
        ...(opts.headers || {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (res.ok) return res.json().catch(() => ({}));
    const json = await res.json().catch(() => ({}));
    if ([429, 502, 503, 504].includes(res.status) && attempt < 4) {
      await new Promise((r) => setTimeout(r, attempt * 4000));
      continue;
    }
    fail((opts.method || "GET") + " " + path, res.status, json);
  }
}

const eventsNode = (event, label) => ({ kind: "EventsNode", event, ...(label ? { name: label } : {}) });

function tiles() {
  const T = [];
  T.push({
    text: {
      body:
        CFG.text_tile ||
        [
          `**${CFG.name}** - the trust loop in one page.`,
          "",
          `Funnel: ${CFG.funnel.map((f) => f.label.toLowerCase()).join(" -> ")}.`,
          "",
          "*Dashboard-as-code with posthog-trust-kit: edit the config, re-run apply. The recipe in git is the asset, not the screen.*",
        ].join("\n"),
    },
  });
  T.push({
    insight: {
      name: "The loop in one funnel",
      query: {
        kind: "FunnelsQuery",
        series: CFG.funnel.map((f) => eventsNode(f.event, f.label)),
        dateRange: { date_from: "-30d" },
        interval: "week",
        funnelsFilter: {
          funnelWindowInterval: CFG.funnel_window_days || 14,
          funnelWindowIntervalUnit: "day",
          funnelOrderType: "ordered",
        },
      },
    },
  });
  T.push({
    insight: {
      name: "Conversion signals per week",
      query: {
        kind: "TrendsQuery",
        series: CFG.signals.map((s) => eventsNode(s.event, s.label)),
        dateRange: { date_from: "-30d" },
        interval: "week",
      },
    },
  });
  for (const b of CFG.breakdowns || []) {
    T.push({
      insight: {
        name: b.label || `${b.event} by ${b.by}`,
        query: {
          kind: "TrendsQuery",
          series: [eventsNode(b.event)],
          dateRange: { date_from: "-30d" },
          interval: "week",
          breakdownFilter: { breakdown: b.by, breakdown_type: "event" },
        },
      },
    });
  }
  if (CFG.guardrails?.length) {
    T.push({
      insight: {
        name: "Guardrails tripped",
        query: {
          kind: "TrendsQuery",
          series: CFG.guardrails.map((g) => eventsNode(g.event, g.label)),
          dateRange: { date_from: "-30d" },
          interval: "week",
        },
      },
    });
  }
  return T;
}

// ---------------------------------------------------------------------------
async function main() {
  if (VERIFY_ONLY) return verify();

  const list = await api(`/dashboards/?limit=500`);
  for (const d of (list.results || []).filter((d) => d.name === CFG.name)) {
    await api(`/dashboards/${d.id}/`, { method: "PATCH", body: { deleted: true } });
    console.log(`deleted stale dashboard id=${d.id}`);
  }
  const dash = await api(`/dashboards/`, {
    method: "POST",
    body: { name: CFG.name, description: `${CFG.name} - built by posthog-trust-kit from ${CONFIG_PATH}`, tags: CFG.tags || ["trust-kit"] },
  });
  console.log(`created dashboard id=${dash.id}`);

  const all = tiles();
  let n = 0;
  for (const tile of all) {
    if (!tile.insight) continue;
    await api(`/insights/`, {
      method: "POST",
      body: { ...tile.insight, dashboards: [dash.id], saved: true },
    });
    n += 1;
    console.log(`  insight ${n} ok (${tile.insight.name})`);
  }
  const textTiles = all.filter((t) => t.text).map((t) => ({ text: t.text }));
  if (textTiles.length) {
    await api(`/dashboards/${dash.id}/`, { method: "PATCH", body: { tiles: textTiles } });
    console.log(`  text tile ok`);
  }

  console.log(`\nApplied -> https://us.posthog.com/dashboard/${dash.id}`);
  return verify(dash.id);
}

// ---------------------------------------------------------------------------
async function verify(forcedId) {
  const found = forcedId
    ? { id: forcedId }
    : (await api(`/dashboards/?limit=500`)).results.find((d) => d.name === CFG.name);
  if (!found) fail("verify", 404, { detail: `dashboard "${CFG.name}" not found` });
  const dash = await api(`/dashboards/${found.id}/`);

  console.log(`\nVerify dashboard ${dash.id} "${dash.name}" (${dash.tiles?.length || 0} tiles)`);
  for (const tile of dash.tiles || []) {
    if (tile.text) {
      console.log(`  [text] ${tile.text.body.split("\n")[0].slice(0, 60)}`);
      continue;
    }
    const ins = tile.insight;
    if (!ins) continue;
    const out = await api(`/query/`, { method: "POST", body: { query: ins.query } });
    if (out.error) {
      console.log(`  [insight ${ins.id}] ${ins.name}\n           QUERY ERROR: ${out.error.slice(0, 200)}`);
      continue;
    }
    const res = out.results;
    let summary = "no result";
    if (Array.isArray(res) && res.length) {
      if (Array.isArray(res[0]?.count)) {
        summary = `funnel: ${res.map((s) => s.count).join(" -> ")}`;
      } else if (Array.isArray(res[0]?.data)) {
        summary = res.map((s) => `${s.label}: ${s.count ?? s.data.reduce((a, b) => a + b, 0)}`).join(", ");
      } else {
        summary = `${res.length} rows`;
      }
    }
    console.log(`  [insight ${ins.id}] ${ins.name}\n           ${summary}`);
  }
  console.log(`\nURL: https://us.posthog.com/dashboard/${dash.id}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
