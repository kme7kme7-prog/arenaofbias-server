// Deterministic store-method ZIP. The CLI never shells out to zip or npm.
// zlib.crc32 arrived in Node.js 22.2.0 (and 20.15.0). This repository supports
// Node.js >= 22.13, which includes it. Older builds fail here with that reason.
import zlib from 'node:zlib';

export const MIN_NODE = '22.2.0';

export function assertZipRuntime(zlibModule = zlib) {
  if (typeof zlibModule.crc32 !== 'function') {
    throw new Error(`需要 Node.js ${MIN_NODE} 或更新版本才能计算 ZIP 校验（zlib.crc32）。当前是 ${process.version}`);
  }
}

export function storeZip(files) {
  assertZipRuntime();
  const locals = [];
  const centrals = [];
  let offset = 0;
  const ordered = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const file of ordered) {
    const name = Buffer.from(file.path, 'utf8');
    const data = Buffer.from(file.data);
    const sum = zlib.crc32(data) >>> 0;
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, data);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0x81a40000, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(ordered.length, 8);
  eocd.writeUInt16LE(ordered.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, eocd]);
}
