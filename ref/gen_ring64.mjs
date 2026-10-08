// 生成 ref/ring64_gain_table.csv（半径 64 圆盘全部整格的距离与增益表）
//       + ref/volume_decay.svg（音量衰减可视化：48 格线性衰减同心圆 + 半径 64 圆周 64 等分）
// 用法：node ref/gen_ring64.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const R = 64;
const rows = [];
for (let x = -R; x <= R; x++) {
  for (let z = -R; z <= R; z++) {
    const d = Math.hypot(x, z);
    if (d <= R) rows.push([x, z, d]);
  }
}
rows.sort((a, b) => a[2] - b[2] || a[0] - b[0] || a[1] - b[1]);

const lines = [
  '# 半径 64 圆盘内全部整格 (x,z) 的距离与声音增益参考表（声源在原点 (0,0)）',
  '# 公式：d = sqrt(x^2 + z^2)（格）；gain = max(0, 1 - d/48)（48 格线性衰减）',
  '# 排列：按距离升序（同距按 x、z 升序）；gain_pct 为增益百分比，1 位小数',
  'x,z,dist,gain_pct',
];
let audible = 0;
for (const [x, z, d] of rows) {
  const gain = Math.max(0, 1 - d / 48);
  if (gain > 0) audible++;
  lines.push(`${x},${z},${d.toFixed(1)},${(gain * 100).toFixed(1)}`);
}
lines.push('');
lines.push(`# 统计：总格数 ${rows.length}；可听（d<48，gain>0）${audible}；静音（d>=48，gain=0）${rows.length - audible}`);

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ring64_gain_table.csv');
fs.writeFileSync(out, lines.join('\n'));
console.log('written:', out);
console.log('total:', rows.length, 'audible:', audible, 'silent:', rows.length - audible);

// ===== 可视化 SVG：音符盒 48 格线性衰减同心圆 + 半径 64 圆周 64 等分 =====
const S = 4.5;                       // px/格
const L = 60, T = 60, W = 2 * (R + 6) * S, H = 2 * (R + 6) * S + 28;
const cx = L + (R + 6) * S, cy = T + (R + 6) * S;
const P = d => [cx + d * S, cy - d * S];
const f1 = v => v.toFixed(1);
const svg = [];
svg.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-monospace, Consolas, monospace">`);
svg.push(`<rect width="${W}" height="${H}" fill="#0d1117"/>`);
svg.push(`<text x="${cx}" y="24" text-anchor="middle" font-size="15" fill="#e6edf3" font-weight="bold">音符盒 48 格线性衰减：gain(d) = max(0, 1 − d/48)（声源在原点，俯视 X–Z 平面）</text>`);

// 可听区 / 静音区底色（r=48 分界）
svg.push(`<circle cx="${cx}" cy="${cy}" r="${48 * S}" fill="#1c2a3d"/>`);

// 圆环参考 12 / 24 / 36 / 48
for (const d of [12, 24, 36]) {
  svg.push(`<circle cx="${cx}" cy="${cy}" r="${d * S}" fill="none" stroke="#3b4a63" stroke-width="1"/>`);
}
svg.push(`<circle cx="${cx}" cy="${cy}" r="${48 * S}" fill="none" stroke="#e3b341" stroke-width="2.5"/>`);

// 半径 64 圆周 64 等分（1 点/5°）：点 + 连线 + 角度标注（每 45° 一个，含 0°）
const ringPts = [];
for (let k = 0; k < 64; k++) {
  const a = (k / 64) * Math.PI * 2;
  ringPts.push([cx + 64 * S * Math.cos(a), cy - 64 * S * Math.sin(a), a]);
}
svg.push(`<polygon points="${ringPts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')}" fill="none" stroke="#8b96a8" stroke-width="1.2" stroke-dasharray="5 4"/>`);
for (const [px, py, a] of ringPts) {
  svg.push(`<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="2.4" fill="#8b96a8"/>`);
  const deg = Math.round((a * 180) / Math.PI);
  if (deg % 45 === 0) {
    const tx = cx + 71 * S * Math.cos(a), ty = cy - 71 * S * Math.sin(a);
    svg.push(`<text x="${tx.toFixed(1)}" y="${(ty + 4).toFixed(1)}" text-anchor="middle" font-size="11" fill="#c9d1d9">${deg}°</text>`);
  }
}

// 圆环文字标注（放在 315° 方向线上，避免互相遮挡）
const ringLabels = [
  [12, '12 格 → 75%', 0],
  [24, '24 格 → 50%', 1],
  [36, '36 格 → 25%', 0],
  [48, '48 格 → 0%（可听边界）', 1],
];
for (const [d, txt, side] of ringLabels) {
  const col = d === 48 ? '#e3b341' : '#9aa7b8';
  const x = cx + d * S * Math.cos(Math.PI * 0.75);
  const y = cy - d * S * Math.sin(Math.PI * 0.75);
  svg.push(`<text x="${(x + 6).toFixed(1)}" y="${(y + (side ? 16 : -3)).toFixed(1)}" font-size="11.5" fill="${col}">${txt}</text>`);
}

// 半径 64 圆周标注（顶部 90° 点上方）
const [gx, gy] = P(64);
svg.push(`<text x="${gx.toFixed(1)}" y="${(gy - 10).toFixed(1)}" text-anchor="middle" font-size="11.5" fill="#c9d1d9">半径 64 圆周 64 等分（1 点/5°）：整格距离 63.5~64.3 → 全部 gain = 0.0%</text>`);

// 图例（底部）
const ly = T + 2 * (R + 6) * S + 16;
const legend = [
  ['#1c2a3d', '可听区 d&lt;48（7209 格）'],
  ['#0d1117', '静音区 d≥48（5644 格）'],
  ['#e3b341', '48 格可听边界'],
  ['#8b96a8', '半径 64 圆周 64 等分'],
];
let lx0 = cx - 320;
for (const [col, txt] of legend) {
  svg.push(`<rect x="${lx0}" y="${ly - 10}" width="14" height="12" fill="${col}" stroke="#555" stroke-width="0.8"/>`);
  svg.push(`<text x="${lx0 + 19}" y="${ly}" font-size="11.5" fill="#c9d1d9">${txt}</text>`);
  lx0 += 170;
}

const svgOut = path.join(path.dirname(fileURLToPath(import.meta.url)), 'volume_decay.svg');
fs.writeFileSync(svgOut, svg.join('\n'));
console.log('written:', svgOut);
