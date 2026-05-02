import net from 'node:net';

const SERVERDATA_AUTH = 3;
const SERVERDATA_EXECCOMMAND = 2;

function encodePacket(id, type, body) {
  const payload = Buffer.from(body, 'utf8');
  const packet = Buffer.alloc(4 + 4 + 4 + payload.length + 2);
  packet.writeInt32LE(4 + 4 + payload.length + 2, 0);
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(type, 8);
  payload.copy(packet, 12);
  packet.writeInt16LE(0, 12 + payload.length);
  return packet;
}

async function readPacket(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('RCON read timed out')), timeoutMs);
    let buffer = Buffer.alloc(0);

    function cleanup() {
      clearTimeout(timeout);
      socket.off('data', onData);
      socket.off('error', onError);
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readInt32LE(0);
      if (buffer.length < length + 4) return;
      cleanup();
      resolve({
        id: buffer.readInt32LE(4),
        type: buffer.readInt32LE(8),
        body: buffer.slice(12, 4 + length - 2).toString('utf8'),
      });
    }

    socket.on('data', onData);
    socket.on('error', onError);
  });
}

export class RconClient {
  constructor({ host, port, password, timeoutMs = 5000 }) {
    this.host = host;
    this.port = port;
    this.password = password;
    this.timeoutMs = timeoutMs;
  }

  async command(command) {
    if (!this.password) {
      throw new Error('MINECRAFT_RCON_PASSWORD is required for graceful stop.');
    }
    const socket = net.createConnection({ host: this.host, port: this.port });
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
      socket.setTimeout(this.timeoutMs, () => reject(new Error('RCON connect timed out')));
    });

    try {
      socket.write(encodePacket(1, SERVERDATA_AUTH, this.password));
      const auth = await readPacket(socket, this.timeoutMs);
      if (auth.id === -1) {
        throw new Error('RCON authentication failed.');
      }
      socket.write(encodePacket(2, SERVERDATA_EXECCOMMAND, command));
      return (await readPacket(socket, this.timeoutMs)).body;
    } finally {
      socket.end();
    }
  }
}
