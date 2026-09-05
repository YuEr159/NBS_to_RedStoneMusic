// 复现浏览器下载路径：buildLitematic + CompressionStream('gzip') 压缩 → 写文件
import { readFileSync, writeFileSync } from 'fs';
import vm from 'vm';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const code = html.match(/<script>([\s\S]*)<\/script>/)[1];
const elements = new Map();
const makeEl = () => ({
  addEventListener() {}, hidden: false, textContent: '', innerHTML: '',
  style: {}, dataset: {}, value: '', checked: false,
  classList: { add() {}, remove() {} }, appendChild() {}, closest() { return null; },
  getContext() { return null; },
});
const documentStub = {
  getElementById(id) { if (!elements.has(id)) elements.set(id, makeEl()); return elements.get(id); },
  createElement() { return makeEl(); }, body: makeEl(),
};
const context = {
  document: documentStub, console,
  TextDecoder, TextEncoder, Uint8Array, Uint16Array, Uint8ClampedArray,
  Int8Array, DataView, BigInt64Array, Map, Set, Array, Object, Math, JSON, String, Number,
  BigInt, parseInt, isNaN, isFinite, alert() {}, confirm() { return true; },
  requestAnimationFrame() {}, setTimeout, clearTimeout, addEventListener() {},
  FileReader: class {}, Blob: class {}, URL: { createObjectURL() { return ''; }, revokeObjectURL() {} },
  CompressionStream: globalThis.CompressionStream, // 与浏览器相同的实现
};
context.window = context;
vm.createContext(context);
vm.runInContext(code, context);
const { parseNBS, computeDelays, buildLayout, buildPalette, packBlockStates, buildLitematic, effectiveTickCount } = context.window.__NBS2SCHEMATIC;
const { gzipBytes } = context;

const song = parseNBS(new Uint8Array(readFileSync(path.join(__dirname, 'demo_song.nbs'))));
const delays = computeDelays(song.tempo, effectiveTickCount(song));
const usedLayers = [];
song.layers.forEach((l, i) => { if (l.notes.size > 0) usedLayers.push(i); });
const groups = [];
for (let i = 0; i < usedLayers.length; i += 3) groups.push({ layers: usedLayers.slice(i, i + 3) });
const starts = groups.map((g, i) => ({ dz: i * 3 + 3, dy: 0 }));
const settings =  { buttonType: 'minecraft:oak_button', customInstrumentMap: new Map() };
const result = buildLayout(song, groups, starts, delays, settings, { dz: 0, dy: 0 }); // 默认轨道 0
const palette = buildPalette(result.grid);
const packed = packBlockStates(result.grid.data, palette.length);
let totalBlocks = 0;
for (const id of result.grid.data) if (id !== 0) totalBlocks++;
const size = { x: result.grid.sx, y: result.grid.sy, z: result.grid.sz };
const nbtBytes = buildLitematic(song, palette, packed, size, totalBlocks, BigInt(Date.now()));
const gz = await gzipBytes(nbtBytes); // 浏览器同一压缩路径
const outPath = path.join(__dirname, 'browser_path.litematic');
writeFileSync(outPath, gz);
console.log(`written ${outPath}: ${gz.length} bytes (gzip via CompressionStream)`);
console.log(`gzip header: ${[...gz.slice(0, 10)].map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
