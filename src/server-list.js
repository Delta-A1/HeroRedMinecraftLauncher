'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { deserialize, serialize, TagType } = require('@xmcl/nbt');
const { ensureDirectory } = require('./file-utils');

class ServerInfo {
  constructor(value = {}) {
    this.name = value.name || '';
    this.ip = value.ip || '';
    this.icon = value.icon || '';
    this.acceptTextures = Number(value.acceptTextures ?? 1);
    this.hidden = Number(value.hidden ?? 0);
  }
}
TagType(TagType.String)(ServerInfo.prototype, 'name');
TagType(TagType.String)(ServerInfo.prototype, 'ip');
TagType(TagType.String)(ServerInfo.prototype, 'icon');
TagType(TagType.Byte)(ServerInfo.prototype, 'acceptTextures');
TagType(TagType.Byte)(ServerInfo.prototype, 'hidden');

class ServerList {
  constructor() {
    this.servers = [];
  }
}
TagType([ServerInfo])(ServerList.prototype, 'servers');

async function readServerList(file) {
  try {
    const data = await fs.readFile(file);
    const parsed = await deserialize(data, { type: ServerList });
    parsed.servers = Array.isArray(parsed.servers) ? parsed.servers : [];
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return new ServerList();
    const backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
    await fs.copyFile(file, backup).catch(() => {});
    return new ServerList();
  }
}

async function upsertServer(gameRoot, server) {
  const file = path.join(gameRoot, 'servers.dat');
  await ensureDirectory(path.dirname(file));
  const list = await readServerList(file);
  const address = String(server.address).toLowerCase();
  const index = list.servers.findIndex((entry) =>
    String(entry.ip || '').toLowerCase() === address
    || String(entry.name || '') === server.name
  );
  const next = new ServerInfo({
    ...(index >= 0 ? list.servers[index] : {}),
    name: server.name,
    ip: server.address,
    acceptTextures: 1,
    hidden: 0
  });
  if (index >= 0) list.servers[index] = next;
  else list.servers.unshift(next);

  const output = Buffer.from(await serialize(list));
  const temp = `${file}.partial`;
  await fs.writeFile(temp, output);
  await fs.rm(file, { force: true });
  await fs.rename(temp, file);
  return {
    file,
    count: list.servers.length,
    added: index < 0
  };
}

module.exports = {
  ServerInfo,
  ServerList,
  readServerList,
  upsertServer
};
