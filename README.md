# Monitoring Stack (Grafana + Prometheus + Loki + Tempo + Pyroscope + Mimir + OTel Collector)

All-in-one repo to spin up a monitoring & logging stack on Docker.
Target: Proxmox LXC (unprivileged) running Debian 12 + Docker.

## Quickstart

```bash
# 1) Copy repo to your LXC host (monstack), then:
cp .env.example .env 2>/dev/null || true    # if you keep an example
# Edit .env and set GRAFANA_ADMIN_PASSWORD

docker compose pull
docker compose up -d
```

Services:
- Grafana: http://<HOST>:${GRAFANA_PORT}
- Prometheus: http://<HOST>:${PROMETHEUS_PORT}
- Loki: http://<HOST>:${LOKI_PORT}
- Alertmanager: http://<HOST>:${ALERTMANAGER_PORT}
- Tempo UI / Trace API: http://<HOST>:${TEMPO_PORT}
- Pyroscope: http://<HOST>:${PYROSCOPE_PORT}
- Mimir (Prometheus-compatible API): http://<HOST>:${MIMIR_PORT}
- OTLP Collector (gRPC ${OTELCOL_OTLP_GRPC_PORT}, HTTP ${OTELCOL_OTLP_HTTP_PORT}, metrics ${OTELCOL_METRICS_PORT})
- Promtail (container + host logs → Loki)
- Demo service (optional overlay): http://<HOST>:18000

## Repo layout

- `docker-compose.yml` — all services
- `prometheus/prometheus.yml` — scrape targets + alerting -> Alertmanager
- `prometheus/alert_rules/*.yml` — example alerting rules
- `loki/loki-config.yaml` — filesystem backend with boltdb-shipper + compactor retention
- `otel-collector/config.yaml` — OpenTelemetry Collector pipelines (OTLP ingest → Tempo/Mimir/Prometheus/Loki)
- `tempo/tempo.yaml` — Tempo single-binary config + local filesystem storage
- `mimir/mimir.yaml` — Grafana Mimir single-binary config + local filesystem storage
- `pyroscope/config.yaml` — Pyroscope single-binary config + local filesystem storage
- `promtail/promtail-config.yaml` — ships Docker and system logs to Loki
- `grafana/provisioning/*` — auto-provision Prometheus & Loki datasources and dashboards
- `alertmanager/alertmanager.yml` — minimal route/receiver (extend as needed)
- `scripts/deploy_stack.sh` — SSH deploy helper

> **Note:** Promtail now ships system & container logs directly to Loki; application telemetry uses the OpenTelemetry Collector.

### Grafana dashboards

- **Stack Overview** (`grafana/dashboards/stack-overview.json`) — infrastructure + service SLO view with logs/traces links.
- **Demo Service Deep Dive** (`grafana/dashboards/demo-service.json`) — queue depth, latency, error insight for the Node.js workload.

## Local smoke test (optional)

Spin up data generators before deploying to Proxmox:

```bash
# Build the demo app image once
docker compose -f docker-compose.yml -f docker-compose.demo.yml build demo-app

# Start the full stack plus demo generators
docker compose -f docker-compose.yml -f docker-compose.demo.yml up -d

# Optional: run targeted smoke scenario (ensure stack is up)
docker compose -f docker-compose.yml -f docker-compose.demo.yml run --rm \
  -e DEMO_SMOKE_ITERATIONS=30 \
  demo-app npm run simulate
# Or from host with services exposed locally:
#   DEMO_BASE_URL=http://localhost:18000 DEMO_SMOKE_ITERATIONS=30 npm --prefix demo-app run simulate
#   # Optional tunables: DEMO_SMOKE_PAUSE_MS, DEMO_JOB_TIMEOUT_MS
```

Included demo components (`docker-compose.demo.yml`):
- `demo-app` — Node.js (Express) service with MongoDB + Redis + BullMQ, instrumented for traces, metrics, logs (exposed on port 18000)
- `demo-load` — curl-based traffic generator hitting the major endpoints (success, cache, job enqueue, error)
- Pyroscope data is produced directly by `demo-app` via the Pyroscope SDK
- `mongo` & `redis` — backing data stores used by the demo service (ephemeral volumes)

Grafana dashboards should populate within ~1 minute; Pyroscope and Tempo will display synthetic profiles and traces. Tear down with:

```bash
docker compose -f docker-compose.yml -f docker-compose.demo.yml down
```

## Remote management (Komodo / CI)

Prefer **SSH context** for remote Docker access instead of exposing `0.0.0.0:2375`.
Example: `DOCKER_HOST=ssh://user@monstack docker compose up -d`.

If you *must* enable TCP API, use TLS on port 2376 and firewall it strictly.

## Security notes
- Docker Remote API: use SSH or TLS; avoid 0.0.0.0:2375
- Limit who can reach Grafana/Prometheus/Loki/Tempo/Pyroscope/OTel Collector ports
- Secure OTLP ports if ingesting telemetry from remote hosts
- Change default Grafana admin password in `.env`
- Tune Loki retention in `.env` and `loki-config.yaml`; adjust Tempo/Pyroscope retention and Mimir limits in their configs as needed
