'use strict';

const express = require('express');
const pino = require('pino');
const pinoHttp = require('pino-http');
const { MongoClient } = require('mongodb');
const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');
const os = require('os');
const process = require('process');
const { metrics, trace, context, SpanStatusCode } = require('@opentelemetry/api');
const client = require('prom-client');

const PORT = Number(process.env.PORT || 8000);
const HOSTNAME = os.hostname();

const mongoUrl = process.env.MONGO_URL || 'mongodb://mongo:27017';
const mongoDbName = process.env.MONGO_DB_NAME || 'monitoring_demo';
const redisUrl = process.env.REDIS_URL || 'redis://redis:6379';
const queueName = process.env.BULLMQ_QUEUE_NAME || 'demo-jobs';
const jobIntervalMs = Number(process.env.DEMO_JOB_INTERVAL_MS || 4000);
const logLevel = process.env.LOG_LEVEL || 'info';

const baseLogger = pino({
  level: logLevel,
  base: { service: 'demo-node-app', hostname: HOSTNAME },
});

const tracer = trace.getTracer('demo-node-app');
const meter = metrics.getMeter('demo-node-app');

const promRegistry = new client.Registry();
client.collectDefaultMetrics({
  register: promRegistry,
});

const httpLatencyHistogram = new client.Histogram({
  name: 'demo_http_request_duration_seconds',
  help: 'HTTP request latency',
  labelNames: ['method', 'route', 'status_code'],
  registers: [promRegistry],
});

const jobDurationHistogram = new client.Histogram({
  name: 'demo_job_processing_seconds',
  help: 'BullMQ job processing duration',
  labelNames: ['task', 'state'],
  registers: [promRegistry],
});

const jobQueueGauge = new client.Gauge({
  name: 'demo_job_queue_size',
  help: 'BullMQ queue depth',
  labelNames: ['state'],
  registers: [promRegistry],
});

const requestCounter = meter.createCounter('demo_http_requests_total', {
  description: 'Total HTTP requests handled by demo service',
});

const errorCounter = meter.createCounter('demo_errors_total', {
  description: 'Errors emitted by the demo service',
});

const jobCounter = meter.createCounter('demo_jobs_total', {
  description: 'BullMQ jobs observed by the demo service',
});

const jobDuration = meter.createHistogram('demo_job_duration_ms', {
  description: 'Duration of BullMQ job processing',
  unit: 'ms',
});

const memoryGauge = meter.createObservableGauge('demo_process_memory_bytes', {
  description: 'Process memory usage by segment',
});

memoryGauge.addCallback((observableResult) => {
  const usage = process.memoryUsage();
  observableResult.observe(usage.rss, { type: 'rss' });
  observableResult.observe(usage.heapUsed, { type: 'heap_used' });
  observableResult.observe(usage.heapTotal, { type: 'heap_total' });
});

const cpuGauge = meter.createObservableGauge('demo_process_cpu_user_seconds', {
  description: 'User CPU time spent by the process',
});

cpuGauge.addCallback((observableResult) => {
  const usage = process.cpuUsage();
  observableResult.observe(usage.user / 1_000_000, { mode: 'user' });
});

const allowRandomFailures = (process.env.DEMO_ALLOW_FAILURES || '').toLowerCase() === 'true';

const app = express();
app.use(express.json());

