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

const AUTH = 3;
const EXEC = 2;

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

function parsePlayers(listOutput) {
  const match = listOutput.match(/There are (\d+) of a max of \d+ players online: ?(.*)$/i);
  if (!match) return { playerCount: 0, players: [], raw: listOutput };
  const playerCount = Number(match[1]);
  const players = match[2] ? match[2].split(',').map((name) => name.trim()).filter(Boolean) : [];
  return { playerCount, players, raw: listOutput };
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

async function heartbeat() {
  let playerInfo = { playerCount: 0, players: [], raw: null };
  let rconError = null;
  try {
    playerInfo = parsePlayers(await rcon('list'));
  } catch (error) {
    rconError = error.message;
  }

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
}

for (;;) {
  try {
    await heartbeat();
  } catch (error) {
    console.error(error.message);
  }
  await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
}
