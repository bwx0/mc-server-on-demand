import fs from 'node:fs/promises';
import path from 'node:path';

const initialState = {
  phase: 'stopped',
  provider: null,
  runtimeId: null,
  runtimeName: null,
  eipAddress: null,
  players: [],
  playerCount: 0,
  zeroPlayersSince: null,
  idleAlertSentAt: null,
  lastHeartbeatAt: null,
  lastHeartbeat: null,
  lastError: null,
  updatedAt: null,
  events: [],
};

export class StateStore {
  constructor(config) {
    this.stateFile = config.app.stateFile;
    this.auditFile = config.app.auditFile;
    this.maxEvents = 100;
  }

  async read() {
    try {
      const raw = await fs.readFile(this.stateFile, 'utf8');
      return { ...initialState, ...JSON.parse(raw) };
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { ...initialState };
      }
      throw error;
    }
  }

  async write(state) {
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
    const next = {
      ...state,
      updatedAt: new Date().toISOString(),
      events: (state.events ?? []).slice(0, this.maxEvents),
    };
    await fs.writeFile(this.stateFile, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }

  async update(mutator) {
    const current = await this.read();
    const changed = await mutator(current);
    return this.write(changed ?? current);
  }

  async reset(overrides = {}) {
    return this.write({ ...initialState, ...overrides });
  }

  async event(type, details = {}) {
    const entry = await this.audit(type, details);
    return this.update((state) => ({
      ...state,
      events: [entry, ...(state.events ?? [])],
    }));
  }

  async audit(type, details = {}) {
    const entry = {
      type,
      details,
      at: new Date().toISOString(),
    };
    await fs.mkdir(path.dirname(this.auditFile), { recursive: true });
    await fs.appendFile(this.auditFile, `${JSON.stringify(entry)}\n`);
    console.log(JSON.stringify(entry));
    return entry;
  }
}
