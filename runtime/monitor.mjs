#!/usr/bin/env node
import os from 'node:os';
import fs from 'node:fs/promises';
import net from 'node:net';

const CONTROL_PLANE_URL = process.env.CONTROL_PLANE_URL;
const RUNTIME_TOKEN = process.env.RUNTIME_TOKEN;
const RCON_HOST = process.env.MINECRAFT_RCON_HOST || '127.0.0.1';
const RCON_PORT = Number(process.env.MINECRAFT_RCON_PORT || 25575);
const RCON_PASSWORD = process.env.MINECRAFT_RCON_PASSWORD;
const INTERVAL_MS = Number(process.env.MONITOR_INTERVAL_MS || 30000);
const MONITOR_DEBUG = ['1', 'true', 'yes', 'on'].includes(String(process.env.MONITOR_DEBUG || '').toLowerCase());
const IDLE_AUTO_STOP = !['0', 'false', 'no', 'off'].includes(String(process.env.IDLE_AUTO_STOP ?? 'true').toLowerCase());
const IDLE_STOP_MS = Number(process.env.IDLE_STOP_MINUTES || 10) * 60 * 1000;
const LOCAL_STOP_EXIT_GRACE_MS = Number(process.env.LOCAL_STOP_EXIT_GRACE_SECONDS || 60) * 1000;
const PROM_PUSHGATEWAY_URL = process.env.PROM_PUSHGATEWAY_URL;
const PROM_PUSH_INTERVAL_MS = Number(process.env.PROM_PUSH_INTERVAL_MS || 10000);
const PROM_PUSH_METHOD = process.env.PROM_PUSH_METHOD || 'POST';
const PROM_JOB = process.env.PROM_JOB || 'minecraft';
const PROM_INSTANCE = process.env.PROM_INSTANCE || os.hostname();
const PROM_SERVER_LABEL = process.env.PROM_SERVER_LABEL || 'mc';
const RUNTIME_STARTED_AT = Date.now();

const AUTH = 3;
const EXEC = 2;
let zeroPlayersSince = null;
let localStopStarted = false;
let lastControlHeartbeatAt = 0;
let lastPromPushAt = 0;
let lastCpuSample = null;
let lastProcessCpuSample = null;
const playerJoinedAt = new Map();

console.log(JSON.stringify({
  type: 'monitor-start',
  version: '2026-05-03-prometheus-push-v2',
  controlPlaneEnabled: Boolean(CONTROL_PLANE_URL && RUNTIME_TOKEN),
  monitorIntervalMs: INTERVAL_MS,
  monitorDebug: MONITOR_DEBUG,
  idleAutoStop: IDLE_AUTO_STOP,
  idleStopMinutes: IDLE_STOP_MS / 60000,
  promPushEnabled: Boolean(PROM_PUSHGATEWAY_URL),
  promPushIntervalMs: PROM_PUSH_INTERVAL_MS,
  promPushMethod: PROM_PUSH_METHOD,
  promJob: PROM_JOB,
  promInstance: PROM_INSTANCE,
  promServerLabel: PROM_SERVER_LABEL,
  at: new Date().toISOString(),
}));

function packet(id, type, body) {
  const payload = Buffer.from(body, 'utf8');
  const out = Buffer.alloc(4 + 4 + 4 + payload.length + 2);
  out.writeInt32LE(4 + 4 + payload.length + 2, 0);
  out.writeInt32LE(id, 4);
  out.writeInt32LE(type, 8);
  payload.copy(out, 12);
  out.writeInt16LE(0, 12 + payload.length);
  return out;
}

async function readPacket(socket) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => reject(new Error('RCON timed out')), 5000);
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readInt32LE(0);
      if (buffer.length < length + 4) return;
      clearTimeout(timer);
      resolve({
        id: buffer.readInt32LE(4),
        body: buffer.slice(12, 4 + length - 2).toString('utf8'),
      });
    });
  });
}

async function rcon(command) {
  if (!RCON_PASSWORD) throw new Error('MINECRAFT_RCON_PASSWORD is not set');
  const socket = net.createConnection({ host: RCON_HOST, port: RCON_PORT });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  try {
    socket.write(packet(1, AUTH, RCON_PASSWORD));
    const auth = await readPacket(socket);
    if (auth.id === -1) throw new Error('RCON auth failed');
    socket.write(packet(2, EXEC, command));
    return (await readPacket(socket)).body;
  } finally {
    socket.end();
  }
}

