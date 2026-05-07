import { AlertService } from './alerts.js';
import { EciProvider } from './cloud/eci-provider.js';
import { EcsProvider } from './cloud/ecs-provider.js';
import { runPreflight } from './cloud/preflight.js';
import { RconClient } from './minecraft/rcon.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function terminalPhase(phase) {
  return ['stopped', 'failed'].includes(phase);
}

function canStart(state) {
  return state.phase === 'stopped' || (state.phase === 'failed' && !state.runtimeId);
}

function runtimeReady(payload) {
  if (payload.rconError) return false;
  if (payload.parseStatus === 'matched') return true;

  // Older runtime images do not send parseStatus. Treat a valid RCON list
  // response as ready so already-running servers can leave initializing.
  const raw = String(payload.raw ?? '');
  return /There are\s+\d+\s+of\s+a\s+max\s+of\s+\d+\s+players\s+online/i.test(raw)
    || /There are\s+\d+\s*\/\s*\d+\s+players\s+online/i.test(raw);
}

function gracefulStopAllowed(phase) {
  return !['starting', 'initializing'].includes(phase);
}

function runtimeAlreadyEnded(cloud) {
  if (!cloud) return false;
  if (cloud.missing) return true;
  const status = String(
    cloud.Status
      ?? cloud.status
      ?? cloud.State
      ?? cloud.state
      ?? cloud.InstanceStatus
      ?? cloud.instanceStatus
      ?? '',
  ).toLowerCase();
  if (!status) return false;
  return ['stopped', 'terminated', 'succeeded', 'failed', 'finished'].some((s) => status.includes(s));
}

function shouldDeferMissingReset(state, config) {
  const now = Date.now();
  const startupGraceMs = 20 * 1000;
  const heartbeatGraceMs = Math.max(20 * 1000, Number(config.runtime.monitorIntervalMs || 30000) * 3);
  const updatedAtMs = state.updatedAt ? new Date(state.updatedAt).getTime() : 0;
  const lastHeartbeatMs = state.lastHeartbeatAt ? new Date(state.lastHeartbeatAt).getTime() : 0;

  if (['starting', 'initializing'].includes(state.phase)) {
    if (!updatedAtMs || Number.isNaN(updatedAtMs)) return true;
    return now - updatedAtMs < startupGraceMs;
  }

  if (state.phase === 'running' && lastHeartbeatMs && !Number.isNaN(lastHeartbeatMs)) {
    return now - lastHeartbeatMs < heartbeatGraceMs;
  }

  return false;
}

export class Orchestrator {
  constructor(config, pop, store) {
    this.config = config;
    this.pop = pop;
    this.store = store;
    this.alerts = new AlertService(config);
    this.providers = {
      eci: new EciProvider(config, pop),
      ecs: new EcsProvider(config, pop),
    };
    this.lockedUntil = 0;
  }

  provider(name = this.config.runtime.provider) {
    const provider = this.providers[name];
    if (!provider) throw new Error(`Unsupported runtime provider: ${name}`);
    return provider;
  }

  async withLock(action, fn) {
    const now = Date.now();
    if (this.lockedUntil > now) {
      throw new Error(`Another lifecycle action is in progress: ${action}`);
    }
    this.lockedUntil = now + this.config.app.lockTimeoutMs;
    try {
      return await fn();
    } finally {
      this.lockedUntil = 0;
    }
  }

  async status() {
    const state = await this.store.read();
    
    // Do not attempt to reconcile cloud state while a lifecycle action (start/stop) is holding the lock.
    if (this.lockedUntil > Date.now()) {
      return { state, cloud: { locked: true } };
    }

    let cloud = null;
    if (state.runtimeId && state.provider) {
      try {
        cloud = await this.provider(state.provider).describeRuntime(state.runtimeId);
        const isMissing = Boolean(cloud?.missing);
        if (isMissing && shouldDeferMissingReset(state, this.config)) {
          return { state, cloud: { ...cloud, deferred: true } };
        }

        if (runtimeAlreadyEnded(cloud)) {
          const deleted = await this.provider(state.provider).deleteRuntime(state.runtimeId).catch(() => null);
          await this.store.event(isMissing ? 'runtime-already-gone' : 'runtime-ended-reconciled', {
            runtimeId: state.runtimeId,
            provider: state.provider,
            during: 'status',
            phase: state.phase,
            cloudStatus: cloud?.Status ?? cloud?.status ?? cloud?.State ?? cloud?.state ?? null,
            deleteResult: deleted?.missing ? 'missing' : 'ok',
          });
          const stopped = await this.store.reset({
            phase: 'stopped',
            provider: null,
            runtimeId: null,
            runtimeName: null,
            eipAddress: this.config.aliyun.eipAddress,
          });
          return { state: stopped, cloud };
        }
      } catch (error) {
        cloud = { error: error.message };
      }
    }
    return { state, cloud };
  }

