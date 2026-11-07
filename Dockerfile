FROM node:22-alpine AS deps

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-alpine

RUN apk add --no-cache postgresql16-client tar

ENV NODE_ENV=production
ENV UV_THREADPOOL_SIZE=8
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY server.js ./
COPY src ./src
COPY scripts ./scripts
COPY tests ./tests
COPY docs ./docs
COPY views ./views
COPY public ./public
COPY README.md ./

RUN mkdir -p /app/data && chown -R node:node /app/data

USER node
EXPOSE 3020
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=4 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3020) + '/readyz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "scripts/start.js"]
