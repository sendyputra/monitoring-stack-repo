# Coding Agent Playbook

## Repository Focus
- This stack runs Grafana, Prometheus, Loki, Tempo, Pyroscope, Mimir, the OpenTelemetry Collector, and supporting agents (Node Exporter, cAdvisor, Promtail) via Docker Compose.
- Core configs live in:
  - `docker-compose.yml` for service wiring, networks, and volumes.
  - `prometheus/prometheus.yml` for scrape targets and remote write.
  - `grafana/provisioning/datasources/datasources.yml` for data sources.
  - `otel-collector/config.yaml`, `tempo/tempo.yaml`, `mimir/mimir.yaml`, `pyroscope/config.yaml`, and `promtail/promtail-config.yaml` for observability backends.
- Promtail ships host and container logs to Loki; the OpenTelemetry Collector handles OTLP traffic from services.
- `demo-app/` contains the Node.js Express/BullMQ demo service used by the local smoke test overlay.
  - `npm run simulate` (via `scripts/smoke.js`) drives a smoke scenario; tune with env vars (`DEMO_SMOKE_ITERATIONS`, `DEMO_SMOKE_PAUSE_MS`, `DEMO_BASE_URL`, etc.).
- The demo overlay (`docker-compose.demo.yml`) also spins up MongoDB/Redis, their exporters, an Nginx gateway + exporter (exposed on `${NGINX_PORT:-18080}`), and the `demo-load` generator that hammers the proxy so dashboards have traffic.
- `mongo-exporter/` houses the custom Node-based MongoDB metrics exporter that feeds the imported MongoDB dashboard.
- `telegraf/` (nginx + host collectors + tail log) menjaga dashboard Nginx lokal; file `telegraf/npmplus-telegraf.conf` dipakai untuk agent Telegraf di server NPMplus terpisah.
- Grafana auto-loads JSON dashboards from `grafana/dashboards` (core) and `grafana/dashboards/imported` (Pino HTTP logs, Node Exporter Full, Loki stack, Redis, MongoDB, NodeJS Runtime, Nginx). Keep datasource UIDs (`PROMETHEUS_DS`, `LOKI_DS`, `TEMPO_DS`, `PYROSCOPE_DS`) consistent when editing.
- `TODO.md` captures the current user-requested fixes with status + report; keep it in sync when you complete tasks referenced in README.md.

## Workflow Expectations
- Keep commits small and focused on one logical change. Use clear, descriptive messages.
- Never rewrite or remove user-created history; only add commits.
- Respect existing `.env` defaults—document new variables in `README.md` instead of committing secrets.
- Prefer configuring services through tracked files rather than inline Docker commands.
- When adding telemetry targets, remember to update both Prometheus and Grafana provisioning.
- Optional local smoke test lives in `docker-compose.demo.yml`. Build the demo app (`docker compose -f docker-compose.yml -f docker-compose.demo.yml build demo-app`) before running the overlay.

## Validation
- Run `docker compose config` after editing Compose or environment files to catch syntax issues.
- When feasible, start the stack (`docker compose up -d`) and check container health (`docker compose ps`).
- For config-only work, validate YAML/TOML/JSON with linters or `docker compose config` as a lightweight check.
- Document manual validation steps in the PR or commit message if automated verification is not possible.

## Communication
- Summaries should highlight user-visible outcomes first, then list files touched with reasoning.
- Call out follow-up actions the user should perform (e.g., restart stack, adjust retention).
- If unsure about destructive steps (pruning volumes, resetting data), stop and ask for guidance.
