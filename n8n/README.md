# n8n workflows

n8n orchestrates; the application owns the rules. No workflow holds a database
credential — every node calls the LCOS API with a service token, so no workflow
can bypass validation, RBAC or audit.

## Included, importable

| File | Replaces spec | What it does |
|---|---|---|
| `WF02_03_Process_Questions.json` | WF02+WF03 | Every 5 min: sweep DEIDENTIFIED questions through classify/embed/cluster; failures dead-letter |
| `WF05_Demand_Recompute.json` | WF05 | Daily 01:00 UTC: recompute the priority and coverage boards |

## Not yet exported (application endpoints exist; wire the same thin pattern)

WF06-WF15 run in-process through the Turn Into Content pipeline today, which is
correct at pilot scale. WF16 (publishing cron for `scheduled_for` jobs), WF17
(analytics collection at +1h/+24h/+7d/+28d) and WF19 (knowledge expiry) are
one-node schedule → HTTP call workflows against:

- `POST /api/v1/distribution/jobs/{id}/publish-now` (due jobs from `GET /distribution/calendar`)
- `POST /api/v1/analytics/collect/{publishedId}` then `POST /api/v1/analytics/scores/{publishedId}`
- `GET /api/v1/knowledge/cards?expiring_within_days=30` → notify

## Setup

1. n8n env: `LCOS_BASE_URL=http://lcos-api:8080`
2. Credential "LCOS service token": header `Authorization: Bearer svc_...`
   (matches `LCOS_SERVICE_TOKEN` in the API env). The automation role cannot
   approve anything — enforced server-side.
3. Import the JSON files via n8n UI → Workflows → Import from file.
