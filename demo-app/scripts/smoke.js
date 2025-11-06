'use strict';

const { setTimeout: delay } = require('timers/promises');
const { URL } = require('url');
const pino = require('pino');
const { trace, SpanStatusCode } = require('@opentelemetry/api');

const BASE_URL = process.env.DEMO_BASE_URL || 'http://demo-app:8000';
const JOB_TIMEOUT_MS = Number(process.env.DEMO_JOB_TIMEOUT_MS || 15000);
const JOB_POLL_INTERVAL_MS = Number(process.env.DEMO_JOB_POLL_INTERVAL_MS || 1000);

const logger = pino({
  name: 'demo-smoke',
  level: process.env.LOG_LEVEL || 'info',
});

const tracer = trace.getTracer('demo-app-smoke');

async function fetchJson(path, options = {}) {
  const url = new URL(path, BASE_URL);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout ?? 5000);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch (err) {
      body = text;
    }
    return { response, body };
  } finally {
    clearTimeout(timeout);
  }
}

async function runScenario() {
  return tracer.startActiveSpan('demo.smoke', async (span) => {
    try {
      await checkHealth();
      await hitRoot();
      await hitCache();
      const jobId = await enqueueJob();
      await pollJob(jobId);
      await callExternal();
      await triggerError();
      logger.info('Smoke test finished');
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (error) {
      logger.error({ err: error }, 'Smoke test failed');
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      throw error;
    } finally {
      span.end();
    }
  });
}

async function checkHealth() {
  logger.info('Checking /healthz');
  const { response, body } = await fetchJson('/healthz');
  if (!response.ok) {
    throw new Error(`/healthz returned ${response.status}`);
  }
  logger.info({ body }, 'Healthz ok');
}

async function hitRoot() {
  logger.info('Calling /');
  const { response, body } = await fetchJson('/');
  if (!response.ok) {
    throw new Error(`Root endpoint returned ${response.status}`);
  }
  logger.info({ queue: body?.queue, host: body?.host }, 'Root response');
}

async function hitCache() {
  logger.info('Calling /cache');
  const { response, body } = await fetchJson('/cache');
  if (!response.ok) {
    throw new Error(`/cache returned ${response.status}`);
  }
  logger.info({ body }, 'Cache response');
}

async function enqueueJob() {
  logger.info('Posting /jobs');
  const { response, body } = await fetchJson('/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      task: 'report',
      actor: 'smoke-test',
    }),
  });
  if (response.status !== 202 || !body?.jobId) {
    throw new Error(`Unexpected job enqueue response: ${response.status}`);
  }
  logger.info({ jobId: body.jobId }, 'Job enqueued');
  return body.jobId;
}

async function pollJob(jobId) {
  logger.info({ jobId }, 'Polling job');
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { response, body } = await fetchJson(`/jobs/${jobId}`);
    if (response.status === 404) {
      logger.warn({ jobId }, 'Job not found yet; retrying');
    } else if (!response.ok) {
      throw new Error(`Job status returned ${response.status}`);
    } else if (body?.state === 'completed') {
      logger.info({ jobId, state: body.state }, 'Job completed');
      return;
    } else if (body?.state === 'failed') {
      throw new Error(`Job ${jobId} failed`);
    } else {
      logger.debug({ jobId, state: body?.state }, 'Job still in progress');
    }
    await delay(JOB_POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for job ${jobId}`);
}

async function callExternal() {
  logger.info('Calling /external');
  const { response, body } = await fetchJson('/external');
  if (!response.ok) {
    throw new Error(`/external returned ${response.status}`);
  }
  logger.info({ provider: body?.upstream }, 'External response received');
}

async function triggerError() {
  logger.info('Triggering /error');
  const { response } = await fetchJson('/error');
  if (response.status !== 503) {
    throw new Error(`/error expected 503, got ${response.status}`);
  }
  logger.info('Error endpoint responded as expected');
}

runScenario()
  .then(() => {
    logger.info('Smoke scenario complete');
    process.exit(0);
  })
  .catch((err) => {
    logger.error({ err }, 'Smoke scenario failed');
    process.exit(1);
  });
