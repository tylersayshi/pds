# Deployer: tiny Node webhook receiver + the docker CLI/compose plugin so it can
# run `docker compose pull/up` against the host daemon (socket mounted in compose).
FROM node:24-alpine

RUN apk add --no-cache docker-cli docker-cli-compose

WORKDIR /app
COPY server.js ./

# Zero npm dependencies — nothing to install.
ENV NODE_ENV=production
EXPOSE 8787
CMD ["node", "server.js"]
