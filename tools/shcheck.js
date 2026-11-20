// POSIX sh 语法检查（零依赖）：逐行扫描，检查引号/括号/关键字配平、常见错误
// 用法: node tools/shcheck.js file.sh [file2.sh ...]
import fs from 'node:fs';

export function checkShell(text) {
  const errors = [];
  const lines = text.split(/\r?\n/);
  let inSingle = false;
  let inDouble = false;
  let heredoc = null; // { delim, strip }
  const stack = [];
  let ifDepth = 0;
  let caseDepth = 0;
  let parenDepth = 0;
  let braceDepth = 0;

  const pushErr = (ln, msg) => errors.push(`L${ln}: ${msg}`);

  for (let i = 0; i < lines.length; i++) {
    const ln = i + 1;
    let line = lines[i];
    if (heredoc) {
      const trimmed = line.replace(/^\t+/, '');
      const target = heredoc.strip ? trimmed : line;
      if (target === heredoc.delim) heredoc = null;
      continue;
    }
    // 去掉行尾注释（引号外）
    let code = '';
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      const next = line[j + 1];
      if (!inSingle && ch === '\\') { code += ch + (next ?? ''); j++; continue; }
      if (!inDouble && ch === "'") { inSingle = !inSingle; code += ch; continue; }
      if (!inSingle && ch === '"') { inDouble = !inDouble; code += ch; continue; }
      if (!inSingle && !inDouble && ch === '#' && (j === 0 || /\s/.test(line[j - 1]))) break;
      code += ch;
    }
    line = code;
    if (!line.trim()) continue;

    // heredoc 开始
    const hd = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
    if (hd) {
      heredoc = { delim: hd[2], strip: line.includes('<<-') };
      continue; // heredoc 内部内容不参与语法分析
    }

    // 关键字
    const words = line.replace(/[;|&]/g, ' ').trim().split(/\s+/);
    const isLoopDo = /^(for|while|until)\b/.test(line.trim()) || /;\s*do\b/.test(line);
    for (let w = 0; w < words.length; w++) {
      const word = words[w];
      if (word === 'then' && ifDepth === 0 && !/;\s*then\b/.test(line)) pushErr(ln, '意外的 then');
      if (word === 'do' && !isLoopDo) pushErr(ln, '意外的 do');
      if (word === 'if') ifDepth++;
      if (word === 'fi') { ifDepth--; if (ifDepth < 0) { pushErr(ln, '多余的 fi'); ifDepth = 0; } }
      if (word === 'case') caseDepth++;
      if (word === 'esac') { caseDepth--; if (caseDepth < 0) { pushErr(ln, '多余的 esac'); caseDepth = 0; } }
      if (word === '(') parenDepth++;
      if (word === ')') parenDepth--;
      if (word === '{') braceDepth++;
      if (word === '}') braceDepth--;
    }
    // 函数定义 xxx() {
    if (/^[A-Za-z_][A-Za-z0-9_]*\s*\(\)\s*\{/.test(line)) {
      // 开括号已计入 braceDepth
    }
    if (/\bfunction\b/.test(line)) pushErr(ln, '使用了非 POSIX 的 function 关键字');
  }

  if (inSingle) pushErr(lines.length, '单引号未闭合');
  if (inDouble) pushErr(lines.length, '双引号未闭合');
  if (heredoc) pushErr(lines.length, `heredoc 未结束: ${heredoc.delim}`);
  if (ifDepth !== 0) pushErr(lines.length, `if/fi 不配对（${ifDepth}）`);
  if (caseDepth !== 0) pushErr(lines.length, `case/esac 不配对（${caseDepth}）`);
  if (braceDepth !== 0) pushErr(lines.length, `花括号不配对（${braceDepth}）`);
  return errors;
}

if (process.argv[1] && process.argv[1].endsWith('shcheck.js')) {
  const files = process.argv.slice(2);
  if (!files.length) { console.error('用法: node tools/shcheck.js <file.sh>...'); process.exit(2); }
  let bad = 0;
  for (const f of files) {
    const errs = checkShell(fs.readFileSync(f, 'utf8'));
    if (errs.length) {
      bad++;
      console.log(`✗ ${f}`);
      for (const e of errs) console.log('   ', e);
    } else {
      console.log(`✓ ${f}`);
    }
  }
  process.exit(bad ? 1 : 0);
}
