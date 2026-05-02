function labelValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function rangeSeries(response) {
  const result = response?.data?.result ?? [];
  return result.flatMap((series) => (series.values ?? []).map(([timestamp, value]) => ({
    t: Number(timestamp) * 1000,
    v: toNumber(value),
  }))).filter((point) => point.v !== null);
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
      cpuCores: `minecraft_container_cpu_usage_cores${selector}`,
      memoryPercent: `100 * minecraft_container_memory_usage_bytes${selector} / minecraft_container_memory_limit_bytes${selector}`,
      networkRxBps: `rate(minecraft_container_network_receive_bytes_total${selector}[1m])`,
      networkTxBps: `rate(minecraft_container_network_transmit_bytes_total${selector}[1m])`,
      playerSessions: `minecraft_player_session_seconds${selector}`,
    };

    const [
      playersOnlineRange,
      cpuRange,
      memoryRange,
      rxRange,
      txRange,
      idleRange,
      onlineNow,
      rconNow,
      idleNow,
      uptimeNow,
      playerSessionsNow,
    ] = await Promise.all([
      this.queryRange(queries.playersOnline, start, end, step),
      this.queryRange(queries.cpuCores, start, end, step),
      this.queryRange(queries.memoryPercent, start, end, step),
      this.queryRange(queries.networkRxBps, start, end, step),
      this.queryRange(queries.networkTxBps, start, end, step),
      this.queryRange(queries.idleSeconds, start, end, step),
      this.query(queries.playersOnline),
      this.query(queries.rconUp),
      this.query(queries.idleSeconds),
      this.query(queries.uptimeSeconds),
      this.query(queries.playerSessions),
    ]);

    return {
      enabled: true,
      range: { start, end, step },
      stats: {
        playersOnline: latestValue(onlineNow),
        rconUp: latestValue(rconNow),
        idleSeconds: latestValue(idleNow),
        uptimeSeconds: latestValue(uptimeNow),
      },
      series: {
        playersOnline: rangeSeries(playersOnlineRange),
        cpuCores: rangeSeries(cpuRange),
        memoryPercent: rangeSeries(memoryRange),
        networkRxBps: rangeSeries(rxRange),
        networkTxBps: rangeSeries(txRange),
        idleSeconds: rangeSeries(idleRange),
      },
      players: vectorValues(playerSessionsNow).map((item) => ({
        name: item.metric.player ?? 'unknown',
        sessionSeconds: item.value,
      })).sort((a, b) => b.sessionSeconds - a.sessionSeconds),
    };
  }
}
