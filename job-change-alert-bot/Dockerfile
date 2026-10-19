FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY tsconfig.json .env.example ./
COPY src ./src
COPY fixtures ./fixtures
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME ["/app/data"]
EXPOSE 3000
# Hosts such as Railway and Fly mount volumes owned by root. When started as root, hand /app/data to the node user and
# drop root (setpriv ships with util-linux in the Debian base image); when the host already runs us as a user, just start.
CMD ["sh", "-c", "if [ \"$(id -u)\" = 0 ]; then chown -R node:node /app/data; exec setpriv --reuid=node --regid=node --init-groups node --import tsx src/server.ts; else exec node --import tsx src/server.ts; fi"]
