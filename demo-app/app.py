import logging
import os
import random
import threading
import time

from flask import Flask, jsonify

from opentelemetry import metrics, trace
from opentelemetry.metrics import Observation
from opentelemetry.exporter.otlp.proto.grpc._log_exporter import OTLPLogExporter
from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.flask import FlaskInstrumentor
from opentelemetry.instrumentation.logging import LoggingInstrumentor
from opentelemetry.instrumentation.requests import RequestsInstrumentor
from opentelemetry.sdk._logs import LoggerProvider
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import (
    PeriodicExportingMetricReader,
)
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry._logs import set_logger_provider
from pyroscope import configure as pyroscope_configure, tag_wrapper


OTLP_ENDPOINT = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://alloy:4317")
SERVICE_NAME = os.getenv("OTEL_SERVICE_NAME", "demo-app")

resource = Resource.create({"service.name": SERVICE_NAME})

pyroscope_configure(
    application_name=SERVICE_NAME,
    server_address=os.getenv("PYROSCOPE_SERVER_ADDRESS", "http://pyroscope:4040"),
    detect_subprocesses=True,
    tags={"env": os.getenv("PYROSCOPE_ENV", "local")},
)

# ----- Traces -----
tracer_provider = TracerProvider(resource=resource)
tracer_provider.add_span_processor(
    BatchSpanProcessor(
        OTLPSpanExporter(endpoint=OTLP_ENDPOINT, insecure=True),
    )
)
trace.set_tracer_provider(tracer_provider)
tracer = trace.get_tracer(__name__)

# ----- Metrics -----
metric_reader = PeriodicExportingMetricReader(
    OTLPMetricExporter(endpoint=OTLP_ENDPOINT, insecure=True),
    export_interval_millis=5000,
)
meter_provider = MeterProvider(resource=resource, metric_readers=[metric_reader])
metrics.set_meter_provider(meter_provider)
meter = metrics.get_meter(__name__)
request_counter = meter.create_counter(
    name="demo_app_requests_total",
    description="Total HTTP requests handled by the demo app",
)
request_latency = meter.create_histogram(
    name="demo_app_request_latency_seconds",
    description="Request latency",
    unit="s",
)
def observe_cpu(_options):
    value = random.uniform(0.1, 0.9)
    yield Observation(value=value, attributes={"component": "background"})


meter.create_observable_gauge(
    name="demo_app_background_cpu",
    callbacks=[observe_cpu],
    description="Synthetic CPU load indicator",
)

# ----- Logs -----
logger_provider = LoggerProvider(resource=resource)
logger_provider.add_log_record_processor(
    BatchLogRecordProcessor(
        OTLPLogExporter(endpoint=OTLP_ENDPOINT, insecure=True),
    )
)
set_logger_provider(logger_provider)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)
LoggingInstrumentor().instrument(set_logging_format=True)

app = Flask(__name__)
FlaskInstrumentor().instrument_app(app)
RequestsInstrumentor().instrument()


def background_noise():
    logger = logging.getLogger("demo.background")
    while True:
        value = random.randint(1, 100)
        if value % 5 == 0:
            logger.warning("background worker spotted a spike", extra={"value": value})
        else:
            logger.info("background worker heartbeat", extra={"value": value})
        with tracer.start_as_current_span("background.work") as span:
            span.set_attribute("demo.background.value", value)
            time.sleep(random.uniform(0.05, 0.2))
        time.sleep(2)


threading.Thread(target=background_noise, daemon=True).start()


@app.route("/")
@tag_wrapper({"endpoint": "root"})
def root():
    delay = random.uniform(0.05, 0.4)
    work_units = random.randint(1, 5)
    logger = logging.getLogger("demo.request")
    with tracer.start_as_current_span("demo.compute") as span:
        span.set_attribute("demo.delay_ms", delay * 1000)
        span.set_attribute("demo.work_units", work_units)
        compute_pi(work_units * 5000)
        time.sleep(delay)

    request_counter.add(1, {"endpoint": "root"})
    request_latency.record(delay, {"endpoint": "root"})
    logger.info("served /", extra={"delay": round(delay, 3), "units": work_units})
    return jsonify(
        message="demo service ok",
        delay_seconds=delay,
        work_units=work_units,
    )


@app.route("/error")
@tag_wrapper({"endpoint": "error"})
def fail():
    logger = logging.getLogger("demo.request")
    delay = random.uniform(0.01, 0.1)
    time.sleep(delay)
    request_counter.add(1, {"endpoint": "error"})
    request_latency.record(delay, {"endpoint": "error"})
    logger.error("intentional error requested")
    raise RuntimeError("Intentional demo error")


@app.errorhandler(Exception)
def handle_error(exc):
    logger = logging.getLogger("demo.errors")
    logger.exception("request failed", extra={"error": str(exc)})
    return jsonify(error=str(exc)), 500


@tag_wrapper({"function": "compute_pi"})
def compute_pi(iterations: int) -> float:
    # Basic Leibniz formula to keep CPU busy without external dependencies.
    total = 0.0
    sign = 1.0
    for i in range(iterations):
        total += sign / (2 * i + 1)
        sign *= -1.0
    return total * 4


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000)
