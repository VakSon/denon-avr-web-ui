# Zero-dependency app, so a tiny single-stage image is all we need.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

WORKDIR /app

# Copy only what the app needs (no build step, no dependencies to install).
COPY package.json denon.js server.js ./
COPY public ./public

# /data holds receivers.json; make it writable by the non-root 'node' user and
# expose it as a volume so the receiver list survives container restarts.
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]

USER node
EXPOSE 3000

CMD ["node", "server.js"]
