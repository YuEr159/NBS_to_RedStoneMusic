// gen-example.mjs — 生成示例 .litematic 文件（Demo1 + Demo2）供游戏内测试
// 用法：node gen-example.mjs
import { readFileSync, writeFileSync } from 'fs';
import zlib from 'zlib';
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
  createElement() { return makeEl(); },
  body: makeEl(),
};
const context = {
  document: documentStub, console,
  TextDecoder, TextEncoder, Uint8Array, Uint16Array, Uint8ClampedArray,
  Int8Array, DataView, BigInt64Array, Map, Set, Array, Object, Math, JSON, String, Number,
  BigInt, parseInt, isNaN, isFinite, alert() {}, confirm() { return true; },
  requestAnimationFrame() {}, setTimeout, clearTimeout, addEventListener() {},
  FileReader: class {}, Blob: class {}, URL: { createObjectURL() { return ''; }, revokeObjectURL() {} },
  CompressionStream: globalThis.CompressionStream,
};
context.window = context;
vm.createContext(context);
vm.runInContext(code, context);

const { parseNBS, computeDelays, buildLayout, buildPalette, packBlockStates, buildLitematic, effectiveTickCount,
  packLanesNoConflict, targetEntry, DEFAULT_TARGET_MC } =
  context.window.__NBS2SCHEMATIC;
// 示例交付物固定默认目标 1.21.11（显式传值，不依赖 buildLitematic 的兜底默认）
const EXAMPLE_DATA_VERSION = targetEntry(DEFAULT_TARGET_MC).dataVersion;

async function generateExample(nbsFile, outName, { gridStarts = null, groups = null, lane0 = { dz: 0, dy: 0 } } = {}) {
  const song = parseNBS(new Uint8Array(readFileSync(path.join(__dirname, nbsFile))));
  const delays = computeDelays(song.tempo, effectiveTickCount(song));
  const usedLayers = [];
  song.layers.forEach((l, i) => { if (l.notes.size > 0) usedLayers.push(i); });
  const groups2 = groups || (() => {
    const g = [];
    for (let i = 0; i < usedLayers.length; i += 3) g.push({ layers: usedLayers.slice(i, i + 3) });
    return g;
  })();
  // 默认轨道 0 恒生成（顶层雪块导轨 + 每 32 格赭黄蛙灯，命令方块预留）；音轨车道起点与轨道 0 让位
  const starts = gridStarts || groups2.map((g, i) => ({ dz: i * 3 + 3, dy: 0 }));
  const settings =  { buttonType: 'minecraft:oak_button', customInstrumentMap: new Map() };
  const result = buildLayout(song, groups2, starts, delays, settings, lane0);
  const palette = buildPalette(result.grid);
  const packed = packBlockStates(result.grid.data, palette.length);
  let totalBlocks = 0;
  for (const id of result.grid.data) if (id !== 0) totalBlocks++;
  const size = { x: result.grid.sx, y: result.grid.sy, z: result.grid.sz };
  const nowMs = BigInt(Date.now());
  const nbtBytes = buildLitematic(song, palette, packed, size, totalBlocks, nowMs, EXAMPLE_DATA_VERSION,
    { tileEntities: result.tileEntities, entities: result.entities });
  // 浏览器用 CompressionStream('gzip')；Node 端用 zlib 等价实现
  const gz = zlib.gzipSync(Buffer.from(nbtBytes), { mtime: 0 });
  const outPath = path.join(__dirname, '..', outName);
  writeFileSync(outPath, gz);
  console.log(`生成 ${outName}: ${size.x}×${size.y}×${size.z} ${totalBlocks} 方块 ${(gz.length / 1024).toFixed(1)} KB `
    + `（${groups2.length} 链、${result.stats.notesPlaced} 音符、tempo ${song.tempo}tps）`);
  return { size, totalBlocks };
}

// Demo1：单链单行
await generateExample('demo_song.nbs', 'demo_song.litematic');
// Demo2：卡农（11 链，网格布局：每行 4 组、行间抬升 5；起点 +3 让位给轨道 0）
const canonGroups = 11;
await generateExample('canon in d major Loop.nbs', 'canon in d major Loop.litematic', {
  gridStarts: Array.from({ length: canonGroups }, (_, i) => ({
    dz: (i % 4) * 3 + 3, dy: Math.floor(i / 4) * 5,
  })),
});

// Demo3：WFXLC（简并建议：无冲突打包 5 车道）
{
  const wfxSong = parseNBS(new Uint8Array(readFileSync(path.join(__dirname, 'WFXLC.nbs'))));
  const wfxPool = [];
  wfxSong.layers.forEach((l, i) => { if (l.notes.size > 0) wfxPool.push(i); });
  const wfxPacked = packLanesNoConflict(wfxSong, wfxPool);
  await generateExample('WFXLC.nbs', 'WFXLC.litematic', {
    groups: wfxPacked.map(t => ({ layers: t })),
  });
}
console.log('完成。将 .litematic 放入 .minecraft/schematics/ 即可在 Litematica 中加载投影。');