  async preflight() {
    return runPreflight(this.config, this.pop);
  }

  async start() {
    return this.withLock('start', async () => {
      const existing = await this.store.read();
      if (!canStart(existing)) {
        return { idempotent: true, state: existing };
      }

      const preflight = await this.preflight();
      if (!preflight.ok) {
        const state = await this.store.update((current) => ({
          ...current,
          phase: 'failed',
          lastError: `Preflight failed: ${preflight.errors.join('; ')}`,
        }));
        await this.store.event('start-preflight-failed', preflight);
        return { preflight, state };
      }

      await this.store.update((current) => ({
        ...current,
        phase: 'starting',
        provider: this.config.runtime.provider,
        lastError: null,
      }));
      await this.store.event('start-requested', { provider: this.config.runtime.provider });

      try {
        const runtime = await this.provider().createRuntime();
        const state = await this.store.update((current) => ({
          ...current,
          phase: 'initializing',
          provider: runtime.provider,
          runtimeId: runtime.runtimeId,
          runtimeName: runtime.runtimeName,
          eipAddress: this.config.aliyun.eipAddress,
          zeroPlayersSince: null,
          idleAlertSentAt: null,
          lastError: null,
        }));
        await this.store.event('runtime-created', runtime);
        return { preflight, runtime, state };
      } catch (error) {
        const state = await this.store.update((current) => ({
          ...current,
          phase: 'failed',
          lastError: error.message,
        }));
        await this.store.event('start-failed', { error: error.message });
        throw Object.assign(error, { state });
      }
    });
  }

  async gracefulStop() {
    const rcon = new RconClient({
      host: this.config.runtime.rconHost,
      port: this.config.runtime.rconPort,
      password: this.config.runtime.rconPassword,
    });

    await rcon.command('say Server is stopping in 15 seconds. World will be saved.');
    await sleep(15_000);
    await rcon.command('save-all flush');
    await rcon.command('stop');
  }

