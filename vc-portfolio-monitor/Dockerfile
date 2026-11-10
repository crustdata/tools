FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY tsconfig.json .env.example portfolio.example.csv ./
COPY src ./src
COPY config ./config
COPY fixtures ./fixtures
# Your portfolio.csv, if you use a file rather than a Google Sheet link (baked into the image; a Sheet link needs no rebuild).
COPY portfolio*.csv ./
ENV DB_PATH=/app/data/monitor.sqlite DIGEST_DIR=/app/data/digests
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME ["/app/data"]
# One run, then exit: schedule the container daily, after 06:00 UTC (Railway cron, Fly machine schedule, any cron).
# Each run imports the portfolio (free when nothing changed), runs the check, on the 1st of the month looks for new
# leaders, and on Mondays (UTC) sends the weekly digest. RUN_DIGEST=1 sends it every run, RUN_DIGEST=0 never. Every
# step runs even when an earlier one fails (a Slack hiccup must not skip the digest); the exit code is the worst one.
# Hosts mount volumes owned by root: when started as root, hand /app/data to the node user and drop root.
CMD ["sh", "-c", "RUN='rc=0; node --import tsx src/cli.ts import --yes || rc=$?; node --import tsx src/cli.ts check || { c=$?; [ $c -gt $rc ] && rc=$c; }; if [ \"$(date -u +%d)\" = 01 ]; then node --import tsx src/cli.ts refresh-leaders --yes || { c=$?; [ $c -gt $rc ] && rc=$c; }; fi; if [ \"$RUN_DIGEST\" = 1 ] || { [ \"$RUN_DIGEST\" != 0 ] && [ \"$(date -u +%u)\" = 1 ]; }; then node --import tsx src/cli.ts digest || { c=$?; [ $c -gt $rc ] && rc=$c; }; fi; exit $rc'; if [ \"$(id -u)\" = 0 ]; then chown -R node:node /app/data; exec setpriv --reuid=node --regid=node --init-groups sh -c \"$RUN\"; else exec sh -c \"$RUN\"; fi"]
