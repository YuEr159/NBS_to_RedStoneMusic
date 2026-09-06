// smoke-ui.mjs — UI 层冒烟测试：模拟完整用户操作链（载入 → 分组 → 布局编辑器 → 生成 → 预览）
// 用法：node smoke-ui.mjs
import { readFileSync } from 'fs';
import zlib from 'zlib';
import vm from 'vm';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const code = html.match(/<script>([\s\S]*)<\/script>/)[1];
if (!code) { console.error('FAIL: 未找到 <script>'); process.exit(1); }

// --- 增强 DOM stub（含 canvas 2D 假上下文）---
const elements = new Map();
function makeCtx() {
  return {
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '',
    clearRect() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    fillText() {}, strokeRect() {}, putImageData() {}, drawImage() {}, setLineDash() {},
    createImageData(w, h) { return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }; },
  };
}
// innerHTML 序列化：应用直接赋值 innerHTML 的字符串优先；否则按 children 树序列化
function serEl(e) {
  if (typeof e._html === 'string' && e._html !== '') return e._html;
  if (Array.isArray(e.children)) return e.children.map(serEl).join('');
  return e.textContent || '';
}
function makeEl(tag) {
  const el = {
    tagName: tag || 'div',
    children: [],
    listeners: {},
    addEventListener(type, fn) { (el.listeners[type] = el.listeners[type] || []).push(fn); },
    dispatch(type, evt) { (el.listeners[type] || []).forEach(fn => fn(evt)); },
    hidden: false, textContent: '',
    _html: '',
    get innerHTML() { return el._html !== '' ? el._html : (el.children.length ? el.children.map(serEl).join('') : ''); },
    set innerHTML(v) { el._html = String(v || ''); el.children = []; },
    style: {}, dataset: {}, value: '', checked: false,
    width: 0, height: 0, options: [],
    _classes: new Set(),
    classList: {
      add(c) { el._classes.add(c); },
      remove(c) { el._classes.delete(c); },
      contains(c) { return el._classes.has(c); },
      toggle(c) { if (el._classes.has(c)) { el._classes.delete(c); return false; } el._classes.add(c); return true; },
    },
    appendChild(c) { el.children.push(c); return c; },
    removeChild(c) { el.children = el.children.filter(x => x !== c); },
    get firstChild() { return el.children[0] || null; },
    closest() { return null; },
    getContext() { return makeCtx(); },
    setPointerCapture() {}, click() {}, remove() {},
  };
  return el;
}
const documentStub = {
  getElementById(id) { if (!elements.has(id)) elements.set(id, makeEl()); return elements.get(id); },
  createElement(tag) { return makeEl(tag); },
  body: Object.assign(makeEl('body')),
};
const context = {
  document: documentStub, console,
  TextDecoder, TextEncoder, Uint8Array, Uint16Array, Uint8ClampedArray,
  Int8Array, DataView, BigInt64Array, Map, Set, Array, Object, Math, JSON, String, Number,
  BigInt, parseInt, isNaN, isFinite, alert() {}, confirm() { return true; },
  requestAnimationFrame() {}, setTimeout, clearTimeout,
  addEventListener() {}, removeEventListener() {},
  FileReader: class {}, Blob: class {}, URL: { createObjectURL() { return ''; }, revokeObjectURL() {} },
  CompressionStream: globalThis.CompressionStream,
  DecompressionStream: globalThis.DecompressionStream,
  localStorage: {
    _m: new Map(),
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
    setItem(k, v) { this._m.set(k, String(v)); },
    removeItem(k) { this._m.delete(k); },
    clear() { this._m.clear(); },
    key(i) { return [...this._m.keys()][i] ?? null; },
    get length() { return this._m.size; },
  },
  window: null,
};
context.window = context;
vm.createContext(context);
vm.runInContext(code, context);

let failed = 0;
const check = (cond, msg) => { if (!cond) { failed++; console.log('FAIL', msg); } else console.log('PASS', msg); };

// 模拟用户：载入 demo_song.nbs
const { parseNBS } = context.window.__NBS2SCHEMATIC;
const song = parseNBS(new Uint8Array(readFileSync(path.join(__dirname, 'demo_song.nbs'))));
song.sourceFileName = 'demo_song.nbs';
context.onSongLoaded(song, null);
check(context.window.__NBS2SCHEMATIC.state.lanes.length === 1, `自动建道 1 条（实际 ${context.window.__NBS2SCHEMATIC.state.lanes.length}）`);
check(context.window.__NBS2SCHEMATIC.state.lanes[0].tracks.join(',') === '0,1,2', `车道音轨为 [0,1,2]（实际 [${context.window.__NBS2SCHEMATIC.state.lanes[0].tracks}]）`);
check(context.window.__NBS2SCHEMATIC.layoutEditor !== null, '布局编辑器已创建');
check(elements.get('group-section').hidden === false, '车道池区已显示');
check(elements.get('layer-section').hidden === false, '音轨池区已显示');
check(elements.get('sidebar').hidden === false, '音轨池左侧边栏已显示（左右分栏）');
// 侧边栏折叠/展开（展开 680px = 340×2；折叠 = 侧栏整体隐藏 + 右侧顶部展开按钮；状态持久化到全局 UI 键）
elements.get('sidebarToggle').dispatch('click', {});
check(elements.get('content').classList.contains('sidebar-collapsed'), '侧栏收起：content.sidebar-collapsed（侧栏整体隐藏）');
let uiParsed = JSON.parse(context.localStorage.getItem('nbs2schematic:ui'));
check(uiParsed && uiParsed.sidebarCollapsed === true, '折叠状态持久化到 nbs2schematic:ui');
elements.get('sidebarOpenBtn').dispatch('click', {});
check(!elements.get('content').classList.contains('sidebar-collapsed'), '右侧「▶ 展开音轨池」还原侧栏');
uiParsed = JSON.parse(context.localStorage.getItem('nbs2schematic:ui'));
check(uiParsed && uiParsed.sidebarCollapsed === false, '展开状态持久化还原');

// 模拟用户：点击「预置：单行」（以 0 号车道为中心：lane0=(0,0) → 车道 1 为 k=0 → (3,0)）
elements.get('presetLineBtn').dispatch('click', {});
check(context.window.__NBS2SCHEMATIC.state.lanes[0].start.dz === 3
  && context.window.__NBS2SCHEMATIC.state.lanes[0].start.dy === 0,
  '预置单行：音轨车道起点 (3,0)（以轨道 0 为中心）');
context.window.__NBS2SCHEMATIC.layoutEditor.refresh();
check(context.window.__NBS2SCHEMATIC.layoutEditor.starts().length === 2, '布局编辑器起点数 2（轨道 0 + 车道 1）');

// 模拟用户：修改设置
context.renderSettings();

// 模拟用户：点击生成
await context.generate();
check(!context.elements || true, 'generate() 无异常');
check(context.window.__NBS2SCHEMATIC.state.result !== null, '生成结果存在');
check(elements.get('downloadBtn').hidden === false, '下载按钮可见');
check(context.window.__NBS2SCHEMATIC.state.litematicBytes.length > 0, `litematic 字节 ${context.window.__NBS2SCHEMATIC.state.litematicBytes.length} > 0`);
check(elements.get('statsPanel').innerHTML.includes('音符盒数'), '统计面板有内容');
check(elements.get('previewPanel').hidden === false, '预览面板可见');
check(context.window.__NBS2SCHEMATIC.topPreview && context.window.__NBS2SCHEMATIC.topPreview.off !== null, '俯视预览离屏图已构建');
check(context.window.__NBS2SCHEMATIC.frontPreview && context.window.__NBS2SCHEMATIC.frontPreview.off !== null, '正视预览离屏图已构建');