app.use(
  pinoHttp({
    logger: baseLogger,
    customLogLevel: (res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
  }),
);

app.use((req, res, next) => {
  const start = Date.now();
  const route = req.route?.path || req.originalUrl || 'unknown';
  const stopTimer = httpLatencyHistogram.startTimer({
    method: req.method,
    route,
  });
  res.on('finish', () => {
    requestCounter.add(1, {
      method: req.method,
      route,
      status_code: res.statusCode,
    });
    const duration = Date.now() - start;
    stopTimer({ status_code: res.statusCode });
    req.log.debug({ route, duration }, 'request completed');
  });
  next();
});

let mongoClient;
let mongoDb;
let redis;
let jobQueue;
let jobWorker;

async function initialiseDataStores() {
  mongoClient = new MongoClient(mongoUrl, { maxConnecting: 8 });
  await mongoClient.connect();
  mongoDb = mongoClient.db(mongoDbName);
  baseLogger.info({ mongoUrl, mongoDbName }, 'Connected to MongoDB');

  redis = new IORedis(redisUrl, { enableAutoPipelining: true });
  redis.on('error', (err) => baseLogger.error({ err }, 'Redis connection error'));
  redis.on('ready', () => baseLogger.info('Redis connection ready'));

  jobQueue = new Queue(queueName, { connection: redis });
  jobWorker = new Worker(
    queueName,
    async (job) => {
      const span = tracer.startSpan('job.process', {
        attributes: {
          'demo.job.id': job.id,
          'demo.job.name': job.name,
        },
      });

      return context.with(trace.setSpan(context.active(), span), async () => {
          const started = Date.now();
          const task = job.data?.task || 'default';
          const collection = mongoDb.collection('job_events');
          await collection.insertOne({
            jobId: job.id,
            task,
            state: 'processing',
            createdAt: new Date(),
          });

          baseLogger.info({ jobId: job.id, task }, 'Processing job');
          const result = await simulateWork(task);

          await collection.updateOne(
            { jobId: job.id },
            {
              $set: {
                state: 'completed',
                completedAt: new Date(),
                result,
              },
            },
          );

          const elapsedMs = Date.now() - started;
          jobDuration.record(elapsedMs, {
            task,
            state: 'completed',
          });
          jobDurationHistogram.observe(elapsedMs / 1000, { task, state: 'completed' });
          jobCounter.add(1, { task, state: 'completed' });
          span.setAttribute('demo.job.duration_ms', elapsedMs);
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
          return result;
        })
        .catch((err) => {
          span.recordException(err);
          span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
          span.end();
          const task = job.data?.task || 'default';
          jobCounter.add(1, { task, state: 'failed' });
          jobDurationHistogram.observe(0, { task, state: 'failed' });
          throw err;
        });
    },
    { connection: redis, concurrency: 2 },
  );

  jobWorker.on('completed', (job) => {
    baseLogger.info({ jobId: job.id }, 'Job completed');
  });

  jobWorker.on('failed', (job, err) => {
    baseLogger.error({ jobId: job?.id, err }, 'Job failed');
  });

  meter.createObservableGauge(
    'demo_job_queue_depth',
    { description: 'BullMQ queue size segmented by state' },
    (observableResult) => {
      const observeState = (promise, state) => {
        promise
          .then((count) => {
            observableResult.observe(count, { state });
            jobQueueGauge.set({ state }, count);
          })
          .catch((err) => baseLogger.debug({ err }, `Failed to read ${state} count`));
      };
      observeState(jobQueue.getWaitingCount(), 'waiting');
      observeState(jobQueue.getActiveCount(), 'active');
      observeState(jobQueue.getDelayedCount(), 'delayed');
    },
  );
}

async function simulateWork(task) {
  // create observable spans for CPU / async work
  return tracer.startActiveSpan(`simulate.${task}`, async (span) => {
    try {
      const iterations = Math.floor(Math.random() * 10_000) + 10_000;
      let total = 0;
      for (let i = 0; i < iterations; i += 1) {
        total += Math.sqrt(i + Math.random());
      }

      if (allowRandomFailures && Math.random() < 0.15) {
        const error = new Error('Randomised worker failure');
        errorCounter.add(1, { scope: 'worker', task });
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, Math.random() * 400 + 50));
      span.setAttribute('demo.worker.iterations', iterations);
      span.setAttribute('demo.worker.total', total);
      return { iterations, total };
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      throw err;
    } finally {
      span.end();
    }
  });
}

