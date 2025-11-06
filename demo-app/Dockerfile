FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

ENV OTEL_EXPORTER_OTLP_ENDPOINT=http://alloy:4317 \
    OTEL_EXPORTER_OTLP_PROTOCOL=grpc \
    OTEL_SERVICE_NAME=demo-app \
    OTEL_PYTHON_LOG_CORRELATION=true \
    OTEL_METRIC_EXPORT_INTERVAL=5000 \
    PYROSCOPE_SERVER_ADDRESS=http://pyroscope:4040 \
    PYROSCOPE_ENV=local

EXPOSE 8000

CMD ["python", "app.py"]