// 中继器朝向：facing=输入侧 → 主链必须 west（输出 +X）
// 触发区（总线/tap/开关）已按用户要求从产物移除 → 产物中无总线/开关；
// 链头（X=0 中继器）输入侧留空属预期（用户手动接粉）；非链头中继器输入侧必须接导体
// （回归保护：facing 语义曾整体搞反导致全断链，见 index.html 05 段注释）
{
  const out = context.window.__NBS2SCHEMATIC.state.result;
  const res = out.result, g = res.geometry, grid = res.grid, palette = out.palette;
  const repDir = { east: [1, 0, 0], west: [-1, 0, 0], south: [0, 0, 1], north: [0, 0, -1] };
  const isConductor = (s) => !!(s && (s.startsWith('minecraft:repeater')
    || s.startsWith('minecraft:note_block') || s.startsWith('minecraft:redstone_wire')));
  const at = (x, y, z) => (x >= 0 && x < grid.sx && y >= 0 && y < grid.sy && z >= 0 && z < grid.sz)
    ? palette[grid.data[(y * grid.sz + z) * grid.sx + x]] : null;
  let bad = 0;
  for (let x = 0; x < grid.sx; x++) for (let y = 0; y < grid.sy; y++) for (let z = 0; z < grid.sz; z++) {
    const st = at(x, y, z);
    if (!st || !st.startsWith('minecraft:repeater')) continue;
    const fm = st.match(/facing=(east|west|south|north)/);
    if (fm[1] !== 'west') { bad++; continue; }
    if (x === 0) continue; // 链头：输入侧留空（触发区由用户手动放置）
    const [dx, , dz] = repDir[fm[1]];
    if (!isConductor(at(x + dx, y, z + dz))) bad++; // 输入侧（facing 方向）必须接导体
  }
  check(bad === 0, `UI 生成产物中继器朝向/输入侧异常 ${bad} 个`);
  // 触发区已移除：产物不得含任何启动开关
  let switchCount = 0;
  for (const s of palette) if (/button|lever|pressure_plate/.test(s)) switchCount++;
  check(switchCount === 0, `触发区已移除：产物中不应有启动开关（实际 ${switchCount}）`);
}

// 目标 Litematica 版本下拉：默认值 + hint + 切换 → 生成产物 DataVersion 随目标变化
// NBT 头三字段提取（大端），固定布局：
//   0: 0A 根 compound；1-2: 空名(00 00)
//   3: 0x03；4-5: 名字长度 20；6-25: 'MinecraftDataVersion'；26-29: DV(i32)
//   30: 0x03；31-32: 长度 7；33-39: 'Version'；40-43: Version(i32)
//   44: 0x03；45-46: 长度 10；47-56: 'SubVersion'；57-60: SubVersion(i32)
function nbtHead(litematicGzBytes) {
  const bytes = new Uint8Array(zlib.gunzipSync(Buffer.from(litematicGzBytes)));
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint8(0) !== 10) throw new Error('根 tag 非 Compound');
  return {
    dataVersion: dv.getInt32(26, false),
    version: dv.getInt32(40, false),
    subVersion: dv.getInt32(57, false),
  };
}
const tvSel = elements.get('targetVersion');
check(tvSel.value === '1.21.11', `目标版本下拉默认 1.21.11（实际 ${tvSel.value}）`);
check(elements.get('targetVersionHint').textContent.includes('4671'), `默认 hint 含 DataVersion 4671（实际 "${elements.get('targetVersionHint').textContent}"）`);
check(context.window.__NBS2SCHEMATIC.state.result !== null, 'demo1 默认目标已生成');
const head12111 = nbtHead(context.window.__NBS2SCHEMATIC.state.litematicBytes);
check(head12111.dataVersion === 4671 && head12111.version === 6 && head12111.subVersion === 1,
  `demo1 默认目标头 DV=${head12111.dataVersion} V=${head12111.version} SV=${head12111.subVersion}（期望 4671/6/1）`);
// 切到 1.20.1 → AppState 更新 + hint 刷新 + 生成产物 DV=3465
tvSel.value = '1.20.1';
tvSel.dispatch('change', { target: tvSel });
check(context.window.__NBS2SCHEMATIC.state.settings.targetVersion === '1.20.1', '切换后 AppState.settings.targetVersion=1.20.1');
check(elements.get('targetVersionHint').textContent.includes('3465'), `切换 hint 含 DataVersion 3465（实际 "${elements.get('targetVersionHint').textContent}"）`);
await context.generate();
const head201 = nbtHead(context.window.__NBS2SCHEMATIC.state.litematicBytes);
check(head201.dataVersion === 3465 && head201.version === 6 && head201.subVersion === 1,
  `1.20.1 目标生成头 DV=${head201.dataVersion} V=${head201.version} SV=${head201.subVersion}（期望 3465/6/1）`);
// 切回默认
tvSel.value = '1.21.11';
tvSel.dispatch('change', { target: tvSel });
check(context.window.__NBS2SCHEMATIC.state.settings.targetVersion === '1.21.11', '切回默认 1.21.11');

