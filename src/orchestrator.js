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
    let cloud = null;
    if (state.runtimeId && state.provider) {
      try {
        cloud = await this.provider(state.provider).describeRuntime(state.runtimeId);
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
      if (!terminalPhase(existing.phase)) {
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
          phase: 'running',
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
      if (terminalPhase(current.phase) || !current.runtimeId) {
        return { idempotent: true, state: current };
      }

      await this.store.update((state) => ({ ...state, phase: 'stopping' }));
      await this.store.event('stop-requested', { force });

      const rconErrors = [];
      if (!force) {
        try {
          await this.gracefulStop();
          await sleep(this.config.runtime.stopGraceSeconds * 1000);
        } catch (error) {
          rconErrors.push(error.message);
          await this.store.event('graceful-stop-failed', { error: error.message });
        }
      }

      if (rconErrors.length > 0 && !force) {
        const state = await this.store.update((next) => ({
          ...next,
          phase: 'failed',
          lastError: `Graceful stop failed: ${rconErrors.join('; ')}. Retry with force=true after checking logs.`,
        }));
        return { state, rconErrors };
      }

      try {
        await this.provider(current.provider).deleteRuntime(current.runtimeId);
        const state = await this.store.reset({
          phase: 'stopped',
          provider: null,
          runtimeId: null,
          runtimeName: null,
          eipAddress: this.config.aliyun.eipAddress,
        });
        await this.store.event('runtime-deleted', { runtimeId: current.runtimeId });
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

    const state = await this.store.update((current) => {
      const zeroPlayersSince = playerCount === 0
        ? current.zeroPlayersSince ?? now.toISOString()
        : null;
      return {
        ...current,
        phase: current.phase === 'starting' ? 'running' : current.phase,
        players,
        playerCount,
        zeroPlayersSince,
        lastHeartbeatAt: now.toISOString(),
      };
    });

    await this.maybeAlertOrStop(state);
    return this.store.read();
  }

  async maybeAlertOrStop(state) {
    if (!state.zeroPlayersSince || state.phase !== 'running') return;
    const idleMs = Date.now() - new Date(state.zeroPlayersSince).getTime();
    const thresholdMs = this.config.runtime.idleAlertMinutes * 60 * 1000;
    if (idleMs < thresholdMs || state.idleAlertSentAt) return;

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

    if (this.config.runtime.idleAutoStop) {
      await this.stop({ force: false });
    }
  }
}
