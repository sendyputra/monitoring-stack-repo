'use strict';

const express = require('express');
const pino = require('pino');
const { Counter, Registry, collectDefaultMetrics } = require('prom-client');
const TailFile = require('tail-file');

const LOG_FILE = process.env.LOG_FILE || '/var/log/nginx/proxy_access.log';
const PORT = Number(process.env.PORT || 9200);
const INSTANCE_LABEL = process.env.INSTANCE_LABEL || 'nginx';
const FROM_BEGINNING = (process.env.LOG_FROM_BEGINNING || 'false').toLowerCase() === 'true';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const registry = new Registry();
collectDefaultMetrics({ register: registry });

const respBytesCounter = new Counter({
  name: 'nginxlog_resp_bytes',
  help: 'Total bytes sent by nginx responses, labelled by status code',
  labelNames: ['instance', 'resp_code'],
  registers: [registry],
});

const lineRegex = /^([^\s]+)\s+[^\s]+\s+[^\s]+\s+\[[^\]]+\]\s+"[^" ]+\s+[^" ]+[^\"]*"\s+(\d{3})\s+(\d+)/;

const tail = new TailFile(LOG_FILE, {
  encoding: 'utf8',
  startPos: FROM_BEGINNING ? 0 : 'end',
  pollFileIntervalMs: 2000,
});

tail.on('line', (line) => {
  const match = lineRegex.exec(line);
  if (!match) {
    logger.debug({ line }, 'line did not match nginx access pattern');
    return;
  }
  const respCode = match[2];
  const bytes = Number(match[3]);
  if (Number.isFinite(bytes)) {
    respBytesCounter.inc({ instance: INSTANCE_LABEL, resp_code: respCode }, bytes);
  }
});

tail.on('error', (err) => {
  logger.error({ err }, 'tail-file error');
});

try {
  tail.start();
  logger.info({ logFile: LOG_FILE }, 'tailing nginx access log');
} catch (err) {
  logger.error({ err }, 'failed to start tailer');
  process.exit(1);
}

const app = express();
app.get('/metrics', async (_req, res) => {
  try {
    res.set('Content-Type', registry.contentType);
    res.end(await registry.metrics());
  } catch (error) {
    logger.error({ error }, 'failed to render metrics');
    res.status(500).send('metrics unavailable');
  }
});

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  logger.info({ port: PORT, logFile: LOG_FILE }, 'nginx log exporter listening');
});

const shutdown = async (signal) => {
  logger.info({ signal }, 'shutting down nginx log exporter');
  await tail.quit();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
