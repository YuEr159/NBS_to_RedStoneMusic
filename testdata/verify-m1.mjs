// verify-m1.mjs — M1 验证：NBS 解析器与已知统计值对照 + 输入校验断言（格式嗅探/规模上限/畸形载荷）
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
  ['v6_sample.nbs', 6, 36, 671, 1022, 18.93, 14],
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

// --- 输入校验：格式嗅探 + 规模上限（防选错文件/损坏文件/超大文件） ---
const expectParse = (buf) => { try { return { ok: true, song: parseNBS(buf) }; } catch (e) { return { ok: false, msg: e.message }; } };
const check = (ok, msg) => { if (ok) console.log('PASS ' + msg); else { failed++; console.log('FAIL ' + msg); } };

// 伪造 v7 头（新格式标记 00 00 + version=7）→ 版本嗅探拒绝
const fakeV7 = new Uint8Array([0x00, 0x00, 0x07, 0x14, 0x08, 0x00, ...Buffer.alloc(40)]);
let r = expectParse(fakeV7);
check(!r.ok && /未知版本号 7/.test(r.msg), '嗅探：伪造 v7 头被拒绝（提示未知版本号）');

// 伪造 v4 头但层数 65535 → 规模上限拒绝（[00 00] 新格式标记 [04] v4 [14] defInst [00 00] songLength [ff ff] 层数）
const fakeLayers = new Uint8Array([0x00, 0x00, 0x04, 0x14, 0x00, 0x00, 0xff, 0xff, ...Buffer.alloc(40)]);
r = expectParse(fakeLayers);
check(!r.ok && /声部数 65535/.test(r.msg), '规模上限：荒谬层数 65535 被拒绝');

// 真实样本截断一半 → 仍报「文件意外结束」
const wfxHalf = new Uint8Array(readFileSync(path.join(__dirname, 'WFXLC.nbs'))).subarray(0, 400);
r = expectParse(wfxHalf);
check(!r.ok && /文件意外结束|不是有效的 NBS|字符串长度超出/.test(r.msg), '截断文件仍被拒绝（提示意外结束/无效）');

// 纯文本文件 → 带指向性的「不是有效的 NBS 文件」提示（走层数上限或版本嗅探，均指向选错文件）
const txt = new Uint8Array(Buffer.from('This is definitely not an NBS binary file, version v4 whatever, just plain text for testing purposes 1234567890'.repeat(4)));
r = expectParse(txt);
check(!r.ok && /不是有效的 NBS 文件/.test(r.msg), '文本文件被拒绝且提示指向选错文件');

// 空/极小文件
r = expectParse(new Uint8Array([]));
check(!r.ok && /文件太小/.test(r.msg), '空文件被拒绝');
r = expectParse(new Uint8Array([0x00, 0x00, 0x04]));
check(!r.ok, '3 字节文件被拒绝');

process.exit(failed ? 1 : 0);
