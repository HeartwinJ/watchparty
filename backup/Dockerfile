# Tiny sidecar for the nightly SQLite backup (built locally by `docker compose up`)
FROM alpine:3.24
RUN apk add --no-cache sqlite
COPY --chmod=755 backup.sh /usr/local/bin/backup.sh
# Same uid as the app, so it can use the WAL's shared-memory file and its backups
# end up owned by the same user as the database
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/backup.sh"]
