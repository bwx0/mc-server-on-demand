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

const AUTH = 3;
const EXEC = 2;
let zeroPlayersSince = null;
let localStopStarted = false;

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
}

async function heartbeat() {
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

  const payload = {
    ...playerInfo,
    rconError,
    host: os.hostname(),
    loadavg: os.loadavg(),
    freeMemBytes: os.freemem(),
    totalMemBytes: os.totalmem(),
    disk: await diskUsage('/data'),
    at: new Date().toISOString(),
  };

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

for (;;) {
  try {
    await heartbeat();
  } catch (error) {
    console.error(error.message);
  }
  await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
}