// 卡农（多链多Y）
const canon = parseNBS(new Uint8Array(readFileSync(path.join(__dirname, 'canon in d major Loop.nbs'))));
canon.sourceFileName = 'canon.nbs';
context.onSongLoaded(canon, null);
check(context.window.__NBS2SCHEMATIC.state.lanes.length === 11, `卡农自动建道 11 条（实际 ${context.window.__NBS2SCHEMATIC.state.lanes.length}）`);
// 导入新文件：旧结果与预览离屏图必须已清除
check(context.window.__NBS2SCHEMATIC.state.result === null, '新文件导入后旧生成结果已清除');
check(context.window.__NBS2SCHEMATIC.topPreview.off === null, '新文件导入后俯视预览离屏图已清除');
check(context.window.__NBS2SCHEMATIC.sidePreview.off === null, '新文件导入后侧视预览离屏图已清除');
// 播放速度分析面板（canon tempo=5 → 1 档中继器、R = 2×5 = 10）
check(elements.get('tempo-section').hidden === false, '速度分析区已显示');
check(elements.get('tempoAdvice').innerHTML.includes('/tick rate 10'), 'tempo=5 给出 /tick rate 10（R=2×tempo）');
check(elements.get('tempoAdvice').innerHTML.includes('跟随播放'), '面板含跟随播放指引');
// 1 档中继器方案：playbackPlan 断言（D 恒 1、R = 2×tempo）
const plan5 = context.playbackPlan(5);
check(plan5.assumedTps === 5 && plan5.delay === 1 && Math.abs(plan5.tickRate - 10) < 1e-9, `tempo=5 → 挡位1、R=10（实际 D=${plan5.delay} R=${plan5.tickRate}）`);
const plan20 = context.playbackPlan(20);
check(plan20.assumedTps === 20 && plan20.delay === 1 && Math.abs(plan20.tickRate - 40) < 1e-9, `tempo=20 → 挡位1、R=40（实际 D=${plan20.delay} R=${plan20.tickRate}）`);
const plan85 = context.playbackPlan(8.5);
check(plan85.assumedTps === 10 && plan85.delay === 1 && Math.abs(plan85.tickRate - 17) < 1e-9, `tempo=8.5 → 挡位1、R=17（实际 D=${plan85.delay} R=${plan85.tickRate}）`);
const plan30 = context.playbackPlan(30);
check(plan30.assumedTps === 20 && plan30.delay === 1 && Math.abs(plan30.tickRate - 60) < 1e-9, `tempo=30 → 挡位1、R=60（实际 D=${plan30.delay} R=${plan30.tickRate}）`);
const plan25 = context.playbackPlan(2.5);
check(plan25.assumedTps === 2.5 && plan25.delay === 1 && Math.abs(plan25.tickRate - 5) < 1e-9, `tempo=2.5 → 挡位1、R=5（实际 D=${plan25.delay} R=${plan25.tickRate}）`);
// 网格预置：每行 5 组、行间抬升 5（轨道 0 占 Z=0 → 车道起点 +3 让位）
context.window.__NBS2SCHEMATIC.state.lanes.forEach((g, i) => {
  g.start = { dz: (i % 5) * 3 + 3, dy: Math.floor(i / 5) * 5 };
});
context.window.__NBS2SCHEMATIC.layoutEditor.refresh();
const { errors } = context.window.__NBS2SCHEMATIC.layoutEditor.validate();
check(errors.length === 0, '布局校验无错误');
await context.generate();
check(context.window.__NBS2SCHEMATIC.state.result !== null, '卡农生成成功');
// 触发区（总线/tap/开关）已按用户要求移除：各链头必须是 X=0 的中继器（输入侧留空待手动接粉）
{
  const out = context.window.__NBS2SCHEMATIC.state.result;
  const res = out.result, grid = res.grid, palette = out.palette;
  const gZOff = res.geometry.zOffset || 1;
  let badHead = 0;
  for (const c of res.chains) {
    const s = palette[grid.data[((c.yb + 1) * grid.sz + (c.zc + gZOff)) * grid.sx + 0]];
    if (!s || !s.startsWith('minecraft:repeater')) badHead++;
  }
  check(badHead === 0, `卡农 ${res.chains.length} 条链头均为 X=0 中继器（触发区移除后西边界即链头）`);
}
check(context.window.__NBS2SCHEMATIC.topPreview.off.width > 0, '卡农俯视预览非空');
check(context.window.__NBS2SCHEMATIC.sidePreview && context.window.__NBS2SCHEMATIC.sidePreview.off.width > 0, '卡农侧视预览非空');

// 调试包导出（不抛错）
context.exportDebugBundle();

// 下载（不抛错）
context.downloadLitematic();

// tempo > 20：1 档中继器 + R=60 建议
context.window.__NBS2SCHEMATIC.state.song.tempo = 30;
context.renderTempoAdvice();
check(elements.get('tempoAdvice').innerHTML.includes('/tick rate 60'), 'tempo=30 给出 /tick rate 60 建议（R=2×tempo）');
context.window.__NBS2SCHEMATIC.state.song.tempo = 5;
context.renderTempoAdvice();

// 重复音轨（如 5: E,E 双倍音量）：同一音轨在一车道出现两次 → 同 tick 音符放两个位
function makeNbs({ tempoTps = 10, songLength = 4, noteSpecs = [] }) {
  const out = [];
  const u8 = v => out.push(v & 0xFF);
  const u16 = v => { out.push(v & 0xFF, (v >> 8) & 0xFF); };
  const u32 = v => { out.push(v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF); };
  const i16 = v => u16(v & 0xFFFF);
  const str = s => { const enc = Buffer.from(s, 'latin1'); u32(enc.length); for (const b of enc) u8(b); };
  u16(0); u8(5); u8(16); u16(songLength); u16(1);
  str('synth'); str(''); str(''); str('');
  u16(Math.round(tempoTps * 100)); u8(0); u8(1); u8(4);
  u32(0); u32(0); u32(0); u32(0); u32(0);
  str(''); u8(0); u8(0); u16(0);
  const byTick = new Map();
  for (const n of noteSpecs) { if (!byTick.has(n.tick)) byTick.set(n.tick, []); byTick.get(n.tick).push(n); }
  const ticks = [...byTick.keys()].sort((a, b) => a - b);
  let prevTick = -1;
  for (const t of ticks) {
    u16(t - prevTick); prevTick = t;
    const ns = byTick.get(t).sort((a, b) => a.layer - b.layer);
    let prevLayer = -1;
    for (const n of ns) {
      u16(n.layer - prevLayer); prevLayer = n.layer;
      u8(n.instrument); u8(n.key); u8(100); u8(100); i16(0);
    }
    u16(0);
  }
  u16(0);
  str('L0'); u8(0); u8(100); u8(100);
  u8(0);
  return Buffer.from(out);
}
const dupSong = context.parseNBS(makeNbs({ tempoTps: 10, songLength: 4, noteSpecs: [
  { tick: 0, layer: 0, instrument: 0, key: 45 },
  { tick: 2, layer: 0, instrument: 1, key: 48 },
]}));
dupSong.sourceFileName = 'dup.nbs';
context.onSongLoaded(dupSong, null);
context.window.__NBS2SCHEMATIC.state.lanes = [{ tracks: [0, 0] }]; // 模拟把音轨 E 两次拖入同一条车道
context.window.__NBS2SCHEMATIC.syncLaneStarts();
context.renderLaneSection();
await context.generate();
const dupResult = context.window.__NBS2SCHEMATIC.state.result;
check(dupResult !== null && dupResult.result.stats.notesPlaced === 4, '重复音轨（E,E 式分配）生成：2 音符 × 2 位 = 4 音符盒');

// 简并建议面板（Demo3：WFXLC）
check(elements.get('mergeAdvice').innerHTML.includes('无冲突打包方案'), '简并建议面板有打包方案');
check(elements.get('applyPackBtn').hidden === false, '应用建议按钮可见');
const wfx = context.parseNBS(new Uint8Array(readFileSync(path.join(__dirname, 'WFXLC.nbs'))));
wfx.sourceFileName = 'WFXLC.nbs';
context.onSongLoaded(wfx, null);
check(elements.get('mergeAdvice').innerHTML.includes('Piano 1'), 'WFXLC 简并建议含 Piano 1 同名组');
check(elements.get('mergeAdvice').innerHTML.includes('Main'), 'WFXLC 简并建议含 Main 相似名组');
// 应用打包建议 → 生成 → 0 丢弃
const wfxPool = [];
wfx.layers.forEach((l, i) => { if (l.notes.size > 0) wfxPool.push(i); });
const wfxPacked = context.packLanesNoConflict(wfx, wfxPool);
// 名称重复优先（用户要求）：Main 相似名组（#0/#1 归组）必须聚同车道；Piano 1 组（7 条）超容量允许的最多分 2 车道
{
  const pianoIdx = wfxPool.filter(i => (wfx.layers[i].name || '').toLowerCase().includes('piano'));
  check(pianoIdx.length === 7, `打包前置：WFXLC Piano 1 组共 ${pianoIdx.length} 条`);
  const pianoLanes = new Set();
  wfxPacked.forEach((tr, li) => { if (tr.some(i => pianoIdx.includes(i))) pianoLanes.add(li); });
  check(pianoLanes.size === 2, `打包：Piano 1 ×7 分 ${pianoLanes.size} 车道（容量允许下尽量聚拢）`);
  check(wfxPacked.some(tr => tr.includes(0) && tr.includes(1)), '打包：Main/Main2（相似名归组）聚同一车道（名称重复优先）');
}
context.window.__NBS2SCHEMATIC.state.lanes = wfxPacked.map(t => ({ tracks: t }));
context.window.__NBS2SCHEMATIC.state.lanes.forEach((l, i) => { l.start = { dz: i * 3 + 3, dy: 0 }; });
context.renderLaneSection();
await context.generate();
const wfRes = context.window.__NBS2SCHEMATIC.state.result;
check(wfRes !== null && wfRes.result.stats.notesDiscarded === 0 && wfRes.result.stats.notesPlaced === 1126,
  `WFXLC 打包方案生成：0 丢弃、1126 音符全放置（丢弃 ${wfRes && wfRes.result.stats.notesDiscarded}）`);