function parsePlayerNames(value) {
  return value
    .replace(/\r/g, '\n')
    .split(/[,\n]/)
    .map((name) => name.trim())
    .filter(Boolean);
}

function parsePlayers(listOutput) {
  const raw = String(listOutput || '').trim();
  const patterns = [
    /There are\s+(\d+)\s+of\s+a\s+max\s+of\s+\d+\s+players\s+online:?\s*([\s\S]*)/i,
    /There are\s+(\d+)\s*\/\s*\d+\s+players\s+online:?\s*([\s\S]*)/i,
    /当前在线玩家(?:数)?[：: ]*\s*(\d+)[^\n：:]*[：:]?\s*([\s\S]*)/i,
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match) {
      const playerCount = Number(match[1]);
      const players = parsePlayerNames(match[2] || '');
      return {
        playerCount,
        players,
        raw,
        parseStatus: 'matched',
      };
    }
  }

  return {
    playerCount: 0,
    players: [],
    raw,
    parseStatus: raw ? 'unmatched' : 'empty',
  };
}

async function diskUsage(path) {
  try {
    const stat = await fs.statfs(path);
    return {
      path,
      totalBytes: stat.blocks * stat.bsize,
      freeBytes: stat.bfree * stat.bsize,
      availableBytes: stat.bavail * stat.bsize,
    };
  } catch {
    return null;
  }
}

