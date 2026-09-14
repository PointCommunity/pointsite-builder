FROM docker.io/library/node:22.23.2-bookworm-slim@sha256:4d676821dff059fd00d277ee4261ef34ea712317fed0737c03941481b5760c96
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_DIRECTORY=/data/workspace RECOVERY_DIRECTORY=/recovery/control BACKUP_DIRECTORY=/backups/native
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node dist/client ./dist/client
COPY --chown=node:node dist/server ./dist/server
COPY --chown=node:node dist/release.json ./dist/release.json
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node recovery-migrations ./recovery-migrations
USER 1000:1000
EXPOSE 3000
CMD ["node", "dist/server/index.js"]