// 车道复制（⧉）：复制后生成双倍音符盒（仅被复制车道的音符翻倍）
context.duplicateLane(0);
const st6 = context.window.__NBS2SCHEMATIC.state;
check(st6.lanes.length === 6 && st6.lanes[0].tracks.join(',') === st6.lanes[1].tracks.join(','),
  '车道复制：新车道紧邻原车道且音轨相同');
await context.generate();
const dupWf = context.window.__NBS2SCHEMATIC.state.result;
const lane0Notes = st6.lanes[0].tracks.reduce((s, t) => s + wfx.layers[t].notes.size, 0);
check(dupWf !== null && dupWf.result.stats.notesPlaced === 1126 + lane0Notes,
  `复制车道生成：1126+${lane0Notes}=${1126 + lane0Notes} 音符盒（实际 ${dupWf && dupWf.result.stats.notesPlaced}）`);

// 未分配音轨检查：清空原车道与复制品 → 面板警告 → 自动并入恢复
context.window.__NBS2SCHEMATIC.state.lanes[0].tracks = [];
context.window.__NBS2SCHEMATIC.state.lanes[1].tracks = [];
context.renderLaneSection();
check(elements.get('mergeAdvice').innerHTML.includes('未分配的音轨'), '未分配音轨警告显示');
check(elements.get('assignRestBtn').hidden === false, '自动并入按钮可见');
const restored = context.assignUnassigned(context.window.__NBS2SCHEMATIC.state.song);
check(restored > 0, `自动并入恢复 ${restored} 条未分配音轨`);
check(!elements.get('mergeAdvice').innerHTML.includes('未分配的音轨'), '并入后无未分配警告');
await context.generate();
const wfRestored = context.window.__NBS2SCHEMATIC.state.result;
check(wfRestored !== null && wfRestored.result.stats.notesDiscarded === 0, '自动并入后生成 0 丢弃');

// ---------- 修复1 回归：删除/复制车道后其余车道起点原样跟随（不再按下标错位） ----------
const canon2 = context.parseNBS(new Uint8Array(readFileSync(path.join(__dirname, 'canon in d major Loop.nbs'))));
canon2.sourceFileName = 'canon in d major Loop.nbs';
context.onSongLoaded(canon2, null);
const st7 = context.window.__NBS2SCHEMATIC.state;
const nLanes = st7.lanes.length;
check(nLanes >= 3, `卡农自动建道 ≥3 条（实际 ${nLanes}）`);
st7.lanes.forEach((l, i) => { l.start = { dz: (i + 1) * 7, dy: i * 3 }; });
const before = st7.lanes.slice(1).map(l => ({ dz: l.start.dz, dy: l.start.dy }));
context.deleteLane(0);
check(st7.lanes.length === nLanes - 1, '车道删除：车道数 -1');
check(st7.lanes.slice(0, nLanes - 1).every((l, i) => l.start.dz === before[i].dz && l.start.dy === before[i].dy),
  '车道删除：其余各道起点原样跟随（无错位）');
const lenBefore = st7.lanes.length;
context.duplicateLane(0);
check(st7.lanes.length === lenBefore + 1, '车道复制：车道数 +1');
const starts = st7.lanes.map(l => `${l.start.dz},${l.start.dy}`);
check(new Set(starts).size === starts.length, `车道复制：新起点与既有起点无重叠（${st7.lanes[1].start.dz},${st7.lanes[1].start.dy}）`);
st7.lanes.forEach((l, i) => { l.start = { dz: (i + 1) * 7, dy: i * 3 }; }); // 复位避免重叠报错
st7.lanes.push({ tracks: [] }); // 空车道：generate 的过滤 lanes 必须与起点逐一对齐
context.syncLaneStarts();
await context.generate();
check(context.window.__NBS2SCHEMATIC.state.result !== null, '含空车道时 generate 不越界（起点与过滤后 lanes 对齐）');

// ---------- 修复2 回归：勾选/取消勾选音轨增量增删，不清空手动车道分组 ----------
st7.lanes = [{ tracks: [0] }, { tracks: [1] }, { tracks: [2] }];
st7.lanes.forEach((l, i) => { l.start = { dz: (i + 1) * 9, dy: i * 4 }; });
st7.selectedLayers = new Set([0, 1, 2]);
const st8 = st7;
const start1 = { ...st8.lanes[1].start }, start2 = { ...st8.lanes[2].start };
context.onLayerToggle(0, false);
check(!st8.selectedLayers.has(0), '取消勾选：selectedLayers 移除 0');
check(st8.lanes.length === 3 && st8.lanes[0].tracks.length === 0 && st8.lanes[1].tracks.join(',') === '1' && st8.lanes[2].tracks.join(',') === '2',
  `取消勾选：0 从各车道移除、空车道保留（实际 ${JSON.stringify(st8.lanes.map(l => l.tracks))}）`);
check(st8.lanes[1].start.dz === start1.dz && st8.lanes[1].start.dy === start1.dy
  && st8.lanes[2].start.dz === start2.dz && st8.lanes[2].start.dy === start2.dy,
  '取消勾选：其余车道起点原样保留（不被整体重建）');
context.onLayerToggle(0, true);
check(st8.selectedLayers.has(0) && st8.lanes[0].tracks.join(',') === '0' && st8.lanes.length === 3,
  '回填勾选：0 追加回第一条无冲突车道（不新建车道）');
context.onLayerToggle(1, false);
context.onLayerToggle(2, false);
context.onLayerToggle(0, false);
check(st8.lanes.length === 3 && st8.lanes.every(l => l.tracks.length === 0), '全部取消勾选：3 条空车道保留');
elements.get('selectNoneBtn').dispatch('click', {});
check(st8.lanes.length === 0 && st8.selectedLayers.size === 0, '全不选：车道与选中池彻底清空');
elements.get('selectAllBtn').dispatch('click', {});
const nLayers = st8.song.layers.length;
check(st8.selectedLayers.size === nLayers && st8.lanes.length === Math.ceil(nLayers / 3)
  && st8.lanes[0].tracks.join(',') === '0,1,2',
  `全选：整体重建为每 3 轨一车道（${st8.lanes.length} 条，首道 [0,1,2]）`);
context.onLayerToggle(st8.lanes[0].tracks[2], false);
check(st8.lanes.length === Math.ceil(nLayers / 3) && st8.lanes[0].tracks.join(',') === '0,1'
  && st8.lanes[1].tracks.includes(3),
  '全选后增量取消勾选：只动对应车道，其余车道分组不受影响');

