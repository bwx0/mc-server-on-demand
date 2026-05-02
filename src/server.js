import http from 'node:http';
import { URL } from 'node:url';
import { loadConfig } from './config.js';
import { AliyunPop } from './cloud/aliyun-pop.js';
import { Orchestrator } from './orchestrator.js';
import { StateStore } from './store.js';
import { renderUi } from './ui.js';

const config = loadConfig();
const store = new StateStore(config);
const pop = new AliyunPop(config);
const orchestrator = new Orchestrator(config, pop, store);

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function requireControl(req) {
  const token = req.headers['x-control-token'] || req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token || token !== config.app.controlToken) {
    const error = new Error('Unauthorized');
    error.status = 401;
    throw error;
  }
}

function requireRuntime(req) {
  const token = req.headers['x-runtime-token'];
  if (!token || token !== config.app.runtimeToken) {
    const error = new Error('Unauthorized runtime');
    error.status = 401;
    throw error;
  }
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/') {
    return send(res, 200, renderUi());
  }

  if (url.pathname === '/healthz') {
    return send(res, 200, { ok: true });
  }

  if (url.pathname === '/api/runtime/heartbeat' && req.method === 'POST') {
    requireRuntime(req);
    const body = await readJson(req);
    const state = await orchestrator.heartbeat(body);
    return send(res, 200, state);
  }

  if (url.pathname.startsWith('/api/')) {
    requireControl(req);
  }

  if (url.pathname === '/api/status' && req.method === 'GET') {
    return send(res, 200, await orchestrator.status());
  }

  if (url.pathname === '/api/preflight' && req.method === 'GET') {
    return send(res, 200, await orchestrator.preflight());
  }

  if (url.pathname === '/api/start' && req.method === 'POST') {
    return send(res, 200, await orchestrator.start());
  }

  if (url.pathname === '/api/stop' && req.method === 'POST') {
    const body = await readJson(req);
    return send(res, 200, await orchestrator.stop({ force: body.force === true }));
  }

  return send(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    const status = error.status || 500;
    send(res, status, {
      error: error.message,
      state: error.state,
    });
  });
});

server.listen(config.app.port, config.app.host, () => {
  console.log(`Control plane listening on http://${config.app.host}:${config.app.port}`);
});
