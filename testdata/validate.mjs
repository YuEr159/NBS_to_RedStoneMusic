// validate.mjs — 端到端验证：模拟浏览器环境运行 index.html 的脚本，
// 生成 .litematic 字节流 → gzip 解压 → NBT 解码 → 位解包 → 与体素网格逐格比对 + 结构断言
// 用法：node validate.mjs
import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import zlib from 'zlib';
import vm from 'vm';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/<script>([\s\S]*)<\/script>/);
if (!m) { console.error('FAIL: 未找到 <script> 块'); process.exit(1); }

// ---------- 最小 DOM stub ----------
const elements = new Map();
function makeEl() {
  return {
    addEventListener() {}, hidden: false, textContent: '', innerHTML: '',
    style: {}, dataset: {}, value: '', checked: false,
    classList: { add() {}, remove() {} },
    appendChild() {}, closest() { return null; },
    getContext() { return null; },
  };
}
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
  requestAnimationFrame() {}, setTimeout, clearTimeout,
  FileReader: class {}, Blob: class {}, URL: { createObjectURL() { return ''; }, revokeObjectURL() {} },
  CompressionStream: globalThis.CompressionStream, // Node 18+
  DecompressionStream: globalThis.DecompressionStream, // Node 18+
  localStorage: {
    _m: new Map(),
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
    setItem(k, v) { this._m.set(k, String(v)); },
    removeItem(k) { this._m.delete(k); },
    clear() { this._m.clear(); },
    key(i) { return [...this._m.keys()][i] ?? null; },
    get length() { return this._m.size; },
  },
};
context.window = context;
vm.createContext(context);
vm.runInContext(html.match(/<script>([\s\S]*)<\/script>/)[1], context);

const { parseNBS, computeDelays, buildLayout, buildPalette, packBlockStates, buildLitematic, noteFromKey,
  mergeSuggestions, packLanesNoConflict, laneConflictStats, TARGET_VERSIONS, targetEntry, DEFAULT_TARGET_MC } =
  context.window.__NBS2SCHEMATIC;

// ---------- NBT 解码器（大端） ----------
class NbtReader {
  constructor(buf) {
    this.buf = buf; this.off = 0;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  u8() { const v = this.view.getUint8(this.off); this.off += 1; return v; }
  i16() { const v = this.view.getInt16(this.off, false); this.off += 2; return v; }
  i32() { const v = this.view.getInt32(this.off, false); this.off += 4; return v; }
  i64() { const v = this.view.getBigInt64(this.off, false); this.off += 8; return v; }
  str() {
    const len = this.i16();
    const s = new TextDecoder('utf-8').decode(this.buf.subarray(this.off, this.off + len));
    this.off += len;
    return s;
  }
  readTag() {
    const type = this.u8();
    if (type === 0) return { type: 0, name: '', value: null };
    const name = this.str();
    return { type, name, value: this.readPayload(type) };
  }
  readPayload(type) {
    switch (type) {
      case 1: return this.u8();
      case 2: return this.i16();
      case 3: return this.i32();
      case 4: return this.i64();
      case 5: { const v = this.view.getFloat32(this.off, false); this.off += 4; return v; }
      case 6: { const v = this.view.getFloat64(this.off, false); this.off += 8; return v; }
      case 7: { const n = this.i32(); const a = []; for (let i = 0; i < n; i++) a.push(this.u8()); return a; }
      case 8: return this.str();
      case 9: {
        const itemType = this.u8();
        const n = this.i32();
        const items = [];
        for (let i = 0; i < n; i++) items.push(this.readPayload(itemType));
        return items;
      }
      case 10: {
        const entries = {};
        while (true) {
          const t = this.readTag();
          if (t.type === 0) break;
          entries[t.name] = t.value;
        }
        return entries;
      }
      case 11: { const n = this.i32(); const a = []; for (let i = 0; i < n; i++) a.push(this.i32()); return a; }
      case 12: { const n = this.i32(); const a = []; for (let i = 0; i < n; i++) a.push(this.i64()); return a; }
      default: throw new Error(`未知 NBT 类型 ${type}`);
    }
  }
  readRoot() {
    // NBT 根 = 具名 compound：type byte(10) + 空名字 + 条目流 + TAG_End
    // （与 level.dat、MC NbtIo / Litematica 读取器一致）
    const type = this.u8();
    if (type !== 10) throw new Error(`根 tag 类型应为 10 (Compound)，实际 ${type}`);
    const rootName = this.str();
    if (rootName !== '') throw new Error(`根 tag 名字应为空，实际 "${rootName}"`);
    const entries = {};
    while (true) {
      const t = this.readTag();
      if (t.type === 0) break;
      entries[t.name] = t.value;
    }
    return { type: 10, name: rootName, entries };
  }
}

// ---------- 位解包（LitematicaBitArray 语义：LSB-first、跨边界） ----------
function decodePacked(longs, bits, count) {
  const mask = (1n << BigInt(bits)) - 1n;
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    const start = i * bits;
    const li = Math.floor(start / 64);
    const shift = start % 64;
    // BigInt64Array 元素有符号：必须 asUintN 转无符号再右移（Java 用 >>> 无符号移位）
    const L = BigInt.asUintN(64, longs[li]);
    let v = (L >> BigInt(shift)) & mask;
    if (shift + bits > 64 && li + 1 < longs.length) {
      const L2 = BigInt.asUintN(64, longs[li + 1]);
      v = ((L >> BigInt(shift)) | (L2 << BigInt(64 - shift))) & mask;
    }
    out[i] = Number(v);
  }
  return out;
}

// ---------- 端到端流程 ----------
// refLayers：Map<声部下标, {type:'bound'|'independent', sound:bool}>（节奏参考双类型，旧 bool 值按MIDI式迁移）；传入后 buildLayout 在轨道 0 生成命令方块
// refLanes：参考车道池 [{tracks, type, start, effects?}]（纯虚拟：不生成任何物理结构，2026-09-07 起仅粒子锚点几何；传数组即启用 refMode——单线式粒子锚定参考车道虚拟槽位；effects 缺省 = 三类特效全选）
function runE2E(nbsFile, { autoGroup = true, groups = null, groupStarts = null, settings = null, targetMc = null, lane0 = null, refLayers = null, refLanes = null } = {}) {
  const bytes = new Uint8Array(readFileSync(path.join(__dirname, nbsFile)));
  const song = parseNBS(bytes);
  let maxTick = song.songLength;
  for (const layer of song.layers) for (const t of layer.notes.keys()) if (t > maxTick) maxTick = t;
  const delays = computeDelays(song.tempo, maxTick + 1);
  // 自动分组：每 3 条有声部的层一组（也可传入自定义 groups，如重复音轨测试）
  const usedLayers = [];
  song.layers.forEach((l, i) => { if (l.notes.size > 0) usedLayers.push(i); });
  const groups2 = groups || (() => {
    const g = [];
    for (let i = 0; i < usedLayers.length; i += 3) g.push({ layers: usedLayers.slice(i, i + 3) });
    return g;
  })();
  const starts = groupStarts || groups2.map((g, i) => ({ dz: i * 3 + 3, dy: 0 }));
  const s = {
    buttonType: 'minecraft:oak_button', customInstrumentMap: new Map(),
    ...(settings || {}),
  };
  // refLanes 与 UI 同构（{tracks, type, start, effects?, sfxParams?}）；缺省 type=independent；
  //   start 缺省镜像 syncRefLaneStarts 分流（2026-09-07 独立中心可拖）：MIDI式=(0,0)（粒子中心基准默认），单线式=单行 i*3+6 接续；
  //   effects 缺省 = 全选（不传该键）；sfxParams 缺省 = 默认命令（不传该键）
  const refGroups = (refLanes || []).map((l, i) => ({ tracks: [...l.tracks], type: l.type || 'independent',
    start: l.start || ((l.type || 'independent') === 'independent' ? { dz: 0, dy: 0 } : { dz: i * 3 + 6, dy: 0 }),
    ...(Array.isArray(l.effects) ? { effects: [...l.effects] } : {}),
    ...(l.sfxParams && typeof l.sfxParams === 'object' ? { sfxParams: { ...l.sfxParams } } : {}) }));
  const result = buildLayout(song, groups2, starts, delays, s, lane0,
    refLanes === null ? null : refGroups, refLayers);
  const palette = buildPalette(result.grid);
  const packed = packBlockStates(result.grid.data, palette.length);
  let totalBlocks = 0;
  for (const id of result.grid.data) if (id !== 0) totalBlocks++;
  const size = { x: result.grid.sx, y: result.grid.sy, z: result.grid.sz };
  const target = targetEntry(targetMc || DEFAULT_TARGET_MC);
  // 有参考声道时 NBT 携带命令方块 TileEntities（与浏览器 generate() 同签名）
  const hasSfx = !!(refLayers && refLayers.size > 0);
  const nbtBytes = buildLitematic(song, palette, packed, size, totalBlocks, 0n, target.dataVersion,
    hasSfx ? { tileEntities: result.tileEntities, entities: result.entities } : undefined);
  return { song, result, palette, packed, size, totalBlocks, nbtBytes, target, refLayers: refLayers ?? new Map() };
}

function verifyE2E(label, r, { expectedDataVersion } = {}) {
  const { result, palette, packed, size, totalBlocks, nbtBytes } = r;
  const errors = [];
  const check = (cond, msg) => { if (!cond) errors.push(msg); };

  // gzip 往返（浏览器生成的压缩流，这里验证解压）
  const gz = zlib.gzipSync(Buffer.from(nbtBytes));
  const gunzipped = zlib.gunzipSync(gz);
  check(Buffer.compare(Buffer.from(nbtBytes), gunzipped) === 0, 'gzip 往返不一致');

  // NBT 解码
  const nbt = new NbtReader(gunzipped).readRoot();
  const expDV = expectedDataVersion !== undefined ? expectedDataVersion : 4671;
  check(nbt.entries.MinecraftDataVersion === expDV, `DataVersion=${nbt.entries.MinecraftDataVersion} ≠ ${expDV}`);
  check(nbt.entries.Version === 6, `Version=${nbt.entries.Version} ≠ 6`);
  check(nbt.entries.SubVersion === 1, `SubVersion=${nbt.entries.SubVersion} ≠ 1`);
  check(nbt.entries.Metadata, '缺 Metadata');
  const meta = nbt.entries.Metadata;
  check(meta.TotalVolume === size.x * size.y * size.z, `TotalVolume=${meta.TotalVolume} ≠ ${size.x * size.y * size.z}`);
  check(meta.TotalBlocks === totalBlocks, `TotalBlocks=${meta.TotalBlocks} ≠ ${totalBlocks}`);
  check(meta.EnclosingSize.x === size.x && meta.EnclosingSize.y === size.y && meta.EnclosingSize.z === size.z,
    'EnclosingSize 与网格尺寸不一致');
  check(meta.RegionCount === 1, `RegionCount=${meta.RegionCount}`);
  const region = nbt.entries.Regions && nbt.entries.Regions.MusicBand;
  check(region, '缺 Region MusicBand');
  check(region.Size.x === size.x && region.Size.y === size.y && region.Size.z === size.z, 'Region Size 不一致');
  check(region.Position.x === 0 && region.Position.y === 0 && region.Position.z === 0, 'Position 非原点');
  check(Array.isArray(region.BlockStatePalette) && region.BlockStatePalette.length === palette.length,
    `palette 长度 ${region.BlockStatePalette?.length} ≠ ${palette.length}`);
  check(region.BlockStatePalette[0].Name === 'minecraft:air', 'palette[0] 不是 air');
  check(Array.isArray(region.BlockStates), '缺 BlockStates');
  check(region.BlockStates.length === packed.longs.length, `LongArray 长度 ${region.BlockStates.length} ≠ ${packed.longs.length}`);
  for (const listName of ['PendingBlockTicks', 'PendingFluidTicks', 'Entities']) {
    check(Array.isArray(region[listName]) && region[listName].length === 0, `${listName} 非空 List`);
  }
  // TileEntities：无参考声道时必须为空；有参考声道时应与 result.tileEntities 逐项一致
  // （NBT 解码后 i32 坐标/命令文本/自执行位；TE 所在格方块须与 te.state 一致、坐标为网格坐标含 zOffset）
  {
    const teInFile = region.TileEntities;
    const expTe = Array.isArray(teInFile) ? teInFile : null;
    if (!r.refLayers || r.refLayers.size === 0) {
      check(Array.isArray(expTe) && expTe.length === 0, `TileEntities 非空 List（无参考声道应为空）`);
    } else {
      const expTeList = result.tileEntities;
      check(Array.isArray(expTe) && expTe.length === expTeList.length,
        `TileEntities 数量 ${expTe && expTe.length} ≠ ${expTeList.length}`);
      if (Array.isArray(expTe) && expTe.length === expTeList.length) {
        // 按 (x,y,z) 建索引逐项比对
        const byPos = new Map();
        for (const te of expTe) byPos.set(`${te.x},${te.y},${te.z}`, te);
        let teBad = 0;
        for (const te of expTeList) {
          const got = byPos.get(`${te.x},${te.y},${te.z}`);
          if (!got) { teBad++; errors.push(`TE 缺失 @(${te.x},${te.y},${te.z})`); continue; }
          if (got.id !== te.id) { teBad++; errors.push(`TE ${te.x},${te.y},${te.z} id=${got.id} ≠ ${te.id}`); }
          if (got.Command !== te.Command) { teBad++; errors.push(`TE ${te.x},${te.y},${te.z} Command=${got.Command} ≠ ${te.Command}`); }
          if (got.auto !== (te.auto ? 1 : 0)) { teBad++; errors.push(`TE ${te.x},${te.y},${te.z} auto=${got.auto} ≠ ${te.auto ? 1 : 0}`); }
        }
        check(teBad === 0, `${teBad} 个 TileEntity 字段不一致`);
        // 所在格方块 = te.state（命令方块状态）
        let cellBad = 0;
        for (const te of expTeList) {
          const idx = te.y * size.x * size.z + te.z * size.x + te.x;
          const cellState = palette[result.grid.data[idx]];
          if (cellState !== te.state) { cellBad++; errors.push(`TE @(${te.x},${te.y},${te.z}) 所在格=${cellState} ≠ ${te.state}`); }
        }
        check(cellBad === 0, `${cellBad} 个 TileEntity 所在格方块不一致`);
      }
    }
  }

  // 位解包与网格逐格比对
  const bits = Math.max(2, Math.ceil(Math.log2(palette.length)));
  const decoded = decodePacked(region.BlockStates, bits, size.x * size.y * size.z);
  let firstDiff = -1;
  for (let i = 0; i < decoded.length; i++) {
    if (decoded[i] !== result.grid.data[i]) { firstDiff = i; break; }
  }
  check(firstDiff === -1,
    `位解包与网格不一致：首个差异 index=${firstDiff}（x=${firstDiff % size.x}, y=${Math.floor(firstDiff / (size.x * size.z))}, z=${Math.floor(firstDiff / size.x) % size.z}）`
    + ` grid=${result.grid.data[firstDiff]} decoded=${decoded[firstDiff]} bits=${bits}`);

  // 方块状态断言
  for (const state of palette) {
    if (state.startsWith('minecraft:note_block')) {
      const noteM = state.match(/note=(\d+)/);
      check(noteM && Number(noteM[1]) >= 0 && Number(noteM[1]) <= 24, `音符盒音高越界：${state}`);
      const instM = state.match(/instrument=([a-z_]+)/);
      check(instM && INSTRUMENT_NAMES.includes(instM[1]), `音符盒乐器非法：${state}`);
    }
  }

  // 取消小节标记后的底座不变式：
  //   1) 网格中不得出现蜂蜜块（小节标记已取消）
  //   2) 每个中继器正下方必须是雪块（中心线底座恒为雪块，与音色无关）
  const grid = result.grid;
  const gsx = grid.sx, gsy = grid.sy, gsz = grid.sz;
  let honeyBlocks = 0, badCenterBase = 0;
  for (let x = 0; x < gsx; x++) {
    for (let y = 0; y < gsy; y++) {
      for (let z = 0; z < gsz; z++) {
        const state = palette[grid.data[(y * gsz + z) * gsx + x]];
        if (state === 'minecraft:honey_block') honeyBlocks++;
        if (state && state.startsWith('minecraft:repeater') && y >= 1) {
          const below = palette[grid.data[((y - 1) * gsz + z) * gsx + x]];
          if (below !== 'minecraft:snow_block') badCenterBase++;
        }
      }
    }
  }
  check(honeyBlocks === 0, `网格中残留蜂蜜块 ${honeyBlocks} 个（小节标记应已取消）`);
  check(badCenterBase === 0, `${badCenterBase} 个中继器下方不是雪块（中心线底座应为雪块）`);

  // 每个音符盒下方必须是实体方块（雪块或音色方块）
  let badBase = 0;
  for (let x = 0; x < gsx; x++) {
    for (let y = 1; y < gsy; y++) {
      for (let z = 0; z < gsz; z++) {
        const state = palette[grid.data[(y * gsz + z) * gsx + x]];
        if (state && state.startsWith('minecraft:note_block')) {
          const below = palette[grid.data[((y - 1) * gsz + z) * gsx + x]];
          if (!below || below === 'minecraft:air' || below.startsWith('minecraft:redstone_wire') ||
              below.startsWith('minecraft:repeater')) badBase++;
        }
      }
    }
  }
  check(badBase === 0, `${badBase} 个音符盒下方不是实体底座`);

  // 音符盒上方必须空气
  let badTop = 0;
  for (let x = 0; x < gsx; x++) {
    for (let y = 0; y < gsy - 1; y++) {
      for (let z = 0; z < gsz; z++) {
        const state = palette[grid.data[(y * gsz + z) * gsx + x]];
        if (state && state.startsWith('minecraft:note_block')) {
          const above = palette[grid.data[((y + 1) * gsz + z) * gsx + x]];
          if (above && above !== 'minecraft:air') badTop++;
        }
      }
    }
  }
  check(badTop === 0, `${badTop} 个音符盒上方有方块（无法发声）`);

  // 中继器底座
  let badRep = 0;
  for (let x = 0; x < gsx; x++) {
    for (let y = 1; y < gsy; y++) {
      for (let z = 0; z < gsz; z++) {
        const state = palette[grid.data[(y * gsz + z) * gsx + x]];
        if (state && state.startsWith('minecraft:repeater')) {
          const below = palette[grid.data[((y - 1) * gsz + z) * gsx + x]];
          if (!below || below === 'minecraft:air') badRep++;
        }
      }
    }
  }
  check(badRep === 0, `${badRep} 个中继器下方无支撑`);

  // 中继器 delay ∈ [1,4]
  let badDelay = 0;
  for (const state of palette) {
    if (state.startsWith('minecraft:repeater')) {
      const m = state.match(/delay=(\d+)/);
      if (!m || Number(m[1]) < 1 || Number(m[1]) > 4) badDelay++;
    }
  }
  check(badDelay === 0, `${badDelay} 个中继器挡位非法`);

  // 中继器朝向：facing 是输入侧（wiki：from output side to input side，与放置时面向相反）。
  // 触发区（总线/tap/开关）已按用户要求从产物移除 → 产物中所有中继器都在主链/扩展格，信号流向 +X →
  //   必须 facing=west（输出朝 +X 指向下一段导体）。
  // 真实输入侧（facing 方向相邻格）必须是导体（中继器/音符盒/红石粉），否则断链；
  //   例外：链头（X=0 的中继器）输入侧是网格外沿——触发区由用户手动放置，留空属预期。
  const repDir = { east: [1, 0, 0], west: [-1, 0, 0], south: [0, 0, 1], north: [0, 0, -1] };
  const isConductor = (s) => !!(s && (s.startsWith('minecraft:repeater')
    || s.startsWith('minecraft:note_block') || s.startsWith('minecraft:redstone_wire')));
  const gGeo = result.geometry;
  const gXOff = gGeo.xOffset || 0; // 触发区移除后 xOffset 恒 0（geometry 不再提供该字段）
  const gYOff = gGeo.yOffset || 0; // 布局 Y/Z 负起点 → 网格整体平移（全非负起点时 y=0、z=1）
  const atL = (lx, ly, lz) => (lx + gXOff >= 0 && lx + gXOff < gsx
    && ly + gYOff >= 0 && ly + gYOff < gsy && lz + gGeo.zOffset >= 0 && lz + gGeo.zOffset < gsz)
    ? palette[grid.data[((ly + gYOff) * gsz + (lz + gGeo.zOffset)) * gsx + (lx + gXOff)]] : null;
  let badFacing = 0;
  const facingMsgs = [];
  for (let x = 0; x < gsx; x++) {
    for (let y = 0; y < gsy; y++) {
      for (let z = 0; z < gsz; z++) {
        const state = palette[grid.data[(y * gsz + z) * gsx + x]];
        if (!state || !state.startsWith('minecraft:repeater')) continue;
        const fm = state.match(/facing=(east|west|south|north)/);
        if (!fm) { badFacing++; facingMsgs.push(`(${x},${y},${z}) 缺 facing`); continue; }
        if (fm[1] !== 'west') {
          badFacing++;
          if (facingMsgs.length < 5) facingMsgs.push(`(${x},${y},${z}) facing=${fm[1]} 应为 west（主链）`);
          continue;
        }
        if (x === 0) continue; // 链头：输入侧留空（触发区由用户手动放置）
        const [dx, dy, dz] = repDir[fm[1]];
        const inX = x + dx, inY = y + dy, inZ = z + dz;
        const inS = (inX >= 0 && inX < gsx && inY >= 0 && inY < gsy && inZ >= 0 && inZ < gsz)
          ? palette[grid.data[(inY * gsz + inZ) * gsx + inX]] : null;
        if (!isConductor(inS)) {
          badFacing++;
          if (facingMsgs.length < 5) facingMsgs.push(`(${x},${y},${z}) ${fm[1]} 输入侧=${inS || '越界'}`);
        }
      }
    }
  }
  check(badFacing === 0, `${badFacing} 个中继器朝向/输入侧异常：${facingMsgs.join('；')}`);

  // 触发区已按用户要求从产物移除（总线/tap/启动开关由用户手动放置）：
  //   1) 全网格不得出现任何按钮/拉杆/压力板
  //   2) 每条链的链头必须是 X=0 的中继器（输入侧留空待用户接粉）
  let switchCount = 0;
  for (const state of palette) {
    if (/button|lever|pressure_plate/.test(state) && !state.startsWith('minecraft:note_block')) switchCount++;
  }
  check(switchCount === 0, `触发区已移除：产物中不应有启动开关，实际 ${switchCount} 个`);
  const heads = result.chains.filter(c => !c.isRefLane).map(c => atL(0, c.yb + 1, c.zc));
  check(heads.length > 0 && heads.every(s => s && s.startsWith('minecraft:repeater')),
    `链头应为 X=0 的中继器（输入侧留空待手动接粉），实际 ${heads.map(s => s || '空').join('、')}`);

  if (errors.length) {
    console.log(`FAIL ${label}:`);
    errors.forEach(e => console.log('   ✖ ' + e));
    return false;
  }
  console.log(`PASS ${label}: X=${size.x} Y=${size.y} Z=${size.z} blocks=${totalBlocks} palette=${palette.length} `
    + `chains=${result.chains.length} notesPlaced=${result.stats.notesPlaced} discarded=${result.stats.notesDiscarded}`);
  return true;
}

