// Builds the game and writes two archives to release/:
//   zero-mile-web-v<version>.zip     — the playable game for itch.io (index.html at the zip root)
//   zero-mile-source-v<version>.zip  — clean source: only files tracked by git, minus export-ignore entries
// Usage: npm run package
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { deflateRawSync } from 'node:zlib';

const root = process.cwd();
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const out = join(root, 'release');
mkdirSync(out, { recursive: true });

// ---------------------------------------------------------------- minimal zip writer (deflate, no dependencies)
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}
function writeZip(file, entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const { time, date } = dosTime(new Date());
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(file, Buffer.concat([...locals, centralBuf, end]));
}
function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const kb = (f) => `${Math.round(statSync(f).size / 1024)} KB`;

// ---------------------------------------------------------------- 1. playable web build
execSync('npm run build', { stdio: 'inherit' });
const dist = join(root, 'dist');
const webEntries = walk(dist).map((f) => ({ name: relative(dist, f).split(sep).join('/'), data: readFileSync(f) }));
if (!webEntries.some((e) => e.name === 'index.html')) throw new Error('dist/index.html missing');
const webZip = join(out, `zero-mile-web-v${version}.zip`);
writeZip(webZip, webEntries);

// ---------------------------------------------------------------- 2. clean source archive (git-tracked files only)
const srcZip = join(out, `zero-mile-source-v${version}.zip`);
execSync(`git archive --format=zip --prefix=zero-mile/ -o "${srcZip}" HEAD`, { stdio: 'inherit' });

console.log(`\nrelease/${relative(out, webZip)}  ${kb(webZip)}  ← upload this to itch.io (HTML, "played in the browser")`);
console.log(`release/${relative(out, srcZip)}  ${kb(srcZip)}  ← source archive (committed files only)`);
