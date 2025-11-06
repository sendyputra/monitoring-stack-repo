# Coding Agent Playbook

## Repository Focus
- This stack runs Grafana, Prometheus, Loki, Tempo, Pyroscope, Mimir, Alloy, and Beyla via Docker Compose.
- Core configs live in:
  - `docker-compose.yml` for service wiring, networks, and volumes.
  - `prometheus/prometheus.yml` for scrape targets and remote write.
  - `grafana/provisioning/datasources/datasources.yml` for data sources.
  - `alloy/config.alloy`, `tempo/tempo.yaml`, `mimir/mimir.yaml`, `pyroscope/config.yaml`, and `beyla/config.yml` for observability backends.
- Legacy Promtail config is kept only as reference; Alloy is the active collector.
- `demo-app/` contains the Node.js Express/BullMQ demo service used by the local smoke test overlay.

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