// ---------- D2 诊断渲染：截断 NBS 解析 → 错误框偏移文本 + details/pre/导出按钮 ----------
{
  const full = new Uint8Array(readFileSync(path.join(__dirname, 'demo_song.nbs')));
  const cut = full.subarray(0, Math.floor(full.length * 0.6));
  let thrown = null;
  try { context.parseNBS(cut); } catch (e) { thrown = e; }
  check(thrown && thrown.name === 'ParseError' && typeof thrown.offset === 'number'
    && thrown.partial && thrown.partial.layers === 27,
    `截断文件 ParseError 带 offset=${thrown && thrown.offset} 与 partial（${thrown && JSON.stringify(thrown.partial)}）`);
  if (thrown) {
    context.showError(thrown.message, thrown);
    const errText = elements.get('errors').textContent;
    check(errText.includes(`字节偏移 ${thrown.offset}/${cut.length}`), '错误框含字节偏移文本');
    check(errText.includes('已解析部分') && errText.includes('27 层'), '错误框含 partial 摘要');
    const diagBox = elements.get('error-diag');
    const details = diagBox.children.find(c => c.tagName === 'details');
    check(!!details, '诊断 details 容器已挂到 #error-diag');
    const pre = details && details.children.find(c => c.tagName === 'pre');
    const btn = details && details.children.find(c => c.tagName === 'button');
    check(!!pre && pre.textContent.includes('"offset"') && pre.textContent.includes('"partial"'), '诊断 pre 含 JSON（offset/partial 字段）');
    check(!!btn && btn.textContent === '导出诊断 JSON', '导出诊断 JSON 按钮存在');
    if (btn) { btn.dispatch('click', {}); check(true, '导出诊断 JSON 点击无异常'); }
    context.clearError();
    check(elements.get('errors').textContent === '' && elements.get('error-diag').children.length === 0,
      'clearError 清空错误框与诊断容器');
  }
}

// ---------- P 状态持久化：保存 → 同歌重载恢复 → 换歌不恢复 ----------
{
  const st9 = context.window.__NBS2SCHEMATIC.state;
  st9.lanes.forEach((l, i) => { l.start = { dz: (i + 1) * 11, dy: i * 2 }; });
  st9.lanes[0].tracks = [0];
  st9.selectedLayers = new Set([0]);
  st9.settings.targetVersion = '1.20.4';
  context.saveStateNow();
  const key = context.stateKey(st9.song);
  const raw = context.localStorage.getItem(key);
  check(!!raw, `saveStateNow 写入 localStorage（key=${key}）`);
  if (raw) {
    const parsed = JSON.parse(raw);
    check(parsed.v === 1 && parsed.lanes.length === st9.lanes.length && parsed.selectedLayers.join(',') === '0'
      && parsed.settings.targetVersion === '1.20.4'
      && parsed.lane0Start && typeof parsed.lane0Start.dz === 'number' && typeof parsed.lane0Start.dy === 'number',
      '持久化载荷含 v/lanes/selectedLayers/settings（含 targetVersion）/lane0Start');
  }
  // 同歌重载 → 恢复车道/起点/选中/设置
  const canon3 = context.parseNBS(new Uint8Array(readFileSync(path.join(__dirname, 'canon in d major Loop.nbs'))));
  canon3.sourceFileName = 'canon in d major Loop.nbs';
  context.onSongLoaded(canon3, null);
  const st10 = context.window.__NBS2SCHEMATIC.state;
  check(st10.lanes.length === st9.lanes.length && st10.lanes[0].tracks.join(',') === '0'
    && st10.lanes[1].start.dz === 22 && st10.lanes[1].start.dy === 2
    && st10.selectedLayers.size === 1 && st10.selectedLayers.has(0)
    && st10.settings.targetVersion === '1.20.4',
    `同歌重载恢复车道/起点/选中/设置（lanes=${st10.lanes.length}，首道 [${st10.lanes[0].tracks}]，道2 起点 ${JSON.stringify(st10.lanes[1].start)}，targetVersion=${st10.settings.targetVersion}）`);
  check(elements.get('genStatus').textContent.includes('已恢复上次编辑状态'), '恢复后 genStatus 提示');
  // 换歌（demo_song）→ 车道/选中不恢复（默认全选自动建道，起点归默认 i*3+3）；
  // 注意 settings 为全局设置，原应用切歌本就不重置（内存保持），故不断言 targetVersion
  const demo2 = context.parseNBS(new Uint8Array(readFileSync(path.join(__dirname, 'demo_song.nbs'))));
  demo2.sourceFileName = 'demo_song.nbs';
  context.onSongLoaded(demo2, null);
  const st11 = context.window.__NBS2SCHEMATIC.state;
  check(st11.lanes.length === 1 && st11.lanes[0].tracks.join(',') === '0,1,2'
    && st11.lanes[0].start.dz === 3 && st11.lanes[0].start.dy === 0
    && st11.selectedLayers.size === 3
    && elements.get('genStatus').textContent === '',
    '换歌加载不恢复（默认全选自动建道起点 i*3+3，无恢复提示）');
}

