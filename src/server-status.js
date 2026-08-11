'use strict';

const net = require('node:net');

function encodeVarInt(value) {
  let current = Number(value) >>> 0;
  const bytes = [];
  do {
    let byte = current & 0x7f;
    current >>>= 7;
    if (current !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (current !== 0);
  return Buffer.from(bytes);
}

function decodeVarInt(buffer, offset = 0) {
  let value = 0;
  let position = 0;
  let cursor = offset;
  while (cursor < buffer.length) {
    const byte = buffer[cursor++];
    value |= (byte & 0x7f) << position;
    if ((byte & 0x80) === 0) return { value: value >>> 0, bytes: cursor - offset };
    position += 7;
    if (position >= 35) throw new Error('잘못된 Minecraft VarInt 응답입니다.');
  }
  return null;
}

function encodeString(value) {
  const bytes = Buffer.from(String(value), 'utf8');
  return Buffer.concat([encodeVarInt(bytes.length), bytes]);
}

function framePacket(payload) {
  return Buffer.concat([encodeVarInt(payload.length), payload]);
}

function parseStatusPacket(buffer) {
  const frame = decodeVarInt(buffer, 0);
  if (!frame || buffer.length < frame.bytes + frame.value) return null;
  let cursor = frame.bytes;
  const packetId = decodeVarInt(buffer, cursor);
  if (!packetId) return null;
  cursor += packetId.bytes;
  if (packetId.value !== 0) throw new Error(`예상하지 못한 상태 패킷입니다: ${packetId.value}`);
  const stringLength = decodeVarInt(buffer, cursor);
  if (!stringLength) return null;
  cursor += stringLength.bytes;
  if (buffer.length < cursor + stringLength.value) return null;
  return JSON.parse(buffer.subarray(cursor, cursor + stringLength.value).toString('utf8'));
}

function queryMinecraftServer(server, options = {}) {
  const host = String(server?.host || '').trim();
  const port = Number(server?.port) || 25565;
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 4500);
  if (!host) return Promise.reject(new Error('Minecraft 서버 호스트가 비어 있습니다.'));

  return new Promise((resolve) => {
    const startedAt = Date.now();
    const socket = net.createConnection({ host, port });
    let received = Buffer.alloc(0);
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      const portBytes = Buffer.allocUnsafe(2);
      portBytes.writeUInt16BE(port);
      const handshake = Buffer.concat([
        Buffer.from([0x00]),
        encodeVarInt(-1),
        encodeString(host),
        portBytes,
        encodeVarInt(1)
      ]);
      socket.write(Buffer.concat([framePacket(handshake), framePacket(Buffer.from([0x00]))]));
    });
    socket.on('data', (chunk) => {
      received = Buffer.concat([received, chunk]);
      try {
        const status = parseStatusPacket(received);
        if (!status) return;
        const players = status.players || {};
        finish({
          online: true,
          playersOnline: Math.max(0, Number(players.online) || 0),
          playersMax: Math.max(0, Number(players.max) || 0),
          sample: Array.isArray(players.sample)
            ? players.sample.slice(0, 12).map((player) => ({
              id: String(player?.id || ''),
              name: String(player?.name || '')
            })).filter((player) => player.name)
            : [],
          latencyMs: Date.now() - startedAt,
          version: String(status.version?.name || '')
        });
      } catch (error) {
        finish({ online: false, playersOnline: 0, playersMax: 0, sample: [], error: error.message });
      }
    });
    socket.once('timeout', () => finish({
      online: false,
      playersOnline: 0,
      playersMax: 0,
      sample: [],
      error: '서버 상태 조회 시간이 초과되었습니다.'
    }));
    socket.once('error', (error) => finish({
      online: false,
      playersOnline: 0,
      playersMax: 0,
      sample: [],
      error: error.message
    }));
    socket.once('end', () => finish({
      online: false,
      playersOnline: 0,
      playersMax: 0,
      sample: [],
      error: '서버가 상태 연결을 종료했습니다.'
    }));
  });
}

module.exports = {
  decodeVarInt,
  encodeVarInt,
  parseStatusPacket,
  queryMinecraftServer
};