// 音高映射：note = key − 33（NBS Studio 官方红石导出公式），33 个锚点全覆盖
// key 33=F#3→0、45=F#4→12、57=F#5→24；越界 → -1（不可放置）
for (let k = 33; k <= 57; k++) {
  if (noteFromKey(k) !== k - 33) {
    console.log(`FAIL 音高映射 key=${k} → ${noteFromKey(k)} ≠ ${k - 33}`);
    ok = false;
    break;
  }
}
if (noteFromKey(57) === 24 && noteFromKey(33) === 0 && noteFromKey(45) === 12) {
  console.log('PASS 音高映射：key 33→note 0（F#3）、45→note 12（F#4）、57→note 24（F#5），33 锚点全对');
}
if (noteFromKey(32) !== -1 || noteFromKey(58) !== -1) {
  console.log(`FAIL 音高越界：key 32 → ${noteFromKey(32)}、key 58 → ${noteFromKey(58)}（应均为 -1）`);
  ok = false;
} else {
  console.log('PASS 音高越界：key 32 / 58 → -1（不可放置）');
}

// ---------- 运行 ----------
const INSTRUMENT_NAMES = [
  'harp', 'bass', 'basedrum', 'snare', 'hat', 'guitar', 'flute', 'bell',
  'chime', 'xylophone', 'iron_xylophone', 'cow_bell', 'didgeridoo',
  'bit', 'banjo', 'pling',
];

let ok = true;
try {
  const demo1 = runE2E('demo_song.nbs');
  ok = verifyE2E('Demo1 demo_song', demo1) && ok;
  // Demo1 已知统计断言
  const { song, result } = demo1;
  if (song.songLayers !== 27 || song.songLength !== 287) { console.log('FAIL Demo1 基础统计'); ok = false; }
  else console.log('PASS Demo1 解析统计: 27层 287tick');
  if (result.stats.notesPlaced !== 76) { console.log(`FAIL Demo1 音符放置 ${result.stats.notesPlaced} ≠ 76`); ok = false; }
  else console.log('PASS Demo1 音符全部放置: 76');
} catch (e) {
  console.log('FAIL Demo1 异常:', e.message);
  ok = false;
}

try {
  const demo2 = runE2E('canon in d major Loop.nbs');
  ok = verifyE2E('Demo2 canon', demo2) && ok;
  const { song, result } = demo2;
  if (song.songLayers !== 72 || song.songLength !== 831) { console.log('FAIL Demo2 基础统计'); ok = false; }
  if (result.stats.notesPlaced !== 2225) { console.log(`FAIL Demo2 音符放置 ${result.stats.notesPlaced} ≠ 2225`); ok = false; }
  else console.log('PASS Demo2 音符全部放置: 2225');
} catch (e) {
  console.log('FAIL Demo2 异常:', e.message);
  ok = false;
}

try {
  const v0 = runE2E('old_demo_song.nbs');
  ok = verifyE2E('v0 旧格式', v0) && ok;
} catch (e) {
  console.log('FAIL v0 异常:', e.message);
  ok = false;
}

// ---------- M3：多起点布局（多 Y 起点，触发区已移除） ----------
try {
  // 卡农 11 链，起点沿 Z 单行但部分链抬升到不同 Y
  const starts = [];
  for (let i = 0; i < 11; i++) starts.push({ dz: i * 3, dy: i % 3 === 1 ? 5 : (i % 3 === 2 ? 9 : 0) });
  const multi = runE2E('canon in d major Loop.nbs', { groupStarts: starts });
  ok = verifyE2E('M3 多Y起点布局（卡农）', multi) && ok;
  // 触发区（总线/tap/开关）已按用户要求从产物移除：各链头必须是 X=0 的中继器（输入侧留空待手动接粉）
  const { result } = multi;
  const paletteM3 = multi.palette;
  const gridM3 = result.grid;
  const gG = result.geometry;
  const gXOff = gG.xOffset || 0;
  const gYOff = gG.yOffset || 0; // 布局 Y 负起点 → 网格平移（全非负时 =0）
  const gZOff = gG.zOffset || 1;
  let badHead = 0;
  for (const c of result.chains) {
    const s = paletteM3[gridM3.data[((c.yb + 1 + gYOff) * gridM3.sz + (c.zc + gZOff)) * gridM3.sx + (0 + gXOff)]];
    if (!s || !s.startsWith('minecraft:repeater')) badHead++;
  }
  if (badHead > 0) { console.log(`FAIL M3 ${badHead} 条链头不是 X=0 中继器（触发区移除后链头即产物西边界）`); ok = false; }
  else console.log(`PASS M3 ${result.chains.length} 条链头均为 X=0 中继器（输入侧留空，用户手动接总线）`);
} catch (e) {
  console.log('FAIL M3 异常:', e.message);
  ok = false;
}

// ---------- M3b：负起点布局（车道起点支持负 Y/Z，网格整体平移保证非负） ----------
// zOffset = 1 − min(0,各链 zc)、yOffset = −min(0,各链 yb)：只在最小值确为负时平移，
//   全非负起点退化为旧值 1/0（产物与旧版一致，其余用例即回归保护）。
// 场景 A：轨道 0 {dz:-2,dy:-1} + 组 {dz:-5,dy:-2} → zOffset=6、yOffset=2
//   组链：zb 布局 0→网格 0、信号 1、z 网格 1；轨道 0：底座网格 1、信号 2、z 网格 4、顶层导轨网格 y=3
// 场景 B：轨道 0 dy=-2、组 dy=0 + snare（沙子音色底）→ 底座网格 y=2，托底雪块落在 y=1（负起点平移后仍有托底空间）
try {
  const nbsNeg = makeNbs({ tempoTps: 10, songLength: 4, noteSpecs: [
    { tick: 0, layer: 0, instrument: 3, key: 44 },   // snare=沙子音色底
    { tick: 2, layer: 0, instrument: 0, key: 46 },
  ]});
  const tmpNeg = 'synth_negstart.nbs';
  writeFileSync(path.join(__dirname, tmpNeg), nbsNeg);
  // --- 场景 A：两条链起点全负 ---
  const neg = runE2E(tmpNeg, {
    lane0: { dz: -2, dy: -1 },
    groups: [{ layers: [0] }],
    groupStarts: [{ dz: -5, dy: -2 }],
  });
  ok = verifyE2E('M3b-A 双负起点（lane0 dz=-2/dy=-1、组 dz=-5/dy=-2）', neg) && ok;
  const g = neg.result.geometry;
  const grid = neg.result.grid, pal = neg.palette;
  if (g.zOffset !== 6 || g.yOffset !== 2) { console.log(`FAIL M3b-A 偏移 zOffset=${g.zOffset} yOffset=${g.yOffset}（期望 6/2）`); ok = false; }
  else console.log('PASS M3b-A 偏移：zOffset=1−minZc=6、yOffset=−minYb=2（网格整体平移非负）');
  if (grid.sx !== 10 || grid.sy !== 4 || grid.sz !== 6) { console.log(`FAIL M3b-A 网格 ${grid.sx}×${grid.sy}×${grid.sz}（期望 10×4×6）`); ok = false; }
  else console.log('PASS M3b-A 网格 10×4×6（sy=maxYb+yOffset+3、sz=zMax+zOffset+2）');
  const cellN = (x, y, z) => pal[grid.data[(y * grid.sz + z) * grid.sx + x]];
  const headGroup = cellN(0, 1, 1), headRail = cellN(0, 2, 4);
  const noteA = cellN(1, 1, 1);
  if (!headGroup || !headGroup.startsWith('minecraft:repeater')) { console.log(`FAIL M3b-A 组链头 @网格(0,1,1)=${headGroup}`); ok = false; }
  if (!headRail || !headRail.startsWith('minecraft:repeater')) { console.log(`FAIL M3b-A 轨道0链头 @网格(0,2,4)=${headRail}`); ok = false; }
  if (!noteA || !noteA.startsWith('minecraft:note_block')) { console.log(`FAIL M3b-A 组音符盒 @网格(1,1,1)=${noteA}`); ok = false; }
  if (headGroup && headGroup.startsWith('minecraft:repeater') && headRail && headRail.startsWith('minecraft:repeater') && noteA && noteA.startsWith('minecraft:note_block'))
    console.log('PASS M3b-A 链头/音符盒均在平移后网格坐标（组 (0,1,1)/(1,1,1)、轨道 0 (0,2,4)）');
  // 轨道 0 顶层导轨：布局 yb+2=1 → 网格 y=3，布局 zc=-2 → 网格 z=4
  if (cellN(0, 3, 4) !== 'minecraft:snow_block') { console.log(`FAIL M3b-A 轨道0顶层导轨 @网格(0,3,4)=${cellN(0, 3, 4)}`); ok = false; }
  else console.log('PASS M3b-A 轨道 0 顶层导轨在平移后网格 (0,3,4)');
  // --- 场景 B：负 lane0 dy + 组 dy=0（沙子音色底在网格 y=2，托底空间保留） ---
  const negB = runE2E(tmpNeg, {
    lane0: { dz: -2, dy: -2 },
    groups: [{ layers: [0] }],
    groupStarts: [{ dz: -5, dy: 0 }],
  });
  ok = verifyE2E('M3b-B 负 lane0 dy=-2 + snare 托底', negB) && ok;
  const gB = negB.result.geometry, gridB = negB.result.grid, palB = negB.palette;
  if (gB.zOffset !== 6 || gB.yOffset !== 2) { console.log(`FAIL M3b-B 偏移 zOffset=${gB.zOffset} yOffset=${gB.yOffset}（期望 6/2）`); ok = false; }
  const cellB = (x, y, z) => palB[gridB.data[(y * gridB.sz + z) * gridB.sx + x]];
  const sandB = cellB(1, 2, 1), snowB = cellB(1, 1, 1), noteB = cellB(1, 3, 1);
  if (sandB !== 'minecraft:sand') { console.log(`FAIL M3b-B snare 音色底 @网格(1,2,1)=${sandB}`); ok = false; }
  if (snowB !== 'minecraft:snow_block') { console.log(`FAIL M3b-B 沙子托底雪块 @网格(1,1,1)=${snowB}`); ok = false; }
  if (!noteB || !noteB.startsWith('minecraft:note_block')) { console.log(`FAIL M3b-B 音符盒 @网格(1,3,1)=${noteB}`); ok = false; }
  if (sandB === 'minecraft:sand' && snowB === 'minecraft:snow_block' && noteB && noteB.startsWith('minecraft:note_block'))
    console.log('PASS M3b-B 负起点平移后托底空间保留：沙子 (1,2,1) 下补雪块 (1,1,1)、音符盒 (1,3,1)');
  // --- 场景 C：全非负退化（偏移回到旧值 1/0，产物与旧版一致） ---
  const negC = runE2E(tmpNeg, {
    lane0: { dz: 0, dy: 0 },
    groups: [{ layers: [0] }],
    groupStarts: [{ dz: 3, dy: 0 }],
  });
  const gC = negC.result.geometry;
  if (gC.zOffset !== 1 || gC.yOffset !== 0) { console.log(`FAIL M3b-C 全非负退化 zOffset=${gC.zOffset} yOffset=${gC.yOffset}（期望 1/0）`); ok = false; }
  else console.log('PASS M3b-C 全非负起点退化：zOffset=1、yOffset=0（产物与旧版一致）');
} catch (e) {
  console.log('FAIL M3b 异常:', e.stack || e.message);
  ok = false;
}

// ---------- M3：合成 NBS 文件测固定挡位 D=1 / D=8 扩展 ----------
function makeNbs({ version = 5, tempoTps = 20, layers = 1, songLength = 8, noteSpecs = [], timeSig = 4 }) {
  // noteSpecs: [{tick, layer, instrument, key}]
  const out = [];
  const u8 = v => out.push(v & 0xFF);
  const u16 = v => { out.push(v & 0xFF, (v >> 8) & 0xFF); };
  const u32 = v => { out.push(v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF); };
  const i16 = v => u16(v & 0xFFFF);
  const str = s => {
    const enc = Buffer.from(s, 'latin1'); // Node 无 cp1252 编码名，测试字符串为 ASCII 等价
    u32(enc.length);
    for (const b of enc) u8(b);
  };
  u16(0);            // 新格式标记
  u8(version);       // version
  u8(16);            // default_instruments
  u16(songLength);   // song_length (v3+)
  u16(layers);       // song_layers
  str('synth'); str(''); str(''); str(''); // 4 字符串
  u16(Math.round(tempoTps * 100)); // tempo
  u8(0); u8(1); u8(timeSig);         // autosave, duration, timesig (默认 4/4；L5 用 3)
  u32(0); u32(0); u32(0); u32(0); u32(0); // 统计
  str('');           // origin
  u8(0); u8(0); u16(0); // loop 字段 (v4+)
  // notes：按 tick 分组
  const byTick = new Map();
  for (const n of noteSpecs) {
    if (!byTick.has(n.tick)) byTick.set(n.tick, []);
    byTick.get(n.tick).push(n);
  }
  const ticks = [...byTick.keys()].sort((a, b) => a - b);
  let prevTick = -1; // 增量基准 -1（首轮 delta = tick + 1）
  for (const t of ticks) {
    u16(t - prevTick);
    prevTick = t;
    const ns = byTick.get(t).sort((a, b) => a.layer - b.layer);
    let prevLayer = -1;
    for (const n of ns) {
      u16(n.layer - prevLayer);
      prevLayer = n.layer;
      u8(n.instrument); u8(n.key);
      u8(100); u8(100); i16(0); // velocity, panning+100, pitch (v4+)
    }
    u16(0);
  }
  u16(0);
  // layers 元数据
  for (let i = 0; i < layers; i++) { str('L' + i); u8(0); u8(100); u8(100); }
  u8(0); // custom instruments count
  return Buffer.from(out);
}

// 主链 1 档中继器：任何 tempo 均为 1 档（R=2×tempo 校正速度）
{
  const nbs = makeNbs({ tempoTps: 20, songLength: 8, noteSpecs: [
    { tick: 0, layer: 0, instrument: 0, key: 45 },
    { tick: 1, layer: 0, instrument: 1, key: 40 },
    { tick: 3, layer: 0, instrument: 0, key: 42 },
    { tick: 4, layer: 0, instrument: 0, key: 48 },
  ]});
  const tmpFile = 'synth_d1.nbs';
  writeFileSync(path.join(__dirname, tmpFile), nbs);
  try {
    const d1 = runE2E(tmpFile);
    ok = verifyE2E('M3 主链 1 档中继器（20tps）', d1) && ok;
    // tickCount = max(songLength=8, maxTick=4)+1 = 9；每段 2 格 → X = 18
    if (d1.result.geometry.xMax !== 18) { console.log(`FAIL M3 X 跨度 ${d1.result.geometry.xMax} ≠ 18`); ok = false; }
    else console.log('PASS M3 X 跨度 18（每段 2 格）');
    if (d1.result.stats.notesPlaced !== 4) { console.log(`FAIL M3 音符 ${d1.result.stats.notesPlaced} ≠ 4`); ok = false; }
    else console.log('PASS M3 音符全部放置');
    // 恒 1 档：任何 tempo 延迟均为 1，R = 2×tempo
    const delays = computeDelays(20, 9);
    if (!delays.every(d => d === 1)) { console.log('FAIL M3 延迟非恒定 1', delays.join(',')); ok = false; }
    else console.log('PASS M3 tempo=20 延迟全为 1（恒 1 档）');
    const plan20 = context.playbackPlan(20);
    if (!(plan20.delay === 1 && Math.abs(plan20.tickRate - 40) < 1e-9)) {
      console.log(`FAIL M3 playbackPlan(20) D=${plan20.delay} R=${plan20.tickRate}（期望 1/40）`); ok = false;
    } else console.log('PASS M3 playbackPlan(20) → D=1、R=40（R=2×tempo）');
  } catch (e) {
    console.log('FAIL M3 主链1档 异常:', e.message);
    ok = false;
  }
}

