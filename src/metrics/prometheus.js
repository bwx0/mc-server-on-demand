function labelValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function rangeSeries(response) {
  const result = response?.data?.result ?? [];
  const points = result.flatMap((series) => (series.values ?? []).map(([timestamp, value]) => ({
    t: Number(timestamp) * 1000,
    v: toNumber(value),
  }))).filter((point) => point.v !== null);
  points.sort((a, b) => a.t - b.t);
  const merged = [];
  for (const point of points) {
    const prev = merged[merged.length - 1];
    if (prev && prev.t === point.t) {
      prev.v = point.v;
    } else {
      merged.push({ t: point.t, v: point.v });
    }
  }
  return merged;
}

function vectorValues(response) {
  const result = response?.data?.result ?? [];
  return result.map((item) => ({
    metric: item.metric ?? {},
    value: toNumber(item.value?.[1]),
  })).filter((item) => item.value !== null);
}

function latestValue(response) {
  return vectorValues(response)[0]?.value ?? null;
}

export class PrometheusClient {
  constructor(config) {
    this.config = config;
    this.baseUrl = config.prometheus.httpApiUrl?.replace(/\/+$/, '');
  }

  enabled() {
    return Boolean(this.baseUrl && this.config.prometheus.accessKeyId && this.config.prometheus.accessKeySecret);
  }

  authHeader() {
    const raw = `${this.config.prometheus.accessKeyId}:${this.config.prometheus.accessKeySecret}`;
    return `Basic ${Buffer.from(raw).toString('base64')}`;
  }

  async request(path, params) {
    if (!this.enabled()) {
      return { disabled: true };
    }
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        authorization: this.authHeader(),
      },
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`Prometheus API failed: ${response.status} ${response.statusText} ${JSON.stringify(body)}`);
    }
    return body;
  }

  query(query) {
    return this.request('/api/v1/query', {
      query,
      timeout: 10000,
    });
  }

  queryRange(query, start, end, step) {
    return this.request('/api/v1/query_range', {
      query,
      start,
      end,
      step,
      timeout: 10000,
    });
  }

  async dashboard() {
    if (!this.enabled()) {
      return {
        enabled: false,
        message: 'Set PROM_HTTP_API_URL, PROM_ACCESS_KEY_ID, and PROM_ACCESS_KEY_SECRET to enable embedded metrics.',
      };
    }

    const server = labelValue(this.config.prometheus.serverLabel);
    const selector = `{server="${server}"}`;
    const end = Math.floor(Date.now() / 1000);
    const start = end - this.config.prometheus.rangeMinutes * 60;
    const step = `${this.config.prometheus.stepSeconds}s`;

    const queries = {
      playersOnline: `minecraft_players_online${selector}`,
      rconUp: `minecraft_rcon_up${selector}`,
      idleSeconds: `minecraft_idle_seconds${selector}`,
      uptimeSeconds: `minecraft_runtime_uptime_seconds${selector}`,
      diskUsagePercent: `100 * (1 - minecraft_disk_free_bytes${selector} / minecraft_disk_total_bytes${selector})`,
      diskTotalBytes: `minecraft_disk_total_bytes${selector}`,
      diskFreeBytes: `minecraft_disk_free_bytes${selector}`,
      cpuCores: `minecraft_container_cpu_usage_cores${selector} or minecraft_java_cpu_usage_cores${selector} or minecraft_process_cpu_usage_cores${selector}`,
      memoryPercent: `100 * minecraft_container_memory_usage_bytes${selector} / minecraft_container_memory_limit_bytes${selector}`,
      networkRxBps: `rate(minecraft_container_network_receive_bytes_total${selector}[1m])`,
      networkTxBps: `rate(minecraft_container_network_transmit_bytes_total${selector}[1m])`,
      playerSessions: `minecraft_player_session_seconds${selector}`,
      playerDuration7d: `sum by (player) (sum_over_time(minecraft_player_online${selector}[${this.config.prometheus.playerRangeDays}d]) * ${this.config.runtime.promPushIntervalMs / 1000})`,
    };

    const [
      playersOnlineRange,
      cpuRange,
      memoryRange,
      diskUsageRange,
      rxRange,
      txRange,
      idleRange,
      onlineNow,
      rconNow,
      idleNow,
      uptimeNow,
      diskUsageNow,
      diskTotalNow,
      diskFreeNow,
      playerSessionsNow,
      playerDuration7d,
    ] = await Promise.all([
      this.queryRange(queries.playersOnline, start, end, step),
      this.queryRange(queries.cpuCores, start, end, step),
      this.queryRange(queries.memoryPercent, start, end, step),
      this.queryRange(queries.diskUsagePercent, start, end, step),
      this.queryRange(queries.networkRxBps, start, end, step),
      this.queryRange(queries.networkTxBps, start, end, step),
      this.queryRange(queries.idleSeconds, start, end, step),
      this.query(queries.playersOnline),
      this.query(queries.rconUp),
      this.query(queries.idleSeconds),
      this.query(queries.uptimeSeconds),
      this.query(queries.diskUsagePercent),
      this.query(queries.diskTotalBytes),
      this.query(queries.diskFreeBytes),
      this.query(queries.playerSessions),
      this.query(queries.playerDuration7d),
    ]);

    return {
      enabled: true,
      range: { start, end, step },
      playerRange: { days: this.config.prometheus.playerRangeDays },
      stats: {
        playersOnline: latestValue(onlineNow),
        rconUp: latestValue(rconNow),
        idleSeconds: latestValue(idleNow),
        uptimeSeconds: latestValue(uptimeNow),
        diskUsagePercent: latestValue(diskUsageNow),
        diskTotalBytes: latestValue(diskTotalNow),
        diskFreeBytes: latestValue(diskFreeNow),
      },
      series: {
        playersOnline: rangeSeries(playersOnlineRange),
        cpuCores: rangeSeries(cpuRange),
        memoryPercent: rangeSeries(memoryRange),
        diskUsagePercent: rangeSeries(diskUsageRange),
        networkRxBps: rangeSeries(rxRange),
        networkTxBps: rangeSeries(txRange),
        idleSeconds: rangeSeries(idleRange),
      },
      players: vectorValues(playerSessionsNow).map((item) => ({
        name: item.metric.player ?? 'unknown',
        sessionSeconds: item.value,
      })).sort((a, b) => b.sessionSeconds - a.sessionSeconds),
      playerDurations: vectorValues(playerDuration7d).map((item) => ({
        name: item.metric.player ?? 'unknown',
        seconds: item.value,
      })).sort((a, b) => b.seconds - a.seconds),
    };
  }
}
