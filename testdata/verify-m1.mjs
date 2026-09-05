// verify-m1.mjs — M1 验证：NBS 解析器与已知统计值对照
// 用法：node verify-m1.mjs（在 testdata 目录下运行）
import { readFileSync } from 'fs';
import vm from 'vm';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/<script>([\s\S]*)<\/script>/);
if (!m) { console.error('FAIL: 未找到 <script> 块'); process.exit(1); }
const code = m[1];

// 最小 DOM stub
const elements = new Map();
function makeEl() {
  return {
    addEventListener() {}, hidden: false, textContent: '', innerHTML: '',
    style: {}, dataset: {}, value: '', checked: false,
    classList: { add() {}, remove() {} },
    appendChild() {}, closest() { return null; },
  };
}
const documentStub = {
  getElementById(id) { if (!elements.has(id)) elements.set(id, makeEl()); return elements.get(id); },
};
const context = {
  document: documentStub, console,
  TextDecoder, Uint8Array, Uint16Array, DataView, Map, Set, Array, Object, Math, JSON, String, Number,
  parseInt, isNaN, isFinite, alert() {}, requestAnimationFrame() {},
  FileReader: class {}, Blob: class {}, URL: { createObjectURL() { return ''; } },
};
context.window = context;
vm.createContext(context);
vm.runInContext(code, context);

const { parseNBS } = context.window.__NBS2SCHEMATIC;

const cases = [
  ['demo_song.nbs', 4, 27, 287, 76, 10.0, 3],
  ['old_demo_song.nbs', 0, 23, 287, 76, 10.0, 3],
  ['new_file.nbs', 4, 1, 8, 5, 10.0, 1],
  ['old_new_file.nbs', 0, 1, 8, 5, 10.0, 1],
  ['canon in d major Loop.nbs', 5, 72, 831, 2225, 5.0, 32],
  ['WFXLC.nbs', 5, 31, 720, 1126, 8.52, 15],
];

let failed = 0;
for (const [file, expVer, expLayers, expLen, expNotes, expTempo, expUsed] of cases) {
  const bytes = new Uint8Array(readFileSync(path.join(__dirname, file)));
  try {
    const song = parseNBS(bytes);
    const used = song.layers.filter(l => l.notes.size > 0).length;
    const totalNotes = song.layers.reduce((s, l) => s + l.notes.size, 0);
    const checks = [
      ['version', song.version, expVer],
      ['songLayers', song.songLayers, expLayers],
      ['songLength', song.songLength, expLen],
      ['tempo', song.tempo, expTempo],
      ['usedLayers', used, expUsed],
    ];
    if (expNotes !== null) checks.push(['totalNotes', totalNotes, expNotes]);
    const bad = checks.filter(([, got, want]) => got !== want);
    if (bad.length) {
      failed++;
      console.log(`FAIL ${file}: ${bad.map(([k, g, w]) => `${k}=${g}(期望${w})`).join(', ')}`);
    } else {
      console.log(`PASS ${file}: v${song.version} ${song.songLayers}层 ${song.songLength}tick ${totalNotes}音符 tempo=${song.tempo}`);
    }
  } catch (err) {
    failed++;
    console.log(`FAIL ${file}: 异常 ${err.message}`);
  }
}
process.exit(failed ? 1 : 0);
