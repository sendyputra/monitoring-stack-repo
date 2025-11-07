FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY src ./src

EXPOSE 9216
CMD ["npm", "start"]