// 无扩展格：主链恒 1 档中继器，任何 tempo 每段恒 2 格（原「d=8 扩展格」用例已废弃——扩展逻辑保留于代码但不再触发）
{
  const nbs = makeNbs({ tempoTps: 2.5, songLength: 4, noteSpecs: [
    { tick: 0, layer: 0, instrument: 1, key: 40 },
    { tick: 2, layer: 0, instrument: 1, key: 42 },
  ]});
  const tmpFile = 'synth_lowtempo.nbs';
  writeFileSync(path.join(__dirname, tmpFile), nbs);
  try {
    const ext = runE2E(tmpFile);
    ok = verifyE2E('M3 慢 tempo 恒 1 档（2.5tps）', ext) && ok;
    // tickCount = max(songLength=4, maxTick=2)+1 = 5；每段 2 格 → X = 10
    if (ext.result.geometry.xMax !== 10) { console.log(`FAIL M3 慢tempo X 跨度 ${ext.result.geometry.xMax} ≠ 10（恒 1 档应无扩展格）`); ok = false; }
    else console.log('PASS M3 慢 tempo 每段 2 格、无扩展格（X 跨度 10）');
    const plan25 = context.playbackPlan(2.5);
    if (!(plan25.delay === 1 && Math.abs(plan25.tickRate - 5) < 1e-9)) {
      console.log(`FAIL M3 playbackPlan(2.5) D=${plan25.delay} R=${plan25.tickRate}（期望 1/5）`); ok = false;
    } else console.log('PASS M3 playbackPlan(2.5) → D=1、R=5（慢速靠 /tick rate 5，非扩展格）');
  } catch (e) {
    console.log('FAIL M3 慢tempo 异常:', e.message);
    ok = false;
  }
}

// 重复音轨 = 双倍音量：同一音轨在一车道出现两次 → 同 tick 音符放两个位（主位 + 第2位）齐响
{
  const nbs = makeNbs({ tempoTps: 10, songLength: 4, noteSpecs: [
    { tick: 0, layer: 0, instrument: 0, key: 45 },
    { tick: 2, layer: 0, instrument: 1, key: 48 },
  ]});
  const tmpFile = 'synth_dup.nbs';
  writeFileSync(path.join(__dirname, tmpFile), nbs);
  try {
    const dup = runE2E(tmpFile, { groups: [{ layers: [0, 0] }] });
    ok = verifyE2E('M3 重复音轨（双倍音量）', dup) && ok;
    // 2 个音符 × 2 个位（主位 zc + 第2位 zc+1）= 4 个音符盒
    if (dup.result.stats.notesPlaced !== 4) { console.log(`FAIL M3 重复音轨放置 ${dup.result.stats.notesPlaced} ≠ 4`); ok = false; }
    else console.log('PASS M3 重复音轨：2 音符 × 2 位 = 4 个音符盒（双倍音量）');
    if (dup.result.stats.noteBlocks !== 4) { console.log(`FAIL M3 重复音轨音符盒 ${dup.result.stats.noteBlocks} ≠ 4`); ok = false; }
    else console.log('PASS M3 重复音轨音符盒数 4');
  } catch (e) {
    console.log('FAIL M3 重复音轨异常:', e.message);
    ok = false;
  }
}

// bit 乐器（instrument 13）：音色底为绿宝石块（emerald_block，已恢复）
{
  const nbs = makeNbs({ tempoTps: 10, songLength: 4, noteSpecs: [
    { tick: 0, layer: 0, instrument: 13, key: 50 },
    { tick: 2, layer: 0, instrument: 13, key: 52 },
  ]});
  const tmpFile = 'synth_bit.nbs';
  writeFileSync(path.join(__dirname, tmpFile), nbs);
  try {
    const bit = runE2E(tmpFile);
    ok = verifyE2E('M3 bit 音色底为绿宝石块', bit) && ok;
    // bit 音符盒下方底座必须全为绿宝石块（bit 是唯一乐器）
    const grid = bit.result.grid, pal = bit.palette;
    let emeraldBase = 0, nonEmeraldBase = 0;
    for (let x = 0; x < grid.sx; x++) for (let y = 1; y < grid.sy; y++) for (let z = 0; z < grid.sz; z++) {
      const s = pal[grid.data[(y * grid.sz + z) * grid.sx + x]];
      if (s && s.startsWith('minecraft:note_block')) {
        const below = pal[grid.data[((y - 1) * grid.sz + z) * grid.sx + x]];
        if (below === 'minecraft:emerald_block') emeraldBase++;
        else nonEmeraldBase++;
      }
    }
    if (emeraldBase !== 2 || nonEmeraldBase !== 0) { console.log(`FAIL M3 bit 底座绿宝石 ${emeraldBase}/2，非绿宝石 ${nonEmeraldBase}`); ok = false; }
    else console.log('PASS M3 bit 音符盒下方底座全为绿宝石块（2 个）');
  } catch (e) {
    console.log('FAIL M3 bit 异常:', e.message);
    ok = false;
  }
}

// snare 防掉落托底：音色底为沙子（重力方块）→ 正下方自动补雪块托住
{
  const nbs = makeNbs({ tempoTps: 10, songLength: 4, noteSpecs: [
    { tick: 0, layer: 0, instrument: 3, key: 44 },
    { tick: 2, layer: 0, instrument: 3, key: 46 },
  ]});
  const tmpFile = 'synth_snare.nbs';
  writeFileSync(path.join(__dirname, tmpFile), nbs);
  try {
    const sn = runE2E(tmpFile, { groupStarts: [{ dz: 0, dy: 2 }] }); // 抬升 dy=2 → 底座 y=2，有托底空间
    ok = verifyE2E('M3 snare 沙子托底', sn) && ok;
    const grid = sn.result.grid, pal = sn.palette;
    let sandOnSnow = 0, sandFloating = 0;
    for (let x = 0; x < grid.sx; x++) for (let y = 1; y < grid.sy; y++) for (let z = 0; z < grid.sz; z++) {
      const s = pal[grid.data[(y * grid.sz + z) * grid.sx + x]];
      if (s !== 'minecraft:sand') continue;
      const below = pal[grid.data[((y - 1) * grid.sz + z) * grid.sx + x]];
      if (below === 'minecraft:snow_block') sandOnSnow++;
      else sandFloating++;
    }
    if (sandOnSnow !== 2 || sandFloating !== 0) {
      console.log(`FAIL M3 snare 托底：沙子 ${sandOnSnow}/2 个下方为雪块，悬空 ${sandFloating}`); ok = false;
    } else console.log('PASS M3 snare 音色底沙子正下方全为雪块托底（2 个）');
  } catch (e) {
    console.log('FAIL M3 snare 异常:', e.message);
    ok = false;
  }
}

// 音高越界（key<33 / >57）：该音跳过、主位红石粉代位保通路、计数进 notesDiscarded
{
  const nbs = makeNbs({ tempoTps: 10, songLength: 6, noteSpecs: [
    { tick: 0, layer: 0, instrument: 0, key: 30 }, // < 33 → 跳过（红石粉代位）
    { tick: 2, layer: 0, instrument: 0, key: 59 }, // > 57 → 跳过（红石粉代位）
    { tick: 4, layer: 0, instrument: 0, key: 45 }, // 范围内 → 正常放置
  ]});
  const tmpFile = 'synth_oob.nbs';
  writeFileSync(path.join(__dirname, tmpFile), nbs);
  try {
    const oob = runE2E(tmpFile);
    ok = verifyE2E('M3 音高越界（key 30/59/45）', oob) && ok;
    if (oob.result.stats.notesPlaced !== 1) { console.log(`FAIL M3 越界 notesPlaced ${oob.result.stats.notesPlaced} ≠ 1`); ok = false; }
    else console.log('PASS M3 越界：仅 key 45 放置（1 个音符盒）');
    if (oob.result.stats.notesDiscarded !== 2) { console.log(`FAIL M3 越界 notesDiscarded ${oob.result.stats.notesDiscarded} ≠ 2`); ok = false; }
    else console.log('PASS M3 越界：key 30/59 各计 1 次丢弃');
    if (oob.result.stats.discardedDetails.filter(d => d.includes('音域')).length !== 2) {
      console.log(`FAIL M3 越界明细 ${JSON.stringify(oob.result.stats.discardedDetails)}`); ok = false;
    } else console.log('PASS M3 越界明细含音域原因 ×2');
    // 被跳过的 2 个 tick 主位（tick 0 → X=1、tick 2 → X=5）必须是红石粉（导电路径未断）
    const { grid, palette } = { grid: oob.result.grid, palette: oob.palette };
    const g = oob.result.geometry;
    const gXOff = g.xOffset || 0; // 触发区移除后 xOffset 恒 0
    const gYOff = g.yOffset || 0; // 布局 Y 负起点 → 网格平移（全非负时 =0）
    const atL = (lx, y, lz) => (lx + gXOff >= 0 && lx + gXOff < grid.sx
      && y + gYOff >= 0 && y + gYOff < grid.sy && lz + g.zOffset >= 0 && lz + g.zOffset < grid.sz)
      ? palette[grid.data[((y + gYOff) * grid.sz + (lz + g.zOffset)) * grid.sx + (lx + gXOff)]] : null;
    // 单链 yb=0 → ySig=1；zc=3（runE2E 默认起点 i*3+3，为轨道 0 让位）
    const w0 = atL(1, 1, 3), w2 = atL(5, 1, 3), w4 = atL(9, 1, 3);
    if (w0 !== 'minecraft:redstone_wire' || w2 !== 'minecraft:redstone_wire'
      || !(w4 && w4.startsWith('minecraft:note_block'))) {
      console.log(`FAIL M3 越界代位：tick0=${w0} tick2=${w2} tick4=${w4}`); ok = false;
    } else {
      const nm = String(w4).match(/note=(\d+)/);
      if (!nm || Number(nm[1]) !== 12) { console.log(`FAIL M3 key45 应为 note=12，实际 ${w4}`); ok = false; }
      else console.log('PASS M3 越界代位：跳过 tick 红石粉保通路，key 45 → note=12');
    }
  } catch (e) {
    console.log('FAIL M3 越界异常:', e.stack || e.message);
    ok = false;
  }
}

// Demo3：WFXLC.nbs — 简并建议 + 无冲突打包 + 端到端（tempo 8.52 → 挡位 2，/tick rate 17.04）
{
  try {
    const song = parseNBS(new Uint8Array(readFileSync(path.join(__dirname, 'WFXLC.nbs'))));
    const pool = [];
    song.layers.forEach((l, i) => { if (l.notes.size > 0) pool.push(i); });
    // 简并建议断言
    const sug = mergeSuggestions(song, pool);
    const piano = sug.find(s => s.text.includes('Piano 1'));
    const main = sug.find(s => s.text.includes('Main'));
    if (!piano || !piano.text.includes('合并为 2 条车道')) { console.log(`FAIL M3 简并建议 Piano 组: ${piano && piano.text}`); ok = false; }
    else console.log('PASS M3 简并建议：Piano 1 ×7 → 建议合并为 2 条车道');
    if (!main || !main.text.includes('#0/#1')) { console.log(`FAIL M3 简并建议 Main 组: ${main && main.text}`); ok = false; }
    else console.log('PASS M3 简并建议：Main/Main2 相似名归组（#0/#1 放同一车道）');
    // 车道冲突分析断言：Piano 全并一条 → 丢弃 102（>3 位被丢弃）
    const pianoAll = laneConflictStats(song, [2, 6, 7, 8, 9, 10, 11]);
    if (pianoAll.discarded !== 102) { console.log(`FAIL M3 Piano 全并丢弃 ${pianoAll.discarded} ≠ 102`); ok = false; }
    else console.log('PASS M3 车道冲突分析：Piano ×7 全并一条 → 丢弃 102');
    // 无冲突打包断言
    const packed = packLanesNoConflict(song, pool);
    let packDiscard = 0;
    for (const tr of packed) packDiscard += laneConflictStats(song, tr).discarded;
    if (packed.length !== 5 || packDiscard !== 0) { console.log(`FAIL M3 打包 ${packed.length} 车道 丢弃 ${packDiscard}（期望 5 车道 0 丢弃）`); ok = false; }
    else console.log('PASS M3 无冲突打包：15 音轨 → 5 车道 0 丢弃');
    // 名称重复优先（用户要求）：Main 相似名组聚同车道、Piano 1 组尽量聚拢（超容量才分 2 车道）
    const pianoIdx = pool.filter(i => (song.layers[i].name || '').toLowerCase().includes('piano'));
    const pianoLanes = new Set();
    packed.forEach((tr, li) => { if (tr.some(i => pianoIdx.includes(i))) pianoLanes.add(li); });
    if (packed.some(tr => tr.includes(0) && tr.includes(1)) && pianoLanes.size === 2)
      console.log('PASS M3 打包名称重复优先：Main/Main2 聚同车道、Piano 1 ×7 分 2 车道');
    else { console.log(`FAIL M3 打包名称聚集：Main 同车道=${packed.some(tr => tr.includes(0) && tr.includes(1))} Piano 车道数=${pianoLanes.size}`); ok = false; }
    // 端到端：用打包方案生成并验证（0 丢弃、1126 音符全放置）
    const r = runE2E('WFXLC.nbs', { groups: packed.map(t => ({ layers: t })) });
    ok = verifyE2E('M3 Demo3 WFXLC（打包方案）', r) && ok;
    if (r.result.stats.notesDiscarded !== 0) { console.log(`FAIL M3 WFXLC 丢弃 ${r.result.stats.notesDiscarded} ≠ 0`); ok = false; }
    else console.log('PASS M3 WFXLC 生成 0 丢弃');
    if (r.result.stats.notesPlaced !== 1126) { console.log(`FAIL M3 WFXLC 放置 ${r.result.stats.notesPlaced} ≠ 1126`); ok = false; }
    else console.log('PASS M3 WFXLC 全部 1126 音符放置');
  } catch (e) {
    console.log('FAIL M3 WFXLC 异常:', e.message);
    ok = false;
  }
}

// ---------- M4：目标 Litematica 版本矩阵（10 个目标各生成一次 → 完整解析 + 内容一致性） ----------
{
  // 合成小歌：固定 tickCount=9、延迟恒定，跨目标内容完全可比
  const nbs = makeNbs({ tempoTps: 20, songLength: 8, noteSpecs: [
    { tick: 0, layer: 0, instrument: 0, key: 45 },
    { tick: 1, layer: 0, instrument: 1, key: 40 },
    { tick: 3, layer: 0, instrument: 0, key: 42 },
    { tick: 4, layer: 0, instrument: 0, key: 48 },
  ]});
  const tmpFile = 'synth_targets.nbs';
  writeFileSync(path.join(__dirname, tmpFile), nbs);
  try {
    const perTarget = [];
    for (const t of TARGET_VERSIONS) {
      const r = runE2E(tmpFile, { targetMc: t.mc });
      if (!verifyE2E(`M4 目标 ${t.mc}（DV ${t.dataVersion}）`, r, { expectedDataVersion: t.dataVersion })) ok = false;
      perTarget.push({ t, r });
    }
    // 内容一致性：10 个目标的 NBT 字节流，仅 MinecraftDataVersion 的 i32 值字节
    // （偏移 26..29：根头 0A+空名 3B + 条目头 0x03 + 名字 22B = 26）允许不同，
    // 其余字节必须逐位一致（nowMs=0n 保证 TimeCreated/TimeModified 恒定）
    const base = perTarget[0];
    for (let i = 1; i < perTarget.length; i++) {
      const a = base.r.nbtBytes, b = perTarget[i].r.nbtBytes;
      const same = a.length === b.length
        && Buffer.compare(Buffer.from(a.subarray(0, 26)), Buffer.from(b.subarray(0, 26))) === 0
        && Buffer.compare(Buffer.from(a.subarray(30)), Buffer.from(b.subarray(30))) === 0;
      if (!same) { console.log(`FAIL M4 目标 ${perTarget[i].t.mc} 与 ${base.t.mc} 的 NBT 内容不一致（应仅 DataVersion 4 字节不同）`); ok = false; }
    }
    if (ok) console.log('PASS M4 10 目标矩阵：各目标 DataVersion 正确、结构与方块内容逐位一致（仅版本头 4 字节不同）');
    // 默认目标回退：未知 mc 字符串应回退 1.21.11
    const fb = targetEntry('nonexistent-mc');
    if (!fb || fb.mc !== DEFAULT_TARGET_MC) { console.log(`FAIL M4 未知目标回退：${fb && fb.mc}`); ok = false; }
    else console.log('PASS M4 未知目标回退默认 1.21.11');
  } catch (e) {
    console.log('FAIL M4 异常:', e.message);
    ok = false;
  }
}

// ---------- V：产物自检（verifyLitematic 全量比对 + 性能 + 三种破坏用例） ----------
try {
  const { verifyLitematic } = context.window.__NBS2SCHEMATIC;
  const vDemo = runE2E('demo_song.nbs');
  const opts = () => ({
    grid: vDemo.result.grid, palette: vDemo.palette, size: vDemo.size,
    totalBlocks: vDemo.totalBlocks, dataVersion: vDemo.target.dataVersion, packed: vDemo.packed,
  });
  const t0 = performance.now();
  const v1 = verifyLitematic(vDemo.nbtBytes, opts());
  const ms = performance.now() - t0;
  if (!v1.ok) { console.log(`FAIL V 自检未通过：${v1.message}`); ok = false; }
  else if (ms >= 200) { console.log(`FAIL V 自检耗时 ${ms.toFixed(1)}ms ≥ 200ms`); ok = false; }
  else console.log(`PASS V 自检 ok:true（demo_song，全量逐格比对，${ms.toFixed(1)}ms < 200ms）`);
  // 破坏1：篡改 DataVersion 头（固定偏移 26..29 的 i32）→ 版本断言失败
  const bad1 = vDemo.nbtBytes.slice();
  new DataView(bad1.buffer, bad1.byteOffset, bad1.byteLength).setInt32(26, 1, false);
  const v1b = verifyLitematic(bad1, opts());
  if (v1b.ok || !/DataVersion/.test(v1b.message)) { console.log(`FAIL V 破坏1（DV 篡改）未捕获：${JSON.stringify(v1b)}`); ok = false; }
  else console.log(`PASS V 破坏1：DV 篡改被捕获（${v1b.message}）`);
  // 破坏2：截断字节流 → NBT 解码失败
  const bad2 = vDemo.nbtBytes.slice(0, Math.floor(vDemo.nbtBytes.length * 0.6));
  const v2b = verifyLitematic(bad2, opts());
  if (v2b.ok || !/解码失败/.test(v2b.message)) { console.log(`FAIL V 破坏2（截断）未捕获：${JSON.stringify(v2b)}`); ok = false; }
  else console.log(`PASS V 破坏2：截断流解码失败被捕获（${v2b.message.slice(0, 60)}…）`);
  // 破坏3：网格与文件不一致 → 报出首个不一致坐标
  const saved = vDemo.result.grid.data[5];
  vDemo.result.grid.data[5] = saved === 0 ? 1 : 0;
  const v3b = verifyLitematic(vDemo.nbtBytes, opts());
  vDemo.result.grid.data[5] = saved;
  if (v3b.ok || !/坐标 \(5,0,0\)/.test(v3b.message)) { console.log(`FAIL V 破坏3（方块不一致）未报坐标：${JSON.stringify(v3b)}`); ok = false; }
  else console.log(`PASS V 破坏3：方块不一致报出坐标（${v3b.message}）`);
} catch (e) {
  console.log('FAIL V 异常:', e.message);
  ok = false;
}

