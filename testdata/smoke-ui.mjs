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
// innerHTML 序列化：应用直接赋值 innerHTML 的字符串优先；否则按 children 树序列化（叶子 textContent 追加，
// 桩里元素不会既有子元素又有裸文本，拼接即可模拟真实 DOM 的 text 节点）
function serEl(e) {
  if (typeof e._html === 'string' && e._html !== '') return e._html;
  const kids = Array.isArray(e.children) ? e.children.map(serEl).join('') : '';
  return kids + (e.textContent || '');
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
    className: '',
    get innerHTML() { return el._html !== '' ? el._html : (el.children.length ? el.children.map(serEl).join('') : ''); },
    set innerHTML(v) { el._html = String(v || ''); el.children = []; },
    style: {}, dataset: {}, value: '', checked: false,
    width: 0, height: 0, options: [],
    _classes: new Set(),
    classList: {
      // 真实 DOM 中 className 与 classList 同步；桩里 class 操作必须回写 className（断言按 className 收集）
      add(c) { el._classes.add(c); const old = String(el.className || '').split(/\s+/).filter(Boolean); el.className = [...new Set([...old, c])].join(' '); },
      remove(c) { el._classes.delete(c); el.className = String(el.className || '').split(/\s+/).filter(x => x && x !== c).join(' '); },
      contains(c) { return el._classes.has(c) || String(el.className || '').split(/\s+/).includes(c); },
      toggle(c) { if (el.classList.contains(c)) { el.classList.remove(c); return false; } el.classList.add(c); return true; },
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
// 粒子特效总览（4 类框架：触发/连接/背景/消失均已实现，2026-09-10 背景型落地）
{
  const eff = elements.get('sfxEffectList').innerHTML;
  check(eff.includes('① 触发型') && eff.includes('② 连接型') && eff.includes('③ 背景型') && eff.includes('④ 消失型'),
    '粒子特效总览：4 类（触发/连接/背景/消失）全部渲染');
  check((eff.match(/已实现/g) || []).length === 4 && (eff.match(/规划中/g) || []).length === 0,
    '粒子特效总览：4 类全标「已实现」（背景型 2026-09-10 落地，无规划中）');
  check(eff.includes('minecraft:end_rod') && eff.includes('sfxPitchStep'),
    '粒子特效总览：触发型条目含当前效果（end_rod 螺旋）与参数规则描述');
  check(eff.includes('tickpolarparameter') && eff.includes('点距 ≤0.1 格'),
    '粒子特效总览：连接型条目含实现描述（tickpolarparameter、点距 ≤0.1 格）');
  check(eff.includes('particleex conditional') && eff.includes('默认不勾选'),
    '粒子特效总览：消失型条目含 #Cube 条件立方体描述与默认不勾选注记');
  check(eff.includes('18.125') && eff.includes('73'),
    '粒子特效总览：背景型条目含小节长公式（拍号×18.125 取整，4/4 → 73）');
}
// 粒子特效独立模块 + 按车道勾选表（无参考车道时空提示）
check(elements.get('sfxEffect-section').hidden === false, '粒子特效总览为独立 section（已显示）');
check(elements.get('sfxEffectLanes').innerHTML.includes('尚无参考车道'),
  '特效勾选表：无参考车道时显示空提示');
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
    check(parsed.v === 2 && parsed.lanes.length === st9.lanes.length && parsed.selectedLayers.join(',') === '0'
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
  // 1) 勾选参考 → 默认MIDI式、sound=false（只进参考车道池；旧版自动在车道池复制一份被用户 2026-09-06 反馈为多余）
  const lanesBeforeRefToggle = JSON.stringify(st.lanes.map(l => l.tracks));
  onRefToggle(0, true);
  check(JSON.stringify(refSpec(0)) === '{"type":"independent","sound":false}', '参考框勾选：refLayers[0]={independent,false}（默认MIDI式、不发声）');
  check(st.selectedLayers.has(0) && st.refLanes.some(l => l.tracks.includes(0)), '勾选参考：进参考车道池');
  check(JSON.stringify(st.lanes.map(l => l.tracks)) === lanesBeforeRefToggle,
    '勾选参考不改动已有车道分配（不再复制一份进车道池——用户反馈的多余副本）');
  check(refLaneClasses().includes('ref-lane-type'), '参考车道卡片渲染类型下拉（选型已从音轨池行移出）');
  check(!listHtml().includes('class="layer-ref-type"'), '音轨池行不再渲染类型下拉');
  check(refLaneTypeOpts().includes('<option value="independent" selected>MIDI式</option>'), '类型下拉默认选中MIDI式（按车道）');
  check(listHtml().includes('class="layer-sound" data-i="0"') && !listHtml().includes('class="layer-sound" data-i="0" checked'),
    'MIDI式发声框渲染且默认未勾选（sound=false）');
  check(listHtml().includes('♪'), '参考声道带 ♪ 标记');
  // 1b) 勾「发声」= 显式在普通轨道也放盒（齐响加倍）；再取消 = 静音独立参考（只留参考车道一份）
  onRefSoundToggle(0, true);
  check(refSpec(0).sound === true && st.lanes.some(l => l.tracks.includes(0)), '勾发声：{independent,true} + 音轨车道池放盒');
  onRefSoundToggle(0, false);
  check(refSpec(0).sound === false && !st.lanes.some(l => l.tracks.includes(0))
    && st.refLanes.some(l => l.tracks.includes(0)),
    '取消发声：静音独立参考（音轨车道盒移除、参考车道盒保留）');
  // 2) 车道类型下拉切单线式 → 成员类型跟随（sound 保持原值；2026-09-07 起单线式不再强制发声、发声框不 disabled）
  onRefLaneTypeChange(0, 'bound');
  check(st.refLanes[0].type === 'bound', '参考车道 lane.type=bound（选型存于车道）');
  check(JSON.stringify(refSpec(0)) === '{"type":"bound","sound":false}', '成员 refLayers 类型跟随车道：{bound,false}（sound 保持原值 false）');
  check(refLaneTypeOpts().includes('<option value="bound" selected>单线式</option>'), '车道类型下拉选中单线式');
  check(!listHtml().includes('disabled'), '单线式成员发声框不再 disabled（2026-09-07 起可自由取消）');
  // 3) 单线式可自由取消发声（旧语义「强制发声」已废除）：取消 → sound=false、出普通车道池
  onRefSoundToggle(0, false);
  check(JSON.stringify(refSpec(0)) === '{"type":"bound","sound":false}',
    '单线式取消发声：{bound,false}（参考车道虚拟，粒子仍恒产生）');
  check(!st.lanes.some(l => l.tracks.includes(0)), '单线式取消发声：普通车道池移除盒（普通轨道静音）');
  // 4) 车道切回MIDI式 → 发声框可用；取消发声 = 静音参考（出车道池、保留参考）
  onRefLaneTypeChange(0, 'independent');
  check(st.refLanes[0].type === 'independent', '车道切回MIDI式：lane.type=independent');
  check(JSON.stringify(refSpec(0)) === '{"type":"independent","sound":false}', '切回MIDI式：成员 sound 保持 false（绑定阶段已静音）');
  check(!listHtml().includes('checked disabled'), 'MIDI式成员发声框不再禁用');
  onRefSoundToggle(0, false);
  check(JSON.stringify(refSpec(0)) === '{"type":"independent","sound":false}', '取消发声：{independent,false}（静音参考）');
  check(!st.lanes.some(l => l.tracks.includes(0)) && !lanePoolMembers(st.song).includes(0),
    '静音MIDI式：移出车道池（不进车道）');
  check(st.refLayers.has(0) && listHtml().includes('♪'), '静音参考：参考状态保留（♪ 仍在，只贡献粒子时序）');
  // 5) 混合场景：#1 单线式（独立绑定车道）+ #2 MIDI式（#0 仍静音MIDI式）→ 生成
  onRefToggle(2, true); // 并入当前空参考车道（MIDI式）
  const liBound = st.refLanes.length;
  st.refLanes.push({ tracks: [1], type: 'independent', start: { dz: 0, dy: 0 } });
  st.refLayers.set(1, { type: 'independent', sound: true }); // 登记参考（模拟勾选，成员直插新车道）
  onRefLaneTypeChange(liBound, 'bound'); // 车道切绑定 → #1 类型跟随（2026-09-07 起不再强制发声/进池）
  check(st.refLayers.size === 3 && refSpec(1).type === 'bound' && refSpec(2).type === 'independent'
    && refSpec(1).sound === true,
    '混合：#0 静音独立、#1 绑定（车道级，sound 保持）、#2 独立静音（勾选默认）');
  st.lanes.forEach((l, i) => { l.start = { dz: i * 3 + 3, dy: 0 }; });
  st.lane0.start = { dz: 0, dy: 0 };
  // 参考车道起点：绑定车道（#1）放 (6,1)；独立车道（#2）放 (0,0) = 缺省中心基准（2026-09-07 独立中心可拖：
  //   MIDI式 start 语义=粒子中心基准，默认不排布、不避让）；空参考车道移除
  // （手动设定起点，模拟用户拖拽；ref 窗口虚拟几何不做碰撞校验）
  st.refLanes = st.refLanes.filter(l => l.tracks.length > 0);
  st.refLanes.forEach((l) => {
    l.start = l.tracks.includes(1) ? { dz: 6, dy: 1 } : ((l.type || 'independent') === 'bound' ? { dz: 12, dy: 1 } : { dz: 0, dy: 0 });
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
    '绑定行锚定参考车道虚拟槽位（refLanes dz=6/dy=1 → ~0 ~2 ~6，而非音轨车道 ~0 ~1 ~3）');
  check(mixRes.sfxTickList.every(e => e.lines.every(l => /~(-?\d+) ~(-?\d+) ~(-?\d+) /.test(l))),
    '所有粒子行坐标段为计算偏移 ~dx ~dy ~dz');
  // zip（STORE 无压缩）内容可直读：逐 tick mcfunction 名 + 每行命令逐字出现
  {
    const zipStr = Buffer.from(st.sfxZipBytes).toString('latin1');
    const ticksOk = mixRes.sfxTickList.every(e => zipStr.includes(`data/nbs2sfx/function/${e.tick}.mcfunction`));
    const linesOk = mixRes.sfxTickList.every(e => e.lines.every(l => zipStr.includes(l)));
    check(ticksOk && linesOk, 'zip 内逐 tick mcfunction 名与全部粒子命令行逐字存在（STORE 直读）');
  }
  // 6) 纯MIDI式场景：#1 参考取消（转普通）→ 仅剩MIDI式 → 0 绑定行
  onRefToggle(1, false);
  await context.generate();
  const indepRes = st.result.result;
  check(indepRes.stats.sfxBoundNotes === 0 && indepRes.stats.sfxStandaloneNotes > 0
    && indepRes.stats.commandBlocks > 0,
    `纯MIDI式：绑定行=0、独立行=${indepRes.stats.sfxStandaloneNotes}、CB=${indepRes.stats.commandBlocks}`);
  check(indepRes.sfxTickList.every(e => e.lines.every(l => /^particleex (?:polarparameter|tickpolarparameter) minecraft:end_rod ~0 ~0 /.test(l))),
    'MIDI式行垂直偏移恒 0（触发独立行 ~0 ~0 ~<z> 与连接线起点 ~0 ~0 ~<z>，dy=0）');
  check(indepRes.stats.sfxConnectLines > 0
    && indepRes.sfxTickList.flatMap(e => e.lines).filter(l => l.startsWith('particleex tickpolarparameter '))
      .every(l => { const m = l.match(/"s1,s2,dis=([-0-9.]+),0,([0-9.]+)\*t"/); return !!m && Math.abs(Number(m[1])) < 1.5707963; })
    && indepRes.sfxTickList.some(e => e.lines.some(l => /^particleex tickpolarparameter /.test(l)
      && l.includes('"s1,s2,dis=') && / 10 null 1\.0 null$/.test(l))),
    `纯MIDI式含连接线（conn=${indepRes.stats.sfxConnectLines}，缺省模板 age=m=10；真空间斜线：|φ|<π/2，方向恒含 +X 分量（B 端沿链前移 2Δt），非垂直于链的纯 Z 线）`);
  // 7) 参考全取消 → 重新生成：zip 隐藏、无 CB
  onRefToggle(0, false);
  onRefToggle(2, false);
  check(st.refLayers.size === 0, '参考框全取消：refLayers 清空');
  await context.generate();
  check(elements.get('sfxZipBtn').hidden === true, '无参考声道：zip 按钮隐藏');
  check(st.sfxZipBytes === null, '无参考声道：sfxZipBytes 清空');
  check(st.result.result.stats.commandBlocks === 0, '无参考声道：0 命令方块');
  // 8) 持久化：单线式 + sfxPitchStep 往返（#0 当前 sound=false：切绑定不再强制发声，sound 保持）
  onRefToggle(0, true); // #0 → 重新并入（当前参考车道为MIDI式、sound 默认 false）
  onRefLaneTypeChange(0, 'bound'); // 其所在参考车道切绑定（2026-09-07：sound 保持 false）
  st.settings.sfxPitchStep = 3;
  context.saveStateNow();
  const raw = context.localStorage.getItem(context.stateKey(st.song));
  const parsed = raw && JSON.parse(raw);
  check(!!parsed && JSON.stringify(parsed.refLayers) === '[[0,{"type":"bound","sound":false}]]',
    '持久化载荷 refLayers=[[0,{type:"bound",sound:false}]]（切绑定不强制发声，sound 保持）');
  check(!!parsed && Array.isArray(parsed.refLanes)
    && parsed.refLanes.some(l => l.tracks.includes(0) && l.type === 'bound'),
    '持久化载荷 refLanes 含单线式车道（lane.type 字段往返）');
  check(!!parsed && parsed.settings.sfxPitchStep === 3, '持久化载荷 settings.sfxPitchStep=3');
  // 8b) 车道级特效勾选（粒子特效独立模块）：取消绑定车道的「触发型」→ 绑定行不生成；恢复/持久化往返
  {
    const boundLi = st.refLanes.findIndex(l => l.tracks.includes(0));
    check(boundLi >= 0 && (st.refLanes[boundLi].type || 'independent') === 'bound', '特效勾选表：绑定车道含 #0（车道级）');
    const findTgl = (li, key) => {
      const cbs = [];
      const rec = (n) => { if (n.className === 'sfx-effect-check') cbs.push(n); (n.children || []).forEach(rec); };
      rec(elements.get('sfxEffectLanes'));
      return cbs.find(c => String(c.dataset.li) === String(li) && c.dataset.k === key);
    };
    check(!!findTgl(boundLi, 'trigger') && findTgl(boundLi, 'trigger').checked === true
      && !!findTgl(boundLi, 'vanish') && findTgl(boundLi, 'vanish').checked === false,
      '特效勾选表：绑定车道四格渲染（触发/连接/背景默认勾选，消失型默认不勾选）');
    const cb = findTgl(boundLi, 'trigger');
    cb.checked = false; cb.dispatch('change', { target: cb }); // 桩 dispatch 直传 evt，需带 target（真实 DOM change 事件语义）
    check(JSON.stringify(st.refLanes[boundLi].effects) === '["connect","background"]',
      '取消触发型：lane.effects 重建为剩余项（connect/background，缺省全选语义反转）');
    await context.generate();
    const offRes = st.result.result;
    // 触发型取消 → 绑定粒子行=0；2026-09-07c 起单线式连线独立于触发型：缺省全选下 connect 仍在 →
    //   沿线连接行照产（自持 tA 的 function/CB，后续空 tick 回退）
    check(offRes.stats.sfxBoundNotes === 0 && offRes.stats.sfxConnectLines > 0
      && offRes.sfxTickList.length > 0
      && offRes.sfxTickList.every(e => e.lines.every(l => l.startsWith('particleex tickpolarparameter '))),
      `触发型取消后绑定行=0（实际 ${offRes.stats.sfxBoundNotes}）——绑定粒子行不生成、单线式连接线独立照产`);
    const cb2 = findTgl(boundLi, 'trigger');
    cb2.checked = true; cb2.dispatch('change', { target: cb2 });
    check(st.refLanes[boundLi].effects.includes('trigger'), '重新勾选触发型：effects 含 trigger');
    await context.generate();
    check(st.result.result.stats.sfxBoundNotes > 0, '恢复勾选后绑定行回归');
    context.saveStateNow();
    const rawE = context.localStorage.getItem(context.stateKey(st.song));
    const parsedE = rawE && JSON.parse(rawE);
    const laneE = parsedE && parsedE.refLanes && parsedE.refLanes.find(l => l.tracks.includes(0));
    check(!!laneE && Array.isArray(laneE.effects) && laneE.effects.includes('trigger'),
      '持久化载荷 refLanes[].effects 往返（含 trigger）');
  }
  // 8c) 车道展开面板：▼ 展开 → 三类模板表单（触发型结构化 5 字段 + 连接/背景文本框）→
  //     改触发型头/尾参 → 绑定行按本车道模板生成、独立行不受影响；恢复默认后逐位还原；sfxParams 持久化往返
  {
    const { sfxParticleCmdFromParts, SFX_PARTICLE_FIELDS } = context.window.__NBS2SCHEMATIC;
    const boundLi = st.refLanes.findIndex(l => l.tracks.includes(0));
    check(boundLi >= 0, '展开面板前置：绑定车道含 #0');
    // 展开：点 ▼ → 面板行出现（x 按钮按行序取 boundLi 对应的；rec 逐个赋值会取到最后一个车道的）
    const xbtns = [];
    {
      const recX = (n) => { if (n.className === 'sfx-lane-x') xbtns.push(n); (n.children || []).forEach(recX); };
      recX(elements.get('sfxEffectLanes'));
    }
    const xbtn = xbtns[boundLi];
    check(!!xbtn && xbtn.textContent === '▼', '勾选表行首渲染展开钮（默认收起 ▼）');
    xbtn.dispatch('click', {}); // 桩 click() 为 noop，直派 click 事件（处理器闭包读 li、不读 evt）
    const panelBox = elements.get('sfxEffectLanes');
    const panelHtml = () => panelBox.innerHTML;
    check(panelHtml().includes('① 触发型 · 粒子命令模板（结构化关键参数）')
      && panelHtml().includes('② 连接型 · 线段参数（A→B，抵达时刻 = B 触发）')
      && panelHtml().includes('③ 背景型 · 粒子命令模板（按小节周期性执行）'),
      '展开面板：三类模板区块齐全（触发型结构化 / 连接型结构化 4 字段 / 背景型小节周期模板）');
    // 表单回填 = 默认命令 5 字段
    const findIn = (cls) => {
      const out = [];
      const rec = (n) => { if (n.className === cls) out.push(n); (n.children || []).forEach(rec); };
      rec(panelBox);
      return out;
    };
    const inputs = [];
    // 只收集面板内输入（同表主行的 3 个 checkbox 也是 input，须排除——按 .sfx-lane-params 子树收集）
    (function collect(n) {
      if (n.className === 'sfx-lane-params') {
        (function inner(m) { if (m.tagName === 'input') inputs.push(m); (m.children || []).forEach(inner); })(n);
        return;
      }
      (n.children || []).forEach(collect);
    })(panelBox);
    check(inputs.length >= 8, `面板输入框 ≥8（命令头/坐标×3/尾参/组名/连接×5/背景，实际 ${inputs.length}）`);
    check(inputs[0].value === SFX_PARTICLE_FIELDS.head && inputs[4].value === SFX_PARTICLE_FIELDS.tail,
      '触发型表单回填默认命令（命令头/尾参，输入序 head/x/y/z/tail）');
    // 连接型结构化 5 字段表单：回填默认（在触发型全清操作之前断言——同面板，全清会一并清空本表单）
    const connIns = findIn('sfx-connect-field');
    check(connIns.length === 5, `连接型表单 5 字段（粒子/颜色/m/α/组，实际 ${connIns.length}）`);
    check(JSON.stringify([connIns[0].value, connIns[1].value, connIns[2].value, connIns[3].value, connIns[4].value])
      === JSON.stringify(['minecraft:end_rod', '1 0.95 0.89 1', '10', '0', '']),
      '连接型表单回填默认（粒子/颜色/m=10/α=0/组留空）');
    // 改触发型命令头 + 尾参 → 生成：绑定行按本车道模板（坐标段仍虚拟槽位 ~0 ~2 ~6），独立行保持默认命令
    const headIn = inputs[0], tailIn = inputs[4];
    headIn.value = 'particleex custom minecraft:totem_of_undying';
    headIn.dispatch('change', { target: headIn });
    tailIn.value = '1 0.95 0.89 1 0 0 0 -10 10 0.1 20 1.0 null';
    tailIn.dispatch('change', { target: tailIn });
    check(!!st.refLanes[boundLi].sfxParams && st.refLanes[boundLi].sfxParams.head === 'particleex custom minecraft:totem_of_undying',
      '触发型表单编辑：lane.sfxParams.head 更新（change 即生效）');
    await context.generate();
    const resC = st.result.result;
    // 期望偏移按本车道实际起点动态算（R 块 8) 把含 #0 的车道切绑定，其起点 (12,1) → dy=+1 层差+1、dz=12）
    const laneC0 = st.refLanes[boundLi];
    const offC = { dx: 0, dy: laneC0.start.dy + 1, dz: laneC0.start.dz };
    const lineC = sfxParticleCmdFromParts(offC.dx, offC.dy, offC.dz, laneC0.sfxParams);
    check(resC.sfxTickList.some(e => e.lines.includes(lineC)),
      `模板生效：绑定行 = 本车道自定义模板 + 虚拟槽位 (0,${offC.dy},${offC.dz})`);
    const stepC = st.settings.sfxPitchStep; // R 块 8) 已置 3
    check(resC.sfxTickList.every(e => e.lines.filter(l => !l.includes('totem_of_undying')
        && !l.startsWith('particleex tickpolarparameter '))
      .every(l => /^particleex polarparameter minecraft:end_rod ~0 ~0 ~(-?\d+) /.test(l)
        && (Math.abs(Number(l.match(/^particleex polarparameter minecraft:end_rod ~0 ~0 ~(-?\d+) /)[1]) % 1) === 0
          && Number(l.match(/^particleex polarparameter minecraft:end_rod ~0 ~0 ~(-?\d+) /)[1]) % stepC === 0))),
      '独立行不受车道模板影响（仍默认命令、音高偏移按 sfxPitchStep）');
    // 恢复默认（全清 = 删键）→ 产物逐位还原
    const inputs2 = [];
    (function collect2(n) {
      if (n.className === 'sfx-lane-params') {
        (function inner2(m) { if (m.tagName === 'input' && m.className !== 'sfx-param-plain') inputs2.push(m); (m.children || []).forEach(inner2); })(n);
        return;
      }
      (n.children || []).forEach(collect2);
    })(panelBox);
    inputs2.forEach(i => { i.value = ''; i.dispatch('change', { target: i }); });
    check(st.refLanes[boundLi].sfxParams === undefined, '触发型表单全空 → sfxParams 删键（缺省 = 默认命令）');
    await context.generate();
    const resD = st.result.result;
    const defD = sfxParticleCmd(offC.dx, offC.dy, offC.dz);
    // 单线式连线行（tickpolarparameter）独立于触发模板 → 允许在列；触发型须回默认命令
    check(resD.sfxTickList.every(e => e.lines.every(l => l === defD
      || /^particleex polarparameter minecraft:end_rod ~0 ~0 ~(-?\d+) /.test(l)
      || l.startsWith('particleex tickpolarparameter '))),
      '恢复默认后产物逐位还原（绑定行回默认命令，连接线独立在列）');
    // 连接型表单编辑（表单计数/回填断言已在触发型编辑前完成）→ 非法值回默认 → 持久化往返
    check(JSON.stringify([connIns[0].value, connIns[1].value, connIns[2].value, connIns[3].value])
      === JSON.stringify(['', '', '', '']),
      '连接型表单随触发型全清同步清空（同面板，桩 input 值被一并重置）');
    connIns[0].value = 'minecraft:dragon_breath'; connIns[0].dispatch('change', { target: connIns[0] });
    connIns[1].value = '0.5 0.5 0.5 1'; connIns[1].dispatch('change', { target: connIns[1] });
    connIns[2].value = '20'; connIns[2].dispatch('change', { target: connIns[2] });
    connIns[3].value = '0.1'; connIns[3].dispatch('change', { target: connIns[3] });
    check(JSON.stringify(st.refLanes[boundLi].sfxParams && st.refLanes[boundLi].sfxParams.connect)
      === JSON.stringify({ particle: 'minecraft:dragon_breath', color: '0.5 0.5 0.5 1', m: 20, alpha: 0.1 }),
      '连接型表单编辑：lane.sfxParams.connect 更新（4 字段结构化对象）');
    // 非法颜色（5 个值）→ 该次回退默认 → connect 键删除（全部=默认）
    connIns[1].value = '0.5 0.5 0.5 1 9'; connIns[1].dispatch('change', { target: connIns[1] });
    check(!(st.refLanes[boundLi].sfxParams && 'connect' in (st.refLanes[boundLi].sfxParams || {})),
      '连接型非法字段（颜色 5 值）→ 回默认、connect 键删除');
    // 重设 connect + 背景模板文本 → 生成（bound 车道 tick0 有参考音符 → 小节 tick 0 产背景行）→ 持久化往返
    connIns[0].value = 'minecraft:dragon_breath'; connIns[0].dispatch('change', { target: connIns[0] });
    connIns[2].value = '20'; connIns[2].dispatch('change', { target: connIns[2] });
    const plainIn = findIn('sfx-param-plain');
    check(plainIn.length === 1, '背景型 1 个模板文本框（连接型已升级为结构化表单）');
    plainIn[0].value = 'particleex bg minecraft:portal ~ ~0.5 ~ 0.5 0.1 0.1 0 0 0 0 10 0.4 1.0 null';
    plainIn[0].dispatch('change', { target: plainIn[0] });
    await context.generate();
    check(Buffer.from(st.sfxZipBytes).toString('latin1').includes('bg minecraft:portal')
      && st.result.result.stats.sfxBackgroundNotes > 0,
      `背景模板进入数据包产物（2026-09-10 实现：按小节周期执行，bg=${st.result.result.stats.sfxBackgroundNotes}）`);
    // 清空背景模板 → 0 背景行（门控：勾选 ∧ 模板非空）
    plainIn[0].value = ''; plainIn[0].dispatch('change', { target: plainIn[0] });
    await context.generate();
    check(st.result.result.stats.sfxBackgroundNotes === 0, '清空背景模板 → 0 背景行');
    plainIn[0].value = 'particleex bg minecraft:portal ~ ~0.5 ~ 0.5 0.1 0.1 0 0 0 0 10 0.4 1.0 null';
    plainIn[0].dispatch('change', { target: plainIn[0] });
    context.saveStateNow();
    const rawF = context.localStorage.getItem(context.stateKey(st.song));
    const parsedF = rawF && JSON.parse(rawF);
    const laneF = parsedF && parsedF.refLanes && parsedF.refLanes[boundLi];
    check(!!laneF && laneF.sfxParams && laneF.sfxParams.connect
      && laneF.sfxParams.connect.particle === 'minecraft:dragon_breath' && laneF.sfxParams.connect.m === 20,
      'sfxParams.connect 持久化载荷为结构化对象（particle/m 往返）');
    check(!!laneF && laneF.sfxParams && laneF.sfxParams.background.includes('portal'),
      'sfxParams.background 占位文本持久化往返');
    check(!laneF.sfxParams || !('head' in laneF.sfxParams), '触发型恢复默认后载荷不含 head（缺省不写该键）');
    // 收起：▲ → 面板行消失（同样按行序取 boundLi 行首按钮）
    const xbtns2 = [];
    {
      const recX2 = (n) => { if (n.className === 'sfx-lane-x') xbtns2.push(n); (n.children || []).forEach(recX2); };
      recX2(elements.get('sfxEffectLanes'));
    }
    xbtns2[boundLi].dispatch('click', {});
    check(!elements.get('sfxEffectLanes').innerHTML.includes('① 触发型 · 粒子命令模板'), '收起（▲）：面板行移除');
  }
  // 8e) 消失型（07e）：默认不勾选不产 → 勾选后 t−N 生成行（寿命 = 实际提前量）→ ④ 表单 3 字段往返 → 取消回 0
  {
    const { SFX_VANISH_DEFAULTS, sfxVanishCmd } = context.window.__NBS2SCHEMATIC;
    const boundLi = st.refLanes.findIndex(l => l.tracks.includes(0));
    const findTgl = (li, key) => {
      const cbs = [];
      const rec = (n) => { if (n.className === 'sfx-effect-check') cbs.push(n); (n.children || []).forEach(rec); };
      rec(elements.get('sfxEffectLanes'));
      return cbs.find(c => String(c.dataset.li) === String(li) && c.dataset.k === key);
    };
    const findIn = (cls) => {
      const out = [];
      const rec = (n) => { if (n.className === cls) out.push(n); (n.children || []).forEach(rec); };
      rec(elements.get('sfxEffectLanes'));
      return out;
    };
    await context.generate();
    check(st.result.result.stats.sfxVanishNotes === 0, '消失型默认不勾选 → 不产行（旧行为逐位不变）');
    // 勾选 → 展开面板改提前量为 10（小值便于断言 t−N 落位）
    const cbV = findTgl(boundLi, 'vanish');
    cbV.checked = true; cbV.dispatch('change', { target: cbV });
    check(st.refLanes[boundLi].effects.includes('vanish'), '勾选消失型：effects 含 vanish');
    const xbtns3 = [];
    { const recX3 = (n) => { if (n.className === 'sfx-lane-x') xbtns3.push(n); (n.children || []).forEach(recX3); }; recX3(elements.get('sfxEffectLanes')); }
    xbtns3[boundLi].dispatch('click', {});
    const vanIns = findIn('sfx-vanish-field');
    check(vanIns.length === 4, `④ 消失型表单 4 字段（粒子/颜色/提前量/组，实际 ${vanIns.length}）`);
    check(JSON.stringify([vanIns[0].value, vanIns[1].value, vanIns[2].value, vanIns[3].value])
      === JSON.stringify([SFX_VANISH_DEFAULTS.particle, SFX_VANISH_DEFAULTS.color, '500', '']),
      '消失型表单回填默认（end_rod / 1 0.95 0.89 1 / 500 / 组留空）');
    vanIns[2].value = '10'; vanIns[2].dispatch('change', { target: vanIns[2] });
    check(JSON.stringify(st.refLanes[boundLi].sfxParams.vanish)
      === JSON.stringify({ particle: 'minecraft:end_rod', color: '1 0.95 0.89 1', ahead: 10 }),
      '提前量表单编辑：lane.sfxParams.vanish 更新（ahead=10）');
    await context.generate();
    const resV = st.result.result;
    check(resV.stats.sfxVanishNotes > 0, `勾选后消失型行生成（实际 ${resV.stats.sfxVanishNotes}）`);
    // 行内容：bound 车道锚点 = 虚拟主位（0, dy, dz）；寿命 = 实际提前量 min(N, t)（t=0 音符跳过）
    const laneV = st.refLanes[boundLi];
    const anchor = { dx: 0, dy: laneV.start.dy + 1, dz: laneV.start.dz };
    const vLines = [];
    for (const e of resV.sfxTickList) for (const l of e.lines) if (l.startsWith('particleex conditional ')) vLines.push(l);
    check(vLines.length > 0 && vLines.every(l => /^particleex conditional minecraft:end_rod ~0 ~\d+ ~-?\d+ 1 0\.95 0\.89 1 0 0 0 0\.5 0\.5 0\.5 '\(abs\(y\)==0\.5.*' 0\.1 \d+ 'vy=0\.05' 1\.0 null$/.test(l)),
      `消失型行 = #Cube 原型（坐标段 ~0 ~${anchor.dy} ~${anchor.dz} 锚点、寿命字段为数字、几何逐字）`);
    check(vLines.some(l => l.includes(`~${anchor.dy} ~${anchor.dz} `)),
      `消失型行锚点 = 车道虚拟主位 (0,${anchor.dy},${anchor.dz})`);
    // 寿命 = min(N, t)：所有行寿命 ≤ 10，且存在寿命恰 = 10 的（t ≥ 10 的音符）
    const lives = vLines.map(l => Number(l.match(/ 0\.1 (\d+) 'vy=0\.05'/)[1]));
    check(lives.every(n => n >= 1 && n <= 10) && lives.includes(10),
      `寿命 = 实际提前量（1..10，含满提前量 10；钳位生效）`);
    // 生成行落 t−N：生成 tick g 的消失行寿命 L 对应演奏 tick g+L（该 tick 有触发行）
    const triggerTicks = new Set(resV.sfxTickList.filter(e => e.lines.some(l => l.startsWith('particleex polarparameter ')))
      .map(e => e.tick));
    let vPairOk = true;
    for (const e of resV.sfxTickList) for (const l of e.lines) {
      if (!l.startsWith('particleex conditional ')) continue;
      const L = Number(l.match(/ 0\.1 (\d+) 'vy=0\.05'/)[1]);
      if (!triggerTicks.has(e.tick + L)) vPairOk = false;
    }
    check(vPairOk, '生成 tick = t−N（消失行寿命 L 对应演奏 tick g+L 存在触发行，寿命 = 实际提前量）');
    // 非法 ahead（-5）→ 回默认 → 取消勾选 → 0 行 + sfxParams.vanish 删键
    vanIns[2].value = '-5'; vanIns[2].dispatch('change', { target: vanIns[2] });
    check(!st.refLanes[boundLi].sfxParams || !('vanish' in st.refLanes[boundLi].sfxParams),
      'ahead 非法（-5）→ 回默认、vanish 键删除（全部=默认）');
    const cbV2 = findTgl(boundLi, 'vanish');
    cbV2.checked = false; cbV2.dispatch('change', { target: cbV2 });
    await context.generate();
    check(!st.refLanes[boundLi].effects.includes('vanish') && st.result.result.stats.sfxVanishNotes === 0,
      '取消消失型：effects 不再含 vanish、不产行（回 0）');
    // 持久化往返：重新勾选 + 设 ahead=7 → 载荷含 vanish
    const cbV3 = findTgl(boundLi, 'vanish');
    cbV3.checked = true; cbV3.dispatch('change', { target: cbV3 });
    const xbtns4 = [];
    { const recX4 = (n) => { if (n.className === 'sfx-lane-x') xbtns4.push(n); (n.children || []).forEach(recX4); }; recX4(elements.get('sfxEffectLanes')); }
    if (xbtns4[boundLi] && xbtns4[boundLi].textContent === '▼') xbtns4[boundLi].dispatch('click', {}); // 面板可能仍展开（sfxLanesOpen 持久）
    const vanIns2 = findIn('sfx-vanish-field');
    check(vanIns2.length === 4, `④ 面板重开后 4 字段在列（实际 ${vanIns2.length}）`);
    vanIns2[2].value = '7'; vanIns2[2].dispatch('change', { target: vanIns2[2] });
    context.saveStateNow();
    const rawV = context.localStorage.getItem(context.stateKey(st.song));
    const parsedV = rawV && JSON.parse(rawV);
    const laneVP = parsedV && parsedV.refLanes && parsedV.refLanes[boundLi];
    check(!!laneVP && laneVP.effects.includes('vanish')
      && laneVP.sfxParams && JSON.stringify(laneVP.sfxParams.vanish)
        === JSON.stringify({ particle: 'minecraft:end_rod', color: '1 0.95 0.89 1', ahead: 7 }),
      '消失型勾选 + 参数持久化往返（effects 含 vanish、sfxParams.vanish.ahead=7）');
    // 收尾还原：取消 vanish + 删 vanish 键，避免影响后续场景（9) 旧格式迁移等）
    const cbV4 = findTgl(boundLi, 'vanish');
    cbV4.checked = false; cbV4.dispatch('change', { target: cbV4 });
    vanIns2[2].value = '500'; vanIns2[2].dispatch('change', { target: vanIns2[2] });
    check(!st.refLanes[boundLi].effects.includes('vanish'), '消失型收尾还原（取消勾选，ahead 回默认删键）');
  }
  // 8f) 背景型（2026-09-10 实现）：按乐曲小节间隔（拍号×18.125 tick 取整）周期性执行车道模板命令 →
  //     模板已填（8c 遗留 portal）+ 勾选（缺省）→ 产行 + zip；取消勾选 → 0；重新勾选 → 回归；持久化往返；收尾清空
  {
    const boundLi = st.refLanes.findIndex(l => l.tracks.includes(0));
    const findTgl = (li, key) => {
      const cbs = [];
      const rec = (n) => { if (n.className === 'sfx-effect-check') cbs.push(n); (n.children || []).forEach(rec); };
      rec(elements.get('sfxEffectLanes'));
      return cbs.find(c => String(c.dataset.li) === String(li) && c.dataset.k === key);
    };
    const findIn = (cls) => {
      const out = [];
      const rec = (n) => { if (n.className === cls) out.push(n); (n.children || []).forEach(rec); };
      rec(elements.get('sfxEffectLanes'));
      return out;
    };
    check(st.refLanes[boundLi].sfxParams && st.refLanes[boundLi].sfxParams.background
      && st.refLanes[boundLi].sfxParams.background.includes('portal'),
      '8f 前置：背景模板文本（8c 遗留 portal 命令）');
    await context.generate();
    const resB = st.result.result;
    check(resB.stats.sfxBackgroundNotes > 0,
      `背景型按小节间隔产行（勾选 + 模板非空；实际 bg=${resB.stats.sfxBackgroundNotes}）`);
    check(resB.sfxTickList.every(e => e.lines.filter(l => l.includes('bg minecraft:portal')).length <= 1),
      '每个背景 tick 至多 1 行/车道（小节周期，与具体音符无关）');
    // 取消勾选背景型 → 0 行（门控：勾选 ∧ 模板非空）
    const cbB = findTgl(boundLi, 'background');
    cbB.checked = false; cbB.dispatch('change', { target: cbB });
    await context.generate();
    check(!st.refLanes[boundLi].effects.includes('background') && st.result.result.stats.sfxBackgroundNotes === 0,
      '取消背景型勾选 → 0 背景行');
    // 重新勾选 → 行回归
    const cbB2 = findTgl(boundLi, 'background');
    cbB2.checked = true; cbB2.dispatch('change', { target: cbB2 });
    await context.generate();
    check(st.result.result.stats.sfxBackgroundNotes > 0, '重新勾选背景型 → 行回归');
    // 持久化往返：sfxParams.background 字符串 + effects 含 background
    context.saveStateNow();
    const rawB = context.localStorage.getItem(context.stateKey(st.song));
    const parsedB = rawB && JSON.parse(rawB);
    const laneBP = parsedB && parsedB.refLanes && parsedB.refLanes[boundLi];
    check(!!laneBP && laneBP.sfxParams && typeof laneBP.sfxParams.background === 'string'
      && laneBP.sfxParams.background.includes('portal')
      && Array.isArray(laneBP.effects) && laneBP.effects.includes('background'),
      '背景模板 + 勾选持久化往返（sfxParams.background 字符串、effects 含 background）');
    // 收尾还原：清空背景模板 → 0 行（避免污染后续场景）
    const xbtns5 = [];
    { const recX5 = (n) => { if (n.className === 'sfx-lane-x') xbtns5.push(n); (n.children || []).forEach(recX5); }; recX5(elements.get('sfxEffectLanes')); }
    if (xbtns5[boundLi] && xbtns5[boundLi].textContent === '▼') xbtns5[boundLi].dispatch('click', {}); // 面板可能仍展开
    const bgIns = findIn('sfx-param-plain');
    bgIns[0].value = ''; bgIns[0].dispatch('change', { target: bgIns[0] });
    await context.generate();
    check(st.result.result.stats.sfxBackgroundNotes === 0, '收尾还原：清空背景模板 → 0 背景行');
  }
  // 8g) 粒子组名（2026-09-10）：① 触发型组名输入（8c 已覆盖）→ ② 连接型组字段 + ④ 消失型组字段 →
  //     连接线/消失行组位写入 + 持久化往返；收尾还原（组清空、取消消失型）
  {
    const boundLi = st.refLanes.findIndex(l => l.tracks.includes(0));
    const findTgl = (li, key) => {
      const cbs = [];
      const rec = (n) => { if (n.className === 'sfx-effect-check') cbs.push(n); (n.children || []).forEach(rec); };
      rec(elements.get('sfxEffectLanes'));
      return cbs.find(c => String(c.dataset.li) === String(li) && c.dataset.k === key);
    };
    const findIn = (cls) => {
      const out = [];
      const rec = (n) => { if (n.className === cls) out.push(n); (n.children || []).forEach(rec); };
      rec(elements.get('sfxEffectLanes'));
      return out;
    };
    // 勾选消失型 + 展开面板
    const cbG = findTgl(boundLi, 'vanish');
    cbG.checked = true; cbG.dispatch('change', { target: cbG });
    const xbtns6 = [];
    { const recX6 = (n) => { if (n.className === 'sfx-lane-x') xbtns6.push(n); (n.children || []).forEach(recX6); }; recX6(elements.get('sfxEffectLanes')); }
    if (xbtns6[boundLi] && xbtns6[boundLi].textContent === '▼') xbtns6[boundLi].dispatch('click', {});
    const vanIns3 = findIn('sfx-vanish-field');
    const connIns2 = findIn('sfx-connect-field');
    check(vanIns3.length === 4 && connIns2.length === 5,
      `8g 前置：④ 表单 4 字段 / ② 表单 5 字段（实际 van=${vanIns3.length} conn=${connIns2.length}）`);
    // ① 触发型组名（第 6 输入）：填写 → 绑定行组位替换；清空 → 组位回 null
    const panelBoxG = elements.get('sfxEffectLanes');
    const allInsG = [];
    (function collectG(n) {
      if (n.className === 'sfx-lane-params') {
        (function innerG(m) { if (m.tagName === 'input') allInsG.push(m); (m.children || []).forEach(innerG); })(n);
        return;
      }
      (n.children || []).forEach(collectG);
    })(panelBoxG);
    const gIn2 = allInsG[5];
    check(!!gIn2 && gIn2.value === '', '① 触发型组名输入框在列（第 6 输入，默认留空）');
    // 组名生效前提 = 5 字段模板有效（normSfxParams 全非空）→ 先回填默认 5 字段，再填组名
    {
      const PFv = context.window.__NBS2SCHEMATIC.SFX_PARTICLE_FIELDS;
      [allInsG[0], allInsG[1], allInsG[2], allInsG[3], allInsG[4]].forEach((inp, i) => {
        inp.value = [PFv.head, PFv.x, PFv.y, PFv.z, PFv.tail][i];
        inp.dispatch('change', { target: inp });
      });
    }
    gIn2.value = 'g1'; gIn2.dispatch('change', { target: gIn2 });
    check(st.refLanes[boundLi].sfxParams && st.refLanes[boundLi].sfxParams.group === 'g1',
      '① 组名表单编辑：lane.sfxParams.group 更新');
    // 填组名：消失 vg9 / 连接 cg9
    vanIns3[3].value = 'vg9'; vanIns3[3].dispatch('change', { target: vanIns3[3] });
    connIns2[4].value = 'cg9'; connIns2[4].dispatch('change', { target: connIns2[4] });
    check(JSON.stringify(st.refLanes[boundLi].sfxParams.vanish)
        === JSON.stringify({ particle: 'minecraft:end_rod', color: '1 0.95 0.89 1', ahead: 500, group: 'vg9' })
      && st.refLanes[boundLi].sfxParams.connect && st.refLanes[boundLi].sfxParams.connect.group === 'cg9',
      '组名表单编辑：sfxParams.vanish.group / sfxParams.connect.group 更新');
    await context.generate();
    const resG2 = st.result.result;
    const vG = resG2.sfxTickList.flatMap(e => e.lines).filter(l => l.startsWith('particleex conditional '));
    const cG = resG2.sfxTickList.flatMap(e => e.lines).filter(l => l.startsWith('particleex tickpolarparameter '));
    check(vG.length > 0 && vG.every(l => /\s+vg9$/.test(l)),
      `消失行组位 = vg9（实际 ${vG.length} 行）`);
    check(cG.length > 0 && cG.every(l => /\s+cg9$/.test(l)),
      `连接线组位 = cg9（实际 ${cG.length} 行）`);
    // ① 绑定行组位 = g1（lane.sfxParams 含完整 5 字段默认模板 + group → 组位替换）
    const boundG = resG2.sfxTickList.flatMap(e => e.lines)
      .filter(l => l.startsWith('particleex polarparameter '));
    const boundGg = boundG.filter(l => /\s+g1$/.test(l));
    check(boundG.length > 0 && boundGg.length === boundG.length,
      `① 绑定行组位 = g1（全部 ${boundG.length} 条触发行末 token g1）`);
    // 持久化往返：vanish.group / connect.group
    context.saveStateNow();
    const rawG = context.localStorage.getItem(context.stateKey(st.song));
    const parsedG = rawG && JSON.parse(rawG);
    const laneGP = parsedG && parsedG.refLanes && parsedG.refLanes[boundLi];
    check(!!laneGP && laneGP.sfxParams
      && laneGP.sfxParams.vanish && laneGP.sfxParams.vanish.group === 'vg9'
      && laneGP.sfxParams.connect && laneGP.sfxParams.connect.group === 'cg9',
      '组名持久化往返（sfxParams.vanish.group / sfxParams.connect.group）');
    // 收尾还原：组清空（触发/连接/消失）+ 取消消失型 → 组位回 null、消失行消失
    gIn2.value = ''; gIn2.dispatch('change', { target: gIn2 });
    vanIns3[3].value = ''; vanIns3[3].dispatch('change', { target: vanIns3[3] });
    connIns2[4].value = ''; connIns2[4].dispatch('change', { target: connIns2[4] });
    const cbG2 = findTgl(boundLi, 'vanish');
    cbG2.checked = false; cbG2.dispatch('change', { target: cbG2 });
    await context.generate();
    const resG3 = st.result.result;
    const vG3 = resG3.sfxTickList.flatMap(e => e.lines).filter(l => l.startsWith('particleex conditional '));
    const cG3 = resG3.sfxTickList.flatMap(e => e.lines).filter(l => l.startsWith('particleex tickpolarparameter '));
    check(vG3.length === 0 && cG3.length > 0 && cG3.every(l => /\s+null$/.test(l)),
      '收尾还原：消失行消失（取消勾选）、连接线组位回 null');
    const boundG3 = resG3.sfxTickList.flatMap(e => e.lines)
      .filter(l => l.startsWith('particleex polarparameter '));
    check(boundG3.length > 0 && boundG3.every(l => !/\s+g1$/.test(l)),
      '收尾还原：① 触发组名清空 → 绑定行组位回 null');
  }
  // 8h) 触发型预设模板库（2026-09-10）：另存当前 5 字段+组名为命名预设（localStorage 跨歌）→
  //     点选回填本表单 → 删除选中。复用 8g 展开的面板与 boundLi；收尾清空库，不污染 9) 段。
  //     ⚠ 每次 save/select/delete 处理器都 renderSfxEffectLanes() 整表重建 → 旧元素引用失效，
  //     每次操作后须重新按 className 收集（同 8g 面板重开 sfxLanesOpen 坑）
  {
    const AP = context.window.__NBS2SCHEMATIC;
    const boundLi = st.refLanes.findIndex(l => l.tracks.includes(0));
    const recH = (cls) => {
      const out = [];
      (function rec(n) { if (n.className === cls) out.push(n); (n.children || []).forEach(rec); })(elements.get('sfxEffectLanes'));
      return out;
    };
    const selH = recH('sfx-preset-sel'), nameH = recH('sfx-preset-name'),
      saveH = recH('sfx-preset-save'), delH = recH('sfx-preset-del');
    check(selH.length >= 1 && nameH.length >= 1 && saveH.length >= 1 && delH.length >= 1,
      `8h 前置：预设库控件在列（sel=${selH.length} name=${nameH.length} save=${saveH.length} del=${delH.length}）`);
    const lane = st.refLanes[boundLi];
    // 前置：当前表单 = 默认 5 字段模板（8g 收尾后 sfxParams 为有效 5 字段、无 group）
    const baseP = AP.SFX_PARTICLE_FIELDS;
    lane.sfxParams = { ...baseP };
    // 另存当前为预设 p1 → 库含 p1、params = 当前 5 字段
    nameH[0].value = 'p1';
    saveH[0].dispatch('click', {});
    const libH = AP.sfxPresetLoad();
    check(libH.length === 1 && libH[0].name === 'p1'
      && JSON.stringify(libH[0].params) === JSON.stringify(baseP),
      '另存当前为预设：库含 p1、params = 当前 5 字段（无 group）');
    // 重渲染后 select 选项应含 p1（renderSfxEffectLanes 已刷新面板）→ 重新收集
    const selH2 = recH('sfx-preset-sel');
    const optNames = selH2[0].children.map(o => o.value);
    check(optNames.includes('p1'), `select 选项含 p1（实际 ${JSON.stringify(optNames)}）`);
    // 改表单为明显不同值 + group pg1 → 选 p1 回填 → 表单回到 p1 的 5 字段、group 清除
    lane.sfxParams = { head: 'particleex polarparameter minecraft:heart', x: '~', y: '~', z: '~', tail: '0.5 0.5 0.5 1 1 1 1 1.0 pg1', group: 'pg1' };
    const selH2b = recH('sfx-preset-sel');
    selH2b[0].value = 'p1';
    selH2b[0].dispatch('change', { target: selH2b[0] });
    check(JSON.stringify(st.refLanes[boundLi].sfxParams) === JSON.stringify(baseP),
      '点选预设 p1 回填：lane.sfxParams 恢复为 p1 的 5 字段（group 清除）');
    // 删除选中 p1 → 库空、select 选项刷新（不含 p1）
    const selH3 = recH('sfx-preset-sel'), delH3 = recH('sfx-preset-del');
    selH3[0].value = 'p1';
    delH3[0].dispatch('click', {});
    check(AP.sfxPresetLoad().length === 0, '删除选中：库清空');
    const selH4 = recH('sfx-preset-sel');
    check(!selH4[0].children.map(o => o.value).includes('p1'), '删除后 select 选项刷新（不含 p1）');
  }
  // 9) 旧格式迁移：手工写入旧 bool 载荷 → 重载按MIDI式迁移
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
  check(!stR.lanes.some(l => l.tracks.includes(1)), '迁移后的参考不自动进音轨车道池（2026-09-06 语义：显式操作才入位）');
  check(stR.settings.sfxPitchStep === 3, 'sfxPitchStep 持久化往返（3 恢复）');
  context.renderSettings();
  check(elements.get('sfxPitchStep').value === '3', '设置区 sfxPitchStep 输入框回填 3');
  // 8d) sfxPitchStep 小数步长（2026-09-07 用户放开，步进 0.1）：0.5 接受 + 非法值回退默认 1
  //     注意：9) 段已重载 demo3（st 已失效），此处须用 stR
  {
    const stepIn = elements.get('sfxPitchStep');
    stepIn.value = '0.5';
    stepIn.dispatch('change', { target: stepIn });
    check(stR.settings.sfxPitchStep === 0.5 && stepIn.value === '0.5',
      'sfxPitchStep 小数：0.5 被接受（状态 + 输入框回填）');
    stepIn.value = 'abc';
    stepIn.dispatch('change', { target: stepIn });
    check(stR.settings.sfxPitchStep === 1, 'sfxPitchStep：非法值回退默认 1');
    stepIn.value = '3';
    stepIn.dispatch('change', { target: stepIn });
    check(stR.settings.sfxPitchStep === 3, 'sfxPitchStep 恢复 3（不影响后续 R2 块断言）');
  }
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
  // 1) 勾选参考 → 勾选式并入参考车道池；不再自动进音轨车道池（用户 2026-09-06 反馈的多余副本）
  onRefToggle(i0, true);
  check(st.refLanes.length === 1 && st.refLanes[0].tracks.includes(i0),
    '勾选参考：自动并入（新建）第一条参考车道');
  check(JSON.stringify(st.lanes.map(l => l.tracks)) === '[]',
    '勾选参考：音轨车道池不变（不复制一份——用户反馈的多余副本已消除）');
  check(refLanePoolMembers(song).includes(i0), 'refLanePoolMembers 含参考成员');
  onRefToggle(i1, true);
  check(st.refLanes.some(l => l.tracks.includes(i1)), '第二条参考并入参考车道池（无冲突同车道或新建）');
  // 2) 卡片渲染：名称/复制/删除/成员标签/计数（DOM 桩无 className 属性 → 按 children 树收集 className 检查）
  const classesOf = (el) => { const out = []; const rec = (n) => { if (n.className) out.push(n.className); (n.children || []).forEach(rec); }; rec(el); return out.join(' '); };
  const cardHtml = classesOf(elements.get('refLaneList'));
  check(cardHtml.includes('ref-lane-del') && cardHtml.includes('ref-lane-dup'), '参考车道卡片渲染删除/复制按钮');
  check(cardHtml.includes('ref-lane-tag'), '参考车道成员标签渲染');
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
  // 3b) 拖拽：dropToRefLane = 登记参考 + 移入目标车道 + 单线式跟随（允许重复拖入齐响）；
  //      不再自动进音轨车道池（2026-09-06 语义：显式拖入车道卡片才让参考在普通轨道发声）
  const { dropToRefLane } = context.window.__NBS2SCHEMATIC;
  st.refLayers = new Map(); st.refLanes = [];
  st.refLanes.push({ tracks: [], type: 'independent', start: { dz: 30, dy: 2 } });
  const i2 = noteLayers[2] !== undefined ? noteLayers[2] : i1;
  dropToRefLane(i2, 0);
  check(JSON.stringify(st.refLayers.get(i2)) === '{"type":"independent","sound":true}'
    && JSON.stringify(st.refLanes[0].tracks) === JSON.stringify([i2]),
    '拖入：未勾选参考的音轨拖入 → 登记为参考（独立+发声）并入目标车道');
  check(!st.lanes.some(l => l.tracks.includes(i2)), '拖入：不自动进音轨车道池（需显式拖入车道卡片才在普通轨道发声）');
  check(refLanePoolMembers(song).includes(i2), '拖入：refLanePoolMembers 含该音轨');
  st.refLanes.push({ tracks: [i0], type: 'independent', start: { dz: 40, dy: 2 } });
  dropToRefLane(i2, 1);
  check(!st.refLanes[0].tracks.includes(i2) && JSON.stringify(st.refLanes[1].tracks) === JSON.stringify([i0, i2]),
    '拖入：音轨从其他参考车道移入目标车道（跨车道移动，与已有成员 i0 共存）');
  st.refLanes[1].type = 'bound';
  dropToRefLane(i2, 1);   // 重复拖入同一车道
  check(JSON.stringify(st.refLanes[1].tracks) === JSON.stringify([i0, i2, i2]),
    '拖入：重复拖入同一车道 = 同 tick 多成员齐响（触发粒子只取主位）');
  check(JSON.stringify(st.refLayers.get(i2)) === '{"type":"bound","sound":true}',
    '拖入：并入单线式车道 → 成员 refLayers 类型跟随车道（bound，sound 保持原值）');
  // 2026-09-07 虚拟化：单线式不再强制发声——先取消 sound 再重拖 → 类型跟随、sound 保持 false
  st.refLayers.set(i2, { type: 'bound', sound: false });
  dropToRefLane(i2, 1);
  check(JSON.stringify(st.refLayers.get(i2)) === '{"type":"bound","sound":false}',
    '拖入单线式车道：不强制发声（sound 保持 false，粒子仍恒产生）');
  // 未发声参考成员拖入提醒（用户 2026-09-07 要求）：标签「（静音）」+ 琥珀样式 + 分区提示
  {
    const mutedHtml = elements.get('refLaneList').innerHTML;
    check(mutedHtml.includes('（静音）'), '静音参考成员：卡片标签标「（静音）」');
    check(classesOf(elements.get('refLaneList')).includes('ref-lane-tag-muted'),
      '静音参考成员：标签琥珀样式（.ref-lane-tag-muted）');
    check(mutedHtml.includes('未勾选「发声」'), '参考车道池分区提示：以下参考成员未勾选「发声」');
  }
  let nLaneI2 = 0; st.lanes.forEach((l) => { nLaneI2 += l.tracks.filter(x => x === i2).length; });
  check(nLaneI2 === 0, '拖入：音轨车道池零份（新语义：拖入参考车道池不进车道池）');
  check(classesOf(elements.get('refLaneList')).includes('ref-lane-drop'), '参考车道卡片渲染拖放区（.ref-lane-drop）');
  // 3c) 分区顺序（2026-09-07 用户要求）：车道池 → **普通车道起点布局** → 参考车道池（含参考布局窗口）。
  //     DOM 桩不解析静态 HTML 树（section 无 parent 链），直接按源码标记位置断言交付顺序
  const secPos = id => html.indexOf(`id="${id}"`);
  check(secPos('group-section') > -1 && secPos('layout-section') > secPos('group-section')
    && secPos('refLane-section') > secPos('layout-section')
    && secPos('sfxEffect-section') > secPos('refLane-section'),
    '分区顺序：车道池 < 普通车道起点布局 < 参考车道池 < 粒子特效总览（源码标记位置）');
  const ed = context.window.__NBS2SCHEMATIC.layoutEditor; // main 窗口编辑器（3d 拖拽序列与 4) 段共用）
  // 3d) 真实 pointer 事件序列拖拽（DOM 桩 dispatch 驱动，回归「网格无法拖拽」类 bug）：
  //     pointerdown 落在标记中心 → pointermove 到目标屏幕点 → start 应精确落到目标格
  {
    // R2 状态下车道池为空（音轨只进了参考车道），先压入一条普通车道模拟用户已拖入
    st.lanes.push({ tracks: [i0], start: { dz: 10, dy: 0 } });
    const cvMain = elements.get('layoutCanvas');
    const p0 = ed.w2s(st.lanes[0].start.dz, st.lanes[0].start.dy);
    cvMain.dispatch('pointerdown', { pointerId: 1, offsetX: p0.x, offsetY: p0.y });
    check(ed.dragIndex === 1 && ed.selected === 1 && !ed.panning,
      'pointer 拖拽：pointerdown 命中车道标记（dragIndex=1，非平移模式）');
    const target = { dz: st.lanes[0].start.dz + 5, dy: st.lanes[0].start.dy + 3 };
    const p1 = ed.w2s(target.dz, target.dy);
    cvMain.dispatch('pointermove', { pointerId: 1, offsetX: p1.x, offsetY: p1.y });
    check(st.lanes[0].start.dz === target.dz && st.lanes[0].start.dy === target.dy,
      'pointer 拖拽：pointermove 后车道 start 精确移动（实际 ' + JSON.stringify(st.lanes[0].start) + '）');
    cvMain.dispatch('pointerup', { pointerId: 1 });
    check(ed.dragIndex === -1 && ed.lastPointer === null, 'pointer 拖拽：pointerup 结束拖拽状态');
    // 越界守护（console 实测 bug：pointerdown 命中车道后该车道被删，pointermove 时
    // dragIndex 越界 → idxKind 读 starts()[i].kind 抛 TypeError，拖拽/平移分支全死）：
    // 复现序列 = 再压一条车道 → pointerdown 命中它（dragIndex=2）→ pop 删掉它 → pointermove
    const pGuard = ed.w2s(26, 0);
    st.lanes.push({ tracks: [], start: { dz: 26, dy: 0 } });
    cvMain.dispatch('pointerdown', { pointerId: 2, offsetX: pGuard.x, offsetY: pGuard.y });
    check(ed.dragIndex === 2, '越界守护前置：pointerdown 命中第二条车道（dragIndex=2）');
    st.lanes.pop(); // 删掉正在拖的车道（starts() 变短，dragIndex 越界）
    let guardOk = true, guardErr = null;
    try {
      cvMain.dispatch('pointermove', { pointerId: 2, offsetX: pGuard.x + 10, offsetY: pGuard.y + 10 });
      cvMain.dispatch('pointermove', { pointerId: 2, offsetX: pGuard.x + 12, offsetY: pGuard.y + 12 });
    } catch (err) { guardOk = false; guardErr = err; }
    check(guardOk, '越界守护：拖拽中车道被删，pointermove 不抛 TypeError（' + (guardErr ? guardErr.message : '无异常') + '）');
    cvMain.dispatch('pointerup', { pointerId: 2 });
    st.lanes.pop(); // 恢复（车道池回到 R2 的空态）
    check(st.lanes.length === 0, '拖拽序列：状态复原（车道池回空，不污染后续断言）');
  }
  // 4) 布局编辑器双窗口（2026-09-07 虚拟化）：main 管轨道 0 + 普通车道（参考车道虚拟背景不可拖）；
  //    ref 窗口管参考车道（可拖，普通车道 + 轨道 0 半透明背景不可拖）
  st.lanes.push({ tracks: [], start: { dz: 20, dy: 0 } }); // 补一条空音轨车道，验证 idxKind 的 lane 映射
  check(ed.starts().length === 1 + st.lanes.length + st.refLanes.length,
    'main 窗口标记 = 轨道 0 + 音轨车道 + 参考车道');
  // 2026-09-07 双类型：main 窗口参考车道按类型分 kind——单线式（bound）= ref-bg 可拖
  // （虚拟盒位锚点，拖它直接决定绑定粒子行偏移）；MIDI式（independent）= ref 背景不可拖
  // （其粒子中心基准在 ref 窗口拖）
  const idxIndepMain = ed.starts().findIndex(it => it.kind === 'ref');
  const idxBoundMain = ed.starts().findIndex(it => it.kind === 'ref-bg');
  const boundMainIt = ed.starts()[idxBoundMain];
  check(idxBoundMain > -1 && st.refLanes[boundMainIt.laneIdx]
    && (st.refLanes[boundMainIt.laneIdx].type || 'independent') === 'bound',
    'main 窗口：单线式参考车道标记 kind=ref-bg（laneIdx 映射到单线式车道）');
  check(ed.idxKind(idxBoundMain).kind === 'ref-bg' && ed.idxKind(idxBoundMain).j === boundMainIt.laneIdx
    && (idxIndepMain > -1 ? ed.idxKind(idxIndepMain).kind === 'ref' && ed.idxKind(idxIndepMain).j === ed.starts()[idxIndepMain].laneIdx : true),
    'idxKind：main 窗口 ref/ref-bg 标记经 laneIdx 映射到 refLanes 真实下标');
  check(ed.idxKind(1).kind === 'lane' && ed.idxKind(0).kind === 'lane0', 'idxKind 音轨车道/轨道 0 映射');
  const refStart = st.refLanes[0].start;
  refStart.dz = -7; refStart.dy = -3; // 负坐标：布局标记与校验不受影响
  const { errors: vErrs } = ed.validate();
  check(vErrs.every(m => !m.includes('undefined')), 'validate 对参考车道起点命名正常（无 undefined）');
  refStart.dz = 0; refStart.dy = 0;
  // 4a) ref 窗口：参考车道可拖、普通车道/轨道 0 背景不可拖；参考车道与音轨车道同起点 → 无碰撞错误
  const edRef = context.window.__NBS2SCHEMATIC.refLayoutEditor;
  check(!!edRef && edRef.mode === 'ref', '参考车道独立窗口已创建（mode=ref）');
  check(edRef.starts().length === st.refLanes.length + st.lanes.length + 1
    && edRef.starts()[0].kind === 'ref' && edRef.starts()[edRef.starts().length - 1].kind === 'lane0',
    'ref 窗口标记 = 参考车道（前）+ 普通车道 + 轨道 0（背景）');
  check(edRef.draggable(0) === true, 'ref 窗口：MIDI式参考车道可拖（粒子中心基准）');
  // 4a-2) MIDI式/单线式分治（2026-09-07 独立中心可拖）：MIDI式=可拖 ref 标记在前，单线式=ref-bg 背景不可拖
  const idxBoundRef = edRef.starts().findIndex(it => it.kind === 'ref-bg');
  const bgIt = edRef.starts()[idxBoundRef];
  check(idxBoundRef > 0 && st.refLanes[bgIt.laneIdx] && (st.refLanes[bgIt.laneIdx].type || 'independent') === 'bound',
    'ref 窗口：单线式参考车道标记 kind=ref-bg（laneIdx 映射到绑定车道）');
  check(edRef.draggable(idxBoundRef) === false, 'ref 窗口：单线式参考车道不可拖（虚拟盒位背景）');
  const ikRef0 = edRef.idxKind(0), ikBg = edRef.idxKind(idxBoundRef);
  check(ikRef0.kind === 'ref' && ikRef0.j === 0
    && ikBg.kind === 'ref-bg' && ikBg.j === bgIt.laneIdx,
    'idxKind：ref 窗口 ref/ref-bg 标记经 laneIdx 映射到 refLanes 真实下标（MIDI式在前排序后 i ≠ 下标）');
  check(edRef.draggable(st.refLanes.length) === false && edRef.draggable(edRef.starts().length - 1) === false,
    'ref 窗口：普通车道与轨道 0 为不可拖背景');
  check(ed.draggable(0) === false && ed.draggable(1) === true
    && ed.draggable(idxBoundMain) === true
    && (idxIndepMain > -1 ? ed.draggable(idxIndepMain) === false : true),
    'main 窗口：轨道 0 不可拖、音轨车道可拖、单线式参考车道可拖（虚拟盒位锚点）、MIDI式为不可拖背景（中心基准在 ref 窗口拖）');
  const refStart2 = st.refLanes[0].start;
  const laneStartX = st.lanes[0].start;
  refStart2.dz = laneStartX.dz; refStart2.dy = laneStartX.dy; // MIDI式中心与音轨车道物理同位
  check(ed.validate().errors.length === 0, 'main 窗口：参考车道与普通车道同起点不报碰撞错误（虚拟化后不参与碰撞）');
  check(edRef.validate().errors.length === 0, 'ref 窗口：MIDI式中心与音轨车道同位/MIDI式互相重叠均不报错（虚拟几何，重叠=粒子叠放）');
  refStart2.dz = 6; refStart2.dy = 1; // 复原
  // 4b) 预置模板：以 0 号车道为中心 + 只重排普通车道（2026-09-07 虚拟化：参考车道位置独立管理、不受预置影响）
  const st2 = context.window.__NBS2SCHEMATIC.state;
  st2.refLanes = [{ tracks: [i0], start: { dz: 6, dy: 0 } }]; // 干净已知状态：1 音轨车道 + 1 参考车道（预置不应动它）
  st2.lane0.start = { dz: 2, dy: 3 }; // 非原点中心
  elements.get('presetLineBtn').dispatch('click', {});
  check(st2.lanes[0].start.dz === 5 && st2.lanes[0].start.dy === 3
    && st2.refLanes[0].start.dz === 6 && st2.refLanes[0].start.dy === 0,
    '预置单行：音轨车道 (5,3)、参考车道保持不动 (6,0)（虚拟化：预置只重排普通车道）');
  elements.get('presetGridBtn').dispatch('click', {});
  check(st2.lanes[0].start.dz === 5 && st2.lanes[0].start.dy === 3
    && st2.refLanes[0].start.dz === 6 && st2.refLanes[0].start.dy === 0,
    '预置网格：音轨车道 (5,3)、参考车道保持不动 (6,0)');
  st2.lanes = [{ tracks: [i0] }, { tracks: [i1] }];
  elements.get('presetRadialBtn').dispatch('click', {});
  check(st2.lanes[0].start.dz === 5 && st2.lanes[0].start.dy === 3
    && st2.lanes[1].start.dz === -1 && st2.lanes[1].start.dy === 3
    && st2.refLanes[0].start.dz === 6 && st2.refLanes[0].start.dy === 0,
    '预置放射：普通车道由近及远 (3,0)→(-3,0)，参考车道保持不动 (6,0)');
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
