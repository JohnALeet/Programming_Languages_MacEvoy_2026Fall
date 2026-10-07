# Node 24 is the current long-term-support line.
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

# Install exactly the versions package-lock.json pins, production dependencies
# only. Copying the manifests before the code lets Docker reuse this layer when
# only the code changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Run as the image's unprivileged user, not root.
USER node
EXPOSE 3000

# `node` directly rather than `npm start`, so the SIGTERM sent by
# `docker compose stop` reaches the server's shutdown handler in index.js.
CMD ["node", "index.js"]