app.get('/', async (req, res, next) => {
  try {
    const [waiting, active, completed] = await Promise.all([
      jobQueue.getWaitingCount(),
      jobQueue.getActiveCount(),
      jobQueue.getCompletedCount(),
    ]);

    const latest = await mongoDb.collection('job_events').find().sort({ createdAt: -1 }).limit(5).toArray();

    res.json({
      status: 'ok',
      time: new Date().toISOString(),
      host: HOSTNAME,
      queue: { waiting, active, completed },
      latestJobs: latest,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/cache', async (req, res, next) => {
  try {
    const now = new Date().toISOString();
    await redis.set('demo:last_seen', now, 'EX', 60);
    const lastSeen = await redis.get('demo:last_seen');
    res.json({ lastSeen, node: HOSTNAME });
  } catch (error) {
    next(error);
  }
});

app.post('/jobs', async (req, res, next) => {
  try {
    const task = req.body?.task || 'report';
    const payload = {
      task,
      startedBy: req.body?.actor || 'api',
      requestedAt: new Date().toISOString(),
    };

    const job = await jobQueue.add(task, payload, {
      attempts: 2,
      backoff: { type: 'exponential', delay: 500 },
      removeOnComplete: false,
      removeOnFail: false,
    });

    jobCounter.add(1, { task, state: 'enqueued' });

    req.log.info({ task, jobId: job.id }, 'Job enqueued');
    res.status(202).json({ jobId: job.id, state: 'enqueued' });
  } catch (error) {
    next(error);
  }
});

app.get('/jobs/:id', async (req, res, next) => {
  try {
    const job = await jobQueue.getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    const state = await job.getState();
    const logs = await mongoDb
      .collection('job_events')
      .find({ jobId: job.id })
      .sort({ createdAt: -1 })
      .limit(5)
      .toArray();

    res.json({
      jobId: job.id,
      name: job.name,
      state,
      attemptsMade: job.attemptsMade,
      data: job.data,
      logs,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/external', async (req, res, next) => {
  try {
    const response = await fetch('https://worldtimeapi.org/api/timezone/Etc/UTC');
    const data = await response.json();
    res.json({ upstream: 'worldtimeapi', data });
  } catch (error) {
    next(error);
  }
});

app.get('/error', async (req, res, next) => {
  const error = new Error('Intentional demo failure');
  error.status = 503;
  errorCounter.add(1, { scope: 'http', route: '/error' });
  next(error);
});

app.get('/healthz', async (req, res) => {
  const healthy = mongoClient?.topology?.isConnected() && redis?.status === 'ready';
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    mongo: mongoClient?.topology?.isConnected() ? 'ready' : 'disconnected',
    redis: redis?.status,
  });
});

app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', promRegistry.contentType);
  res.end(await promRegistry.metrics());
});

app.use((err, req, res, _next) => {
  req.log.error({ err }, 'Request failed');
  const status = err.status || 500;
  errorCounter.add(1, { scope: 'http', route: req.route?.path || req.originalUrl || 'unknown' });
  res.status(status).json({
    error: err.message,
    status,
  });
});

process.on('unhandledRejection', (reason, promise) => {
  baseLogger.error({ reason, promise }, 'Unhandled promise rejection');
  errorCounter.add(1, { scope: 'process', type: 'unhandledRejection' });
});

process.on('uncaughtException', (err) => {
  baseLogger.fatal({ err }, 'Uncaught exception');
  errorCounter.add(1, { scope: 'process', type: 'uncaughtException' });
});

async function start() {
  try {
    await initialiseDataStores();

    setInterval(() => {
      jobQueue
        .add(
          'heartbeat',
          {
            task: 'heartbeat',
            producedAt: new Date().toISOString(),
          },
          { removeOnComplete: false, attempts: 1 },
        )
        .catch((err) => baseLogger.warn({ err }, 'Unable to enqueue heartbeat'));
    }, jobIntervalMs).unref();

    setInterval(() => {
      baseLogger.info(
        {
          memory: process.memoryUsage(),
          loadAvg: os.loadavg(),
        },
        'process heartbeat',
      );
    }, 15000).unref();

    app.listen(PORT, () => {
      baseLogger.info({ port: PORT }, 'Demo service listening');
    });
  } catch (error) {
    baseLogger.fatal({ error }, 'Failed to start demo service');
    process.exit(1);
  }
}

start();

process.on('SIGTERM', async () => {
  baseLogger.info('Received SIGTERM, shutting down');
  await jobWorker?.close();
  await jobQueue?.close();
  await redis?.quit();
  await mongoClient?.close();
  process.exit(0);
});