// ---------- D1：错误期诊断（截断文件 → 字节偏移 + partial 统计 + 诊断 JSON 渲染） ----------
try {
  const full = new Uint8Array(readFileSync(path.join(__dirname, 'demo_song.nbs')));
  const cut = full.subarray(0, Math.floor(full.length * 0.6));
  let thrown = null;
  try { parseNBS(cut); } catch (e) { thrown = e; }
  if (!thrown || thrown.name !== 'ParseError') { console.log('FAIL D1 截断文件未抛 ParseError'); ok = false; }
  else if (typeof thrown.offset !== 'number' || thrown.offset < 0 || thrown.offset >= cut.length) {
    console.log(`FAIL D1 错误字节偏移缺失/越界（offset=${thrown.offset}）`); ok = false;
  } else if (!thrown.partial || thrown.partial.layers !== 27 || thrown.partial.notes >= 76
    || thrown.partial.bytesTotal !== cut.length) {
    console.log(`FAIL D1 partial 统计缺失或错误（${JSON.stringify(thrown.partial)}）`); ok = false;
  } else {
    console.log(`PASS D1 截断文件 ParseError 带 offset=${thrown.offset}/${cut.length}、partial=${JSON.stringify(thrown.partial)}`);
    // showError 扩签：错误框追加偏移/partial 文本 + 诊断 JSON 容器
    context.showError(thrown.message, thrown);
    const errText = elements.get('errors').textContent;
    const diagBox = elements.get('error-diag');
    if (!errText.includes(`字节偏移 ${thrown.offset}/${cut.length}`)) {
      console.log(`FAIL D1 错误框未含偏移文本（"${errText}"）`); ok = false;
    } else if (!errText.includes('已解析部分')) {
      console.log('FAIL D1 错误框未含 partial 摘要'); ok = false;
    } else if (typeof diagBox.innerHTML !== 'string' || diagBox.innerHTML === undefined) {
      console.log('FAIL D1 诊断容器不可访问'); ok = false;
    } else {
      console.log(`PASS D1 showError 渲染偏移+partial 摘要（诊断容器就绪）`);
    }
    context.clearError();
    if (elements.get('errors').textContent !== '' || elements.get('error-diag').innerHTML !== '') {
      console.log('FAIL D1 clearError 未清空错误框/诊断容器'); ok = false;
    } else {
      console.log('PASS D1 clearError 清空错误框与诊断容器');
    }
  }
} catch (e) {
  console.log('FAIL D1 异常:', e.message);
  ok = false;
}

// 默认轨道 0：顶层雪块导轨 + 每 32 格赭黄蛙灯（命令方块预留）
{
  // 40 tick → xMax=80 → 蛙灯落在 X=32,64（共 2 个）
  const nbs = makeNbs({ tempoTps: 10, songLength: 40, noteSpecs: [
    { tick: 0, layer: 0, instrument: 0, key: 45 },
    { tick: 10, layer: 0, instrument: 1, key: 47 },
  ]});
  const tmpFile = 'synth_lane0.nbs';
  writeFileSync(path.join(__dirname, tmpFile), nbs);
  try {
    // 音轨车道在 dz=3（syncLaneStarts 默认 +3），轨道 0 在 dz=0 → 不重叠
    const r = runE2E(tmpFile, { lane0: { dz: 0, dy: 0 } });
    ok = verifyE2E('默认轨道 0（雪块导轨 + 每 32 格蛙灯）', r) && ok;
    const { result } = r;
    const grid = result.grid, palette = r.palette;
    const g = result.geometry;
    const dr = g.defaultRail;
    if (!dr || dr.zc !== 0 || dr.yb !== 0) { console.log(`FAIL 轨道0 geometry.defaultRail=${JSON.stringify(dr)}`); ok = false; }
    else console.log(`PASS 轨道0 几何：zc=${dr.zc} yb=${dr.yb}（顶层导轨 y=${dr.yb + 2}）`);
    // 扫描顶层导轨层 y=yb+2：x=0..xMax-1 应全为雪块，除 X=32,64 为赭黄蛙灯
    const yRail = dr.yb + 2 + (g.yOffset || 0), zc = dr.zc + g.zOffset, gXOff = g.xOffset || 0;
    let snow = 0, frog = 0, other = 0; const frogX = [];
    for (let x = 0; x < g.xMax; x++) {
      const s = palette[grid.data[(yRail * grid.sz + zc) * grid.sx + (x + gXOff)]];
      if (s === 'minecraft:snow_block') snow++;
      else if (s === 'minecraft:ochre_froglight') { frog++; frogX.push(x); }
      else other++;
    }
    if (frog !== 2 || frogX.join(',') !== '32,64' || other !== 0) {
      console.log(`FAIL 轨道0 顶层：蛙灯 ${frog} 个 @${frogX.join(',')}，其他 ${other}，雪块 ${snow}（期望蛙灯 2 个 @32,64）`); ok = false;
    } else {
      console.log(`PASS 轨道0 顶层每 32 格 1 蛙灯（X=${frogX.join(',')}），其余 ${snow} 格雪块、无杂块`);
    }
    // 顶层导轨下方（y=yb+1，轨道 0 信号层）必须是导体（中继器/红石粉），证明轨道 0 是真实链
    let conductor = 0;
    for (let x = 0; x < g.xMax; x += 4) {
      const s = palette[grid.data[((dr.yb + 1) * grid.sz + zc) * grid.sx + (x + gXOff)]];
      if (s && (s.startsWith('minecraft:repeater') || s.startsWith('minecraft:redstone_wire'))) conductor++;
    }
    if (conductor === 0) { console.log('FAIL 轨道0 信号层无导体（应为真实中继器链）'); ok = false; }
    else console.log(`PASS 轨道0 信号层含 ${conductor} 个导体格（真实中继器链）`);
    // 无音轨车道（lanes=[]）也可生成：仅轨道 0 链（触发区由用户手动放置）
    const rEmpty = runE2E(tmpFile, { groups: [], lane0: { dz: 0, dy: 0 } });
    if (rEmpty.result.chains.length !== 1 || rEmpty.result.stats.noteBlocks !== 0) {
      console.log(`FAIL 空车道池生成：chains=${rEmpty.result.chains.length} noteBlocks=${rEmpty.result.stats.noteBlocks}（期望 1 链 0 音符盒）`); ok = false;
    } else console.log('PASS 空车道池可生成（仅轨道 0 链，0 音符盒）');
  } catch (e) {
    console.log('FAIL 默认轨道 0 异常:', e.message);
    ok = false;
  }
}