async function readText(path) {
  try {
    return await fs.readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function cgroupMemory() {
  const current = await readText('/sys/fs/cgroup/memory.current');
  const max = await readText('/sys/fs/cgroup/memory.max');
  if (!current) {
    return {
      currentBytes: os.totalmem() - os.freemem(),
      maxBytes: os.totalmem(),
    };
  }
  return {
    currentBytes: Number(current.trim()),
    maxBytes: max?.trim() === 'max' ? os.totalmem() : Number(max?.trim() || os.totalmem()),
  };
}

async function cgroupCpuUsageCores() {
  const raw = await readText('/sys/fs/cgroup/cpu.stat');
  if (!raw) return null;
  const usageLine = raw.split('\n').find((line) => line.startsWith('usage_usec '));
  if (!usageLine) return null;
  const usageUsec = Number(usageLine.split(/\s+/)[1]);
  const now = Date.now();
  const previous = lastCpuSample;
  lastCpuSample = { usageUsec, at: now };
  if (!previous) return null;
  const usageDeltaMs = (usageUsec - previous.usageUsec) / 1000;
  const wallDeltaMs = now - previous.at;
  return wallDeltaMs > 0 ? usageDeltaMs / wallDeltaMs : null;
}

function processCpuUsageCores() {
  const usage = process.cpuUsage();
  const usageUsec = usage.user + usage.system;
  const now = Date.now();
  const previous = lastProcessCpuSample;
  lastProcessCpuSample = { usageUsec, at: now };
  if (!previous) return null;
  const usageDeltaMs = (usageUsec - previous.usageUsec) / 1000;
  const wallDeltaMs = now - previous.at;
  return wallDeltaMs > 0 ? usageDeltaMs / wallDeltaMs : null;
}

async function networkUsage() {
  const raw = await readText('/proc/net/dev');
  if (!raw) return null;
  let receiveBytes = 0;
  let transmitBytes = 0;
  for (const line of raw.split('\n').slice(2)) {
    const [namePart, dataPart] = line.split(':');
    if (!dataPart) continue;
    const name = namePart.trim();
    if (!name || name === 'lo') continue;
    const fields = dataPart.trim().split(/\s+/).map(Number);
    receiveBytes += fields[0] || 0;
    transmitBytes += fields[8] || 0;
  }
  return { receiveBytes, transmitBytes };
}

function updatePlayerSessions(players) {
  const now = Date.now();
  const online = new Set(players);
  for (const player of players) {
    if (!playerJoinedAt.has(player)) {
      playerJoinedAt.set(player, now);
    }
  }
  for (const player of playerJoinedAt.keys()) {
    if (!online.has(player)) {
      playerJoinedAt.delete(player);
    }
  }
}

async function localIdleStop(playerInfo, rconError) {
  if (!IDLE_AUTO_STOP || localStopStarted || rconError || playerInfo.parseStatus !== 'matched') {
    if (playerInfo.playerCount > 0) zeroPlayersSince = null;
    return;
  }

  if (playerInfo.playerCount > 0) {
    zeroPlayersSince = null;
    return;
  }

  const now = Date.now();
  zeroPlayersSince ??= now;
  if (now - zeroPlayersSince < IDLE_STOP_MS) return;

  localStopStarted = true;
  console.log(JSON.stringify({
    type: 'local-idle-stop-triggered',
    idleStopMinutes: IDLE_STOP_MS / 60000,
    zeroPlayersSince: new Date(zeroPlayersSince).toISOString(),
    at: new Date().toISOString(),
  }));

  await rcon('say Server is stopping because no players are online. World will be saved.');
  await new Promise((resolve) => setTimeout(resolve, 5000));
  await rcon('save-all flush');
  await rcon('stop');

  // If the server wrapper script does not exit after Minecraft stops, the ECI
  // container can stay alive. Terminate PID 1 after a grace period so the
  // container reaches a terminal state.
  setTimeout(() => {
    try {
      console.log(JSON.stringify({
        type: 'local-idle-stop-terminating-pid1',
        graceSeconds: LOCAL_STOP_EXIT_GRACE_MS / 1000,
        at: new Date().toISOString(),
      }));
      process.kill(1, 'SIGTERM');
    } catch (error) {
      console.error(`failed to terminate pid 1: ${error.message}`);
    }
  }, LOCAL_STOP_EXIT_GRACE_MS).unref();
}

async function collectPayload() {
  let playerInfo = { playerCount: 0, players: [], raw: null };
  let rconError = null;
  try {
    const listOutput = await rcon('list');
    playerInfo = parsePlayers(listOutput);
    if (MONITOR_DEBUG) {
      console.log(JSON.stringify({
        type: 'rcon-list',
        output: listOutput,
        parsed: playerInfo,
        at: new Date().toISOString(),
      }));
    }
  } catch (error) {
    rconError = error.message;
  }

  await localIdleStop(playerInfo, rconError);
  updatePlayerSessions(playerInfo.players);

  return {
    ...playerInfo,
    rconError,
    host: os.hostname(),
    loadavg: os.loadavg(),
    freeMemBytes: os.freemem(),
    totalMemBytes: os.totalmem(),
    disk: await diskUsage('/data'),
    cgroupMemory: await cgroupMemory(),
    cpuUsageCores: await cgroupCpuUsageCores(),
    processCpuUsageCores: processCpuUsageCores(),
    network: await networkUsage(),
    at: new Date().toISOString(),
  };
}

async function heartbeat(payload) {
  if (!CONTROL_PLANE_URL || !RUNTIME_TOKEN) {
    console.log(JSON.stringify(payload));
    return;
  }

  const response = await fetch(new URL('/api/runtime/heartbeat', CONTROL_PLANE_URL), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-runtime-token': RUNTIME_TOKEN,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`heartbeat failed: ${response.status} ${response.statusText}`);
  }
  if (MONITOR_DEBUG) {
    console.log(JSON.stringify({
      type: 'heartbeat-ok',
      playerCount: payload.playerCount,
      players: payload.players,
      at: payload.at,
    }));
  }
}

function escapeLabel(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function labels(extra = {}) {
  const all = {
    server: PROM_SERVER_LABEL,
    instance: PROM_INSTANCE,
    ...extra,
  };
  return `{${Object.entries(all).map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(',')}}`;
}

function metricLine(name, value, extraLabels) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return null;
  return `${name}${labels(extraLabels)} ${Number(value)}`;
}

function prometheusText(payload) {
  const idleSeconds = zeroPlayersSince ? Math.floor((Date.now() - zeroPlayersSince) / 1000) : 0;
  const lines = [
    '# TYPE minecraft_players_online gauge',
    metricLine('minecraft_players_online', payload.playerCount, {}),
    '# TYPE minecraft_rcon_up gauge',
    metricLine('minecraft_rcon_up', payload.rconError ? 0 : 1, {}),
    '# TYPE minecraft_idle_seconds gauge',
    metricLine('minecraft_idle_seconds', idleSeconds, {}),
    '# TYPE minecraft_runtime_uptime_seconds gauge',
    metricLine('minecraft_runtime_uptime_seconds', Math.floor((Date.now() - RUNTIME_STARTED_AT) / 1000), {}),
    '# TYPE minecraft_disk_total_bytes gauge',
    metricLine('minecraft_disk_total_bytes', payload.disk?.totalBytes, {}),
    '# TYPE minecraft_disk_free_bytes gauge',
    metricLine('minecraft_disk_free_bytes', payload.disk?.freeBytes, {}),
    '# TYPE minecraft_disk_available_bytes gauge',
    metricLine('minecraft_disk_available_bytes', payload.disk?.availableBytes, {}),
    '# TYPE minecraft_container_memory_usage_bytes gauge',
    metricLine('minecraft_container_memory_usage_bytes', payload.cgroupMemory?.currentBytes, {}),
    '# TYPE minecraft_container_memory_limit_bytes gauge',
    metricLine('minecraft_container_memory_limit_bytes', payload.cgroupMemory?.maxBytes, {}),
    '# TYPE minecraft_container_cpu_usage_cores gauge',
    metricLine('minecraft_container_cpu_usage_cores', payload.cpuUsageCores, {}),
    '# TYPE minecraft_process_cpu_usage_cores gauge',
    metricLine('minecraft_process_cpu_usage_cores', payload.processCpuUsageCores, {}),
    '# TYPE minecraft_container_network_receive_bytes_total counter',
    metricLine('minecraft_container_network_receive_bytes_total', payload.network?.receiveBytes, {}),
    '# TYPE minecraft_container_network_transmit_bytes_total counter',
    metricLine('minecraft_container_network_transmit_bytes_total', payload.network?.transmitBytes, {}),
    '# TYPE minecraft_system_load1 gauge',
    metricLine('minecraft_system_load1', payload.loadavg?.[0], {}),
    '# TYPE minecraft_system_load5 gauge',
    metricLine('minecraft_system_load5', payload.loadavg?.[1], {}),
    '# TYPE minecraft_system_load15 gauge',
    metricLine('minecraft_system_load15', payload.loadavg?.[2], {}),
  ].filter(Boolean);

  for (const player of payload.players) {
    lines.push(metricLine('minecraft_player_online', 1, { player }));
    lines.push(metricLine('minecraft_player_session_seconds', Math.floor((Date.now() - playerJoinedAt.get(player)) / 1000), { player }));
  }

  return `${lines.join('\n')}\n`;
}

function pushGatewayUrl() {
  if (!PROM_PUSHGATEWAY_URL) return null;
  const base = PROM_PUSHGATEWAY_URL.replace(/\/+$/, '');
  if (base.includes('/metrics/job/')) return base;
  return `${base}/metrics/job/${encodeURIComponent(PROM_JOB)}/instance/${encodeURIComponent(PROM_INSTANCE)}`;
}

async function pushPrometheus(payload) {
  const url = pushGatewayUrl();
  if (!url) {
    if (MONITOR_DEBUG) {
      console.log(JSON.stringify({
        type: 'pushgateway-disabled',
        reason: 'PROM_PUSHGATEWAY_URL is empty',
        at: payload.at,
      }));
    }
    return;
  }
  const response = await fetch(url, {
    method: PROM_PUSH_METHOD,
    headers: {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
    },
    body: prometheusText(payload),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`pushgateway failed: ${response.status} ${response.statusText} ${text}`);
  }
  if (MONITOR_DEBUG) {
    console.log(JSON.stringify({
      type: 'pushgateway-ok',
      url,
      method: PROM_PUSH_METHOD,
      playerCount: payload.playerCount,
      at: payload.at,
    }));
  }
}

for (;;) {
  try {
    const now = Date.now();
    const payload = await collectPayload();
    if (now - lastPromPushAt >= PROM_PUSH_INTERVAL_MS) {
      try {
        await pushPrometheus(payload);
        lastPromPushAt = now;
      } catch (error) {
        console.error(error.message);
      }
    }
    if (now - lastControlHeartbeatAt >= INTERVAL_MS) {
      try {
        await heartbeat(payload);
        lastControlHeartbeatAt = now;
      } catch (error) {
        console.error(error.message);
      }
    }
  } catch (error) {
    console.error(error.message);
  }
  await new Promise((resolve) => setTimeout(resolve, Math.min(INTERVAL_MS, PROM_PUSH_INTERVAL_MS)));
}
