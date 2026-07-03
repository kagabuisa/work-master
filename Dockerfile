FROM node:22-alpine AS deps

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY server.js ./
COPY src ./src
COPY views ./views
COPY public ./public
COPY README.md ./

RUN mkdir -p /app/data && chown -R node:node /app/data

USER node
EXPOSE 3020

CMD ["npm", "start"]