// ---------- R 节奏参考声道：双类型（绑定/独立）+ 生成产物 + 旧格式迁移 + sfxPitchStep 持久化 ----------
{
  const st = context.window.__NBS2SCHEMATIC.state;
  const { onRefToggle, onRefSoundToggle, onRefLaneTypeChange, refSpecOf, lanePoolMembers,
    SFX_PARTICLE_CMD, SFX_CB_STATE, sfxParticleCmd } = context.window.__NBS2SCHEMATIC;
  const listHtml = () => elements.get('layerList').innerHTML;
  const refLaneClasses = () => {
    const out = []; const rec = (n) => { if (n.className) out.push(n.className); (n.children || []).forEach(rec); };
    rec(elements.get('refLaneList')); return out.join(' ');
  };
  const refLaneTypeOpts = () => {
    const out = []; const rec = (n) => {
      if (n.className && n.className.includes('ref-lane-type')) { if (n._html) out.push(n._html); }
      (n.children || []).forEach(rec);
    }; rec(elements.get('refLaneList')); return out.join('');
  };
  const refSpec = i => st.refLayers.get(i);
  // 0) refSpecOf 归一化（旧 bool 宽松迁移）
  check(JSON.stringify(refSpecOf(true)) === '{"type":"independent","sound":true}'
    && JSON.stringify(refSpecOf(false)) === '{"type":"independent","sound":false}'
    && JSON.stringify(refSpecOf({ type: 'bound', sound: true })) === '{"type":"bound","sound":true}'
    && JSON.stringify(refSpecOf(undefined)) === '{"type":"independent","sound":false}',
    'refSpecOf：bool/对象/未定义 归一化为 {type,sound}');
  // 1) 勾选参考 → 默认独立型、发声勾、进车道池 + 参考车道卡片渲染类型下拉（选型已移至参考车道池，按车道）
  onRefToggle(0, true);
  check(JSON.stringify(refSpec(0)) === '{"type":"independent","sound":true}', '参考框勾选：refLayers[0]={independent,true}（默认独立型）');
  check(st.selectedLayers.has(0) && st.lanes.some(l => l.tracks.includes(0)) && lanePoolMembers(st.song).includes(0),
    '参考+发声：进车道池');
  check(refLaneClasses().includes('ref-lane-type'), '参考车道卡片渲染类型下拉（选型已从音轨池行移出）');
  check(!listHtml().includes('class="layer-ref-type"'), '音轨池行不再渲染类型下拉');
  check(refLaneTypeOpts().includes('<option value="independent" selected>独立型</option>'), '类型下拉默认选中独立型（按车道）');
  check(listHtml().includes('class="layer-sound" data-i="0" checked') && !listHtml().includes('data-i="0" checked" disabled'),
    '独立型发声框渲染且未禁用');
  check(listHtml().includes('♪'), '参考声道带 ♪ 标记');
  // 2) 车道类型下拉切绑定型 → 成员强制发声、发声框禁用
  onRefLaneTypeChange(0, 'bound');
  check(st.refLanes[0].type === 'bound', '参考车道 lane.type=bound（选型存于车道）');
  check(JSON.stringify(refSpec(0)) === '{"type":"bound","sound":true}', '成员 refLayers 类型跟随车道：{bound,true}');
  check(st.lanes.some(l => l.tracks.includes(0)), '绑定型：成员仍在车道池（必须发声）');
  check(refLaneTypeOpts().includes('<option value="bound" selected>绑定型</option>'), '车道类型下拉选中绑定型');
  check(listHtml().includes('class="layer-sound" data-i="0" checked disabled'), '绑定型成员发声框 checked + disabled');
  // 3) 绑定型强制发声：取消发声被拒绝
  onRefSoundToggle(0, false);
  check(refSpec(0).sound === true && st.lanes.some(l => l.tracks.includes(0)),
    '绑定型取消发声被强制恢复（sound 恒 true、仍在车道池）');
  // 4) 车道切回独立型 → 发声框可用；取消发声 = 静音参考（出车道池、保留参考）
  onRefLaneTypeChange(0, 'independent');
  check(st.refLanes[0].type === 'independent', '车道切回独立型：lane.type=independent');
  check(JSON.stringify(refSpec(0)) === '{"type":"independent","sound":true}', '切回独立型：成员保持发声');
  check(!listHtml().includes('checked disabled'), '独立型成员发声框不再禁用');
  onRefSoundToggle(0, false);
  check(JSON.stringify(refSpec(0)) === '{"type":"independent","sound":false}', '取消发声：{independent,false}（静音参考）');
  check(!st.lanes.some(l => l.tracks.includes(0)) && !lanePoolMembers(st.song).includes(0),
    '静音独立型：移出车道池（不进车道）');
  check(st.refLayers.has(0) && listHtml().includes('♪'), '静音参考：参考状态保留（♪ 仍在，只贡献粒子时序）');
  // 5) 混合场景：#1 绑定型（独立绑定车道）+ #2 独立型（#0 仍静音独立型）→ 生成
  onRefToggle(2, true); // 并入当前空参考车道（独立型）
  const liBound = st.refLanes.length;
  st.refLanes.push({ tracks: [1], type: 'independent', start: { dz: 0, dy: 0 } });
  st.refLayers.set(1, { type: 'independent', sound: true }); // 登记参考（模拟勾选，成员直插新车道）
  onRefLaneTypeChange(liBound, 'bound'); // 车道切绑定 → #1 强制发声并进音轨车道池
  check(st.refLayers.size === 3 && refSpec(1).type === 'bound' && refSpec(2).type === 'independent',
    '混合：#0 静音独立、#1 绑定（车道级）、#2 独立发声');
  st.lanes.forEach((l, i) => { l.start = { dz: i * 3 + 3, dy: 0 }; });
  st.lane0.start = { dz: 0, dy: 0 };
  // 参考车道起点：绑定车道（#1）放 (6,1)、独立车道（#2）放 (12,1)；空参考车道移除
  // （手动设定起点，模拟用户拖拽避让；重叠会被布局校验阻断生成）
  st.refLanes = st.refLanes.filter(l => l.tracks.length > 0);
  st.refLanes.forEach((l) => {
    l.start = l.tracks.includes(1) ? { dz: 6, dy: 1 } : { dz: 12, dy: 1 };
  });
  check(st.refLanes.some(l => l.tracks.includes(1) && (l.type || 'independent') === 'bound'
    && l.start.dz === 6 && l.start.dy === 1), '混合布局：绑定车道（#1）起点 (6,1)');
  st.settings.targetVersion = '1.21.11'; // 断言目录名用 1.21 的 function/（前文 P 块可能遗留其他目标）
  context.renderLaneSection();
  await context.generate();
  check(elements.get('sfxZipBtn').hidden === false, '有参考声道：粒子数据包 zip 按钮可见');
  check(st.sfxZipBytes && st.sfxZipBytes.length > 40, `生成后 sfxZipBytes 非空（${st.sfxZipBytes && st.sfxZipBytes.length} 字节）`);
  const mixRes = st.result.result;
  check(mixRes.stats.commandBlocks > 0 && mixRes.stats.sfxBoundNotes > 0 && mixRes.stats.sfxStandaloneNotes > 0,
    `混合产物：CB=${mixRes.stats.commandBlocks} 绑定行=${mixRes.stats.sfxBoundNotes} 独立行=${mixRes.stats.sfxStandaloneNotes}（均 >0）`);
  check(mixRes.sfxTickList.length === mixRes.stats.commandBlocks,
    'sfxTickList 与命令方块一一对应（有行 ⇔ 有 CB）');
  check(mixRes.tileEntities.length > 0
    && mixRes.tileEntities.every(te => /^function nbs2sfx:\d+$/.test(te.Command)),
    'TE 命令均为 function nbs2sfx:<tick>');
  // CB 全在轨道 0 主位底座（lane0 坐标），且所在格方块 = facing=up
  {
    const out = st.result, grid = out.result.grid, palette = out.palette;
    let bad = 0;
    for (const te of out.result.tileEntities) {
      if (te.y !== 0 || te.z !== 1) bad++;
      else if (palette[grid.data[(te.y * grid.sz + te.z) * grid.sx + te.x]] !== SFX_CB_STATE) bad++;
    }
    check(bad === 0, `全部 CB 在轨道 0 主位底座（y=0, 网格 z=1，facing=up），异常 ${bad} 个`);
  }
  // 粒子行：偏移已计算（无一逐字等于原始参考命令）；绑定行 = 参考车道盒偏移（refLanes[0] dz=6/dy=1 → ~0 ~2 ~6，音轨车道重叠盒不产行）；独立行形如 ~0 ~0 ~<z>
  check(mixRes.sfxTickList.every(e => e.lines.every(l => l.startsWith('particleex ') && l !== SFX_PARTICLE_CMD)),
    '所有粒子行偏移已计算（无一与逐字原命令相同）');
  check(mixRes.sfxTickList.some(e => e.lines.includes(sfxParticleCmd(0, 2, 6))),
    '绑定行锚定参考车道盒（refLanes dz=6/dy=1 → ~0 ~2 ~6，而非音轨车道 ~0 ~1 ~3）');
  check(mixRes.sfxTickList.every(e => e.lines.every(l => /~(-?\d+) ~(-?\d+) ~(-?\d+) /.test(l))),
    '所有粒子行坐标段为计算偏移 ~dx ~dy ~dz');
  // zip（STORE 无压缩）内容可直读：逐 tick mcfunction 名 + 每行命令逐字出现
  {
    const zipStr = Buffer.from(st.sfxZipBytes).toString('latin1');
    const ticksOk = mixRes.sfxTickList.every(e => zipStr.includes(`data/nbs2sfx/function/${e.tick}.mcfunction`));
    const linesOk = mixRes.sfxTickList.every(e => e.lines.every(l => zipStr.includes(l)));
    check(ticksOk && linesOk, 'zip 内逐 tick mcfunction 名与全部粒子命令行逐字存在（STORE 直读）');
  }
  // 6) 纯独立型场景：#1 参考取消（转普通）→ 仅剩独立型 → 0 绑定行
  onRefToggle(1, false);
  await context.generate();
  const indepRes = st.result.result;
  check(indepRes.stats.sfxBoundNotes === 0 && indepRes.stats.sfxStandaloneNotes > 0
    && indepRes.stats.commandBlocks > 0,
    `纯独立型：绑定行=0、独立行=${indepRes.stats.sfxStandaloneNotes}、CB=${indepRes.stats.commandBlocks}`);
  check(indepRes.sfxTickList.every(e => e.lines.every(l => /^particleex polarparameter minecraft:end_rod ~0 ~0 ~-?\d+ /.test(l))),
    '独立型行垂直偏移恒 0（~0 ~0 ~<z>，z 按音高）');
  // 7) 参考全取消 → 重新生成：zip 隐藏、无 CB
  onRefToggle(0, false);
  onRefToggle(2, false);
  check(st.refLayers.size === 0, '参考框全取消：refLayers 清空');
  await context.generate();
  check(elements.get('sfxZipBtn').hidden === true, '无参考声道：zip 按钮隐藏');
  check(st.sfxZipBytes === null, '无参考声道：sfxZipBytes 清空');
  check(st.result.result.stats.commandBlocks === 0, '无参考声道：0 命令方块');
  // 8) 持久化：绑定型 + sfxPitchStep 往返
  onRefToggle(0, true); // #0 静音独立 → 重新发声并入（当前参考车道为独立型）
  onRefLaneTypeChange(0, 'bound'); // 其所在参考车道切绑定
  st.settings.sfxPitchStep = 3;
  context.saveStateNow();
  const raw = context.localStorage.getItem(context.stateKey(st.song));
  const parsed = raw && JSON.parse(raw);
  check(!!parsed && JSON.stringify(parsed.refLayers) === '[[0,{"type":"bound","sound":true}]]',
    '持久化载荷 refLayers=[[0,{type:"bound",sound:true}]]（新对象格式）');
  check(!!parsed && Array.isArray(parsed.refLanes)
    && parsed.refLanes.some(l => l.tracks.includes(0) && l.type === 'bound'),
    '持久化载荷 refLanes 含绑定型车道（lane.type 字段往返）');
  check(!!parsed && parsed.settings.sfxPitchStep === 3, '持久化载荷 settings.sfxPitchStep=3');
  // 9) 旧格式迁移：手工写入旧 bool 载荷 → 重载按独立型迁移
  if (parsed) {
    parsed.refLayers = [[1, true]];
    context.localStorage.setItem(context.stateKey(st.song), JSON.stringify(parsed));
  }
  const demo3 = context.parseNBS(new Uint8Array(readFileSync(path.join(__dirname, 'demo_song.nbs'))));
  demo3.sourceFileName = 'demo_song.nbs';
  context.onSongLoaded(demo3, null);
  const stR = context.window.__NBS2SCHEMATIC.state;
  check(stR.refLayers.size === 1 && JSON.stringify(stR.refLayers.get(1)) === '{"type":"independent","sound":true}',
    '旧存档 bool 值迁移：refLayers[1]=true → {independent,true}');
  check(stR.lanes.some(l => l.tracks.includes(1)), '迁移后的发声参考在车道池');
  check(stR.settings.sfxPitchStep === 3, 'sfxPitchStep 持久化往返（3 恢复）');
  context.renderSettings();
  check(elements.get('sfxPitchStep').value === '3', '设置区 sfxPitchStep 输入框回填 3');
}

