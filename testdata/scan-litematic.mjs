// scan-litematic.mjs — 扫描目录下所有 .litematic，列出其中出现的黄/绿/粘性系方块
import { readFileSync, readdirSync, statSync } from 'fs';
import zlib from 'zlib';
import path from 'path';

const dir = process.argv[2] || '.';
const files = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    const p = path.join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (e.endsWith('.litematic')) files.push(p);
  }
})(dir);

const INTEREST = /slime|honey|emerald|lime|yellow|green|froglight/;
for (const f of files) {
  try {
    const raw = zlib.gunzipSync(readFileSync(f)).toString('latin1');
    const names = new Set();
    const re = /minecraft:[a-z_0-9]+/g;
    let m;
    while ((m = re.exec(raw))) names.add(m[0].replace('minecraft:', ''));
    const odd = [...names].filter(n => INTEREST.test(n));
    console.log(f.replace(/\\/g, '/'), '→', odd.length ? `黄绿/粘性系: ${odd.join(', ')}` : '（无）');
  } catch (e) {
    console.log(f, '读取失败', e.message);
  }
}
