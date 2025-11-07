'use strict';

const { diag, DiagConsoleLogger, DiagLogLevel } = require('@opentelemetry/api');
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-grpc');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-grpc');
const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-grpc');
const { BatchLogRecordProcessor } = require('@opentelemetry/sdk-logs');
const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');

diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://otel-collector:4317';

const traceExporter = new OTLPTraceExporter({ url: otlpEndpoint });
const metricReader = new PeriodicExportingMetricReader({
  exporter: new OTLPMetricExporter({ url: otlpEndpoint }),
});
const logExporter = new OTLPLogExporter({ url: otlpEndpoint });

const resource = new Resource({
  [SemanticResourceAttributes.SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'demo-node-app',
  [SemanticResourceAttributes.SERVICE_NAMESPACE]: 'demo',
  [SemanticResourceAttributes.SERVICE_INSTANCE_ID]:
    process.env.HOSTNAME || `demo-node-app-${Date.now()}`,
  [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]:
    process.env.DEMO_ENVIRONMENT || 'local',
});

const sdk = new NodeSDK({
  resource,
  traceExporter,
  metricReader,
  logRecordProcessor: new BatchLogRecordProcessor(logExporter),
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-http': {
        requireParentforOutgoingSpans: false,
      },
      '@opentelemetry/instrumentation-express': {
        enabled: true,
      },
      '@opentelemetry/instrumentation-redis': {
        enabled: true,
      },
      '@opentelemetry/instrumentation-mongodb': {
        enabled: true,
      },
      '@opentelemetry/instrumentation-pino': {
        enabled: true,
        logHook: (span, record) => {
          if (span) {
            record['span.id'] = span.spanContext().spanId;
            record['trace.id'] = span.spanContext().traceId;
          }
        },
      },
    }),
  ],
});

try {
  Promise.resolve(sdk.start())
    .then(() => {
      diag.debug('OpenTelemetry SDK started');
    })
    .catch((error) => {
      console.error('Error starting OpenTelemetry SDK', error);
    });
} catch (error) {
  console.error('Error starting OpenTelemetry SDK', error);
}

process.on('SIGTERM', () => {
  sdk
    .shutdown()
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      console.error('Error shutting down OpenTelemetry SDK', error);
      process.exit(1);
    });
});
