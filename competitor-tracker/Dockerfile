FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY tsconfig.json .env.example ./
COPY src ./src
COPY config ./config
COPY fixtures ./fixtures
# Your competitors.json (from npm run setup) is copied to the volume on the first run; after that the volume copy is used.
COPY competitors*.json ./
ENV COMPETITORS_FILE=/app/data/competitors.json DIGEST_DIR=/app/data/digests
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME ["/app/data"]
# One weekly run, then exit: schedule the container (Railway cron, Fly machine schedule, any cron).
# Each run first sets up anything missing (free when nothing changed), then builds the digest. A failed setup stops the run.
# Hosts mount volumes owned by root: when started as root, hand /app/data to the node user and drop root.
CMD ["sh", "-c", "RUN='(test -f data/competitors.json || cp competitors.json data/competitors.json); node --import tsx src/cli.ts init --yes && exec node --import tsx src/cli.ts digest'; if [ \"$(id -u)\" = 0 ]; then chown -R node:node /app/data; exec setpriv --reuid=node --regid=node --init-groups sh -c \"$RUN\"; else exec sh -c \"$RUN\"; fi"]