// ---------- SFX：节奏参考声道双类型（统一轨道 0 CB + nbs2sfx 数据包 zip，偏移构建时求解） ----------
// 混合场景（4 层，refLanes 未传 = 旧模式）：layer 0 单线式（锚定音轨车道盒）、layer 1 MIDI式静音（不进车道池）、
//   layer 2 MIDI式发声、layer 3 普通 —— 三层同组 [0,1,2]（1 车道 dz=3,dy=0）+ layer 3 单独组 [3]（dz=6）
{
  const { SFX_NAMESPACE, SFX_PARTICLE_CMD, SFX_CB_STATE, buildSfxPackMcmeta,
    buildSfxFunctions, buildZip, zipCrc32, buildSfxDatapackZip, sfxParticleCmd } = context.window.__NBS2SCHEMATIC;
  // tick 0/2/4 三层同刻（绑定+独立×2）、tick 6 仅 layer 0（绑定）
  const nbs = makeNbs({ tempoTps: 20, songLength: 8, layers: 4, noteSpecs: [
    { tick: 0, layer: 0, instrument: 0, key: 45 },
    { tick: 0, layer: 1, instrument: 1, key: 44 },
    { tick: 0, layer: 2, instrument: 2, key: 43 },
    { tick: 0, layer: 3, instrument: 3, key: 57 },
    { tick: 2, layer: 0, instrument: 0, key: 47 },
    { tick: 2, layer: 1, instrument: 1, key: 46 },
    { tick: 2, layer: 2, instrument: 2, key: 45 },
    { tick: 4, layer: 0, instrument: 0, key: 50 },
    { tick: 4, layer: 1, instrument: 1, key: 49 },
    { tick: 4, layer: 2, instrument: 2, key: 48 },
    { tick: 6, layer: 0, instrument: 0, key: 52 },
  ]});
  const tmpFile = 'synth_sfx.nbs';
  writeFileSync(path.join(__dirname, tmpFile), nbs);
  const ref = new Map([
    [0, { type: 'bound', sound: true }],       // 单线式（旧模式：锚定音轨车道盒）
    [1, { type: 'independent', sound: false }], // MIDI式静音：不进车道池、只贡献粒子时序
    [2, { type: 'independent', sound: true }],  // MIDI式发声：进车道池
  ]);
  // 期望行（布局：轨道 0 dz=0/dy=0；组1 dz=3/dy=0；组2 dz=6/dy=0；zOffset=1）：
  //   绑定行 = 音符盒坐标 − 轨道 0 CB 坐标（仅单线式层产）：本场景只有 layer 0 绑定 → 恒 P0→(0,1,3)
  //   独立行 = (0, 0, (clamp(note,0,24)−12)×step)，note=key−33：layer 1/2 逐音符（声部升序，layer 1 在前）
  const P0 = sfxParticleCmd(0, 1, 3);
  const I = k => sfxParticleCmd(0, 0, (Math.max(0, Math.min(24, k - 33)) - 12));
  try {
    // buildLayout：轨道 0 在 dz=0，tick t 段长 2 格 → CB 在 X=2t+1, Y=yb, 网格 Z=1
    const r = runE2E(tmpFile, {
      lane0: { dz: 0, dy: 0 }, refLayers: ref,
      groups: [{ layers: [0, 1, 2] }, { layers: [3] }],
      groupStarts: [{ dz: 3, dy: 0 }, { dz: 6, dy: 0 }],
    });
    ok = verifyE2E('SFX 双类型参考声道（CB+TE 逐 tick）', r) && ok;
    const { result } = r;
    const grid = result.grid, palette = r.palette;
    const g = result.geometry;
    const zcGrid = 0 + g.zOffset; // TE/网格坐标含 zOffset
    const expCbs = [{ x: 1, tick: 0 }, { x: 5, tick: 2 }, { x: 9, tick: 4 }, { x: 13, tick: 6 }];
    // 1) 网格中命令方块恰在期望位置、状态 facing=up（全部在轨道 0 主位底座）
    let cbCells = 0;
    for (let x = 0; x < grid.sx; x++) for (let y = 0; y < grid.sy; y++) for (let z = 0; z < grid.sz; z++) {
      const s = palette[grid.data[(y * grid.sz + z) * grid.sx + x]];
      if (s === SFX_CB_STATE) { cbCells++;
        const hit = expCbs.find(e => e.x === x);
        if (!hit || y !== 0 || z !== zcGrid) { console.log(`FAIL SFX 网格 CB 位置异常 @(${x},${y},${z})（应全在轨道 0 主位底座 yb 层）`); ok = false; }
      }
    }
    if (cbCells !== 4) { console.log(`FAIL SFX 网格 CB 数量 ${cbCells} ≠ 4`); ok = false; }
    else console.log('PASS SFX 网格 4 个命令方块 @X=1/5/9/13（统一轨道 0 主位底座，facing=up）');
    // 2) TE 列表：4 条，Command = function nbs2sfx:<tick>，坐标含 zOffset
    const tes = result.tileEntities;
    if (tes.length !== 4) { console.log(`FAIL SFX TE 数量 ${tes.length} ≠ 4`); ok = false; }
    else {
      let teOk = true;
      for (const e of expCbs) {
        const te = tes.find(t => t.x === e.x && t.y === 0 && t.z === zcGrid);
        const want = `function ${SFX_NAMESPACE}:${e.tick}`;
        if (!te || te.Command !== want || te.id !== 'minecraft:command_block' || te.auto !== false || te.state !== SFX_CB_STATE) {
          console.log(`FAIL SFX TE @X=${e.x}: ${JSON.stringify(te)}（期望 Command="${want}"）`); teOk = false;
        }
      }
      if (teOk) console.log(`PASS SFX TE 命令逐 tick 正确：function ${SFX_NAMESPACE}:0/2/4/6（auto=false，facing=up）`);
      else ok = false;
    }
    // 3) 声道去向：单线式发声（4 音）、MIDI式静音不发声（0 音）、MIDI式发声（3 音）、普通（1 音）→ 8
    if (result.stats.notesPlaced !== 8) { console.log(`FAIL SFX 音符放置 ${result.stats.notesPlaced} ≠ 8（静音MIDI式不应发声，单线式发声 4 音）`); ok = false; }
    else console.log('PASS SFX 音符放置 8（绑定 4 + 独立发声 3 + 普通 1；静音MIDI式 3 音不发声）');
    // 4) 统计拆分：绑定 4 行、独立 6 行、总 10；无丢弃、无空 tick 回退
    if (result.stats.sfxBoundNotes !== 4 || result.stats.sfxStandaloneNotes !== 6 || result.stats.sfxNotes !== 10) {
      console.log(`FAIL SFX 统计拆分 bound=${result.stats.sfxBoundNotes}/indep=${result.stats.sfxStandaloneNotes}/total=${result.stats.sfxNotes}（期望 4/6/10）`); ok = false;
    } else if (result.stats.sfxDiscarded !== 0 || result.stats.sfxEmptyTicks !== 0) {
      console.log(`FAIL SFX discarded=${result.stats.sfxDiscarded} emptyTicks=${result.stats.sfxEmptyTicks}（期望 0/0）`); ok = false;
    } else if (result.stats.commandBlocks !== 4) { console.log(`FAIL SFX commandBlocks ${result.stats.commandBlocks} ≠ 4`); ok = false; }
    else console.log('PASS SFX 统计：bound=4、indep=6、sfxNotes=10、commandBlocks=4、无丢弃无空 tick');
    // 5) sfxTickList：tick 升序、行序 = 绑定行在前（车道放置顺序 P0/P1/P2）+ 独立行在后（声部升序）
    const tl = result.sfxTickList;
    if (!Array.isArray(tl) || tl.length !== 4 || JSON.stringify(tl.map(e => e.tick)) !== JSON.stringify([0, 2, 4, 6])) {
      console.log(`FAIL SFX sfxTickList tick 序列 ${JSON.stringify(tl && tl.map(e => e.tick))}（期望 [0,2,4,6]）`); ok = false;
    } else {
      const exp = [
        [P0, I(44), I(43)],
        [P0, I(46), I(45)],
        [P0, I(49), I(48)],
        [P0],
      ];
      let linesOk = true;
      tl.forEach((e, i) => {
        if (JSON.stringify(e.lines) !== JSON.stringify(exp[i])) {
          console.log(`FAIL SFX tick ${e.tick} 行 ${JSON.stringify(e.lines)} ≠ ${JSON.stringify(exp[i])}`); linesOk = false;
        }
      });
      if (linesOk) console.log('PASS SFX sfxTickList 逐 tick 行内容：绑定行=音符盒偏移、独立行=音高偏移（行序 绑定→独立）');
      else ok = false;
    }
    // 6) 无参考回归：同一首歌不传 refLayers → 0 CB、0 TE、全部 11 音符发声（含原静音层）
    const rNoRef = runE2E(tmpFile, {
      lane0: { dz: 0, dy: 0 },
      groups: [{ layers: [0, 1, 2] }, { layers: [3] }],
      groupStarts: [{ dz: 3, dy: 0 }, { dz: 6, dy: 0 }],
    });
    if (rNoRef.result.stats.commandBlocks !== 0 || rNoRef.result.tileEntities.length !== 0
      || rNoRef.result.stats.notesPlaced !== 11) {
      console.log(`FAIL SFX 无参考回归：CB=${rNoRef.result.stats.commandBlocks} TE=${rNoRef.result.tileEntities.length} notes=${rNoRef.result.stats.notesPlaced}（期望 0/0/11）`); ok = false;
    } else console.log('PASS SFX 无参考回归：0 CB、0 TE、全部 11 音符发声');
    // 7) buildSfxFunctions 旧回退（不传 sfxTickList）：每参考音符一行、逐字 SFX_PARTICLE_CMD
    const song = r.song;
    const funcs = buildSfxFunctions(song, ref);
    if (funcs.length !== 4) { console.log(`FAIL SFX functions 回退 tick 数 ${funcs.length} ≠ 4`); ok = false; }
    else {
      const linesPer = funcs.map(f => f.lines.length).join(',');
      if (linesPer !== '3,3,3,1') { console.log(`FAIL SFX functions 回退行数 ${linesPer} ≠ 3,3,3,1`); ok = false; }
      else if (!funcs.every(f => f.lines.every(l => l === SFX_PARTICLE_CMD))) { console.log('FAIL SFX mcfunction 回退行应与参考命令逐字相等'); ok = false; }
      else console.log('PASS SFX functions 回退（无 sfxTickList）：行数 3,3,3,1，每行 = 参考命令逐字原文');
    }
    // 8) pack.mcmeta 两种写法
    const mcOld = JSON.parse(buildSfxPackMcmeta('1.19.4', 'test'));
    if (mcOld.pack.pack_format !== 13 || mcOld.pack.min_format !== undefined) {
      console.log(`FAIL SFX mcmeta 1.19.4: ${JSON.stringify(mcOld.pack)}`); ok = false;
    } else console.log('PASS SFX mcmeta 1.19.4 → pack_format:13（整数写法）');
    const mcNew = JSON.parse(buildSfxPackMcmeta('1.21.11', 'test'));
    if (mcNew.pack.pack_format !== undefined || String(mcNew.pack.min_format) !== '94.1' || String(mcNew.pack.max_format) !== '94.1') {
      console.log(`FAIL SFX mcmeta 1.21.11: ${JSON.stringify(mcNew.pack)}`); ok = false;
    } else console.log('PASS SFX mcmeta 1.21.11 → min_format/max_format:94.1（新写法）');
    // 9) zip 结构：EOCD 魔数、条目数、local/central 偏移、CRC、mcfunction 逐字内容（sfxTickList 版）
    const { bytes: zip, fileCount } = buildSfxDatapackZip(song, ref, '1.21.11', result.sfxTickList);
    if (fileCount !== 5) { console.log(`FAIL SFX zip 条目 ${fileCount} ≠ 5（1 mcmeta + 4 mcfunction）`); ok = false; }
    else console.log('PASS SFX zip 条目数 5');
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    // EOCD：从尾部找 0x06054b50（zip 魔数为小端字节序 50 4B 05 06 → 须按小端读 u32）
    let eocd = -1;
    for (let i = zip.length - 22; i >= 0; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) { console.log('FAIL SFX zip 缺 EOCD 魔数'); ok = false; }
    else {
      // EOCD / local header 字段均为小端（PKZIP 规范）
      const totalEntries = dv.getUint16(eocd + 10, true);
      const centralSize = dv.getUint32(eocd + 12, true);
      const centralOff = dv.getUint32(eocd + 16, true);
      if (totalEntries !== 5) { console.log(`FAIL SFX EOCD 条目数 ${totalEntries} ≠ 5`); ok = false; }
      // EOCD 紧跟 central 目录之后：centralOff + centralSize 应恰好指向 EOCD 起点
      if (centralOff + centralSize !== eocd) { console.log(`FAIL SFX EOCD central 偏移/大小不衔接（${centralOff}+${centralSize} ≠ ${eocd}）`); ok = false; }
      // 逐 local header：签名 0x04034b50、CRC、名字、数据逐字比对
      let off = 0; let entriesOk = true; const found = new Map();
      for (let i = 0; i < 5; i++) {
        if (dv.getUint32(off, true) !== 0x04034b50) { console.log(`FAIL SFX local[i] 签名 @${off}`); entriesOk = false; break; }
        const crc = dv.getUint32(off + 14, true);
        const compSize = dv.getUint32(off + 18, true);
        const nameLen = dv.getUint16(off + 26, true);
        const name = new TextDecoder().decode(zip.subarray(off + 30, off + 30 + nameLen));
        const dataStart = off + 30 + nameLen;
        const dataCrc = zipCrc32(zip.subarray(dataStart, dataStart + compSize));
        if (dataCrc !== crc) { console.log(`FAIL SFX zip CRC 不匹配 ${name}（${dataCrc.toString(16)} ≠ ${crc.toString(16)}）`); entriesOk = false; }
        found.set(name, zip.slice(dataStart, dataStart + compSize));
        off = dataStart + compSize;
      }
      if (entriesOk && off === centralOff) console.log('PASS SFX zip 5 个 local header 签名/名字/CRC 全对、central 偏移衔接');
      else { console.log(`FAIL SFX zip 解析（off=${off} centralOff=${centralOff}）`); ok = false; }
      // mcfunction 内容逐字（sfxTickList 行：绑定行音符盒偏移、独立行音高偏移）
      const f0 = found.get('data/nbs2sfx/function/0.mcfunction');
      const f6 = found.get('data/nbs2sfx/function/6.mcfunction');
      if (!f0 || !f6) { console.log('FAIL SFX zip 缺 1.21.11 function 目录 mcfunction（应为 data/nbs2sfx/function/<tick>.mcfunction）'); ok = false; }
      else {
        const d0 = new TextDecoder().decode(f0);
        const d6 = new TextDecoder().decode(f6);
        if (d0 !== `${P0}\n${I(44)}\n${I(43)}\n`) { console.log(`FAIL SFX 0.mcfunction 内容（绑定 P0 + 独立 key44/key43）`); ok = false; }
        if (d6 !== `${P0}\n`) { console.log(`FAIL SFX 6.mcfunction 内容（仅绑定 P0）`); ok = false; }
        if (ok) console.log('PASS SFX mcfunction 文件逐字内容正确（1.21.11 → function/ 目录，偏移已计算）');
        // mcmeta 在 zip 内可解析
        const mm = new TextDecoder().decode(found.get('pack.mcmeta'));
        JSON.parse(mm);
      }
      // 旧版目标：1.19.4 → functions/ 目录
      const { bytes: zipOld } = buildSfxDatapackZip(song, ref, '1.19.4', result.sfxTickList);
      const txtOld = new TextDecoder().decode(zipOld);
      if (!txtOld.includes('functions/0.mcfunction') || txtOld.includes('function/0.mcfunction')) {
        console.log('FAIL SFX 1.19.4 zip 应使用 functions/ 目录名'); ok = false;
      } else console.log('PASS SFX 1.19.4 zip 使用 functions/ 目录名（1.21 改名前）');
    }
    // 10) 系统级校验：Windows 自带 PowerShell Expand-Archive（系统 zip 库）真实解包
    //    → 文件清单/内容验证（本机 tar 不支持 zip 容器，7z/python 未安装）
    const { bytes: zipSys } = buildSfxDatapackZip(song, ref, '1.21.11', result.sfxTickList);
    const tmpZip = path.join(__dirname, 'sfx_selftest.zip');
    const tmpDir = path.join(__dirname, 'sfx_selftest_out');
    try {
      writeFileSync(tmpZip, Buffer.from(zipSys));
      rmSync(tmpDir, { recursive: true, force: true });
      mkdirSync(tmpDir, { recursive: true });
      execFileSync('powershell.exe', ['-NoProfile', '-Command',
        `Expand-Archive -LiteralPath '${tmpZip}' -DestinationPath '${tmpDir}' -Force`], { stdio: 'pipe' });
      const walk = d => readdirSync(d, { withFileTypes: true }).flatMap(e =>
        e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
      const files = walk(tmpDir).map(f => path.relative(tmpDir, f).replace(/\\/g, '/')).sort();
      // 参考声道 tick：layer 0/1/2 在 0/2/4（每 tick 3 行），layer 0 在 6（1 行）→ 4 个 mcfunction + pack.mcmeta
      const expectFiles = [
        'data/nbs2sfx/function/0.mcfunction', 'data/nbs2sfx/function/2.mcfunction',
        'data/nbs2sfx/function/4.mcfunction', 'data/nbs2sfx/function/6.mcfunction', 'pack.mcmeta',
      ].sort();
      if (files.length !== expectFiles.length || files.join('\n') !== expectFiles.join('\n')) {
        console.log(`FAIL SFX 系统解包文件清单不符（${files.length} 个）：${files.slice(0, 5).join(', ')}`); ok = false;
      } else {
        const c0 = readFileSync(path.join(tmpDir, 'data/nbs2sfx/function/0.mcfunction'), 'utf8');
        const c6 = readFileSync(path.join(tmpDir, 'data/nbs2sfx/function/6.mcfunction'), 'utf8');
        const mm = readFileSync(path.join(tmpDir, 'pack.mcmeta'), 'utf8');
        JSON.parse(mm);
        if (c0 !== `${P0}\n${I(44)}\n${I(43)}\n` || c6 !== `${P0}\n`) {
          console.log('FAIL SFX 系统解包内容不符'); ok = false;
        } else if (ok) console.log('PASS SFX zip 经系统 Expand-Archive 真实解包：5 文件齐全、内容逐字一致');
      }
    } catch (e) {
      console.log(`FAIL SFX 系统解包异常：${String(e.message).split('\n')[0]}`); ok = false;
    } finally {
      try { rmSync(tmpZip, { force: true }); rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
    // 11) 纯单线式场景：粒子行只来自音符盒偏移（无独立行）；组 dy 抬升 → 绑定行 dy 含抬升量
    {
      const nbs2 = makeNbs({ tempoTps: 20, songLength: 8, layers: 1, noteSpecs: [
        { tick: 0, layer: 0, instrument: 0, key: 45 },
        { tick: 2, layer: 0, instrument: 0, key: 50 },
      ]});
      writeFileSync(path.join(__dirname, tmpFile), nbs2);
      const refB = new Map([[0, { type: 'bound', sound: true }]]);
      // 组 [0] 起点 dz=3, dy=1 → 绑定行偏移 = (0, (1+1)−0, 3−0) = (0, 2, 3)
      const rB = runE2E(tmpFile, {
        lane0: { dz: 0, dy: 0 }, refLayers: refB,
        groups: [{ layers: [0] }], groupStarts: [{ dz: 3, dy: 1 }],
      });
      const tlb = rB.result.sfxTickList;
      const PB = sfxParticleCmd(0, 2, 3);
      if (!Array.isArray(tlb) || tlb.length !== 2 || tlb[0].tick !== 0 || tlb[1].tick !== 2
        || JSON.stringify(tlb[0].lines) !== JSON.stringify([PB]) || JSON.stringify(tlb[1].lines) !== JSON.stringify([PB])) {
        console.log(`FAIL SFX 纯绑定场景 sfxTickList ${JSON.stringify(tlb)}（期望 tick 0/2 各 1 行 ${PB.slice(0, 40)}…）`); ok = false;
      } else if (rB.result.stats.sfxBoundNotes !== 2 || rB.result.stats.sfxStandaloneNotes !== 0
        || rB.result.stats.commandBlocks !== 2) {
        console.log(`FAIL SFX 纯绑定场景统计 bound=${rB.result.stats.sfxBoundNotes} indep=${rB.result.stats.sfxStandaloneNotes} CB=${rB.result.stats.commandBlocks}（期望 2/0/2）`); ok = false;
      } else if (rB.result.stats.notesPlaced !== 2) {
        console.log(`FAIL SFX 纯绑定场景 notesPlaced ${rB.result.stats.notesPlaced} ≠ 2`); ok = false;
      } else console.log('PASS SFX 纯绑定场景：dy 抬升(1)+1 层差=2、dz=3 全部按轨道设定求解（非常数）');
      // 12) 单线式未分配车道 → 空 tick 回退：CB/TE 移除、统计回退、明细警告
      {
        // groups 不含 layer 0 → boundRefLayers[0] 无车道；sfxEntries 仍有 tick 0/2
        const rE = runE2E(tmpFile, {
          lane0: { dz: 0, dy: 0 }, refLayers: refB,
          groups: [{ layers: [] }], groupStarts: [{ dz: 3, dy: 0 }],
        });
        const se = rE.result.stats;
        if (se.commandBlocks !== 0 || rE.result.tileEntities.length !== 0
          || se.sfxEmptyTicks !== 2 || se.sfxDiscarded !== 2
          || se.sfxNotes !== 0 || !Array.isArray(rE.result.sfxTickList) || rE.result.sfxTickList.length !== 0) {
          console.log(`FAIL SFX 空 tick 回退：CB=${se.commandBlocks} TE=${rE.result.tileEntities.length} empty=${se.sfxEmptyTicks} disc=${se.sfxDiscarded}（期望 0/0/2/2）`); ok = false;
        } else {
          let cbCount = 0;
          const gE = rE.result, palE = rE.palette;
          for (let x = 0; x < gE.grid.sx; x++) for (let y = 0; y < gE.grid.sy; y++) for (let z = 0; z < gE.grid.sz; z++)
            if (palE[gE.grid.data[(y * gE.grid.sz + z) * gE.grid.sx + x]] === SFX_CB_STATE) cbCount++;
          if (cbCount !== 0) { console.log(`FAIL SFX 空 tick 回退后网格仍含 CB ${cbCount} 个（底座应还原雪块）`); ok = false; }
          else if (!rE.result.stats.discardedDetails.some(d => d.includes('未分配车道'))) {
            console.log('FAIL SFX 空 tick 回退缺「未分配车道」警告明细'); ok = false;
          } else console.log('PASS SFX 单线式未分配车道 → 空 tick 回退（底座还原雪块、TE 移除、警告留痕）');
        }
      }
    }
  } catch (e) {
    console.log('FAIL SFX 异常:', e.stack || e.message);
    ok = false;
  }
}

// ---------- 参考车道池：纯虚拟（2026-09-07 虚拟化）——零物理结构 + 绑定粒子锚定虚拟槽位 ----------
// 布局：轨道 0 dz=0/dy=0；音轨车道 dz=3/dy=0；参考车道 dz=6/dy=1（全非负 → zOffset=1、yOffset=0，
//   尺寸只由真实链决定）
{
  const { SFX_NAMESPACE, SFX_CB_STATE, sfxParticleCmd, sfxParticleCmdFromParts,
    SFX_PARTICLE_FIELDS, sfxParticleCmdWithGroup, normSfxParams, normConnectParams,
    SFX_CONNECT_DEFAULTS, SFX_CONNECT_POINT_GAP, SFX_CONNECT_NEAR_DT, sfxConnectCmd, sfxChordPairs,
    SFX_VANISH_DEFAULTS, sfxVanishCmd, normVanishParams,
    sfxBarLen, sfxNormBackground } = context.window.__NBS2SCHEMATIC;
  // 单线式连接线（2026-09-07c「连接前后节奏」）：端点 = 车道虚拟主位（中间槽位），沿链 +X（每 tick 2 格）。
  //   A/D/E2/H/H2 用 refLanes start {dz:6,dy:1} → mid=(0,2,6)；F 用 {dz:3,dy:0} → mid=(0,1,3)
  const boundConn = (my, mz, dt) => {
    const L = dt * 2;
    const n0 = Math.ceil(L / SFX_CONNECT_POINT_GAP);
    const cpt = Math.max(1, Math.ceil((n0 + 1) / (dt + 1)));
    const P = (dt + 1) * cpt;
    return sfxConnectCmd([0, my, mz], [L, 0, 0], L, P,
      SFX_CONNECT_DEFAULTS.m, SFX_CONNECT_DEFAULTS.alpha, SFX_CONNECT_DEFAULTS);
  };
  const BC_26 = boundConn(2, 6, 2);   // (0,2,6) 沿 X 4 格、P=42（与失败样本交叉核对：dis=4*t 0.024390244 42）
  const BC_13 = boundConn(1, 3, 2);
  // layer 0：tick0 key45（音高 12）、tick2 key50（音高 17）
  const nbs = makeNbs({ tempoTps: 20, songLength: 8, layers: 1, noteSpecs: [
    { tick: 0, layer: 0, instrument: 0, key: 45 },
    { tick: 2, layer: 0, instrument: 0, key: 50 },
  ]});
  const tmpFile = 'synth_reflane.nbs';
  writeFileSync(path.join(__dirname, tmpFile), nbs);
  const REF = new Map([[0, { type: 'bound', sound: true }]]);
  // 期望网格（真实链 = 轨道 0 dz0/dy0 + 音轨车道 dz3/dy0）：sx=16, sy=3, sz=6
  const GRID = { sx: 18, sy: 3, sz: 6 };
  try {
    // A) 单线式 + 参考车道：参考车道零方块（虚拟），音轨车道照常 2 盒；
    //    绑定粒子行锚定参考车道**虚拟槽位**：dy=(1+1)−0=2、dz=6−0=6（槽 0）
    const rA = runE2E(tmpFile, {
      lane0: { dz: 0, dy: 0 }, refLayers: REF,
      groups: [{ layers: [0] }], groupStarts: [{ dz: 3, dy: 0 }],
      refLanes: [{ tracks: [0], type: 'bound', start: { dz: 6, dy: 1 } }],
    });
    ok = verifyE2E('参考车道池·虚拟绑定', rA) && ok;
    const gA = rA.result;
    const palA = rA.palette, gridA = gA.grid;
    const cellA = (x, y, z) => palA[gridA.data[(y * gridA.sz + z) * gridA.sx + x]];
    if (gA.chains.length !== 3) {
      console.log(`FAIL 参考车道 chains=${gA.chains.length}（期望 轨道0+音轨车道+虚拟参考车道=3）`); ok = false;
    } else console.log('PASS 参考车道为虚拟链（chains=3，含 1 条不产方块的参考链）');
    const statA = gA.stats;
    if (statA.noteBlocks !== 2 || statA.noteBlocks !== statA.notesPlaced) {
      console.log(`FAIL 参考车道虚拟化 noteBlocks=${statA.noteBlocks}（期望 2：仅音轨车道 2 tick；参考车道零盒）`); ok = false;
    } else console.log('PASS 参考车道零物理结构：音符盒只剩音轨车道的 2 个（旧版 4 个双盒已消除）');
    // 网格尺寸只由真实链决定（参考车道 dz=6/dy=1 虚拟起点不扩格）
    if (gridA.sx !== GRID.sx || gridA.sy !== GRID.sy || gridA.sz !== GRID.sz) {
      console.log(`FAIL 参考车道网格尺寸 ${gridA.sx}×${gridA.sy}×${gridA.sz}（期望 ${GRID.sx}×${GRID.sy}×${GRID.sz}，参考车道虚拟不扩格）`); ok = false;
    }
    // 参考车道零物理结构的硬指标：中继器总数 = 2 条真实链 × 9 tick = 18（旧版含参考链会是 27）
    if (statA.repeaters !== 18) {
      console.log(`FAIL 参考车道零物理结构：中继器 ${statA.repeaters} 个（期望 18 = 2 真实链 × 9 tick；参考链不产中继器）`); ok = false;
    }
    // 音轨车道盒仍在 (1,1,4)（网格 z=3+1）
    if (cellA(1, 1, 4) !== 'minecraft:note_block[instrument=harp,note=12,powered=false]') {
      console.log(`FAIL 音轨车道盒缺失/错位 (1,1,4)=${cellA(1, 1, 4)}`); ok = false;
    }
    // 绑定行 = 虚拟槽位 − 轨道 0 CB：(0, 2, 6)；音轨车道重叠不再产行（无盒可锚）；
    //   2026-09-07c 起单线式连线恒产生（缺省全选）：tick0 追加沿链 X 的 A→B 线段（t0→t2，Δt=2 → X 移 4 格）
    const P0R = sfxParticleCmd(0, 2, 6);
    const tlbA = gA.sfxTickList;
    if (tlbA.length !== 2 || JSON.stringify(tlbA[0].lines) !== JSON.stringify([P0R, BC_26])
      || JSON.stringify(tlbA[1].lines) !== JSON.stringify([P0R])) {
      console.log(`FAIL 参考车道虚拟绑定行 ${JSON.stringify(tlbA)}（期望 tick0 [绑定行, 连接线] / tick2 [绑定行]）`); ok = false;
    } else if (statA.sfxBoundNotes !== 2 || statA.sfxStandaloneNotes !== 0 || statA.sfxConnectLines !== 1 || statA.commandBlocks !== 2) {
      console.log(`FAIL 参考车道统计 bound=${statA.sfxBoundNotes} indep=${statA.sfxStandaloneNotes} conn=${statA.sfxConnectLines} CB=${statA.commandBlocks}（期望 2/0/1/2）`); ok = false;
    } else console.log('PASS 单线式锚定参考车道虚拟槽位：dy=2（dy=1 抬升+1 层差）、dz=6 按参考车道起点求解（+沿链 X 连接线）');
    // B) 参考车道池为空（refLanes=[]，refMode 生效）：绑定层无锚点 → 粒子全跳 + 空 tick 回退
    const rB = runE2E(tmpFile, {
      lane0: { dz: 0, dy: 0 }, refLayers: REF,
      groups: [{ layers: [0] }], groupStarts: [{ dz: 3, dy: 0 }],
      refLanes: [],
    });
    ok = verifyE2E('参考车道池·空池绑定跳过', rB) && ok;
    const statB = rB.result.stats;
    if (statB.commandBlocks !== 0 || rB.result.tileEntities.length !== 0
      || statB.sfxEmptyTicks !== 2 || statB.sfxDiscarded !== 2 || statB.sfxNotes !== 0) {
      console.log(`FAIL 空参考车道池回退：CB=${statB.commandBlocks} TE=${rB.result.tileEntities.length} empty=${statB.sfxEmptyTicks} disc=${statB.sfxDiscarded}（期望 0/0/2/2）`); ok = false;
    } else if (statB.noteBlocks !== 2 || rB.result.sfxTickList.length !== 0
      || !statB.discardedDetails.some(d => d.includes('未分配参考车道'))) {
      console.log('FAIL 空参考车道池：音轨车道应仍发声（2 盒）、无粒子行、留「未分配参考车道」警告'); ok = false;
    } else {
      console.log('PASS 参考车道池空 → 绑定粒子整体跳过+空 tick 回退（CB 还原雪块、TE 移除），音轨车道照常发声');
    }
    // C) MIDI式 + 参考车道：参考车道零方块，音轨车道 2 盒；
    //    粒子行 = 轨道 0 CB + 所属MIDI式参考车道 start（中心基准）+ (0,0,音高偏移)——start (0,0) 时行恒 (0,0,音高偏移)
    const rC = runE2E(tmpFile, {
      lane0: { dz: 0, dy: 0 },
      refLayers: new Map([[0, { type: 'independent', sound: true }]]),
      groups: [{ layers: [0] }], groupStarts: [{ dz: 3, dy: 0 }],
      refLanes: [{ tracks: [0], start: { dz: 0, dy: 0 }, effects: ['trigger'] }],
    });
    ok = verifyE2E('参考车道池·MIDI式', rC) && ok;
    const statC = rC.result.stats;
    const tlbC = rC.result.sfxTickList;
    const I12 = sfxParticleCmd(0, 0, 0), I17 = sfxParticleCmd(0, 0, 5);
    if (statC.noteBlocks !== 2 || statC.sfxStandaloneNotes !== 2 || statC.sfxBoundNotes !== 0
      || tlbC.length !== 2 || JSON.stringify(tlbC[0].lines) !== JSON.stringify([I12])
      || JSON.stringify(tlbC[1].lines) !== JSON.stringify([I17])) {
      console.log(`FAIL MIDI式参考车道：盒=${statC.noteBlocks} indep=${statC.sfxStandaloneNotes} 行=${JSON.stringify(tlbC)}（期望 2 盒、tick0 dz=0/tick2 dz=5）`); ok = false;
    } else {
      console.log('PASS MIDI式：参考车道零方块，音轨车道 2 盒，粒子行按音高偏移（start=(0,0) 缺省基准）');
    }
    // C2) MIDI式中心基准平移（2026-09-07 独立中心可拖）：start (dz=4,dy=2) → 行 = (0, 2, 4+音高偏移)
    const rC2 = runE2E(tmpFile, {
      lane0: { dz: 0, dy: 0 },
      refLayers: new Map([[0, { type: 'independent', sound: true }]]),
      groups: [{ layers: [0] }], groupStarts: [{ dz: 3, dy: 0 }],
      refLanes: [{ tracks: [0], start: { dz: 4, dy: 2 }, effects: ['trigger'] }],
    });
    ok = verifyE2E('参考车道池·MIDI式中心平移', rC2) && ok;
    const statC2 = rC2.result.stats;
    const tlbC2 = rC2.result.sfxTickList;
    if (statC2.noteBlocks !== 2 || statC2.sfxStandaloneNotes !== 2 || statC2.sfxBoundNotes !== 0
      || tlbC2.length !== 2 || JSON.stringify(tlbC2[0].lines) !== JSON.stringify([sfxParticleCmd(0, 2, 4)])
      || JSON.stringify(tlbC2[1].lines) !== JSON.stringify([sfxParticleCmd(0, 2, 9)])) {
      console.log(`FAIL MIDI式中心平移：盒=${statC2.noteBlocks} indep=${statC2.sfxStandaloneNotes} 行=${JSON.stringify(tlbC2)}（期望 2 盒、(0,2,4)/(0,2,9)）`); ok = false;
    } else {
      console.log('PASS MIDI式中心平移：start (4,2) → 粒子行 (0,2,4+音高偏移)，中心基准整体平移+音高 Z 展开');
    }
    // C3) 小数音高步长（2026-09-07 用户放开，步进 0.1）：sfxPitchStep=2.5 → dz = 4 + (note−12)×2.5
    //     音高 12 → 4（偏移 0）；音高 17 → 4+12.5=16.5（浮点噪声须在产物命令中不出现）
    const rC3 = runE2E(tmpFile, {
      lane0: { dz: 0, dy: 0 },
      settings: { sfxPitchStep: 2.5 },
      refLayers: new Map([[0, { type: 'independent', sound: true }]]),
      groups: [{ layers: [0] }], groupStarts: [{ dz: 3, dy: 0 }],
      refLanes: [{ tracks: [0], start: { dz: 4, dy: 2 }, effects: ['trigger'] }],
    });
    ok = verifyE2E('参考车道池·MIDI式小数步长', rC3) && ok;
    const statC3 = rC3.result.stats;
    const tlbC3 = rC3.result.sfxTickList;
    if (statC3.noteBlocks !== 2 || statC3.sfxStandaloneNotes !== 2 || statC3.sfxBoundNotes !== 0
      || !tlbC3 || tlbC3.length !== 2
      || JSON.stringify(tlbC3[0].lines) !== JSON.stringify([sfxParticleCmd(0, 2, 4)])
      || JSON.stringify(tlbC3[1].lines) !== JSON.stringify([sfxParticleCmd(0, 2, 16.5)])
      || !tlbC3[1].lines[0].includes('~16.5') || tlbC3[1].lines[0].includes('16.50000')) {
      console.log(`FAIL MIDI式小数步长：indep=${statC3.sfxStandaloneNotes} 行=${JSON.stringify(tlbC3)}（期望 (0,2,4)/(0,2,16.5)，命令文本 ~16.5 无浮点噪声）`); ok = false;
    } else {
      console.log('PASS MIDI式小数步长 2.5：粒子行 (0,2,4)/(0,2,16.5)，命令文本无浮点噪声');
    }
    // D) 类型选型按参考车道：refLayers 记MIDI式、但参考车道 lane.type='bound' → 绑定语义胜出，
    //    粒子锚定参考车道虚拟槽位（dz=6/dy=1 → (0,2,6)）
    const rD = runE2E(tmpFile, {
      lane0: { dz: 0, dy: 0 },
      refLayers: new Map([[0, { type: 'independent', sound: true }]]),
      groups: [{ layers: [0] }], groupStarts: [{ dz: 3, dy: 0 }],
      refLanes: [{ tracks: [0], type: 'bound', start: { dz: 6, dy: 1 } }],
    });
    ok = verifyE2E('参考车道池·车道级单线式', rD) && ok;
    const statD = rD.result.stats;
    const tlbD = rD.result.sfxTickList;
    if (statD.sfxBoundNotes !== 2 || statD.sfxStandaloneNotes !== 0 || statD.sfxConnectLines !== 1
      || tlbD.length !== 2 || JSON.stringify(tlbD[0].lines) !== JSON.stringify([P0R, BC_26])
      || JSON.stringify(tlbD[1].lines) !== JSON.stringify([P0R])) {
      console.log(`FAIL 车道级单线式：bound=${statD.sfxBoundNotes} indep=${statD.sfxStandaloneNotes} conn=${statD.sfxConnectLines} 行=${JSON.stringify(tlbD)}（期望 2/0/1、tick0 [绑定行, 连接线] / tick2 [绑定行]）`); ok = false;
    } else {
      console.log('PASS 类型选型按车道：车道 type=bound 时声道级MIDI式被覆盖、粒子锚定参考车道虚拟槽位（+沿链 X 连接线）');
    }
    // E) 单线式车道 + 成员 sound=false（2026-09-07 起可自由取消发声）：
    //    音轨车道无盒（零发声）但粒子行**恒产生**（参考意义，按虚拟槽位）；连接线同理恒产生
    const rE2 = runE2E(tmpFile, {
      lane0: { dz: 0, dy: 0 },
      refLayers: new Map([[0, { type: 'bound', sound: false }]]),
      groups: [{ layers: [0] }], groupStarts: [{ dz: 3, dy: 0 }],
      refLanes: [{ tracks: [0], type: 'bound', start: { dz: 6, dy: 1 } }],
    });
    const statE2 = rE2.result.stats;
    const tlbE2 = rE2.result.sfxTickList;
    if (statE2.noteBlocks !== 0 || statE2.sfxBoundNotes !== 2 || statE2.sfxStandaloneNotes !== 0
      || statE2.sfxConnectLines !== 1 || statE2.commandBlocks !== 2 || tlbE2.length !== 2
      || JSON.stringify(tlbE2[0].lines) !== JSON.stringify([P0R, BC_26])
      || JSON.stringify(tlbE2[1].lines) !== JSON.stringify([P0R])) {
      console.log(`FAIL 绑定车道 sound=false 成员：盒=${statE2.noteBlocks} bound=${statE2.sfxBoundNotes} conn=${statE2.sfxConnectLines} CB=${statE2.commandBlocks}（期望 0 盒、2 绑定行、1 连接线、2 CB——粒子恒产生）`); ok = false;
    } else {
      console.log('PASS 单线式取消发声：普通轨道零盒（纯参考），粒子行+连接线恒产生（虚拟槽位锚定）');
    }
    // F) 参考车道与普通车道同起点（物理并排）：生成不报错（虚拟化后参考车道不参与碰撞；
    //    网格只含普通车道结构，参考车道虚拟起点不产方块）
    const rF = runE2E(tmpFile, {
      lane0: { dz: 0, dy: 0 }, refLayers: REF,
      groups: [{ layers: [0] }], groupStarts: [{ dz: 3, dy: 0 }],
      refLanes: [{ tracks: [0], type: 'bound', start: { dz: 3, dy: 0 } }],
    });
    const statF = rF.result.stats;
    const tlbF = rF.result.sfxTickList;
    if (statF.noteBlocks !== 2 || tlbF.length !== 2
      || JSON.stringify(tlbF[0].lines) !== JSON.stringify([sfxParticleCmd(0, 1, 3), BC_13])
      || JSON.stringify(tlbF[1].lines) !== JSON.stringify([sfxParticleCmd(0, 1, 3)])
      || statF.sfxConnectLines !== 1) {
      console.log(`FAIL 参考/普通同起点：盒=${statF.noteBlocks} conn=${statF.sfxConnectLines} 行=${JSON.stringify(tlbF)}（期望 2 盒、1 连接线、绑定行按虚拟槽位 (0,1,3) + 沿链 X 连线）`); ok = false;
    } else console.log('PASS 参考车道与普通车道同起点：生成正常（零结构、不参与碰撞、粒子按虚拟槽位 + 沿链 X 连线）');
    // G) 车道级特效勾选：refLanes[0].effects 不含 'trigger' → 绑定行不生成；但**连接型勾选（含 connect）
    //    仍产单线式连接线**（连线自持 tA 的 function/CB）→ tick0 [连接线]、tick2 无行 → 空 tick 回退
    //    （缺省（无 effects 字段）= 全选，场景 A 已覆盖）
    const rG = runE2E(tmpFile, {
      lane0: { dz: 0, dy: 0 }, refLayers: REF,
      groups: [{ layers: [0] }], groupStarts: [{ dz: 3, dy: 0 }],
      refLanes: [{ tracks: [0], type: 'bound', start: { dz: 6, dy: 1 }, effects: ['connect'] }],
    });
    const statG = rG.result.stats;
    const tlbG = rG.result.sfxTickList;
    if (statG.noteBlocks !== 2 || statG.sfxBoundNotes !== 0 || statG.sfxConnectLines !== 1
      || statG.commandBlocks !== 1 || statG.sfxEmptyTicks !== 1 || tlbG.length !== 1
      || JSON.stringify(tlbG[0].lines) !== JSON.stringify([BC_26])) {
      console.log(`FAIL 触发型勾选关闭：盒=${statG.noteBlocks} bound=${statG.sfxBoundNotes} conn=${statG.sfxConnectLines} CB=${statG.commandBlocks} empty=${statG.sfxEmptyTicks} 行=${JSON.stringify(tlbG)}（期望 2/0/1/1/1，tick0 [连接线]、tick2 空 tick 回退）`); ok = false;
    } else {
      console.log('PASS 触发型勾选关闭（effects 不含 trigger）：绑定行不生成、单线式连接线仍产（自持 tA 的 function/CB）');
    }
    // H) 车道级触发模板（lane.sfxParams 结构化 5 字段）：绑定行按本车道模板生成（命令头/尾参逐字、
    //    坐标段仍按虚拟槽位替换）；独立行不受车道模板影响（属声道级，仍用默认命令）
    const FIELDS = { head: 'particleex custom minecraft:totem_of_undying', x: '~', y: '~', z: '~',
      tail: '1 0.95 0.89 1 0 0 0 -10 10 0.1 20 1.0 null' };
    const lineH = sfxParticleCmdFromParts(0, 2, 6, FIELDS);
    const rH = runE2E(tmpFile, {
      lane0: { dz: 0, dy: 0 }, refLayers: REF,
      groups: [{ layers: [0] }], groupStarts: [{ dz: 3, dy: 0 }],
      refLanes: [{ tracks: [0], type: 'bound', start: { dz: 6, dy: 1 }, sfxParams: FIELDS }],
    });
    const statH = rH.result.stats;
    const tlbH = rH.result.sfxTickList;
    if (statH.noteBlocks !== 2 || statH.sfxBoundNotes !== 2 || statH.sfxConnectLines !== 1 || tlbH.length !== 2
      || JSON.stringify(tlbH[0].lines) !== JSON.stringify([lineH, BC_26])
      || JSON.stringify(tlbH[1].lines) !== JSON.stringify([lineH])) {
      console.log(`FAIL 车道级触发模板：bound=${statH.sfxBoundNotes} conn=${statH.sfxConnectLines} 行=${JSON.stringify(tlbH)}（期望 tick0 [自定义模板行, 连接线] / tick2 [自定义模板行]，坐标段仍按虚拟槽位替换）`); ok = false;
    } else console.log('PASS 车道级触发模板：绑定行按本车道 5 字段模板生成（连接线不受触发模板影响，仍默认命令）');
    // H2) 模板残缺（5 字段不全）→ normSfxParams 判无效 → 回退默认命令（产物与缺省逐位一致）
    const rH2 = runE2E(tmpFile, {
      lane0: { dz: 0, dy: 0 }, refLayers: REF,
      groups: [{ layers: [0] }], groupStarts: [{ dz: 3, dy: 0 }],
      refLanes: [{ tracks: [0], type: 'bound', start: { dz: 6, dy: 1 }, sfxParams: { head: 'x', tail: 'y' } }],
    });
    if (JSON.stringify(rH2.result.sfxTickList[0].lines) !== JSON.stringify([sfxParticleCmd(0, 2, 6), BC_26])
      || JSON.stringify(rH2.result.sfxTickList[1].lines) !== JSON.stringify([sfxParticleCmd(0, 2, 6)])) {
      console.log(`FAIL 模板残缺回退默认：${JSON.stringify(rH2.result.sfxTickList[0].lines)}（期望默认命令 (0,2,6) + 连接线）`); ok = false;
    } else console.log('PASS 模板残缺（字段不全）：回退默认命令，产物与缺省逐位一致（连接线在位）');
    // H3) 命令头含 ~ 占位（用户把坐标段误留在头里）→ 本车道绑定行不生成 + 告警一次（避免空 function 方块）；
    //    连接型独立于触发模板，连接线仍产（自持 tA 的 function/CB，tick2 无行 → 空 tick 回退）
    const rH3 = runE2E(tmpFile, {
      lane0: { dz: 0, dy: 0 }, refLayers: REF,
      groups: [{ layers: [0] }], groupStarts: [{ dz: 3, dy: 0 }],
      refLanes: [{ tracks: [0], type: 'bound', start: { dz: 6, dy: 1 },
        sfxParams: { head: 'particleex custom minecraft:end_rod ~ ~2 ~', x: '~', y: '~', z: '~', tail: '1 0.1 20 null' } }],
    });
    const statH3 = rH3.result.stats;
    const tlbH3 = rH3.result.sfxTickList;
    if (statH3.sfxBoundNotes !== 0 || statH3.sfxConnectLines !== 1 || tlbH3.length !== 1
      || JSON.stringify(tlbH3[0].lines) !== JSON.stringify([BC_26]) || statH3.sfxEmptyTicks !== 1
      || !rH3.result.stats.discardedDetails.some(s => s.includes('命令头含 ~ 占位'))) {
      console.log(`FAIL 模板头含~：bound=${statH3.sfxBoundNotes} conn=${statH3.sfxConnectLines} empty=${statH3.sfxEmptyTicks} 行=${JSON.stringify(tlbH3)} 告警=${JSON.stringify(rH3.result.stats.discardedDetails)}（期望 bound=0、conn=1、tick0 [连接线]、tick2 空 tick 回退）`); ok = false;
    } else console.log('PASS 模板命令头含 ~ 占位：绑定行跳过 + 告警，连接线独立照产（自持 tA 的 function/CB）');
    // I) 触发粒子只取主位（2026-09-07d 用户定）：bound 车道 2 成员同 tick 齐响 → 仅主位 1 行（不展开第2/3位）；
    //    车道级演奏 tick 序列不变 → 连接线照常（tick0→tick2，BC_26）
    const nbsI = makeNbs({ tempoTps: 20, songLength: 8, layers: 2, noteSpecs: [
      { tick: 0, layer: 0, instrument: 0, key: 45 },
      { tick: 0, layer: 1, instrument: 0, key: 50 },
      { tick: 2, layer: 1, instrument: 0, key: 45 },
    ]});
    const tmpI = 'synth_reflane_multi.nbs';
    writeFileSync(path.join(__dirname, tmpI), nbsI);
    const REF2 = new Map([[0, { type: 'bound', sound: true }], [1, { type: 'bound', sound: true }]]);
    const rI = runE2E(tmpI, {
      lane0: { dz: 0, dy: 0 }, refLayers: REF2,
      groups: [{ layers: [0, 1] }], groupStarts: [{ dz: 3, dy: 0 }],
      refLanes: [{ tracks: [0, 1], type: 'bound', start: { dz: 6, dy: 1 } }],
    });
    ok = verifyE2E('参考车道池·多成员只主位', rI) && ok;
    const statI = rI.result.stats;
    const tlbI = rI.result.sfxTickList;
    if (statI.sfxBoundNotes !== 2 || statI.sfxConnectLines !== 1 || tlbI.length !== 2
      || JSON.stringify(tlbI[0].lines) !== JSON.stringify([P0R, BC_26])
      || JSON.stringify(tlbI[1].lines) !== JSON.stringify([P0R])) {
      console.log(`FAIL 多成员只主位：bound=${statI.sfxBoundNotes} conn=${statI.sfxConnectLines} 行=${JSON.stringify(tlbI)}（期望 bound=2：t0 双成员齐响仅主位 1 行 / t2 1 行；tick0 [P0R, 连接线]、tick2 [P0R]）`); ok = false;
    } else {
      console.log('PASS 触发粒子只取主位：多成员同 tick 齐响不展开第2/3位（每 tick 每车道至多 1 行），连接线照产');
    }
    // K) 连接型（2026-09-07 用户定规格：MIDI式相邻音符对 A→B 线段，tB 时刻笔尖恰好抵达 B）：
    //    K1 缺省全选（触发+连接）：独立行 + 连接线；K2 取消连接（effects 仅 trigger）→ 无连接线、
    //    网格与 K1 逐位一致（连接线零 litematic 改动）；K3 仅连接（effects 仅 connect）→ 无独立行、
    //    行全为连接线；K4 车道级连接模板（sfxParams.connect）；K5 短 Δt（cpt>1）+ L<0.05 跳过
    //    （tick0/2 同音高 A≡B 不连线、tick2/6 连）
    {
      // K1 期望（默认模板）：A=(0,0,0)、B=(0,0,5)（音高 12→17）；d=(0,0,5)、L=5、Δt=2
      //   N0=⌈5/0.1⌉=50、cpt=⌈51/3⌉=17、P=51、step=1/50=0.02、end=1.01、age=m=10、φ=π/2、θ=0
      const expK1 = sfxConnectCmd([0, 0, 0], [0, 0, 5], 5, 51,
        SFX_CONNECT_DEFAULTS.m, SFX_CONNECT_DEFAULTS.alpha, SFX_CONNECT_DEFAULTS);
      const k1Opts = {
        lane0: { dz: 0, dy: 0 },
        refLayers: new Map([[0, { type: 'independent', sound: true }]]),
        groups: [{ layers: [0] }], groupStarts: [{ dz: 3, dy: 0 }],
        refLanes: [{ tracks: [0], start: { dz: 0, dy: 0 } }],
      };
      const rK1 = runE2E(tmpFile, k1Opts);
      ok = verifyE2E('参考车道池·连接线缺省', rK1) && ok;
      const statK1 = rK1.result.stats;
      const tlbK1 = rK1.result.sfxTickList;
      if (statK1.sfxStandaloneNotes !== 2 || statK1.sfxConnectLines !== 1 || statK1.commandBlocks !== 2
        || tlbK1.length !== 2
        || JSON.stringify(tlbK1[0].lines) !== JSON.stringify([sfxParticleCmd(0, 0, 0), expK1])
        || JSON.stringify(tlbK1[1].lines) !== JSON.stringify([sfxParticleCmd(0, 0, 5)])
        || !expK1.startsWith('particleex tickpolarparameter minecraft:end_rod ~0 ~0 ~0 1 0.95 0.89 1 0 0 0 0 1.01')
        || !expK1.includes('"s1,s2,dis=1.570796327,0,5*t" 0.02 51 10 null 1.0 null')) {
        console.log(`FAIL 连接线缺省：indep=${statK1.sfxStandaloneNotes} conn=${statK1.sfxConnectLines} CB=${statK1.commandBlocks} 行=${JSON.stringify(tlbK1)}（期望 tick0 [独立行, 连接线] / tick1 [独立行]；命令 φ=π/2、L=5、step=0.02、P=51、age=10）`); ok = false;
      } else {
        console.log('PASS 连接线缺省（全选）：tA 行 = 独立行+连接线（t_B=t_A+2 笔尖抵达，无缝衔接），litematic 结构不变');
      }
      // K2 取消连接（effects 仅 trigger）：无连接线；网格/盒/中继器与 K1 逐位一致（零 litematic 改动）
      const rK2 = runE2E(tmpFile, { ...k1Opts, refLanes: [{ tracks: [0], start: { dz: 0, dy: 0 }, effects: ['trigger'] }] });
      ok = verifyE2E('参考车道池·连接线关闭', rK2) && ok;
      const statK2 = rK2.result.stats;
      if (statK2.sfxConnectLines !== 0 || statK2.sfxStandaloneNotes !== 2
        || rK2.packed.longs.length !== rK1.packed.longs.length || !rK1.packed.longs.every((v, i) => v === rK2.packed.longs[i])
        || rK2.totalBlocks !== rK1.totalBlocks) {
        console.log(`FAIL 连接线关闭：conn=${statK2.sfxConnectLines} 网格差异（期望 conn=0、网格与 K1 逐位一致）`); ok = false;
      } else console.log('PASS 连接线关闭（effects 仅 trigger）：零连接线，litematic 网格与缺省全选逐位一致');
      // K3 仅连接（effects 仅 connect）：无独立触发行；tick0 行=连接线（CB 自持）；
      //   tick2 无任何行 → 空 tick 回退（CB 还原雪块、TE 移除）
      const rK3 = runE2E(tmpFile, { ...k1Opts, refLanes: [{ tracks: [0], start: { dz: 0, dy: 0 }, effects: ['connect'] }] });
      const statK3 = rK3.result.stats;
      const tlbK3 = rK3.result.sfxTickList;
      if (statK3.sfxStandaloneNotes !== 0 || statK3.sfxConnectLines !== 1 || statK3.commandBlocks !== 1
        || statK3.sfxEmptyTicks !== 1 || tlbK3.length !== 1
        || JSON.stringify(tlbK3[0].lines) !== JSON.stringify([expK1])) {
        console.log(`FAIL 连接线单独开（仅 connect）：indep=${statK3.sfxStandaloneNotes} conn=${statK3.sfxConnectLines} CB=${statK3.commandBlocks} empty=${statK3.sfxEmptyTicks} 行=${JSON.stringify(tlbK3)}（期望 tick0 [连接线]、tick2 空 tick 回退）`); ok = false;
      } else {
        console.log('PASS 连接线单独开（effects 仅 connect）：无触发独立行；tB tick 无行 → 空 tick 回退（连线自持 tA 的 function/CB）');
      }
      // K4 车道级连接模板（sfxParams.connect）：粒子/颜色/m/α 逐字进命令（α=0.1 → 速度 (0,0,α·dz/L)=(0,0,0.1)，
      //   沿 AB 方向的漂移）；独立行（声道级触发命令）不受车道连接模板影响
      const connK4 = { particle: 'minecraft:dragon_breath', color: '0.5 0.5 0.5 1', m: 20, alpha: 0.1 };
      const rK4 = runE2E(tmpFile, { ...k1Opts, refLanes: [{ tracks: [0], start: { dz: 0, dy: 0 }, sfxParams: { connect: connK4 } }] });
      const tlbK4 = rK4.result.sfxTickList;
      const expK4 = sfxConnectCmd([0, 0, 0], [0, 0, 5], 5, 51, 20, 0.1, { particle: 'minecraft:dragon_breath', color: '0.5 0.5 0.5 1' });
      if (JSON.stringify(tlbK4[0].lines) !== JSON.stringify([sfxParticleCmd(0, 0, 0), expK4])
        || !expK4.startsWith('particleex tickpolarparameter minecraft:dragon_breath ~0 ~0 ~0 0.5 0.5 0.5 1 0 0 0.1 0 1.01')
        || !expK4.includes('"s1,s2,dis=1.570796327,0,5*t" 0.02 51 20 null 1.0 null')) {
        console.log(`FAIL 车道级连接模板：行=${JSON.stringify(tlbK4[0].lines)}（期望 dragon_breath、色 0.5 0.5 0.5 1、vz=0.1、age=20）`); ok = false;
      } else {
        console.log('PASS 车道级连接模板（sfxParams.connect）：粒子/颜色/m/α 定制进命令，独立行不受影响');
      }
      // K5 短 Δt + L<0.05 跳过：tick0 k45(12)、tick2 k45(12，A≡B 跳过)、tick6 k40(7)
      //   对 (0,6)：d=(0,0,−5)、L=5、Δt=6、N0=50、cpt=⌈51/7⌉=8、P=55、step=1/54≈0.018518519、end=1.009259259
      const nbsK5 = makeNbs({ tempoTps: 20, songLength: 8, layers: 1, noteSpecs: [
        { tick: 0, layer: 0, instrument: 0, key: 45 },
        { tick: 2, layer: 0, instrument: 0, key: 45 },
        { tick: 6, layer: 0, instrument: 0, key: 40 },
      ]});
      const tmpK5 = 'synth_connect_short.nbs';
      writeFileSync(path.join(__dirname, tmpK5), nbsK5);
      const rK5 = runE2E(tmpK5, k1Opts);
      ok = verifyE2E('参考车道池·连接线短Δt', rK5) && ok;
      const statK5 = rK5.result.stats;
      const tlbK5 = rK5.result.sfxTickList;
      const expK5 = sfxConnectCmd([0, 0, 0], [0, 0, -5], 5, 55,
        SFX_CONNECT_DEFAULTS.m, SFX_CONNECT_DEFAULTS.alpha, SFX_CONNECT_DEFAULTS);
      if (statK5.sfxStandaloneNotes !== 3 || statK5.sfxConnectLines !== 1
        || tlbK5.length !== 3
        || JSON.stringify(tlbK5[0].lines) !== JSON.stringify([sfxParticleCmd(0, 0, 0)])
        || JSON.stringify(tlbK5[1].lines) !== JSON.stringify([sfxParticleCmd(0, 0, 0), expK5])
        || JSON.stringify(tlbK5[2].lines) !== JSON.stringify([sfxParticleCmd(0, 0, -5)])
        || !expK5.includes('"s1,s2,dis=-1.570796327,0,5*t" 0.018518519 55 10 null 1.0 null')) {
        console.log(`FAIL 连接线短Δt：indep=${statK5.sfxStandaloneNotes} conn=${statK5.sfxConnectLines} 行=${JSON.stringify(tlbK5)}（期望仅 (2,6) 一对连线、行落 t_A=2：L=5、Δt=6、P=55、step=1/54；(0,2) 同音高 A≡B 跳过）`); ok = false;
      } else {
        console.log('PASS 连接线短Δt：cpt=⌈(N0+1)/(Δt+1)⌉ 量化点距 ≤0.1；L<0.05（A≡B）自动跳过');
      }
      // K6 和弦连线（2026-09-07c）：sfxChordPairs 单元断言 + 近/远距端到端
      {
        // 单元：近距 3→1 / 1→3 / 远距严格 1:1
        const p1 = sfxChordPairs([44, 50], [45, 50, 55], true);
        const p2 = sfxChordPairs([45], [45, 48, 52], true);
        const p3 = sfxChordPairs([45], [45, 48, 52], false);
        const p4 = sfxChordPairs([44, 50, 55], [45], true);
        const p5 = sfxChordPairs([44, 50, 55], [45], false);
        if (JSON.stringify(p1) !== JSON.stringify([[44, 45], [50, 50], [50, 55]])
          || JSON.stringify(p2) !== JSON.stringify([[45, 45], [45, 48], [45, 52]])
          || JSON.stringify(p3) !== JSON.stringify([[45, 45]])
          || JSON.stringify(p4) !== JSON.stringify([[44, 45], [50, 45], [55, 45]])
          || JSON.stringify(p5) !== JSON.stringify([[44, 45]])) {
          console.log(`FAIL sfxChordPairs 单元：p1=${JSON.stringify(p1)} p2=${JSON.stringify(p2)} p3=${JSON.stringify(p3)} p4=${JSON.stringify(p4)} p5=${JSON.stringify(p5)}`); ok = false;
        } else console.log('PASS sfxChordPairs 单元：近距 1:1+落单挂靠（1:3/3:1）、远距严格 1:1（落单不连）');
        // K6a 近距 Δt=4：MIDI式车道 [layer0, layer1, layer2]；
        //   A t0 = [44(L0), 50(L1)] → B t4 = [45(L0), 50(L1), 55(L2)]（NBS 每 (声道,tick) 至多 1 音 →
        //   和弦 = 多成员跨声道同 tick）：1:1 (44→45,L=1)、(50→50,L=0 跳过)、落单 B=55 挂靠 A=50（L=5，1:3）
        //   → 2 条线；独立行和弦每音一行（行序 = 声部升序，连接线整体在后）
        const nbsK6a = makeNbs({ tempoTps: 20, songLength: 8, layers: 3, noteSpecs: [
          { tick: 0, layer: 0, instrument: 0, key: 44 },
          { tick: 0, layer: 1, instrument: 0, key: 50 },
          { tick: 4, layer: 0, instrument: 0, key: 45 },
          { tick: 4, layer: 1, instrument: 0, key: 50 },
          { tick: 4, layer: 2, instrument: 0, key: 55 },
        ]});
        const tmpK6a = 'synth_chord_near.nbs';
        writeFileSync(path.join(__dirname, tmpK6a), nbsK6a);
        const refK6 = new Map([[0, { type: 'independent', sound: true }],
          [1, { type: 'independent', sound: true }], [2, { type: 'independent', sound: true }]]);
        const rK6a = runE2E(tmpK6a, { ...k1Opts, refLayers: refK6, refLanes: [{ tracks: [0, 1, 2], start: { dz: 0, dy: 0 } }] });
        ok = verifyE2E('参考车道池·和弦连线近距', rK6a) && ok;
        const statK6a = rK6a.result.stats;
        const tlbK6a = rK6a.result.sfxTickList;
        // 独立行：t0 I(44)=(0,0,-1)、I(50)=(0,0,5)；t4 I(45)=(0,0,0)、I(50)=(0,0,5)、I(55)=(0,0,10)
        const I24 = (n) => sfxParticleCmd(0, 0, n);
        const expK6a1 = sfxConnectCmd([0, 0, -1], [0, 0, 1], 1, 15,
          SFX_CONNECT_DEFAULTS.m, SFX_CONNECT_DEFAULTS.alpha, SFX_CONNECT_DEFAULTS); // (44→45) L=1 Δt=4 → N0=10 cpt=3 P=15
        const expK6a2 = sfxConnectCmd([0, 0, 5], [0, 0, 10], 5, 55,
          SFX_CONNECT_DEFAULTS.m, SFX_CONNECT_DEFAULTS.alpha, SFX_CONNECT_DEFAULTS); // (50→55 挂靠) L=5 Δt=4 → N0=50 cpt=11 P=55
        if (statK6a.sfxStandaloneNotes !== 5 || statK6a.sfxConnectLines !== 2
          || JSON.stringify(tlbK6a[0].lines) !== JSON.stringify([I24(-1), I24(5), expK6a1, expK6a2])
          || JSON.stringify(tlbK6a[1].lines) !== JSON.stringify([I24(0), I24(5), I24(10)])) {
          console.log(`FAIL 和弦连线近距：indep=${statK6a.sfxStandaloneNotes} conn=${statK6a.sfxConnectLines} 行=${JSON.stringify(tlbK6a)}（期望 t0 [I(44),I(50),线1,线2] / t4 [I(45),I(50),I(55)]；(50→50) L=0 跳过）`); ok = false;
        } else {
          console.log('PASS 和弦连线近距（Δt≤32）：1:1 最近邻 + 落单音就近挂靠（1:3）、L=0 对跳过；和弦每音独立粒子行');
        }
        // K6b 远距 Δt=40：MIDI式车道 [layer0, layer1, layer2]；
        //   A t0 = [45(L0)] → B t40 = [45(L0), 48(L1), 52(L2)]：严格 1:1 仅 (45→45,L=0 跳过)
        //   → 0 条线（远距不挂靠、落单不连）
        const nbsK6b = makeNbs({ tempoTps: 20, songLength: 48, layers: 3, noteSpecs: [
          { tick: 0, layer: 0, instrument: 0, key: 45 },
          { tick: 40, layer: 0, instrument: 0, key: 45 },
          { tick: 40, layer: 1, instrument: 0, key: 48 },
          { tick: 40, layer: 2, instrument: 0, key: 52 },
        ]});
        const tmpK6b = 'synth_chord_far.nbs';
        writeFileSync(path.join(__dirname, tmpK6b), nbsK6b);
        const rK6b = runE2E(tmpK6b, { ...k1Opts, refLayers: refK6, refLanes: [{ tracks: [0, 1, 2], start: { dz: 0, dy: 0 } }] });
        ok = verifyE2E('参考车道池·和弦连线远距', rK6b) && ok;
        const statK6b = rK6b.result.stats;
        const tlbK6b = rK6b.result.sfxTickList;
        if (statK6b.sfxStandaloneNotes !== 4 || statK6b.sfxConnectLines !== 0
          || JSON.stringify(tlbK6b[0].lines) !== JSON.stringify([I24(0)])
          || JSON.stringify(tlbK6b[1].lines) !== JSON.stringify([I24(0), I24(3), I24(7)])) {
          console.log(`FAIL 和弦连线远距：indep=${statK6b.sfxStandaloneNotes} conn=${statK6b.sfxConnectLines} 行=${JSON.stringify(tlbK6b)}（期望 conn=0：Δt=40>32 严格 1:1、(45→45) L=0 跳过、落单不连）`); ok = false;
        } else {
          console.log('PASS 和弦连线远距（Δt>32）：严格 1:1、落单音不连（0 条线）');
        }
      }
    }
    // J) 消失型（2026-09-07e 用户定规格：演奏 tick 前 N tick 提前出现、恰在演奏 tick 消亡）：
    //    t−N 生成 #Cube conditional 行（寿命 = 实际提前量，构建替换原型 age 字段）；钳位 t−N<0 → tick 0；
    //    门控 = effects 显式含 'vanish'（默认不勾选，opt-in）；锚点 bound=虚拟主位 / independent=车道 start。
    //    J1 默认不勾选不产；J2 bound N=10 钳位（t0 跳过 / t2 寿命 2 落 tick0）；
    //    J3 MIDI式 start 锚点 + 空 tick 回退；J4 N=0 全跳过；J5 仅 vanish → sfxVanishTicks 支撑孤立 CB。
    {
      // 命令字面量（与 SFX_VANISH_PROTO 逐字对照，几何写死、仅坐标段与寿命替换）
      const VANISH = (dy, dz, N) => sfxVanishCmd(0, dy, dz, N, SFX_VANISH_DEFAULTS);
      const vanLite = (dy, dz, N) => `particleex conditional minecraft:end_rod ~0 ~${dy} ~${dz} 1 0.95 0.89 1 0 0 0 0.5 0.5 0.5 '(abs(y)==0.5&!(abs(z)<0.5))|(abs(x)==0.5&(!(abs(z)<0.5)|!(abs(y)<0.5)))' 0.1 ${N} 'vy=0.05' 1.0 null`;
      // 单元：寿命字段 = age（原型索引 10 的 '20'），step '0.1' 不动 + normVanishParams 3 字段校验
      if (VANISH(2, 6, 7) !== vanLite(2, 6, 7) || !VANISH(2, 6, 7).includes(' 0.1 7 \'vy=0.05\'')
        || JSON.stringify(normVanishParams({ particle: 'minecraft:heart', color: '0.5 0.5 0.5 1', ahead: 3 }))
          !== JSON.stringify({ particle: 'minecraft:heart', color: '0.5 0.5 0.5 1', ahead: 3 })
        || normVanishParams({ particle: 'x', color: '1 0.95 0.89 1', ahead: -1 }) !== undefined
        || normVanishParams({ particle: 'x', color: '1 0.95 0.89', ahead: 1 }) !== undefined
        || normVanishParams({ particle: 'x', color: '1 0.95 0.89 2', ahead: 1 }) !== undefined
        || normVanishParams({ particle: 'x', color: '1 0.95 0.89 1', ahead: 1.5 }) !== undefined
        || normVanishParams(null) !== undefined) {
        console.log(`FAIL 消失型单元：cmd=${VANISH(2, 6, 7)}（期望 ${vanLite(2, 6, 7)}；age 字段=寿命、step 0.1 保留；normVanishParams 校验非法值 → undefined）`); ok = false;
      } else {
        console.log('PASS 消失型单元：#Cube 命令 age 字段=寿命（step 0.1 保留）、normVanishParams 3 字段校验');
      }
      // J1 默认不勾选：refLanes 无 effects（缺省 trigger/connect/background 全选、vanish 不勾选）
      //   → sfxVanishNotes=0、行与 A 场景期望逐位一致（[P0R, BC_26] / [P0R]）
      const rJ1 = runE2E(tmpFile, {
        lane0: { dz: 0, dy: 0 }, refLayers: REF,
        groups: [{ layers: [0] }], groupStarts: [{ dz: 3, dy: 0 }],
        refLanes: [{ tracks: [0], type: 'bound', start: { dz: 6, dy: 1 } }],
      });
      const statJ1 = rJ1.result.stats;
      const tlbJ1 = rJ1.result.sfxTickList;
      if (statJ1.sfxVanishNotes !== 0 || tlbJ1.length !== 2
        || JSON.stringify(tlbJ1[0].lines) !== JSON.stringify([P0R, BC_26])
        || JSON.stringify(tlbJ1[1].lines) !== JSON.stringify([P0R])) {
        console.log(`FAIL 消失型默认不勾选：vanish=${statJ1.sfxVanishNotes} 行=${JSON.stringify(tlbJ1)}（期望 0 行、行与缺省全选一致 [P0R,BC_26]/[P0R]）`); ok = false;
      } else {
        console.log('PASS 消失型默认不勾选（opt-in）：不产行、产物与缺省全选逐位一致（旧存档向后兼容）');
      }
      // J2 bound 车道 N=10 钳位：t0（life=0 跳过）/ t2 → gT=0 life=2；
      //   effects ['trigger','vanish']（无 connect → 无连接线）；行序：消失行最前（生成块在放置循环前）
      const rJ2 = runE2E(tmpFile, {
        lane0: { dz: 0, dy: 0 }, refLayers: REF,
        groups: [{ layers: [0] }], groupStarts: [{ dz: 3, dy: 0 }],
        refLanes: [{ tracks: [0], type: 'bound', start: { dz: 6, dy: 1 },
          effects: ['trigger', 'vanish'],
          sfxParams: { vanish: { particle: 'minecraft:end_rod', color: '1 0.95 0.89 1', ahead: 10 } } }],
      });
      ok = verifyE2E('参考车道池·消失型 bound 钳位', rJ2) && ok;
      const statJ2 = rJ2.result.stats;
      const tlbJ2 = rJ2.result.sfxTickList;
      if (statJ2.sfxVanishNotes !== 1 || statJ2.commandBlocks !== 2 || tlbJ2.length !== 2
        || JSON.stringify(tlbJ2[0].lines) !== JSON.stringify([VANISH(2, 6, 2), P0R])
        || JSON.stringify(tlbJ2[1].lines) !== JSON.stringify([P0R])) {
        console.log(`FAIL 消失型 bound 钳位：vanish=${statJ2.sfxVanishNotes} CB=${statJ2.commandBlocks} 行=${JSON.stringify(tlbJ2)}（期望 t0 跳过、t2 钳位 gT=0 life=2 → tick0 [VANISH(2), P0R, BC_26] / tick2 [P0R]，锚 (0,2,6)）`); ok = false;
      } else {
        console.log('PASS 消失型 bound 钳位：t=0 无提前量跳过、t=2 提前量不足钳位 tick 0（寿命=实际提前量 2）');
      }
      // J3 MIDI式 independent：锚点 = 车道 start（可拖，{dz:4,dy:2}）→ (0,2,4)；
      //   effects 仅 ['vanish']（trigger 不勾 → 无独立行）→ tick0 仅消失行、tick2 空 tick 回退
      const rJ3 = runE2E(tmpFile, {
        lane0: { dz: 0, dy: 0 },
        refLayers: new Map([[0, { type: 'independent', sound: true }]]),
        groups: [{ layers: [0] }], groupStarts: [{ dz: 3, dy: 0 }],
        refLanes: [{ tracks: [0], start: { dz: 4, dy: 2 },
          effects: ['vanish'],
          sfxParams: { vanish: { particle: 'minecraft:end_rod', color: '1 0.95 0.89 1', ahead: 10 } } }],
      });
      const statJ3 = rJ3.result.stats;
      const tlbJ3 = rJ3.result.sfxTickList;
      if (statJ3.sfxVanishNotes !== 1 || statJ3.sfxStandaloneNotes !== 0
        || statJ3.commandBlocks !== 1 || statJ3.sfxEmptyTicks !== 1 || tlbJ3.length !== 1
        || JSON.stringify(tlbJ3[0].lines) !== JSON.stringify([VANISH(2, 4, 2)])) {
        console.log(`FAIL 消失型 MIDI 锚点：vanish=${statJ3.sfxVanishNotes} indep=${statJ3.sfxStandaloneNotes} CB=${statJ3.commandBlocks} empty=${statJ3.sfxEmptyTicks} 行=${JSON.stringify(tlbJ3)}（期望 tick0 [VANISH(2)@ (0,2,4)]、tick2 空 tick 回退）`); ok = false;
      } else {
        console.log('PASS 消失型 MIDI式锚点 = 车道 start（可拖基准）、生成行自持 CB、演奏 tick 空 tick 回退');
      }
      // J4 N=0：每 tick 提前量为 0 → 全跳过（无 t−N 可生成）
      const rJ4 = runE2E(tmpFile, {
        lane0: { dz: 0, dy: 0 }, refLayers: REF,
        groups: [{ layers: [0] }], groupStarts: [{ dz: 3, dy: 0 }],
        refLanes: [{ tracks: [0], type: 'bound', start: { dz: 6, dy: 1 },
          effects: ['vanish'],
          sfxParams: { vanish: { particle: 'minecraft:end_rod', color: '1 0.95 0.89 1', ahead: 0 } } }],
      });
      const statJ4 = rJ4.result.stats;
      if (statJ4.sfxVanishNotes !== 0 || rJ4.result.sfxTickList.length !== 0
        || statJ4.commandBlocks !== 0 || statJ4.sfxEmptyTicks !== 2) {
        console.log(`FAIL 消失型 N=0：vanish=${statJ4.sfxVanishNotes} 行=${rJ4.result.sfxTickList.length} CB=${statJ4.commandBlocks} empty=${statJ4.sfxEmptyTicks}（期望全跳过：0 行 0 CB、t0/t2 空 tick 回退）`); ok = false;
      } else {
        console.log('PASS 消失型 N=0：提前量为 0 → 全跳过（寿命 = 实际提前量 = 0 无意义）');
      }
      // J5 仅 vanish（trigger 不勾）：音符 t20/t40 → 生成行落 t10/t30（sfxVanishTicks 支撑孤立 CB）；
      //   t20/t40 有 sfxEntries 但无行 → 空 tick 回退（CB 还原雪块、TE 移除）
      const nbsJ5 = makeNbs({ tempoTps: 20, songLength: 48, layers: 1, noteSpecs: [
        { tick: 20, layer: 0, instrument: 0, key: 45 },
        { tick: 40, layer: 0, instrument: 0, key: 50 },
      ]});
      const tmpJ5 = 'synth_vanish.nbs';
      writeFileSync(path.join(__dirname, tmpJ5), nbsJ5);
      const rJ5 = runE2E(tmpJ5, {
        lane0: { dz: 0, dy: 0 }, refLayers: REF,
        groups: [{ layers: [0] }], groupStarts: [{ dz: 3, dy: 0 }],
        refLanes: [{ tracks: [0], type: 'bound', start: { dz: 6, dy: 1 },
          effects: ['vanish'],
          sfxParams: { vanish: { particle: 'minecraft:end_rod', color: '1 0.95 0.89 1', ahead: 10 } } }],
      });
      ok = verifyE2E('参考车道池·消失型孤立 CB', rJ5) && ok;
      const statJ5 = rJ5.result.stats;
      const tlbJ5 = rJ5.result.sfxTickList;
      if (statJ5.sfxVanishNotes !== 2 || statJ5.commandBlocks !== 2 || statJ5.sfxEmptyTicks !== 2
        || tlbJ5.length !== 2
        || tlbJ5[0].tick !== 10 || tlbJ5[1].tick !== 30
        || JSON.stringify(tlbJ5[0].lines) !== JSON.stringify([VANISH(2, 6, 10)])
        || JSON.stringify(tlbJ5[1].lines) !== JSON.stringify([VANISH(2, 6, 10)])) {
        console.log(`FAIL 消失型孤立 CB：vanish=${statJ5.sfxVanishNotes} CB=${statJ5.commandBlocks} empty=${statJ5.sfxEmptyTicks} 行=${JSON.stringify(tlbJ5)}（期望 行落 t10/t30 各 [VANISH(10)]、CB=2 自持、t20/t40 空 tick 回退）`); ok = false;
      } else {
        console.log('PASS 消失型 sfxVanishTicks 支撑孤立 CB：生成 tick（无参考音符）自持 function/CB，演奏 tick 无行 → 空 tick 回退');
      }
      // L) 背景型（2026-09-10 实现：按乐曲小节间隔周期性激活，与具体音符无关，铺底氛围）：
      //    小节长 = 拍号×18.125 tick 取整（4/4→73、3/4→54）；行 = 用户全文命令（trim 后逐字）；
      //    门控 = effects 含 'background'（缺省 = 勾选）+ 模板非空 → 旧存档/未填模板产物逐位不变；
      //    行落 tick 0/barLen/2·barLen…，sfxBackgroundTicks 支撑轨道 0 CB。
      {
        const BG_CMD = 'particleex bg minecraft:portal ~ ~0.5 ~ 0.5 0.1 0.1 0 0 0 0 10 0.4 1.0 null';
        const REFIND = new Map([[0, { type: 'independent', sound: true }]]);
        // L1 单元：sfxBarLen 拍号映射 + 非法兜底；sfxNormBackground trim/空/类型
        if (sfxBarLen({ timeSignature: 4 }) !== 73 || sfxBarLen({ timeSignature: 3 }) !== 54
          || sfxBarLen({ timeSignature: 0 }) !== 73 || sfxBarLen({}) !== 73
          || sfxNormBackground('  ' + BG_CMD + '  ') !== BG_CMD
          || sfxNormBackground('') !== null || sfxNormBackground('   ') !== null
          || sfxNormBackground(null) !== null || sfxNormBackground(123) !== null) {
          console.log(`FAIL 背景型单元：barLen(4)=${sfxBarLen({ timeSignature: 4 })} barLen(3)=${sfxBarLen({ timeSignature: 3 })}（期望 73/54；非法拍号 → 73）normBg 空/非字符串 → null`); ok = false;
        } else {
          console.log('PASS 背景型单元：sfxBarLen 拍号×18.125 取整（4→73、3→54、非法→73）+ sfxNormBackground trim/空/类型校验');
        }
        // L2 默认不产：refLane 无 background 文本（J1 配置）→ sfxBackgroundNotes=0、行与 A 场景逐位一致
        const rL2 = runE2E(tmpFile, {
          lane0: { dz: 0, dy: 0 }, refLayers: REF,
          groups: [{ layers: [0] }], groupStarts: [{ dz: 3, dy: 0 }],
          refLanes: [{ tracks: [0], type: 'bound', start: { dz: 6, dy: 1 } }],
        });
        const statL2 = rL2.result.stats;
        const tlbL2 = rL2.result.sfxTickList;
        if (statL2.sfxBackgroundNotes !== 0 || tlbL2.length !== 2
          || JSON.stringify(tlbL2[0].lines) !== JSON.stringify([P0R, BC_26])
          || JSON.stringify(tlbL2[1].lines) !== JSON.stringify([P0R])) {
          console.log(`FAIL 背景型默认不产：bg=${statL2.sfxBackgroundNotes} 行=${JSON.stringify(tlbL2)}（期望 0 行、行与缺省一致 [P0R,BC_26]/[P0R]）`); ok = false;
        } else {
          console.log('PASS 背景型默认不产（模板留空）：不产行、产物与未实现时逐位一致（旧存档向后兼容）');
        }
        // L3 e2e 4/4（barLen=73）：3 小节内音符 t0/t100/t200 → 背景行落 tick 0/73/146（219 ≥ nTicks=209 不产）；
        //   tick0 行序 = [背景行, 绑定行, 连接线]（背景块在绑定行段之前；bound 车道 connect 缺省开 → t0→t100 连接线 Δt=100）；CB = {0,73,100,146,200} 共 5
        const BC_100 = boundConn(2, 6, 100);   // (0,2,6) 沿 X 200 格
        const nbsL3 = makeNbs({ tempoTps: 20, songLength: 208, layers: 1, noteSpecs: [
          { tick: 0, layer: 0, instrument: 0, key: 45 },
          { tick: 100, layer: 0, instrument: 0, key: 50 },
          { tick: 200, layer: 0, instrument: 0, key: 45 },
        ]});
        writeFileSync(path.join(__dirname, 'synth_bg.nbs'), nbsL3);
        const rL3 = runE2E('synth_bg.nbs', {
          lane0: { dz: 0, dy: 0 }, refLayers: REF,
          groups: [{ layers: [0] }], groupStarts: [{ dz: 3, dy: 0 }],
          refLanes: [{ tracks: [0], type: 'bound', start: { dz: 6, dy: 1 },
            sfxParams: { background: BG_CMD } }],
        });
        ok = verifyE2E('参考车道池·背景型 4/4', rL3) && ok;
        const statL3 = rL3.result.stats;
        const tlbL3 = rL3.result.sfxTickList;
        if (statL3.sfxBackgroundNotes !== 3 || statL3.commandBlocks !== 5
          || statL3.sfxEmptyTicks !== 0 || tlbL3.length !== 5
          || tlbL3[0].tick !== 0 || tlbL3[1].tick !== 73 || tlbL3[2].tick !== 100
          || tlbL3[3].tick !== 146 || tlbL3[4].tick !== 200
          || JSON.stringify(tlbL3[0].lines) !== JSON.stringify([BG_CMD, P0R, BC_100])
          || JSON.stringify(tlbL3[1].lines) !== JSON.stringify([BG_CMD])
          || JSON.stringify(tlbL3[3].lines) !== JSON.stringify([BG_CMD])
          || JSON.stringify(tlbL3[2].lines) !== JSON.stringify([P0R, BC_100])
          || JSON.stringify(tlbL3[4].lines) !== JSON.stringify([P0R])) {
          console.log(`FAIL 背景型 4/4 e2e：bg=${statL3.sfxBackgroundNotes} CB=${statL3.commandBlocks} empty=${statL3.sfxEmptyTicks} 行=${JSON.stringify(tlbL3)}（期望 bg=3 落 t0/73/146、CB=5、tick0 [BG,P0R]、小节空 tick [BG] 自持 CB）`); ok = false;
        } else {
          console.log('PASS 背景型 4/4 e2e：行落 tick 0/73/146（小节长 73）、sfxBackgroundTicks 支撑孤立 CB、tick0 行序 [背景,绑定]');
        }
        // L4 显式取消勾选背景型（effects 无 background，trigger/connect 显式开启）+ 模板有值 → 不产（勾选门控）
        const rL4 = runE2E(tmpFile, {
          lane0: { dz: 0, dy: 0 }, refLayers: REF,
          groups: [{ layers: [0] }], groupStarts: [{ dz: 3, dy: 0 }],
          refLanes: [{ tracks: [0], type: 'bound', start: { dz: 6, dy: 1 },
            effects: ['trigger', 'connect'],
            sfxParams: { background: BG_CMD } }],
        });
        const statL4 = rL4.result.stats;
        if (statL4.sfxBackgroundNotes !== 0 || JSON.stringify(rL4.result.sfxTickList) !== JSON.stringify(tlbL2)) {
          console.log(`FAIL 背景型取消勾选：bg=${statL4.sfxBackgroundNotes} 行=${JSON.stringify(rL4.result.sfxTickList)}（期望 0 行、行与 L2 逐位一致）`); ok = false;
        } else {
          console.log('PASS 背景型显式取消勾选：模板有值也不产（门控 = 勾选 ∧ 模板非空）');
        }
        // L5 3/4 拍号（barLen=54）：音符 t0/t100、songLength=120 → 小节 tick 0/54/108（162 ≥ nTicks=121 不产）
        const nbsL5 = makeNbs({ tempoTps: 20, songLength: 120, layers: 1, timeSig: 3, noteSpecs: [
          { tick: 0, layer: 0, instrument: 0, key: 45 },
          { tick: 100, layer: 0, instrument: 0, key: 50 },
        ]});
        writeFileSync(path.join(__dirname, 'synth_bg_34.nbs'), nbsL5);
        const rL5 = runE2E('synth_bg_34.nbs', {
          lane0: { dz: 0, dy: 0 }, refLayers: REF,
          groups: [{ layers: [0] }], groupStarts: [{ dz: 3, dy: 0 }],
          refLanes: [{ tracks: [0], type: 'bound', start: { dz: 6, dy: 1 },
            sfxParams: { background: BG_CMD } }],
        });
        const statL5 = rL5.result.stats;
        const tlbL5 = rL5.result.sfxTickList;
        if (statL5.sfxBackgroundNotes !== 3 || statL5.commandBlocks !== 4
          || tlbL5.length !== 4
          || tlbL5[0].tick !== 0 || tlbL5[1].tick !== 54 || tlbL5[2].tick !== 100 || tlbL5[3].tick !== 108
          || JSON.stringify(tlbL5[0].lines) !== JSON.stringify([BG_CMD, P0R, BC_100])
          || JSON.stringify(tlbL5[1].lines) !== JSON.stringify([BG_CMD])
          || JSON.stringify(tlbL5[2].lines) !== JSON.stringify([P0R])
          || JSON.stringify(tlbL5[3].lines) !== JSON.stringify([BG_CMD])) {
          console.log(`FAIL 背景型 3/4 e2e：bg=${statL5.sfxBackgroundNotes} CB=${statL5.commandBlocks} 行=${JSON.stringify(tlbL5)}（期望 barLen=54 → 行落 0/54/108、CB=4）`); ok = false;
        } else {
          console.log('PASS 背景型 3/4 拍号：小节长 54（3×18.125 取整）→ 行落 0/54/108');
        }
        // N) 粒子组名（2026-09-10：particleex 命令组位开放为车道级可选参数，缺省保持 null）：
        //    触发型（group 附加在 5 字段模板上，仅 tail 末 token = null 时替换组位）/
        //    连接型（sfxConnectCmd 末位）/ 消失型（sfxVanishCmd 索引 13）
        {
          const CG = 'cg1', VG = 'vg1', TG = 'tg1';
          // N1 单元：三处组位写入 + 校验规则（多 token/非字符串组名 → 丢弃该字段）
          const connG = sfxConnectCmd([0, 0, 0], [2, 0, 0], 2, 5, 10, 0, { ...SFX_CONNECT_DEFAULTS, group: CG });
          const connG0 = sfxConnectCmd([0, 0, 0], [2, 0, 0], 2, 5, 10, 0, SFX_CONNECT_DEFAULTS);
          const vanG = sfxVanishCmd(0, 2, 6, 9, { ...SFX_VANISH_DEFAULTS, ahead: 9, group: VG });
          const tgBase = { ...SFX_PARTICLE_FIELDS };
          const tgCmd = sfxParticleCmdWithGroup(0, 2, 6, { ...tgBase, group: TG }, TG);
          const tgPlain = sfxParticleCmdWithGroup(0, 2, 6, tgBase, undefined);
          const tailNoNull = { ...tgBase, tail: '1 0.95 0.89 1 0 0 0 -10 10 0.1 20 1.0 end' };
          const tgIgnored = sfxParticleCmdWithGroup(0, 2, 6, { ...tailNoNull, group: TG }, TG);
          // 校验规则：非字符串/空组名 → 忽略（不存该字段，返回 5 字段对象）；含空白（多 token）→ 整模板无效（undefined）
          if (connG.slice(-3) !== CG
            || connG0.slice(-4) !== 'null'
            || vanG.slice(-3) !== VG || tgCmd.slice(-3) !== TG
            || tgPlain !== sfxParticleCmdFromParts(0, 2, 6, tgBase)
            || tgIgnored !== sfxParticleCmdFromParts(0, 2, 6, tailNoNull)
            || normSfxParams({ ...tgBase, group: 'a b' }) !== undefined
            || JSON.stringify(normSfxParams({ ...tgBase, group: 5 })) !== JSON.stringify(normSfxParams(tgBase))
            || normSfxParams({ ...tgBase, group: '' }) === undefined
            || normSfxParams({ ...tgBase, group: TG }).group !== TG
            || normConnectParams({ ...SFX_CONNECT_DEFAULTS, group: 'x y' }) !== undefined
            || normConnectParams({ ...SFX_CONNECT_DEFAULTS, group: CG }).group !== CG
            || normVanishParams({ particle: 'minecraft:end_rod', color: '1 0.95 0.89 1', ahead: 1, group: VG }).group !== VG
            || normVanishParams({ particle: 'minecraft:end_rod', color: '1 0.95 0.89 1', ahead: 1, group: '' }) === undefined) {
            console.log(`FAIL 组名单元：conn=${connG} van=${vanG} tg=${tgCmd}（期望 conn/van/tg 末位分别 ${CG}/${VG}/${TG}、缺省 null；tail 末 token 非 null 时不替换；非字符串/空组名忽略、多 token → 整模板无效）`); ok = false;
          } else {
            console.log('PASS 组名单元：触发/连接/消失三命令组位写入（缺省 null）、tail 末 token 非 null 时忽略、校验规则（单 token）');
          }
          // N2 e2e 触发型：bound 车道 + 完整 5 字段模板（= 默认命令拆分）+ group → 绑定行组位 = tg1
          const rN2 = runE2E(tmpFile, {
            lane0: { dz: 0, dy: 0 }, refLayers: REF,
            groups: [{ layers: [0] }], groupStarts: [{ dz: 3, dy: 0 }],
            refLanes: [{ tracks: [0], type: 'bound', start: { dz: 6, dy: 1 },
              sfxParams: { ...SFX_PARTICLE_FIELDS, group: TG } }],
          });
          const tlbN2 = rN2.result.sfxTickList;
          const expN2 = sfxParticleCmdWithGroup(0, 2, 6, { ...SFX_PARTICLE_FIELDS, group: TG }, TG);
          if (!expN2.endsWith(' ' + TG) || tlbN2.length !== 2
            || JSON.stringify(tlbN2[0].lines) !== JSON.stringify([expN2, BC_26])
            || JSON.stringify(tlbN2[1].lines) !== JSON.stringify([expN2])) {
            console.log(`FAIL 组名 e2e 触发型：行=${JSON.stringify(tlbN2)}（期望绑定行组位 ${TG}、连接线不受触发模板组名影响仍默认命令）`); ok = false;
          } else {
            console.log('PASS 组名 e2e 触发型：绑定行按本车道模板 + 组名生成（组位末 token 替换），连接线不受影响');
          }
          // N3 e2e 消失型：vanish.group → 生成行组位 = vg1（bound t20/t40、N=10 → 行落 t10/t30）
          const nbsN3 = makeNbs({ tempoTps: 20, songLength: 52, layers: 1, noteSpecs: [
            { tick: 20, layer: 0, instrument: 0, key: 45 },
            { tick: 40, layer: 0, instrument: 0, key: 50 },
          ]});
          const tmpN3 = 'synth_vanish_g.nbs';
          writeFileSync(path.join(__dirname, tmpN3), nbsN3);
          const rN3 = runE2E(tmpN3, {
            lane0: { dz: 0, dy: 0 }, refLayers: REF,
            groups: [{ layers: [0] }], groupStarts: [{ dz: 3, dy: 0 }],
            refLanes: [{ tracks: [0], type: 'bound', start: { dz: 6, dy: 1 },
              effects: ['vanish'],
              sfxParams: { vanish: { particle: 'minecraft:end_rod', color: '1 0.95 0.89 1', ahead: 10, group: VG } } }],
          });
          ok = verifyE2E('参考车道池·消失型组名', rN3) && ok;
          const statN3 = rN3.result.stats;
          const tlbN3 = rN3.result.sfxTickList;
          const expN3 = sfxVanishCmd(0, 2, 6, 10, { ...SFX_VANISH_DEFAULTS, ahead: 10, group: VG });
          if (statN3.sfxVanishNotes !== 2 || tlbN3.length !== 2
            || JSON.stringify(tlbN3[0].lines) !== JSON.stringify([expN3])
            || JSON.stringify(tlbN3[1].lines) !== JSON.stringify([expN3])) {
            console.log(`FAIL 组名 e2e 消失型：vanish=${statN3.sfxVanishNotes} 行=${JSON.stringify(tlbN3)}（期望 t10/t30 各 [vanish 组位 ${VG}]）`); ok = false;
          } else {
            console.log(`PASS 组名 e2e 消失型：生成行组位 = ${VG}（sfxVanishCmd 索引 13），自持 CB`);
          }
        }
      }
    }
  } catch (e) {
    console.log('FAIL 参考车道池异常:', e.stack || e.message);
    ok = false;
  }
}

process.exit(ok ? 0 : 1);
