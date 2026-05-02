FROM eclipse-temurin:21-jre

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl nodejs procps util-linux \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /data
COPY container-entrypoint.sh /entrypoint.sh
COPY monitor.mjs /opt/mc-monitor/monitor.mjs

RUN chmod +x /entrypoint.sh /opt/mc-monitor/monitor.mjs

EXPOSE 25565/tcp 25575/tcp
ENTRYPOINT ["/entrypoint.sh"]
