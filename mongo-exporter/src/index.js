'use strict';

const express = require('express');
const pino = require('pino');
const { MongoClient } = require('mongodb');
const client = require('prom-client');

const MONGO_URL = process.env.MONGO_URL || 'mongodb://mongo:27017';
const SCRAPE_INTERVAL_MS = Number(process.env.MONGO_SCRAPE_INTERVAL_MS || 5000);
const PORT = Number(process.env.PORT || 9216);
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

const logger = pino({ level: LOG_LEVEL });

const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'mongo_exporter_' });

const mongoUp = new client.Gauge({ name: 'mongodb_up', help: 'MongoDB availability (1 = up)', registers: [registry] });
const mongoUptime = new client.Gauge({ name: 'mongodb_instance_uptime_seconds', help: 'MongoDB uptime', registers: [registry] });
const mongoConnections = new client.Gauge({ name: 'mongodb_connections', help: 'MongoDB connections by state', labelNames: ['state'], registers: [registry] });
const mongoMemory = new client.Gauge({ name: 'mongodb_memory', help: 'MongoDB memory usage bytes', labelNames: ['type'], registers: [registry] });
const opCounters = new client.Counter({ name: 'mongodb_op_counters_total', help: 'MongoDB opcounters', labelNames: ['type'], registers: [registry] });
const opCountersRepl = new client.Counter({ name: 'mongodb_op_counters_repl_total', help: 'MongoDB opcounters replication', labelNames: ['type'], registers: [registry] });
const documentMetrics = new client.Counter({ name: 'mongodb_metrics_document_total', help: 'MongoDB document metrics', labelNames: ['type'], registers: [registry] });
const queryExecutorMetrics = new client.Counter({ name: 'mongodb_metrics_query_executor_total', help: 'MongoDB query executor metrics', labelNames: ['type'], registers: [registry] });
const operationMetrics = new client.Counter({ name: 'mongodb_metrics_operation_total', help: 'MongoDB operation metrics', labelNames: ['type'], registers: [registry] });
const locksTime = new client.Counter({ name: 'mongodb_locks_time_acquiring_global_microseconds_total', help: 'Time acquiring global locks', labelNames: ['type'], registers: [registry] });
const networkBytes = new client.Counter({ name: 'mongodb_network_bytes_total', help: 'MongoDB network bytes', labelNames: ['direction'], registers: [registry] });
const replMembers = new client.Gauge({ name: 'mongodb_replset_number_of_members', help: 'Replica set members', registers: [registry] });
const replHealth = new client.Gauge({ name: 'mongodb_replset_member_health', help: 'Replica set member health', labelNames: ['member'], registers: [registry] });
const replState = new client.Gauge({ name: 'mongodb_replset_member_state', help: 'Replica set member state', labelNames: ['state', 'name'], registers: [registry] });
const replOplogSize = new client.Gauge({ name: 'mongodb_replset_oplog_size_bytes', help: 'Replica set oplog size bytes', labelNames: ['type'], registers: [registry] });
const replOplogHead = new client.Gauge({ name: 'mongodb_replset_oplog_head_timestamp', help: 'Replica set oplog head timestamp seconds', registers: [registry] });

const snapshots = {
  opcounters: {},
  opcountersRepl: {},
  metricsDocument: {},
  metricsQuery: {},
  metricsOperation: {},
  locks: {},
  network: {},
};

const toNumber = (value) => {
  if (value == null) return undefined;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'object') {
    if (typeof value.toNumber === 'function') return value.toNumber();
    if (value._bsontype === 'Decimal128') return Number(value.toString());
    if (value._bsontype === 'Double') return Number(value.value);
    if (value._bsontype === 'Int32') return Number(value.value);
  }
  const parsed = Number(value);
  return Number.isNaN(parsed) ? undefined : parsed;
};

const updateCounters = (current = {}, store, counter, label) => {
  Object.entries(current).forEach(([key, raw]) => {
    const currentValue = toNumber(raw);
    if (!Number.isFinite(currentValue)) return;
    const previous = store[key];
    if (Number.isFinite(previous) && currentValue >= previous) {
      counter.inc({ [label]: key }, currentValue - previous);
    }
    store[key] = currentValue;
  });
};

const setMemoryMetrics = (mem = {}) => {
  const resident = toNumber(mem.resident);
  const virtual = toNumber(mem.virtual);
  if (Number.isFinite(resident)) mongoMemory.set({ type: 'resident' }, resident * 1024 * 1024);
  if (Number.isFinite(virtual)) mongoMemory.set({ type: 'virtual' }, virtual * 1024 * 1024);
};

