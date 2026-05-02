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

function clientIp(req) {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }
  return req.socket.remoteAddress;
}

function auditBase(req, action, details = {}) {
  return {
    action,
    role: req.controlRole ?? 'unknown',
    method: req.method,
    path: req.url,
    ip: clientIp(req),
    userAgent: req.headers['user-agent'],
    ...details,
  };
}

function resultSummary(result) {
  return {
    idempotent: result?.idempotent,
    phase: result?.state?.phase,
    runtimeId: result?.state?.runtimeId ?? result?.runtime?.runtimeId,
    runtimeName: result?.state?.runtimeName ?? result?.runtime?.runtimeName,
  };
}

async function auditedPageOperation(req, action, details, fn) {
  await store.audit('page-operation-start', auditBase(req, action, details));
  try {
    const result = await fn();
    await store.audit('page-operation-complete', auditBase(req, action, {
      ...details,
      result: resultSummary(result),
    }));
    return result;
  } catch (error) {
    await store.audit('page-operation-failed', auditBase(req, action, {
      ...details,
      error: error.message,
      status: error.status ?? 500,
    }));
    throw error;
  }
}

function publicState(state) {
  if (!state) return state;
  return {
    phase: state.phase,
    provider: state.provider,
    runtimeName: state.runtimeName,
    eipAddress: state.eipAddress,
    players: state.players,
    playerCount: state.playerCount,
    zeroPlayersSince: state.zeroPlayersSince,
    idleAlertSentAt: state.idleAlertSentAt,
    lastHeartbeatAt: state.lastHeartbeatAt,
    lastError: state.lastError,
    updatedAt: state.updatedAt,
  };
}

function publicSettings() {
  return {
    idleAutoStop: config.runtime.idleAutoStop,
    idleStopMinutes: config.runtime.idleStopMinutes,
  };
}

function responseForRole(data, role) {
  if (role === 'admin') {
    return { role, settings: publicSettings(), ...data };
  }
  return {
    role,
    settings: publicSettings(),
    idempotent: data.idempotent,
    message: data.message,
    state: publicState(data.state),
  };
}

function requireControl(req) {
  const token = req.headers['x-control-token'] || req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (token && token === config.app.adminToken) {
    req.controlRole = 'admin';
    return 'admin';
  }
  if (token && config.app.userToken && token === config.app.userToken) {
    req.controlRole = 'user';
    return 'user';
  }
  if (token && token === config.app.controlToken) {
    req.controlRole = 'admin';
    return 'admin';
  }
  {
    const error = new Error('Unauthorized');
    error.status = 401;
    throw error;
  }
}

function requireAdmin(req) {
  if (req.controlRole !== 'admin') {
    const error = new Error('Admin token required');
    error.status = 403;
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

  let role = null;
  if (url.pathname.startsWith('/api/')) {
    role = requireControl(req);
  }

  if (url.pathname === '/api/status' && req.method === 'GET') {
    return send(res, 200, responseForRole(await orchestrator.status(), role));
  }

  if (url.pathname === '/api/preflight' && req.method === 'GET') {
    const result = await auditedPageOperation(req, 'preflight', {}, async () => {
      requireAdmin(req);
      return orchestrator.preflight();
    });
    return send(res, 200, { role, ...result });
  }

  if (url.pathname === '/api/start' && req.method === 'POST') {
    const result = await auditedPageOperation(req, 'start', {}, () => orchestrator.start());
    return send(res, 200, responseForRole(result, role));
  }

  if (url.pathname === '/api/stop' && req.method === 'POST') {
    const body = await readJson(req);
    const force = body.force === true;
    const result = await auditedPageOperation(req, force ? 'force-stop' : 'graceful-stop', { force }, () => orchestrator.stop({ force }));
    return send(res, 200, responseForRole(result, role));
  }

  return send(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    const status = error.status || 500;
    if (req.url?.startsWith('/api/') && req.url !== '/api/runtime/heartbeat') {
      store.audit('page-operation-error', auditBase(req, 'request', {
        error: error.message,
        status,
      })).catch((auditError) => console.error(`audit failed: ${auditError.message}`));
    }
    send(res, status, {
      error: error.message,
      state: req.controlRole === 'user' ? publicState(error.state) : error.state,
    });
  });
});

server.listen(config.app.port, config.app.host, () => {
  console.log(`Control plane listening on http://${config.app.host}:${config.app.port}`);
});
