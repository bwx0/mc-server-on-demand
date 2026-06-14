FROM debian:12-slim

ENV DEBIAN_FRONTEND=noninteractive

# Recovery/maintenance toolbox: SSH for manual save operations, Python for
# scripting, JDK for Minecraft-related tooling, nginx to expose /data for file
# download, plus common file tools.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     bash ca-certificates curl \
     openssh-server openssh-client \
     nginx \
     openjdk-21-jdk-headless \
     python3 python3-pip python3-venv \
     less nano vim-tiny unzip zip rsync procps util-linux coreutils tzdata \
  && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 22: SSH, 80: nginx file listing of /data
EXPOSE 22/tcp 80/tcp

ENTRYPOINT ["/entrypoint.sh"]
