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
// 歌词渲染桩：measureText 每字 8px 宽、getImageData 全不透明（裁剪 = 整 canvas）、
//   toDataURL 固定 base64（解码 = PNG 魔数 6 字节；8l 只断言条目存在/CRC，不验像素）。
//   注意：裁剪后 canvas 恒 4×4 → 所有歌词行 widthPx=4、heightPx=4、pixels=16。
function makeCtx() {
  return {
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '',
    clearRect() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    arc() {},
    fillText() {}, strokeRect() {}, putImageData() {}, drawImage() {}, setLineDash() {},
    createImageData(w, h) { return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }; },
    measureText() { return { width: 8 }; },
    getImageData(x, y, w, h) {
      const d = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < d.length; i += 4) { d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; d[i + 3] = 255; }
      return { data: d, width: w, height: h };
    },
    toDataURL() { return 'data:image/png;base64,iVBORw0K'; },
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
    append(...cs) { el.children.push(...cs.filter(Boolean)); },
    removeChild(c) { el.children = el.children.filter(x => x !== c); },
    get firstChild() { return el.children[0] || null; },
    // 类选择器自匹配（事件处理器用 closest('.custom-inst-select') 等按 className 找回自身）
    closest(sel) {
      if (sel && sel.startsWith('.')) {
        const name = sel.slice(1);
        if (el.classList && el.classList.contains(name)) return el;
      }
      return null;
    },
    getContext() { return makeCtx(); },
    // 歌词渲染裁剪路径 out.toDataURL（生产代码仅 index.html renderLyricLine 调用；
    // 固定 base64 解码 = PNG 魔数 6 字节，8l 只断言条目存在/CRC，不验像素）
    toDataURL() { return 'data:image/png;base64,iVBORw0K'; },
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

let failed = 0, passed = 0;
const check = (cond, msg) => { if (!cond) { failed++; console.log('FAIL', msg); } else { passed++; console.log('PASS', msg); } };

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
    '粒子特效总览：触发型条目含当前效果（end_rod 圆环）与参数规则描述');
  check(eff.includes('依次显现') && eff.includes('无缝衔接'),
    '粒子特效总览：连接型条目含核心语义（依次显现、无缝衔接）');
  check(eff.includes('particleex conditional') && eff.includes('默认不勾选'),
    '粒子特效总览：消失型条目含 #Cube 条件立方体描述与默认不勾选注记');
  check(eff.includes('0/73/146') && eff.includes('4/4 拍 → 73'),
    '粒子特效总览：背景型条目含小节执行点（每小节 tick 0/73/146，4/4 → 73）');
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
// 生成进度条（2026-10-06）：成功收尾 → 条 100% 不隐藏 + 按钮恢复 + 状态行完成文案
check(elements.get('genProgressFill').style.width === '100%' && elements.get('genProgress').hidden === false,
  '生成进度条：完成后宽 100% 且可见');
check(elements.get('generateBtn').disabled === false, '生成进度条：按钮完成后恢复可用');
check(elements.get('genStatus').textContent.includes('自检通过'), '生成进度条：状态行含完成文案（自检通过）');

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
      u8(n.instrument); u8(n.key); u8(n.velocity ?? 100); u8(100); i16(0);
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
check(st6.lanes[1].start.dz === -3 && st6.lanes[1].start.dy === 0,
  `车道复制：起点优先取关于 y 轴对称的镜像位（(3,0) → (−3,0)，实际 ${st6.lanes[1].start.dz},${st6.lanes[1].start.dy}）`);
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
check(st7.lanes[1].start.dz === -14 && st7.lanes[1].start.dy === 3,
  `镜像位优先：卡农复制 (14,3) → (−14,3)（实际 ${st7.lanes[1].start.dz},${st7.lanes[1].start.dy}）`);