// ---------- R2 参考车道池：勾选式并入 / 卡片操作 / 布局标记 / 持久化 / 旧存档兼容 ----------
{
  const st = context.window.__NBS2SCHEMATIC.state;
  const { onRefToggle, refLanePoolMembers, duplicateRefLane, deleteRefLane,
    saveStateNow, stateKey, loadSavedState, applySavedState } = context.window.__NBS2SCHEMATIC;
  const song = st.song;
  const noteLayers = [];
  song.layers.forEach((l, i) => { if (l.notes.size > 0) noteLayers.push(i); });
  const [i0, i1] = noteLayers;
  check(noteLayers.length >= 2, 'R2 前置：测试曲至少 2 条有声部');
  // 干净状态（R 块遗留的 refLayers/lanes/refLanes 全清）
  st.refLayers = new Map(); st.lanes = []; st.refLanes = [];
  // 1) 勾选参考 → 勾选式并入参考车道池 + 允许重叠（同时进音轨车道池）
  onRefToggle(i0, true);
  check(st.refLanes.length === 1 && st.refLanes[0].tracks.includes(i0),
    '勾选参考：自动并入（新建）第一条参考车道');
  check(st.lanes.some(l => l.tracks.includes(i0)), '允许重叠：发声参考同时在音轨车道池');
  check(refLanePoolMembers(song).includes(i0), 'refLanePoolMembers 含发声参考');
  onRefToggle(i1, true);
  check(st.refLanes.some(l => l.tracks.includes(i1)), '第二条参考并入参考车道池（无冲突同车道或新建）');
  // 2) 卡片渲染：名称/复制/删除/成员标签/计数（DOM 桩无 className 属性 → 按 children 树收集 className 检查）
  const classesOf = (el) => { const out = []; const rec = (n) => { if (n.className) out.push(n.className); (n.children || []).forEach(rec); }; rec(el); return out.join(' '); };
  const html = classesOf(elements.get('refLaneList'));
  check(html.includes('ref-lane-del') && html.includes('ref-lane-dup'), '参考车道卡片渲染删除/复制按钮');
  check(html.includes('ref-lane-tag'), '参考车道成员标签渲染');
  check(elements.get('refGroupCount').textContent === `共 ${st.refLanes.length} 条参考车道`, 'refGroupCount 计数正确');
  // 3) 复制/删除
  const nBefore = st.refLanes.length;
  const srcTracks = JSON.stringify(st.refLanes[0].tracks);
  duplicateRefLane(0);
  check(st.refLanes.length === nBefore + 1 && JSON.stringify(st.refLanes[1].tracks) === srcTracks,
    '复制：新车道插入源后、tracks 相同');
  deleteRefLane(1);
  check(st.refLanes.length === nBefore && JSON.stringify(st.refLanes[0].tracks) === srcTracks,
    '删除：复制出的车道移除、源车道保留');
  // 3b) 拖拽：dropToRefLane = 登记参考 + 移入目标车道 + 进音轨车道池 + 绑定型跟随（允许重复拖入齐响）
  const { dropToRefLane } = context.window.__NBS2SCHEMATIC;
  st.refLayers = new Map(); st.refLanes = [];
  st.refLanes.push({ tracks: [], type: 'independent', start: { dz: 30, dy: 2 } });
  const i2 = noteLayers[2] !== undefined ? noteLayers[2] : i1;
  dropToRefLane(i2, 0);
  check(JSON.stringify(st.refLayers.get(i2)) === '{"type":"independent","sound":true}'
    && JSON.stringify(st.refLanes[0].tracks) === JSON.stringify([i2]),
    '拖入：未勾选参考的音轨拖入 → 登记为参考（独立+发声）并入目标车道');
  check(st.lanes.some(l => l.tracks.includes(i2)), '拖入：发声参考同时进音轨车道池（允许重叠）');
  check(refLanePoolMembers(song).includes(i2), '拖入：refLanePoolMembers 含该音轨');
  st.refLanes.push({ tracks: [i0], type: 'independent', start: { dz: 40, dy: 2 } });
  dropToRefLane(i2, 1);
  check(!st.refLanes[0].tracks.includes(i2) && JSON.stringify(st.refLanes[1].tracks) === JSON.stringify([i0, i2]),
    '拖入：音轨从其他参考车道移入目标车道（跨车道移动，与已有成员 i0 共存）');
  st.refLanes[1].type = 'bound';
  dropToRefLane(i2, 1);   // 重复拖入同一车道
  check(JSON.stringify(st.refLanes[1].tracks) === JSON.stringify([i0, i2, i2]),
    '拖入：重复拖入同一车道 = 占多个盒位齐响');
  check(JSON.stringify(st.refLayers.get(i2)) === '{"type":"bound","sound":true}',
    '拖入：并入绑定型车道 → 成员 refLayers 类型跟随车道（bound）');
  let nLaneI2 = 0; st.lanes.forEach((l) => { nLaneI2 += l.tracks.filter(x => x === i2).length; });
  check(nLaneI2 === 1, '拖入：音轨车道池不重复入位（仍 1 份）');
  check(classesOf(elements.get('refLaneList')).includes('ref-lane-drop'), '参考车道卡片渲染拖放区（.ref-lane-drop）');
  // 4) 布局编辑器：标记含参考车道（紫色 R 前缀、idxKind 映射、validate 命名）
  const ed = context.window.__NBS2SCHEMATIC.layoutEditor;
  check(ed.starts().length === 1 + st.lanes.length + st.refLanes.length,
    '布局编辑器标记 = 轨道 0 + 音轨车道 + 参考车道');
  check(ed.idxKind(1 + st.lanes.length).kind === 'ref' && ed.idxKind(1 + st.lanes.length).j === 0,
    'idxKind 将参考车道下标映射到 refLanes[0]');
  check(ed.idxKind(1).kind === 'lane' && ed.idxKind(0).kind === 'lane0', 'idxKind 音轨车道/轨道 0 映射');
  const refStart = st.refLanes[0].start;
  refStart.dz = -7; refStart.dy = -3; // 负坐标：布局标记与校验不受影响
  const { errors: vErrs } = ed.validate();
  check(vErrs.every(m => !m.includes('undefined')), 'validate 对参考车道起点命名正常（无 undefined）');
  refStart.dz = 0; refStart.dy = 0;
  // 4b) 预置模板：以 0 号车道为中心 + 参考车道一并重排
  const st2 = context.window.__NBS2SCHEMATIC.state;
  st2.refLanes = [{ tracks: [i0] }]; // 干净已知状态：1 音轨车道 + 1 参考车道
  st2.lane0.start = { dz: 2, dy: 3 }; // 非原点中心
  elements.get('presetLineBtn').dispatch('click', {});
  check(st2.lanes[0].start.dz === 5 && st2.lanes[0].start.dy === 3
    && st2.refLanes[0].start.dz === -1 && st2.refLanes[0].start.dy === 3,
    '预置单行：音轨车道 (5,3)、参考车道 (-1,3)（以 (2,3) 为中心，Z 两侧交替 ±3）');
  elements.get('presetGridBtn').dispatch('click', {});
  check(st2.lanes[0].start.dz === 5 && st2.lanes[0].start.dy === 3
    && st2.refLanes[0].start.dz === -1 && st2.refLanes[0].start.dy === 3,
    '预置网格：音轨车道 (5,3)、参考车道 (-1,3)（首行两侧，行距未用到）');
  st2.lanes = [{ tracks: [i0] }, { tracks: [i1] }];
  elements.get('presetRadialBtn').dispatch('click', {});
  check(st2.lanes[0].start.dz === 5 && st2.lanes[0].start.dy === 3
    && st2.lanes[1].start.dz === -1 && st2.lanes[1].start.dy === 3
    && st2.refLanes[0].start.dz === 8 && st2.refLanes[0].start.dy === 3,
    '预置放射：按到中心距离由近及远 (3,0)→(-3,0)→(6,0)（同距取 +Z 侧优先）');
  const { errors: pErrs } = ed.validate();
  check(pErrs.length === 0, '预置放射后布局无重叠错误');
  st2.lanes = [{ tracks: [i0], start: { dz: 3, dy: 0 } }]; st2.refLanes = [{ tracks: [i0] }];
  st2.lane0.start = { dz: 0, dy: 0 };
  context.window.__NBS2SCHEMATIC.syncRefLaneStarts(); // 预置还原的新车道补起点（供后续持久化断言）
  // 5) 持久化往返
  saveStateNow();
  let parsed = JSON.parse(context.localStorage.getItem(stateKey(song)));
  check(Array.isArray(parsed.refLanes) && parsed.refLanes.length === st.refLanes.length
    && JSON.stringify(parsed.refLanes[0].tracks) === JSON.stringify(st.refLanes[0].tracks)
    && Number.isFinite(parsed.refLanes[0].start.dz), '持久化载荷 refLanes 结构完整（tracks+start）');
  // 6) 旧存档无 refLanes 字段 → 恢复为空池（不报错）
  delete parsed.refLanes;
  context.localStorage.setItem(stateKey(song), JSON.stringify(parsed));
  const saved2 = loadSavedState(song);
  check(!!saved2 && !('refLanes' in saved2), 'loadSavedState 接受无 refLanes 的旧载荷');
  applySavedState(song, saved2);
  check(Array.isArray(st.refLanes) && st.refLanes.length === 0, '旧存档恢复：refLanes = 空池');
}