  async stop({ force = false } = {}) {
    return this.withLock('stop', async () => {
      const current = await this.store.read();
      if (!current.runtimeId || (!force && terminalPhase(current.phase))) {
        return { idempotent: true, state: current };
      }
      if (!force && !gracefulStopAllowed(current.phase)) {
        return {
          idempotent: true,
          state: current,
          message: `Graceful stop is disabled while server is ${current.phase}. Use force stop if the runtime must be deleted.`,
        };
      }
      const providerName = current.provider ?? this.config.runtime.provider;

      await this.store.update((state) => ({ ...state, phase: force ? 'force-stopping' : 'stopping' }));
      await this.store.event('stop-requested', { force });

      const rconErrors = [];
      if (!force) {
        let cloud = null;
        try {
          cloud = await this.provider(providerName).describeRuntime(current.runtimeId);
        } catch (error) {
          await this.store.event('stop-precheck-failed', { error: error.message });
        }

        if (runtimeAlreadyEnded(cloud)) {
          console.log(`[STOP] Precheck: runtime already ended. cloud.Status=${cloud?.Status}, missing=${cloud?.missing}`);
          await this.store.event('stop-skip-graceful-runtime-ended', {
            runtimeId: current.runtimeId,
            provider: providerName,
            status: cloud?.Status ?? cloud?.status ?? cloud?.State ?? cloud?.state ?? null,
            missing: Boolean(cloud?.missing),
          });
        } else {
          try {
            console.log(`[STOP] Graceful stop starting. cloud.Status=${cloud?.Status}`);
            await this.gracefulStop();
            console.log(`[STOP] Graceful stop RCON commands sent. Sleeping for ${this.config.runtime.stopGraceSeconds} seconds...`);
            await sleep(this.config.runtime.stopGraceSeconds * 1000);
            console.log(`[STOP] Sleep finished.`);
          } catch (error) {
            rconErrors.push(error.message);
            await this.store.event('graceful-stop-failed', { error: error.message });
          }
        }
      }

      // Container may already be gone; RCON then fails but the cloud record should still clear.
      if (rconErrors.length > 0 && !force) {
        try {
          const described = await this.provider(providerName).describeRuntime(current.runtimeId);
          if (described?.missing) {
            const state = await this.store.reset({
              phase: 'stopped',
              provider: null,
              runtimeId: null,
              runtimeName: null,
              eipAddress: this.config.aliyun.eipAddress,
            });
            await this.store.event('runtime-already-gone', {
              runtimeId: current.runtimeId,
              provider: providerName,
              during: 'stop-after-rcon-failure',
              rconErrors,
            });
            return { state, rconErrors };
          }
        } catch (error) {
          await this.store.event('describe-after-rcon-failure', { error: error.message });
        }
        const state = await this.store.update((next) => ({
          ...next,
          phase: 'failed',
          lastError: `Graceful stop failed: ${rconErrors.join('; ')}. Retry with force=true after checking logs.`,
        }));
        return { state, rconErrors };
      }

      try {
        const deleted = await this.provider(providerName).deleteRuntime(current.runtimeId);
        const state = await this.store.reset({
          phase: 'stopped',
          provider: null,
          runtimeId: null,
          runtimeName: null,
          eipAddress: this.config.aliyun.eipAddress,
        });
        await this.store.event(deleted?.missing ? 'runtime-already-gone' : 'runtime-deleted', {
          runtimeId: current.runtimeId,
          provider: providerName,
          force,
          during: 'stop',
        });
        return { state };
      } catch (error) {
        const state = await this.store.update((next) => ({
          ...next,
          phase: 'failed',
          lastError: error.message,
        }));
        await this.store.event('stop-failed', { error: error.message });
        throw Object.assign(error, { state });
      }
    });
  }

  async heartbeat(payload) {
    const now = new Date();
    const playerCount = Number(payload.playerCount ?? payload.players?.length ?? 0);
    const players = Array.isArray(payload.players) ? payload.players : [];
    const ready = runtimeReady(payload);
    const nextPhase = ready ? 'running' : 'initializing';

    const state = await this.store.update((current) => {
      const phase = ['starting', 'initializing'].includes(current.phase) ? nextPhase : current.phase;
      const zeroPlayersSince = phase === 'running' && ready && playerCount === 0
        ? current.zeroPlayersSince ?? now.toISOString()
        : null;
      return {
        ...current,
        phase,
        players,
        playerCount,
        zeroPlayersSince,
        lastHeartbeatAt: now.toISOString(),
        lastHeartbeat: {
          at: payload.at ?? now.toISOString(),
          host: payload.host,
          raw: payload.raw,
          parseStatus: payload.parseStatus,
          rconError: payload.rconError,
          disk: payload.disk,
          loadavg: payload.loadavg,
          freeMemBytes: payload.freeMemBytes,
          totalMemBytes: payload.totalMemBytes,
        },
      };
    });

    await this.maybeAlertOrStop(state);
    return this.store.read();
  }

  async maybeAlertOrStop(state) {
    if (!state.zeroPlayersSince || state.phase !== 'running') return;
    const idleMs = Date.now() - new Date(state.zeroPlayersSince).getTime();
    const alertThresholdMs = this.config.runtime.idleAlertMinutes * 60 * 1000;
    const stopThresholdMs = this.config.runtime.idleStopMinutes * 60 * 1000;

    if (idleMs >= alertThresholdMs && !state.idleAlertSentAt) {
      try {
        await this.alerts.sendIdleAlert(state);
        await this.store.update((current) => ({
          ...current,
          idleAlertSentAt: new Date().toISOString(),
        }));
        await this.store.event('idle-alert-sent', { playerCount: state.playerCount });
      } catch (error) {
        await this.store.event('idle-alert-failed', { error: error.message });
      }
    }

    if (this.config.runtime.idleAutoStop && idleMs >= stopThresholdMs) {
      await this.store.event('idle-auto-stop-triggered', {
        idleMinutes: Math.floor(idleMs / 60000),
        thresholdMinutes: this.config.runtime.idleStopMinutes,
      });
      await this.stop({ force: false });
    }
  }
}