// 镜像位被占 → 回退空位扫描（不落下重叠起点；新车道插在源后一位 index 1）
st7.lanes[0].start = { dz: 8, dy: 1 };
st7.lanes.push({ tracks: [], start: { dz: -8, dy: 1 } }); // 预先占住镜像位 (−8,1)
context.duplicateLane(0);
const copyStart = st7.lanes[1].start;
check(copyStart.dz === 11 && copyStart.dy === 1
  && new Set(st7.lanes.map(l => `${l.start.dz},${l.start.dy}`)).size === st7.lanes.length,
  `镜像被占 → 回退扫描到空闲位 (11,1)（实际 ${copyStart.dz},${copyStart.dy}，无重叠）`);
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
  // 追加命令默认行（particleex conditional，2026-09-25 内置缺省）不参与 dy 断言——只校验触发/连接线
  check(indepRes.sfxTickList.every(e => e.lines.filter(l => !l.startsWith('particleex conditional '))
    .every(l => /^particleex (?:polarparameter|tickpolarparameter) minecraft:end_rod ~0 ~0 /.test(l))),
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
    const { sfxParticleCmdFromParts, SFX_PARTICLE_FIELDS, SFX_EXTRA_DEFAULT_CMD, sfxParseCmdCoord } = context.window.__NBS2SCHEMATIC;
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
    // 2026-09-25 追加命令内置默认：textarea 回填 = 内置 conditional 默认命令（未填过）
    const extraTa8c = findIn('sfx-extra-field');
    check(extraTa8c.length >= 1 && extraTa8c[0].value === SFX_EXTRA_DEFAULT_CMD,
      `追加命令表单回填：默认 = 内置 conditional 默认命令（实际 ${JSON.stringify(String(extraTa8c[0] && extraTa8c[0].value).slice(0, 30))}…）`);
    // 连接型结构化表单：line 态（缺省）lift/p 两输入 hidden → 收集后过滤，可见 5 字段；
    //   回填默认断言在触发型全清操作之前（同面板，全清会一并清空本表单）
    const connIns = findIn('sfx-connect-field').filter(el => !el.hidden);
    check(connIns.length === 5, `连接型表单 5 可见字段（line 态：粒子/颜色/m/α/组，lift/p 隐藏；实际可见 ${connIns.length}）`);
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
        && !l.startsWith('particleex tickpolarparameter ')
        && !l.startsWith('particleex conditional '))
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
    // 2026-09-25 追加命令缺省 = 内置 conditional 默认命令 → 绑定行恒伴生默认追加行（同偏移）
    const defE = sfxParticleCmdFromParts(offC.dx, offC.dy, offC.dz, sfxParseCmdCoord(SFX_EXTRA_DEFAULT_CMD));
    // 单线式连线行（tickpolarparameter）独立于触发模板 → 允许在列；触发型须回默认命令 + 默认追加行
    check(resD.sfxTickList.every(e => e.lines.every(l => l === defD || l === defE
      || /^particleex polarparameter minecraft:end_rod ~0 ~0 ~(-?\d+) /.test(l)
      || l.startsWith('particleex tickpolarparameter '))),
      '恢复默认后产物逐位还原（绑定行回默认命令 + 默认追加行，连接线独立在列）');
    // 连接型表单编辑（表单计数/回填断言已在触发型编辑前完成）→ 非法值回默认 → 持久化往返
    check(JSON.stringify([connIns[0].value, connIns[1].value, connIns[2].value, connIns[3].value])
      === JSON.stringify(['', '', '', '']),
      '连接型表单随触发型全清同步清空（同面板，桩 input 值被一并重置）');
    connIns[0].value = 'minecraft:dragon_breath'; connIns[0].dispatch('change', { target: connIns[0] });
    connIns[1].value = '0.5 0.5 0.5 1'; connIns[1].dispatch('change', { target: connIns[1] });
    connIns[2].value = '20'; connIns[2].dispatch('change', { target: connIns[2] });
    connIns[3].value = '0.1'; connIns[3].dispatch('change', { target: connIns[3] });
    check(JSON.stringify(st.refLanes[boundLi].sfxParams && st.refLanes[boundLi].sfxParams.connect)
      === JSON.stringify({ particle: 'minecraft:dragon_breath', color: '0.5 0.5 0.5 1', m: 20, alpha: 0.1,
        style: 'line', lift: 0.15, p: 1.4 }),
      '连接型表单编辑：lane.sfxParams.connect 更新（4 字段 + 风格三键 style/lift/p 恒随存）');
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
    // 2026-09-25 追加命令有内置默认（conditional 默认命令，寿命 50、同锚点）→ 显式清空（空串 = 不追加），
    //   隔离下方消失型行（#Cube、寿命 ≤10）断言——同锚点同前缀，靠坐标无法区分
    const extraTa8e = findIn('sfx-extra-field');
    check(extraTa8e.length >= 1, '8e 前置：触发面板含追加命令 textarea');
    if (extraTa8e.length >= 1) { extraTa8e[0].value = ''; extraTa8e[0].dispatch('change', { target: extraTa8e[0] }); }
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
    check(vLines.length > 0 && vLines.every(l => /^particleex conditional minecraft:end_rod ~0 ~\d+ ~-?\d+ 1 0\.95 0\.89 1 0 0 0 0\.5 0\.5 0\.5 '\(abs\(y\)==0\.5.*' 0\.1 \d+ 'vy=0\.05' 1\.0 (null|nbs2sfx_vanish_\d+)$/.test(l)),
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
    const connIns2 = findIn('sfx-connect-field').filter(el => !el.hidden);   // line 态：lift/p 隐藏
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
    check(vG.length > 0 && vG.every(l => /\s+vg9\|nbs2sfx_vanish_\d+$/.test(l)),
      `消失行组位 = vg9|保险组（实际 ${vG.length} 行）`);
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
    // 2026-10-05 内置预设：「螺旋展开」（旧默认模板 dis=1 平面螺旋）渲染注入选项（不写用户库）→
    //   点选回填旧模板 5 字段；不可删除（alert 拒绝 + 选项仍在）
    const selH5 = recH('sfx-preset-sel');
    const optNames5 = selH5[0].children.map(o => o.value);
    check(optNames5.includes('螺旋展开'), `8h 内置预设：select 选项含「螺旋展开」（实际 ${JSON.stringify(optNames5)}）`);
    check(AP.sfxPresetLoad().length === 0, '8h 内置预设：不写用户库（sfxPresetLoad 仍空）');
    selH5[0].value = '螺旋展开';
    selH5[0].dispatch('change', { target: selH5[0] });
    const spH = st.refLanes[boundLi].sfxParams;
    check(spH && /dis=1;s1=2\*t;s2=0/.test(spH.tail) && spH.head.endsWith('minecraft:end_rod'),
      '8h 内置预设：点选「螺旋展开」回填旧默认模板（dis=1 平面螺旋）');
    const selH6 = recH('sfx-preset-sel'), delH6 = recH('sfx-preset-del');
    selH6[0].value = '螺旋展开';
    delH6[0].dispatch('click', {});
    check(recH('sfx-preset-sel')[0].children.map(o => o.value).includes('螺旋展开'),
      '8h 内置预设：删除被拒（alert），选项仍在');
    st.refLanes[boundLi].sfxParams = { ...baseP };   // 还原默认模板，不污染后续段
  }
  // 8i) 触发型追加命令（2026-09-25）：多行文本框每行一条完整命令（含单引号条件表达式）→
  //     change → sfxParams.extra 更新 → 主行后逐行追加（坐标段 = 与主命令相同偏移）→ 持久化往返；
  //     2026-09-25 起：缺省（undefined）= 内置 conditional 默认命令、清空 = 存空串（显式不追加）
  {
    const boundLi = st.refLanes.findIndex(l => l.tracks.includes(0));
    const recI = (cls) => {
      const out = [];
      (function rec(n) { if (n.className === cls) out.push(n); (n.children || []).forEach(rec); })(elements.get('sfxEffectLanes'));
      return out;
    };
    // 面板可能因 8h 重渲染仍在展开（sfxLanesOpen 持久）→ 按钮态判断再点
    const xbtns7 = [];
    { const recX7 = (n) => { if (n.className === 'sfx-lane-x') xbtns7.push(n); (n.children || []).forEach(recX7); }; recX7(elements.get('sfxEffectLanes')); }
    if (xbtns7[boundLi] && xbtns7[boundLi].textContent === '▼') xbtns7[boundLi].dispatch('click', {});
    const extraTa = recI('sfx-extra-field');
    check(extraTa.length >= 1 && extraTa[0].tagName === 'textarea', `8i 前置：触发面板含追加命令 textarea（实际 ${extraTa.length}）`);
    // 2026-09-25 缺省 = 内置默认命令：8h 预设回填已把 sfxParams 整体替换为预设 params（无 extra 键，
    //   = 旧存档「未填过」语义）→ 重渲染后 textarea 回填内置 conditional 默认命令
    check(extraTa[0].value === context.window.__NBS2SCHEMATIC.SFX_EXTRA_DEFAULT_CMD,
      '追加命令表单回填：extra 缺省（预设回填删键，旧存档语义）→ 回填内置 conditional 默认命令');
    const CMD_I = "particleex conditional minecraft:end_rod ~ ~ ~ 1 0.95 0.89 1 0 0 0 0.5 0.5 0.5 '(abs(y)==0.5&!(abs(z)<0.5))|(abs(x)==0.5&(!(abs(z)<0.5)|!(abs(y)<0.5)))' 0.1 0 'vy=0.2' 1 null";
    extraTa[0].value = CMD_I;
    extraTa[0].dispatch('change', { target: extraTa[0] });
    check(st.refLanes[boundLi].sfxParams && st.refLanes[boundLi].sfxParams.extra === CMD_I,
      '追加命令表单编辑：lane.sfxParams.extra 更新（多行原文）');
    await context.generate();
    const resI2 = st.result.result;
    const laneI = st.refLanes[boundLi];
    const offI = { dy: laneI.start.dy + 1, dz: laneI.start.dz };
    const expExtraI = "particleex conditional minecraft:end_rod ~0 ~" + offI.dy + " ~" + offI.dz + " 1 0.95 0.89 1 0 0 0 0.5 0.5 0.5 '(abs(y)==0.5&!(abs(z)<0.5))|(abs(x)==0.5&(!(abs(z)<0.5)|!(abs(y)<0.5)))' 0.1 0 'vy=0.2' 1 null";
    const entryI = resI2.sfxTickList.find(e => e.lines.includes(expExtraI));
    check(!!entryI, `追加命令行生成：整条命令原文 + 坐标段替换为与主命令相同偏移 (0,${offI.dy},${offI.dz})`);
    if (entryI) {
      const idxMain = entryI.lines.findIndex(l => l.startsWith('particleex polarparameter '));
      check(idxMain >= 0 && entryI.lines[idxMain + 1] === expExtraI,
        '行序：追加行紧跟主触发行之后');
    }
    // 持久化往返（saveStateNow 存当前状态：extra = 用户多行原文逐字）
    context.saveStateNow();
    const rawI = context.localStorage.getItem(context.stateKey(st.song));
    const parsedI = rawI && JSON.parse(rawI);
    const laneIP = parsedI && parsedI.refLanes && parsedI.refLanes[boundLi];
    check(!!laneIP && laneIP.sfxParams && laneIP.sfxParams.extra === CMD_I,
      'sfxParams.extra 持久化往返（多行原文逐字）');
    // 清空 → 存空串（显式「不追加」，区别于缺省 undefined = 内置默认命令）→ 追加行消失
    const extraTa2 = recI('sfx-extra-field');
    extraTa2[0].value = ''; extraTa2[0].dispatch('change', { target: extraTa2[0] });
    check(st.refLanes[boundLi].sfxParams && st.refLanes[boundLi].sfxParams.extra === '',
      '追加命令清空 → sfxParams.extra 存空串（显式不追加，不冲主命令表单）');
    await context.generate();
    check(!st.result.result.sfxTickList.some(e => e.lines.some(l => l.includes('abs(y)==0.5'))),
      '收尾：追加行消失（无用户条件表达式的 conditional 行）');
    // 2026-09-25 缺省语义：删键（= 旧存档未填过，undefined）→ 构建走内置默认命令 → conditional 默认行生成
    delete st.refLanes[boundLi].sfxParams.extra;
    await context.generate();
    check(st.result.result.sfxTickList.some(e => e.lines.some(l => l.includes('abs(y)==0.5') && l.includes(' 0.1 0 '))),
      '旧存档（extra 缺省 undefined）→ 内置 conditional 默认追加命令生成（寿命 0 默认行）');
  }
  // 8j) 连接型弧线风格（2026-09-28）：结构 → 状态 → 产物 → 回归 四层断言（结构优先、字面为辅，
  //     整行字面期望留在 validate K7/K9）；末尾恢复缺省状态，不污染 9) 段
  {
    const AP = context.window.__NBS2SCHEMATIC;
    const boundLi = st.refLanes.findIndex(l => l.tracks.includes(0));
    const recJ = (cls) => {
      const out = [];
      (function rec(n) { if (n.className === cls) out.push(n); (n.children || []).forEach(rec); })(elements.get('sfxEffectLanes'));
      return out;
    };
    // 面板态与 8i 同模式：sfxLanesOpen 持久，仅收起态才点
    const xbtnsJ = [];
    { const recXJ = (n) => { if (n.className === 'sfx-lane-x') xbtnsJ.push(n); (n.children || []).forEach(recXJ); }; recXJ(elements.get('sfxEffectLanes')); }
    if (xbtnsJ[boundLi] && xbtnsJ[boundLi].textContent === '▼') xbtnsJ[boundLi].dispatch('click', {});
    // 结构层：风格 select 存在、缺省 line、两选项；line 态 lift/p 隐藏（DOM 中 5 旧字段在前、
    //   lift/p 在后 → 隐藏 2 项按 placeholder 指认 lift/p）
    const styleSel = recJ('sfx-connect-style');
    check(styleSel.length >= 1 && styleSel[0].value === 'line',
      `8j 结构：风格 select 在列且缺省 = line（实际 ${JSON.stringify(styleSel.map(s => s.value))}）`);
    check(JSON.stringify(styleSel[0].children.map(o => o.value)) === JSON.stringify(['line', 'arc']),
      '8j 结构：选项 = [line, arc]');
    const hideJ = recJ('sfx-connect-field').filter(el => el.hidden);
    const visJ = recJ('sfx-connect-field').filter(el => !el.hidden);
    check(hideJ.length === 2 && visJ.length === 5
      && hideJ.some(el => el.placeholder === '0~1，如 0.15')
      && hideJ.some(el => el.placeholder === '1~2，如 1.4'),
      `8j 结构：line 态 lift/p 两输入隐藏（隐藏 ${hideJ.length}、可见 ${visJ.length}，按 placeholder 指认）`);
    // 状态层：切 arc → connect 键必存（style ≠ 默认）；风格切换触发重渲染，lift/p 可见且回填缺省
    //   （DOM 顺序：风格 → lift → p → 5 旧字段，lift = vis[0]、p = vis[1]）
    styleSel[0].value = 'arc';
    styleSel[0].dispatch('change', { target: styleSel[0] });
    const laneJ = st.refLanes[boundLi];
    check(laneJ.sfxParams && laneJ.sfxParams.connect && laneJ.sfxParams.connect.style === 'arc',
      '8j 状态：切弧线 → sfxParams.connect.style = arc（style ≠ 默认必存键）');
    const visJ2 = recJ('sfx-connect-field').filter(el => !el.hidden);
    check(visJ2.length === 7 && visJ2[0].value === '0.15' && visJ2[1].value === '1.4',
      `8j 状态：弧线态 lift/p 可见且回填缺省（可见 ${visJ2.length}、lift=${visJ2[0].value}、p=${visJ2[1].value}）`);
    visJ2[0].value = '0.3';
    visJ2[0].dispatch('change', { target: visJ2[0] });
    const connJ = st.refLanes[boundLi].sfxParams.connect;
    check(connJ.lift === 0.3 && connJ.style === 'arc' && connJ.p === 1.4
      && connJ.particle === 'minecraft:end_rod' && connJ.color === '1 0.95 0.89 1'
      && connJ.m === 10 && connJ.alpha === 0,
      '8j 状态：改 lift=0.3 → 数值化，不冲其余 6 字段（逐键断言）');
    // 产物层（只断言前缀/片段/尾参，整行字面留 validate K7）：tickparameter 行 + 重参数化
    //   片段 + 坐标段与主命令同偏移（A = mid，与触发主行同基准）+ 组位 null
    await context.generate();
    const resJ = st.result.result;
    const laneJ2 = st.refLanes[boundLi];
    const offJ = { dy: laneJ2.start.dy + 1, dz: laneJ2.start.dz };
    const tickP = resJ.sfxTickList.flatMap(e => e.lines)
      .filter(l => l.startsWith('particleex tickparameter '));
    check(tickP.length >= 1 && tickP.every(l => l.includes('pow(abs(1-t),1.4)') && /\s+null$/.test(l)),
      `8j 产物：弧线行 = tickparameter + 重参数化 pow(abs(1-t),1.4) + 组位 null（共 ${tickP.length} 行）`);
    check(tickP.some(l => l.includes(`~0 ~${offJ.dy} ~${offJ.dz}`)),
      `8j 产物：坐标段与主命令同偏移 (0,${offJ.dy},${offJ.dz})`);
    // 回归层：切回 line（lift 仍 0.3）→ tickparameter 消失、tickpolarparameter 恢复
    const styleSel2 = recJ('sfx-connect-style');
    styleSel2[0].value = 'line';
    styleSel2[0].dispatch('change', { target: styleSel2[0] });
    await context.generate();
    const resJ2 = st.result.result;
    const tickP2 = resJ2.sfxTickList.flatMap(e => e.lines)
      .filter(l => l.startsWith('particleex tickparameter '));
    const tickPol2 = resJ2.sfxTickList.flatMap(e => e.lines)
      .filter(l => l.startsWith('particleex tickpolarparameter '));
    check(tickP2.length === 0 && tickPol2.length > 0,
      `8j 回归：切回直线 → tickparameter 消失（${tickP2.length}）、tickpolarparameter 恢复（${tickPol2.length}）`);
    // 载荷回归：connect 全默认 → delete 键（isDefault 语义；lift/p 回默认后与 SFX_CONNECT_DEFAULTS 逐键相等）
    delete st.refLanes[boundLi].sfxParams.connect;
    context.saveStateNow();
    const rawJ = context.localStorage.getItem(context.stateKey(st.song));
    const parsedJ = rawJ && JSON.parse(rawJ);
    const laneJ3 = parsedJ && parsedJ.refLanes[boundLi];
    check(!!laneJ3 && !(laneJ3.sfxParams || {}).connect,
      '8j 回归：connect 全默认 → connect 键被删，载荷回旧形状（持久化往返）');
  }
  // 8k) 自定义乐器资源包 playsound（2026-09-29 用户定）：结构 → 状态（合法/非法/清空）→ 产物
  //     → 持久化 四层断言；末尾恢复 demo 原歌（无自定义乐器），不污染 9) 段
  {
    const songK = context.parseNBS(new Uint8Array(readFileSync(path.join(__dirname, 'demo_song.nbs'))));
    songK.sourceFileName = 'demo_song.nbs';
    // 注入 1 个自定义乐器（ID = defaultInstruments + 0 = 16），并把声部 0 第 1 个音符改成该乐器
    songK.customInstruments = [{ name: 'MySynth', soundFile: 'my_synth.ogg', pitch: 12, pressKey: false }];
    const [kK, nK] = songK.layers[0].notes.entries().next().value;
    nK.instrument = songK.defaultInstruments;
    // 8i/8j 在 demo 同 key 下遗留 refLanes（layer 0 绑参考车道 → 虚拟不放置 → 无 playsound 行）→ 清档
    context.localStorage.removeItem(context.stateKey(songK));
    context.onSongLoaded(songK, null);
    const stK = context.window.__NBS2SCHEMATIC.state;
    const instIdK = songK.defaultInstruments; // 16
    const recK = (cls) => {
      const out = [];
      (function rec(n) { if (n.className === cls) out.push(n); (n.children || []).forEach(rec); })(elements.get('customInstSelects'));
      return out;
    };
    // 结构层：设置区出现 custom-inst-sound 输入，placeholder 指认、缺省空
    const sndK = recK('custom-inst-sound');
    check(sndK.length === 1 && sndK[0].dataset.instId === String(instIdK)
      && sndK[0].value === '' && sndK[0].placeholder === '资源包声音 ID（可选，如 minecraft:block.portal.trigger）',
      `8k 结构：自定义乐器行出现资源包声音 ID 输入（#${instIdK}，缺省空）`);
    // 状态层：合法写入 → map 更新；非法（含空格）→ 保持旧值 + 输入框回填；清空 → delete
    //   （change 注册在容器 #customInstSelects 上，事件对象按真实 DOM 冒泡语义带 target）
    const boxK = elements.get('customInstSelects');
    sndK[0].value = 'music:my_synth';
    boxK.dispatch('change', { target: sndK[0] });
    check(stK.settings.soundIdMap.get(instIdK) === 'music:my_synth',
      '8k 状态：填写合法 ID → settings.soundIdMap 写入');
    sndK[0].value = 'bad id';
    boxK.dispatch('change', { target: sndK[0] });
    check(stK.settings.soundIdMap.get(instIdK) === 'music:my_synth' && sndK[0].value === 'music:my_synth',
      '8k 状态：非法 ID（含空格）拒写，输入框回填旧值');
    sndK[0].value = '';
    boxK.dispatch('change', { target: sndK[0] });
    check(!stK.settings.soundIdMap.has(instIdK), '8k 状态：清空 → 显式不配置（delete）');
    sndK[0].value = 'music:my_synth';
    boxK.dispatch('change', { target: sndK[0] });
    // 产物层（2026-09-29 命令方块直写）：代位格正上方 CB 的 Command = playsound 裸命令（无斜杠）；
    //   函数管线不再承载 playsound（无参考声道 → 无数据包 zip）
    await context.generate();
    const resK = stK.result.result;
    const psTeK = resK.tileEntities.filter(e => typeof e.Command === 'string'
      && e.Command.startsWith('playsound music:my_synth master @a ~ ~ ~ '));
    check(resK.stats.playsoundNotes === 1 && psTeK.length === 1
      && /\s\d+\.\d{2} [\d.]+$/.test(psTeK[0].Command),
      `8k 产物：playsound 命令方块 ×1（Command 直写，volume/pitch 数值尾段）：${psTeK[0].Command}`);
    check(resK.sfxTickList.length === 0 && !stK.sfxZipBytes,
      '8k 产物：playsound 不进 <t>.mcfunction（无参考声道时不产数据包 zip）');
    // 持久化层：settings.soundIdMap 进载荷
    context.saveStateNow();
    const rawK = context.localStorage.getItem(context.stateKey(stK.song));
    const parsedK = rawK && JSON.parse(rawK);
    check(!!parsedK && JSON.stringify(parsedK.settings.soundIdMap) === JSON.stringify([[instIdK, 'music:my_synth']]),
      '8k 持久化：settings.soundIdMap 进载荷');
    // 收尾：恢复 demo 原歌（无自定义乐器 → 输入行消失、playsound 计数归零）
    const songK2 = context.parseNBS(new Uint8Array(readFileSync(path.join(__dirname, 'demo_song.nbs'))));
    songK2.sourceFileName = 'demo_song.nbs';
    context.onSongLoaded(songK2, null);
    const stK2 = context.window.__NBS2SCHEMATIC.state;
    check(elements.get('customInstRow').hidden === true,
      '8k 收尾：原 demo 歌无自定义乐器 → 设置区输入行隐藏');
    stK2.settings.soundIdMap.clear();
    await context.generate();
    check(stK2.result.result.stats.playsoundNotes === 0,
      '8k 收尾：playsound 计数归零（原歌无自定义乐器音符）');
  }
  // 8l) 粒子歌词（2026-10-06 用户定）：canvas 桩（measureText/getImageData/toDataURL）走通
  //     导入 → 编辑 → 持久化往返 → 生成（buildLyricPngs → 命令/CB → 纯歌词 zip）→ 设置/删除
  {
    const AP = context.window.__NBS2SCHEMATIC;
    const demoL = context.parseNBS(new Uint8Array(readFileSync(path.join(__dirname, 'demo_song.nbs'))));
    demoL.sourceFileName = 'demo_song.nbs';
    // 8b-8j 在 demo 同 key 下遗留 refLanes（参考车道 → 函数管线行 → 污染歌词 CB/管线断言）→ 清档
    context.localStorage.removeItem(context.stateKey(demoL));
    context.onSongLoaded(demoL, null);
    const stL = AP.state;
    // 1) 结构：lyric-section 显示（onSongLoaded 解除 hidden）、控件齐备、缺省无句
    //    lyricText 只在文件 change 回调里被首次访问（回调不触发）→ 预热（模拟浏览器解析 HTML 建元素）
    context.document.getElementById('lyricText');
    check(elements.get('lyric-section').hidden === false, '8l 结构：lyric-section 已显示');
    check(['lyricFileBtn', 'lyricParseBtn', 'lyricText', 'lyricList', 'lyricAddBtn', 'lyricParticle', 'lyricSize',
      'lyricGap', 'lyricMaxChars', 'lyricRotate', 'lyricPitch', 'lyricFont', 'lyricFontSample', 'lyricFontUploadBtn', 'lyricPosX', 'lyricCanvas', 'lyricLayoutInfo']
      .every(id => !!elements.get(id)), '8l 结构：导入/设置/句列表/字体/位置窗口控件齐备');
    const fsL0 = elements.get('lyricFontSample');
    check(!!fsL0 && fsL0.textContent === '我的世界' && /LXGW/.test(fsL0.style.fontFamily || ''),
      `8l 结构：字体样例「我的世界」按当前字体（lxgw 默认）渲染（text=${fsL0 && fsL0.textContent} family=${fsL0 && fsL0.style.fontFamily}）`);
    check(elements.get('lyricList').children.length === 0 && elements.get('lyricCount').textContent.includes('未导入'),
      '8l 结构：缺省无句、lyricCount 显示「未导入」');
    // 2) 导入：LRC 粘贴 → 解析 → 2 句（demo tempo=10：0.50s→5、1.00s→10、末句 end=曲长 287）
    elements.get('lyricText').value = '[00:00.50]你好世界\n[00:01.00]第二行\n';
    elements.get('lyricParseBtn').dispatch('click', {});
    check(stL.lyrics.length === 2
      && JSON.stringify(stL.lyrics.map(s => [s.start, s.end, s.text])) === JSON.stringify([[5, 10, '你好世界'], [10, 287, '第二行']])
      && elements.get('lyricList').children.length === 2,
      `8l 导入：LRC → 2 句 [[5,10],[10,287]]（实际 ${JSON.stringify(stL.lyrics)}）`);
    // 3) 编辑：首句 end 10→15（title 显示秒）→ commit
    const inE0 = elements.get('lyricList').children[0].children[1];
    check(inE0.title.includes('1.00s'), `8l 编辑：end 输入 title 显示秒（${inE0.title}）`);
    inE0.value = '15';
    inE0.dispatch('change', { target: inE0 });
    check(stL.lyrics[0].end === 15, '8l 编辑：end 改 10→15 → 状态更新');
    // 4) 持久化往返：载荷 lyrics + settings.lyric → 重载恢复
    context.saveStateNow();
    const rawL = context.localStorage.getItem(context.stateKey(stL.song));
    const parsedL = rawL && JSON.parse(rawL);
    check(!!parsedL && JSON.stringify(parsedL.lyrics) === JSON.stringify([{ start: 5, end: 15, text: '你好世界' }, { start: 10, end: 287, text: '第二行' }]),
      `8l 持久化：载荷 lyrics = [{5,15,你好世界},{10,287,第二行}]（实际 ${JSON.stringify(parsedL && parsedL.lyrics)}）`);
    check(!!parsedL && parsedL.settings && parsedL.settings.lyric && parsedL.settings.lyric.size === 32
      && parsedL.settings.lyric.pos && parsedL.settings.lyric.pos.y === 3,
      `8l 持久化：settings.lyric 进载荷（size=32、pos.y=3；实际 ${JSON.stringify(parsedL && parsedL.settings && parsedL.settings.lyric)}）`);
    const demoL2 = context.parseNBS(new Uint8Array(readFileSync(path.join(__dirname, 'demo_song.nbs'))));
    demoL2.sourceFileName = 'demo_song.nbs';
    context.onSongLoaded(demoL2, null);
    const stL2 = AP.state;
    check(stL2.lyrics.length === 2 && stL2.lyrics[0].end === 15, '8l 持久化：重载 → lyrics 恢复（2 句、首句 end=15）');
    // 清档后 lanes 空（generate 需至少 1 条车道）→ 模拟用户预置单行（音轨 0 → 车道 1，dz=3）
    stL2.lanes = [{ tracks: [0], start: { dz: 3, dy: 0 } }];
    // 5) 生成：canvas 桩走通 buildLyricPngs → image 命令 + 起始 tick CB + 纯歌词 zip
    await context.generate();
    const resL = stL2.result.result;
    check(resL.stats.lyricSentences === 2 && resL.stats.lyricLines === 2 && resL.stats.lyricPngs === 2,
      `8l 产物：歌词 2 句 · 2 行 · 2 PNG（粒子=${resL.stats.lyricParticles}）`);
    const tlL = resL.sfxTickList;
    check(JSON.stringify(tlL.map(e => e.tick)) === JSON.stringify([5, 10])
      && tlL.every(e => e.lines.length === 1 && e.lines[0].startsWith('particleex image minecraft:end_rod ')),
      `8l 产物：函数管线 = 歌词起始 tick 5/10、每行 1 条 image 命令（实际 ${JSON.stringify(tlL.map(e => e.tick))}）`);
    const cbsL = resL.tileEntities.filter(t => t.id === 'minecraft:command_block' && t.Command.startsWith('function nbs2sfx:'));
    check(cbsL.length === 2 && cbsL.some(t => t.Command === 'function nbs2sfx:5') && cbsL.some(t => t.Command === 'function nbs2sfx:10')
      && resL.stats.commandBlocks === 2,
      '8l 产物：起始 tick CB ×2（function nbs2sfx:5/10）、总 CB=2（纯歌词、无参考声道）');
    const zBytes = AP.state.sfxZipBytes;
    check(!!zBytes && zBytes.length > 0, '8l zip：纯歌词（无参考声道）生成数据包 zip（新条件）');
    if (zBytes) {
      const zStr = new TextDecoder().decode(new Uint8Array(zBytes));
      check(zStr.includes('data/nbs2sfx/lyric/s0000_l0.png') && zStr.includes('data/nbs2sfx/lyric/s0001_l0.png')
        && zStr.includes('function/5.mcfunction') && zStr.includes('function/10.mcfunction'),
        '8l zip：条目含 2 歌词 PNG（s0000/s0001_l0）+ function/5 + function/10');
    }
    // 6) 设置：size 48 → settings.lyric 即时更新
    const szIn = elements.get('lyricSize');
    szIn.value = '48';
    szIn.dispatch('change', { target: szIn });
    check(stL2.settings.lyric.size === 48, '8l 设置：size 改 32→48 → settings.lyric 更新');
    // 6b) 字体样例：切 system → 样例按系统楷体渲染；还原 lxgw → 回 LXGW 链
    const fSel = elements.get('lyricFont'), fsL = elements.get('lyricFontSample');
    fSel.value = 'system';
    fSel.dispatch('change', { target: fSel });
    check(fsL.textContent === '我的世界' && !/LXGW/.test(fsL.style.fontFamily || '') && /KaiTi/.test(fsL.style.fontFamily || ''),
      `8l 设置：字体切 system → 样例「我的世界」按系统楷体渲染（family=${fsL.style.fontFamily}）`);
    fSel.value = 'lxgw';
    fSel.dispatch('change', { target: fSel });
    check(/LXGW/.test(fsL.style.fontFamily || ''), '8l 设置：字体还原 lxgw → 样例回 LXGW 链');
    // 6c) 俯仰：pitch 0→2 → settings.lyric 更新 + 输入框回填（xRot 位传透由 validate N 段断言）
    const pIn = elements.get('lyricPitch');
    pIn.value = '2';
    pIn.dispatch('change', { target: pIn });
    check(stL2.settings.lyric.pitch === 2 && pIn.value === '2', '8l 设置：俯仰改 0→2 → settings.lyric.pitch=2 且输入框回填');
    // 7) 删除：✕ → 剩 1 句
    elements.get('lyricList').children[0].children[3].dispatch('click', {});
    check(stL2.lyrics.length === 1, '8l 删除：✕ 点击 → 剩 1 句');
    // 8) 收尾：清空 lyrics、size 还原缺省，不污染 9) 段
    stL2.lyrics = [];
    stL2.settings.lyric = { ...AP.LYRIC_DEFAULTS, pos: { ...AP.LYRIC_DEFAULTS.pos } };
    context.renderLyricSection();
    context.saveStateNow();
    check(stL2.lyrics.length === 0 && stL2.settings.lyric.size === 32, '8l 收尾：lyrics 清空、size 还原 32');
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
    // 3e) 轨道 0 可拖（2026-10-08）：pointerdown 命中轨道 0 标记（main 窗口下标 0）→ pointermove 落到 (14,2)
    const l0p0 = ed.w2s(st.lane0.start.dz, st.lane0.start.dy);
    cvMain.dispatch('pointerdown', { pointerId: 3, offsetX: l0p0.x, offsetY: l0p0.y });
    check(ed.dragIndex === 0 && ed.selected === 0, '轨道 0 拖拽：pointerdown 命中轨道 0 标记（dragIndex=0）');
    const l0Target = { dz: 14, dy: 2 };
    const l0p1 = ed.w2s(l0Target.dz, l0Target.dy);
    cvMain.dispatch('pointermove', { pointerId: 3, offsetX: l0p1.x, offsetY: l0p1.y });
    check(st.lane0.start.dz === l0Target.dz && st.lane0.start.dy === l0Target.dy,
      '轨道 0 拖拽：pointermove 后 lane0.start 精确移动（实际 ' + JSON.stringify(st.lane0.start) + '）');
    cvMain.dispatch('pointerup', { pointerId: 3 });
    // 3e-2) 过近校验：轨道 0 与其他车道起点 3 格内 → 琥珀警告、不阻止（errors 不含该对）
    {
      const nearIdx = st.lanes.findIndex(l => l.start && Math.abs(l.start.dz - st.lane0.start.dz) < 3 && Math.abs(l.start.dy - st.lane0.start.dy) < 3);
      if (nearIdx > -1) {
        const { warnings: ws, errors: es } = ed.validate();
        check(ws.some(m => m.includes('轨道 0') && m.includes('车道')) && !es.some(m => m.includes('轨道 0')),
          '轨道 0 与车道过近 → 警告不阻止（' + JSON.stringify({ warn: ws.length, err: es.length }) + '）');
      } else {
        // 无天然近邻 → 构造一对再校验
        const saved = st.lanes[0].start;
        st.lanes[0].start = { dz: st.lane0.start.dz + 1, dy: st.lane0.start.dy + 1 };
        const { warnings: ws, errors: es } = ed.validate();
        check(ws.some(m => m.includes('轨道 0') && m.includes('车道')) && !es.some(m => m.includes('轨道 0')),
          '轨道 0 与车道过近（构造）→ 警告不阻止');
        st.lanes[0].start = saved;
      }
    }
    st.lane0.start = { dz: 0, dy: 0 }; // 复原（后文预置测试依赖原点中心）
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
  check(edRef.draggable(st.refLanes.length) === false
    && edRef.draggable(edRef.starts().length - 1) === true,
    'ref 窗口：普通车道不可拖背景、轨道 0 可拖（2026-10-08）');
  check(ed.draggable(0) === true && ed.draggable(1) === true
    && ed.draggable(idxBoundMain) === true
    && (idxIndepMain > -1 ? ed.draggable(idxIndepMain) === false : true),
    'main 窗口：轨道 0 可拖（2026-10-08）、音轨车道可拖、单线式参考车道可拖（虚拟盒位锚点）、MIDI式为不可拖背景（中心基准在 ref 窗口拖）');
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
  // 4c) 预置：声像（2026-10-06，参考 NBS-to-minecraftsave 的 panning 自动布局）：
  //     临时换合成 song（lane0 响度低 pan+90 / lane1 pan−100 vel30 / lane2 pan+50 vel10）+ 3 音轨车道，测后还原
  {
    const origSong = st2.song;
    st2.song = {
      songLength: 4, tempo: 20,
      layers: [
        { panning: 0, notes: new Map([[0, { velocity: 10, panning: 90 }]]) },
        { panning: 0, notes: new Map([[0, { velocity: 30, panning: -100 }]]) },
        { panning: 0, notes: new Map([[0, { velocity: 10, panning: 50 }]]) },
      ],
    };
    st2.lanes = [{ tracks: [0] }, { tracks: [1] }, { tracks: [2] }];
    st2.lane0.start = { dz: 0, dy: 0 };
    st2.refLanes = [{ tracks: [i0], start: { dz: 7, dy: 2 } }];
    // panPresetMode 桩元素懒创建：先经 document.getElementById 触发建元（与真实 DOM 一致，ID 来自 index.html）
    const modeSel = context.document.getElementById('panPresetMode');
    modeSel.value = 'panning';
    elements.get('presetPanBtn').dispatch('click', {});
    check(st2.lanes[0].start.dz === 24 && st2.lanes[0].start.dy === 0
      && st2.lanes[1].start.dz === -12 && st2.lanes[1].start.dy === -21
      && st2.lanes[2].start.dz === -12 && st2.lanes[2].start.dy === 21,
      '预置声像·panning：均值降序（90>50>−100）占半径 24 圆 → (24,0)/(−12,−21)/(−12,21)');
    modeSel.value = 'volume';
    elements.get('presetPanBtn').dispatch('click', {});
    check(st2.lanes[0].start.dz === 24 && st2.lanes[0].start.dy === 0
      && st2.lanes[1].start.dz === -12 && st2.lanes[1].start.dy === -21
      && st2.lanes[2].start.dz === -12 && st2.lanes[2].start.dy === 21,
      '预置声像·volume：方向+响度排序占半径 24 圆 → (24,0)/(−12,−21)/(−12,21)');
    check(st2.refLanes[0].start.dz === 7 && st2.refLanes[0].start.dy === 2,
      '预置声像：参考车道保持不动 (7,2)（预置只重排普通车道）');
    // 圆心 = 坐标轴原点（2026-10-10 用户定案）：轨道 0 起点非原点时声像仍以 (0,0) 为圆心
    st2.lane0.start = { dz: 2, dy: 3 };
    modeSel.value = 'panning';
    elements.get('presetPanBtn').dispatch('click', {});
    check(st2.lanes[0].start.dz === 24 && st2.lanes[0].start.dy === 0,
      '预置声像：圆心恒为坐标轴原点 (0,0)（轨道 0 起点 (2,3) 不参与）');
    st2.lane0.start = { dz: 0, dy: 0 }; // 还原
    st2.song = origSong; // 还原
  }
  // 4d) 预置：圆环（2026-10-07，48 格可听范围参考）：4 条车道半径 16 → 十字形 (±16,0)/(0,±16)
  {
    st2.lanes = [{ tracks: [i0] }, { tracks: [i0] }, { tracks: [i0] }, { tracks: [i0] }];
    st2.lane0.start = { dz: 0, dy: 0 };
    const radSel = context.document.getElementById('ringRadius');
    radSel.value = '16';
    elements.get('presetRingBtn').dispatch('click', {});
    check(st2.lanes[0].start.dz === 16 && st2.lanes[0].start.dy === 0
      && st2.lanes[1].start.dz === 0 && st2.lanes[1].start.dy === 16
      && st2.lanes[2].start.dz === -16 && st2.lanes[2].start.dy === 0
      && st2.lanes[3].start.dz === 0 && st2.lanes[3].start.dy === -16,
      '预置圆环·R16：四车道正交十字 (16,0)/(0,16)/(−16,0)/(0,−16)');
    // 圆环只重排普通车道，参考车道不动
    st2.refLanes = [{ tracks: [i0], start: { dz: 4, dy: 4 } }];
    elements.get('presetRingBtn').dispatch('click', {});
    check(st2.refLanes[0].start.dz === 4 && st2.refLanes[0].start.dy === 4,
      '预置圆环：参考车道保持不动 (4,4)');
    const { errors: ringErrs } = ed.validate();
    check(ringErrs.length === 0, '预置圆环后布局无重叠错误');
  }
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

// ---------- L 矿车监听系统 UI（2026-10-07） ----------
{
  const st = context.window.__NBS2SCHEMATIC.state;
  const cb = elements.get('listenerEnabled');
  check(!!cb, 'L listenerEnabled 复选框存在');
  // 勾选 → settings
  cb.checked = true; cb.dispatch('change', { target: cb });
  check(st.settings.listener && st.settings.listener.enabled === true, 'L 勾选 → settings.listener.enabled=true');
  // 生成 → 2 个监听 CB（启动 impulse + 跟随 repeating）
  await context.generate();
  const r0 = st.result.result;
  const cbs = r0.tileEntities.filter(te => te.Command && te.Command.startsWith('function nbs2sfx:listener_'));
  check(cbs.length === 2, `L 生成含 2 个监听 CB（实际 ${cbs.length}）`);
  const hasStart = cbs.some(te => te.Command === 'function nbs2sfx:listener_start' && te.auto === false);
  const hasFollow = cbs.some(te => te.Command === 'function nbs2sfx:listener_follow' && te.auto === true);
  check(hasStart && hasFollow, 'L 启动 CB auto=false / 跟随 CB auto=true');
  check(!!r0.geometry.listener && r0.geometry.listener.start.placed === true && r0.geometry.listener.follow.placed === true,
    'L geometry.listener 两 CB placed=true');
  // 取消勾选 → 零回归（0 监听 CB、listener=null）
  cb.checked = false; cb.dispatch('change', { target: cb });
  await context.generate();
  const r1 = st.result.result;
  const cbs2 = r1.tileEntities.filter(te => te.Command && te.Command.startsWith('function nbs2sfx:listener_'));
  check(cbs2.length === 0 && r1.geometry.listener === null, 'L 取消勾选 → 0 监听 CB / listener=null（零回归）');
}

// ---------- M 音量还原模式（2026-10-09）：每轨 opt-in，依赖矿车监听 ----------
{
  const st = context.window.__NBS2SCHEMATIC.state;
  context.clearError();
  const mBuf = makeNbs({ tempoTps: 10, songLength: 6, noteSpecs: [
    { tick: 0, layer: 0, instrument: 0, key: 40, velocity: 100 },
    { tick: 2, layer: 0, instrument: 0, key: 41, velocity: 80 },
  ]});
  context.onSongLoaded(context.parseNBS(new Uint8Array(mBuf)), null);
  st.lanes = [{ tracks: [0], start: { dz: 6, dy: 0 }, volRestore: true }];
  st.lane0.start = { dz: 0, dy: 0 };
  context.window.__NBS2SCHEMATIC.syncLaneStarts();
  // 车道卡片渲染层断言：音量还原复选框勾选态 + title 含起点增益百分比（volRestoreGain(6,0)≈87%）
  context.renderLaneSection();
  const findRestoreCb = (node) => {
    if (node.className && String(node.className).split(/\s+/).includes('lane-restore')) return node;
    for (const c of (node.children || [])) { const f = findRestoreCb(c); if (f) return f; }
    return null;
  };
  const restoreCb = findRestoreCb(elements.get('groupList'));
  check(!!restoreCb && restoreCb.checked === true && restoreCb.title.includes('87%'),
    `M 车道卡片渲染音量还原复选框（勾选 + title 含起点增益 87%；实际 ${restoreCb && (restoreCb.checked ? '勾选' : '未勾选')}）`);
  // 未启用监听 → 报错中止（音量还原依赖监听者作增益参照物）
  await context.generate();
  const errTxt = elements.get('errors').textContent;
  check(errTxt.includes('音量还原') && errTxt.includes('矿车监听'), `M 未启用监听：报错提示（${errTxt.slice(0, 36)}…）`);
  // 启用监听 → 生成：锚点 = 让位后 zc 8（dz6+shift2）、g0=1−√65/48；v100 → 分支末端盒、v80 → 主位盒
  const cb = elements.get('listenerEnabled');
  cb.checked = true; cb.dispatch('change', { target: cb });
  await context.generate();
  const r = st.result && st.result.result;
  check(!!r, 'M 启用监听后生成成功');
  const vr = r && r.geometry.volRestore;
  check(Array.isArray(vr) && vr.length === 1, `M geometry.volRestore 单条记录（实际 ${vr ? vr.length : vr}）`);
  if (vr && vr[0]) {
    check(vr[0].lane === 1 && vr[0].anchorZc === 8 && vr[0].noteCount === 2,
      `M 锚点=让位后 zc 8、参与音符 2（组索引 ${vr[0].lane} = 音轨车道，组 0 = 轨道 0；anchorZc=${vr[0].anchorZc}）`);
    check(vr[0].zLine === 16 && Math.abs(vr[0].g0 - 0.8320362969) < 1e-9,
      `M 主链重定位 zLine=16、g0=${vr[0].g0}（=1−√65/48）`);
    check(vr[0].clampedTo100 === false && vr[0].truncated === 0, 'M 未截断（跨度 8.02 ≤ 30 且 |dz| ≤ 15）');
  }
  check(r && r.stats.volRestoreNotes === 2 && r.stats.noteBlocks === 2 && r.stats.notesDiscarded === 0,
    `M 两音符均放盒（v100 分支末端 / v80 主位；volRestoreNotes=${r && r.stats.volRestoreNotes}）`);
  check(r && r.stats.discardedDetails.some(s => s.includes('音量还原启用') && s.includes('主链已重定位')),
    'M 明细含「音量还原启用…主链已重定位」');
  // 取消音量还原 → 零回归（geometry.volRestore=null、无计数）
  st.lanes[0].volRestore = false;
  context.renderLaneSection();
  check(findRestoreCb(elements.get('groupList')).checked === false, 'M 取消后卡片复选框回未勾选');
  await context.generate();
  const r2 = st.result.result;
  check(r2.geometry.volRestore === null && r2.stats.volRestoreNotes === 0, 'M 取消音量还原 → geometry.volRestore=null（零回归）');
  cb.checked = false; cb.dispatch('change', { target: cb }); // 复原监听开关
}

console.log(`汇总：共 ${passed + failed} 项 — ${passed} PASS / ${failed} FAIL`);
process.exit(failed ? 1 : 0);