// 7) v6 小号回退提示：NBS ID 16-19 = MC 26.1 Trumpet 系，目标 MC 1.19.4~1.21.11 note_block 无小号音色
const trumpBuf = Buffer.from(makeNbs({ tempoTps: 10, songLength: 8, noteSpecs: [
  { tick: 0, layer: 0, instrument: 16, key: 40 },
  { tick: 2, layer: 0, instrument: 17, key: 42 },
  { tick: 4, layer: 0, instrument: 18, key: 44 },
  { tick: 6, layer: 0, instrument: 19, key: 45 },
]}));
trumpBuf[2] = 6; trumpBuf[3] = 20; // 改写头部为 v6（nbs_version 6 + first_custom_index 20，字节格式与 v5 一致）
context.onSongLoaded(context.parseNBS(new Uint8Array(trumpBuf)), null);
let infoHtml = elements.get('songInfo').innerHTML;
check(infoHtml.includes('<b>4</b>') && infoHtml.includes('小号') && infoHtml.includes('harp'),
  'v6 歌曲含 4 个小号音符：歌曲信息区提示回退 harp（雪块底座）');
const v5Buf = makeNbs({ tempoTps: 10, songLength: 4, noteSpecs: [
  { tick: 0, layer: 0, instrument: 16, key: 40 },
]});
context.onSongLoaded(context.parseNBS(new Uint8Array(v5Buf)), null);
infoHtml = elements.get('songInfo').innerHTML;
check(!infoHtml.includes('小号'), 'v5 歌曲：ID 16 是自定义乐器而非内置小号，不触发小号提示');

process.exit(failed ? 1 : 0);
