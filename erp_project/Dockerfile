# syntax=docker/dockerfile:1

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# Without this the container runs UTC while every user is in India, so any
# server-rendered date disagrees with the same date rendered in the browser —
# by five and a half hours, and by a whole day around midnight. lib/date.ts
# still pins IST explicitly; this makes the host agree rather than be relied on.
ENV TZ=Asia/Kolkata

RUN groupadd -r nodejs && useradd -r -g nodejs nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

RUN mkdir -p /app/logs && chown nextjs:nodejs /app/logs
VOLUME /app/logs

USER nextjs

EXPOSE 3000

CMD ["node", "server.js"]