const setConnections = (connections = {}) => {
  const current = toNumber(connections.current);
  const available = toNumber(connections.available);
  if (Number.isFinite(current)) mongoConnections.set({ state: 'current' }, current);
  if (Number.isFinite(available)) mongoConnections.set({ state: 'available' }, available);
};

let mongoClient;
let adminDb;
let intervalHandle;

const collectReplicaMetrics = async () => {
  try {
    const status = await adminDb.command({ replSetGetStatus: 1 });
    const members = status.members ?? [];
    replMembers.set(members.length);
    members.forEach((member) => {
      const name = member.name || 'member';
      const stateStr = member.stateStr || String(member.state);
      const health = toNumber(member.health);
      const state = toNumber(member.state);
      if (Number.isFinite(health)) replHealth.set({ member: name }, health);
      if (Number.isFinite(state)) replState.set({ state: stateStr, name }, state);
    });
    const primary = members.find((m) => m.stateStr === 'PRIMARY') || members[0];
    if (primary?.optimeDate instanceof Date) {
      replOplogHead.set(primary.optimeDate.getTime() / 1000);
    }
    if (status?.storageEngine?.oplogSizeMB) {
      const oplogBytes = toNumber(status.storageEngine.oplogSizeMB) * 1024 * 1024;
      if (Number.isFinite(oplogBytes)) replOplogSize.set({ type: 'allocated' }, oplogBytes);
    }
  } catch (error) {
    replMembers.set(1);
    replHealth.set({ member: 'standalone' }, 1);
    replState.set({ state: 'standalone', name: 'standalone' }, 1);
    replOplogHead.set(0);
    replOplogSize.set({ type: 'allocated' }, 0);
  }
};

const collectOnce = async () => {
  try {
    const status = await adminDb.command({ serverStatus: 1 });
    mongoUp.set(1);
    const uptime = toNumber(status.uptime);
    if (Number.isFinite(uptime)) mongoUptime.set(uptime);
    setMemoryMetrics(status.mem);
    setConnections(status.connections);
    updateCounters(status.opcounters, snapshots.opcounters, opCounters, 'type');
    updateCounters(status.opcountersRepl, snapshots.opcountersRepl, opCountersRepl, 'type');
    updateCounters(status.metrics?.document, snapshots.metricsDocument, documentMetrics, 'type');
    updateCounters(status.metrics?.queryExecutor, snapshots.metricsQuery, queryExecutorMetrics, 'type');
    updateCounters(status.metrics?.operation, snapshots.metricsOperation, operationMetrics, 'type');
    updateCounters(status.locks?.Global?.timeAcquiringMicros, snapshots.locks, locksTime, 'type');
    updateCounters({ bytesIn: status.network?.bytesIn, bytesOut: status.network?.bytesOut }, snapshots.network, networkBytes, 'direction');
    await collectReplicaMetrics();
  } catch (error) {
    mongoUp.set(0);
    logger.error({ err: error }, 'MongoDB metrics collection failed');
  }
};

const start = async () => {
  mongoClient = new MongoClient(MONGO_URL, { directConnection: true, serverSelectionTimeoutMS: 5000 });
  await mongoClient.connect();
  adminDb = mongoClient.db('admin');
  logger.info({ url: MONGO_URL }, 'Connected to MongoDB');
  await collectOnce();
  intervalHandle = setInterval(collectOnce, SCRAPE_INTERVAL_MS).unref();
};

const app = express();
app.get('/metrics', async (_req, res) => {
  try {
    res.set('Content-Type', registry.contentType);
    res.end(await registry.metrics());
  } catch (error) {
    res.status(500).send(error.message);
  }
});

const getUpValue = () => {
  try {
    const series = mongoUp.get().values ?? [];
    return Number(series[0]?.value ?? 0);
  } catch (error) {
    logger.debug({ err: error }, 'Failed to read mongoUp gauge');
    return 0;
  }
};

app.get('/healthz', (_req, res) => {
  const value = getUpValue();
  res.json({ status: value >= 1 ? 'ok' : 'degraded', mongoUp: value });
});

start()
  .then(() => {
    app.listen(PORT, () => logger.info({ port: PORT }, 'Mongo exporter listening'));
  })
  .catch((error) => {
    logger.error({ err: error }, 'Failed to start mongo exporter');
    process.exit(1);
  });

const shutdown = async () => {
  clearInterval(intervalHandle);
  await mongoClient?.close();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
