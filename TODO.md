# TODO & Work Log

Source of truth documents: see `README.md` (Manual verification checklist, dashboards) and `AGENTS.md` (Coding Agent Playbook). Each item below tracks the fixes requested in the latest instructions; mark them complete with a short report once finished.

- [x] Run README manual verification checklist step **#3** (Grafana UI validation) after stack updates.  
  _Ref: README.md:62-88 · Report: full stack + demo overlay are up via `docker compose -f docker-compose.yml -f docker-compose.demo.yml up -d`; smoke test (`npm --prefix demo-app run simulate` with `DEMO_BASE_URL=http://localhost:8080`) completed 40/40 iterations with success, Grafana responded with HTTP 200 at `/login`, and dashboards were populated with fresh data._
- [x] Remove all occurrences of `"kubernetes"` from imported Loki dashboards so they align with the Docker/Promtail labels.  
  _Ref: grafana/dashboards/imported/loki-stack-monitoring.json · Report: queries now match Docker labels (`log_messages_total` filters and drop legend rewritten)._
- [x] Repair the MongoDB dashboard (`grafana/dashboards/imported/mongodb-overview.json`) so panels display metrics from the Percona exporter used in `docker-compose.demo.yml`.  
  _Ref: AGENTS.md (demo overlay services) · Report: replaced the container image with a custom Node-based exporter (`mongo-exporter/`) that emits the `mongodb_*` counters the dashboard expects + set the templating default to `All` so panels populate immediately._
- [x] Repair the Nginx dashboard (`grafana/dashboards/imported/nginx-metrics.json`) so every panel uses metrics emitted by `nginx-prometheus-exporter`.  
  _Ref: README.md (demo overlay description) · Report: replaced the upstream JSON with a lightweight board that charts `nginx_http_requests_total`, `nginx_connections_*`, and `nginx_up`, all of which are provided by the exporter shipping in the demo overlay._
- [x] Repair the Pino HTTP Logs dashboard (`grafana/dashboards/imported/pino-http-logs.json`) so total/success/error counters and logs work with the current Loki labels.  
  _Ref: grafana/dashboards/imported/pino-http-logs.json · Report: queries now parse `res.statusCode` from the JSON payload, filter on `\"request completed\"`, and relabel timeseries so totals/success/4xx/5xx counters show real values._
- [x] Update `grafana/dashboards/stack-overview.json` to monitor only the core observability services (exclude demo app).  
  _Ref: README.md:47-61 · Report: dashboard now tracks host health, `up{job=...}` across Grafana/Prometheus/Loki/Tempo/Mimir/Pyroscope/OTel/Alertmanager, container CPU/memory, alert count, and shared logs; demo-specific charts were removed._
- [x] Rebuild `grafana/dashboards/demo-service.json` by adopting the most relevant panels from the imported dashboards (Pino logs, Nginx metrics, Redis/Mongo views) for complete demo coverage.  
  _Ref: grafana/dashboards/demo-service.json & imported dashboards · Report: new layout combines HTTP metrics, BullMQ data, Redis command rates, Mongo op counters, Nginx request rate, NodeJS runtime stats, Loki logs, and Tempo traces so every supporting dashboard is represented._
