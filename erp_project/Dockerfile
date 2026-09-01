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

# Build provenance, surfaced by app/api/health. Deliberately the LAST thing before
# CMD: an ARG invalidates the build cache for every layer below it and GIT_SHA
# changes on every commit, so anything above this stays cached.
#
# ARG and ENV are both needed and are not interchangeable — an ARG exists only
# while the image is being built and is gone by the time a container starts; the
# ENV is what survives into the running process. ARG receives, ENV keeps.
#
# APP_VERSION is the release name a person says out loud ("v1.2.0"), or the raw
# SHA on test where no tag is cut. GIT_SHA is the forensic one: a tag can be moved
# or deleted, a commit hash cannot lie.
ARG APP_VERSION=dev
ARG GIT_SHA=dev
ARG BUILD_TIME=unknown
ENV APP_VERSION=$APP_VERSION
ENV GIT_SHA=$GIT_SHA
ENV BUILD_TIME=$BUILD_TIME

CMD ["node", "server.js"]
