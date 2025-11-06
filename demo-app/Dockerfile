FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY otel.js ./otel.js
COPY src ./src

ENV NODE_ENV=production \
    PORT=8000 \
    LOG_LEVEL=info \
    OTEL_EXPORTER_OTLP_ENDPOINT=http://alloy:4317 \
    OTEL_SERVICE_NAME=demo-node-app \
    DEMO_ENVIRONMENT=local \
    MONGO_URL=mongodb://mongo:27017 \
    MONGO_DB_NAME=monitoring_demo \
    REDIS_URL=redis://redis:6379

EXPOSE 8000

CMD ["npm", "start"]
