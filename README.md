# posthog-trust-kit

**Your PostHog dashboard as a recipe, not a sandcastle.**

Two scripts, one config file:

1. `create_dashboard.mjs` - rebuilds a complete PostHog dashboard (text tile, funnel, conversion signals, breakdowns, guardrails) from a JSON config. One command, anywhere, forever.
2. `trust_brief.mjs` - generates a weekly markdown data sheet (funnel + week-over-week signals + guardrails) that a human or an agent wraps in interpretation.

No clicking in a UI. No drift between environments. If the dashboard dies - key rotated, project rebuilt, teammate deleted it - you run one command and it is back, byte for byte, because the recipe lives in git.

## Why (in plain words)

A dashboard built by clicking is a sandcastle: the tide (key changes, sandbox resets, accidental deletes) takes it, and nobody remembers every tile's exact settings. A dashboard defined as code is a mold - pour water, castle back. And because the recipe is a file, you can review it in pull requests, copy it to another project, and hand it to an agent to maintain.

## Quickstart

```bash
# 1. get your ids: PostHog project numeric id (from /project/<id>/ in the URL)
#    and a personal API key (Settings -> Personal API keys).
#    create_dashboard needs write scope; trust_brief works read-only.
export POSTHOG_PERSONAL_API_KEY=phx_...

# 2. make your config
cp config.example.json config.json
#    edit: project_id, name, and the event names your site actually emits.

# 3. build the dashboard
node create_dashboard.mjs --config config.json

# 4. generate a data sheet any time
node trust_brief.mjs --config config.json
```

Weekly automation: copy `examples/weekly-brief.yml` into `.github/workflows/`, add `POSTHOG_PERSONAL_API_KEY` as a repo secret. Monday morning, the sheet waits as a workflow artifact.

> Security note: if your repo is public, keep the sheet as an artifact (login-only), never commit it - guardrail counts and tripwire details are operational intel. The included workflow already does this and uses `--quiet` so the sheet never leaks into public Action logs.

## Config reference

| Field | What it is |
|---|---|
| `name` | Dashboard name; apply deletes-and-recreates any dashboard with this name |
| `project_id` | PostHog project numeric id (not the `phc_` token) |
| `launch_date` | `YYYY-MM-DD` - "since launch" column in the sheet |
| `funnel_window_days` | Max days allowed between funnel steps (default 14) |
| `funnel[]` | Ordered steps, `{event, label}`; step 1 is usually `$pageview` |
| `signals[]` | Conversion events to track weekly |
| `guardrails[]` | Abuse/quality events (honeypot hits, CSP violations, rejected actions) |
| `breakdowns[]` | Optional per-event property splits, `{event, by, label}` |
| `text_tile` | Optional markdown for the dashboard's text tile (auto-generated if null) |

See `examples/dc254.json` - the production config of a real site (data-centers-254.vercel.app), which you can also use to test the kit against your own PostHog project by swapping the ids.

## Honest scoping (when NOT to use this)

- You want ad-hoc exploration - the PostHog UI is great for that. This kit is for the 5-8 tiles you always want, reproducibly.
- Your events are not in your control yet - instrument first (server-side conversions with stable event names are the strongest foundation), then codify.
- You expect pre-built "insights" - the kit builds the boards; reading them is your job (or your agent's).

## Compat notes (already handled for you)

PostHog's API has sharp edges; this kit encodes them so you don't re-fight them: inline insights in dashboard PATCH are silently dropped (use `POST /insights/` with `dashboards:[id]`), dashboards list omits tiles (GET the detail), fresh insights need `POST /query/` to verify, soft-delete is `PATCH {deleted:true}`, and transient `503 clickhouse_at_capacity` responses are retried with backoff.

## License

MIT - see [LICENSE](LICENSE).
