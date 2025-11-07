'use strict';

const { setTimeout: delay } = require('timers/promises');
const { URL } = require('url');
const pino = require('pino');
const { trace, SpanStatusCode } = require('@opentelemetry/api');

const BASE_URL = process.env.DEMO_BASE_URL || 'http://demo-app:8000';
const JOB_TIMEOUT_MS = Number(process.env.DEMO_JOB_TIMEOUT_MS || 15000);
const JOB_POLL_INTERVAL_MS = Number(process.env.DEMO_JOB_POLL_INTERVAL_MS || 1000);
const ITERATIONS = Number(process.env.DEMO_SMOKE_ITERATIONS || 20);
const PAUSE_MS = Number(process.env.DEMO_SMOKE_PAUSE_MS || 500);
const ALLOW_JOB_FAILURES = (process.env.DEMO_SMOKE_ALLOW_JOB_FAILURES || 'true').toLowerCase() === 'true';

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
      if (ALLOW_JOB_FAILURES) {
        logger.warn({ jobId }, 'Job failed (expected); continuing');
        return;
      }
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
    logger.warn({ status: response.status, body }, 'External call failed');
    return;
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

async function main() {
  const summary = {
    total: ITERATIONS,
    success: 0,
    failed: 0,
    failures: [],
  };

  for (let i = 1; i <= ITERATIONS; i += 1) {
    logger.info({ iteration: i }, 'Starting smoke iteration');
    try {
      await runScenario();
      summary.success += 1;
      logger.info({ iteration: i }, 'Iteration completed');
    } catch (error) {
      summary.failed += 1;
      summary.failures.push({ iteration: i, message: error.message });
      logger.warn({ iteration: i, err: error }, 'Iteration failed');
    }

    if (i < ITERATIONS && PAUSE_MS > 0) {
      await delay(PAUSE_MS);
    }
  }

  logger.info({ summary }, 'Smoke test summary');

  if (summary.failed > 0) {
    const error = new Error(`Smoke test completed with ${summary.failed} failures`);
    error.summary = summary;
    throw error;
  }

  return summary;
}

main()
  .then((summary) => {
    logger.info({ summary }, 'Smoke test complete');
    process.exit(0);
  })
  .catch((err) => {
    logger.error({ err, summary: err.summary }, 'Smoke test encountered errors');
    process.exit(1);
  });
