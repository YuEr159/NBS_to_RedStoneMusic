// brace-scan.mjs — 扫描 index.html 内联脚本的括号平衡，找出未闭合构造
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const code = html.match(/<script>([\s\S]*)<\/script>/)[1];

const stack = [];
let line = 1;
const opens = { '{': '}', '(': ')', '[': ']' };
const closes = { '}': '{', ')': '(', ']': '[' };

for (let i = 0; i < code.length;) {
  const ch = code[i];
  if (ch === '\n') line++;
  if (ch === '/' && code[i + 1] === '/') { i += 2; while (i < code.length && code[i] !== '\n') i++; continue; }
  if (ch === '/' && code[i + 1] === '*') {
    i += 2;
    while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) { if (code[i] === '\n') line++; i++; }
    i += 2;
    continue;
  }
  if (ch === "'" || ch === '"') {
    const q = ch; i++;
    while (i < code.length) {
      if (code[i] === '\\') { i += 2; continue; }
      if (code[i] === q) break;
      if (code[i] === '\n') line++;
      i++;
    }
    i++;
    continue;
  }
  if (ch === '`') {
    i++;
    while (i < code.length) {
      if (code[i] === '\\') { i += 2; continue; }
      if (code[i] === '`') break;
      if (code[i] === '\n') line++;
      i++;
    }
    i++;
    continue;
  }
  if (opens[ch]) stack.push({ ch, line, pos: i });
  else if (closes[ch]) {
    const top = stack.pop();
    if (!top || top.ch !== closes[ch]) {
      console.log(`不匹配闭合 ${JSON.stringify(ch)} at line ${line}（栈顶 ${top ? JSON.stringify(top.ch) + ' 开于 ' + top.line : '空'}）`);
    }
  }
  i++;
}
console.log('剩余未闭合:', stack.length);
stack.slice(0, 20).forEach(s => {
  const ctx = code.slice(Math.max(0, s.pos - 60), s.pos + 60).replace(/\r?\n/g, '⏎');
  console.log(`  未闭合 ${JSON.stringify(s.ch)} 打开于第 ${s.line} 行附近：…${ctx}…`);
});
