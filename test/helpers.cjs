'use strict';

/**
 * 测试用的小工具：断言、临时目录、可选范围执行、耗时统计。
 * 不引第三方测试框架——这些用例要能直接用 `npm test` 跑。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, '.tmp', 'test');

/* ------------------------------------------------------------------ *
 * 可选范围执行
 *
 *   --only=S2,S3   只跑这几段
 *   --skip=C1      跳过这几段
 *   --list         只列出各段 id，不执行
 *
 * 迭代时只跑相关的那一段，不必每次都把整个套件拖一遍。
 * ------------------------------------------------------------------ */
const argv = process.argv.slice(2);

function argValue(name) {
  const hit = argv.find((a) => a.indexOf(name + '=') === 0);
  return hit ? hit.slice(name.length + 1) : '';
}

const splitIds = (s) => String(s).split(',').map((x) => x.trim()).filter(Boolean);
const onlySet = new Set(splitIds(argValue('--only')));
const skipSet = new Set(splitIds(argValue('--skip')));
const LIST = argv.indexOf('--list') >= 0;

const sections = [];
const skipped = [];

function enabled(id) {
  if (onlySet.size) return onlySet.has(id);
  return !skipSet.has(id);
}

/* ---------------- 断言与耗时 ---------------- */

let passed = 0;
let failed = 0;

const timings = [];
const startedAt = Date.now();
let current = null;
let currentAt = 0;

/**
 * 声明并执行一段用例，id 是范围开关用的短名字。
 * 没被选中的段落整块跳过——**包括 fn 里的准备动作**（建夹具、开窗口），
 * 所以 --only 挑一段时不会为别的段落白付启动开销。
 */
async function run(id, title, fn) {
  sections.push({ id: id, title: title });
  if (LIST) return;
  if (!enabled(id)) {
    skipped.push(id);
    return;
  }
  const now = Date.now();
  if (current) timings.push({ title: current, ms: now - currentAt });
  else timings.push({ title: '启动与准备', ms: now - startedAt });
  current = id + ' · ' + title;
  currentAt = now;
  console.log('\n' + current);
  await fn();
}

function ok(name, cond, detail) {
  if (cond) {
    passed++;
    console.log('  \u2714 ' + name);
    return true;
  }
  failed++;
  console.log('  \u2718 ' + name + (detail === undefined ? '' : '  \u2192 ' + JSON.stringify(detail)));
  return false;
}

function eq(name, actual, expected) {
  return ok(name, actual === expected, { actual: actual, expected: expected });
}

/** 比较数组 / 对象（JSON 可表示的东西） */
function eqJson(name, actual, expected) {
  return ok(name, JSON.stringify(actual) === JSON.stringify(expected), { actual: actual, expected: expected });
}

/** 打印各段耗时与汇总，设置退出码；返回是否全部通过 */
function done() {
  if (LIST) {
    console.log('\n可选的段落 id：');
    for (const s of sections) console.log('  ' + s.id.padEnd(7) + s.title);
    const cmd = String(process.argv[1] || '').indexOf('integration') >= 0
      ? 'npm run test:integration'
      : 'npm run test:unit';
    console.log('\n只跑其中一段：' + cmd + ' -- --only=' + (sections[0] ? sections[0].id : ''));
    process.exitCode = 0;
    return true;
  }

  if (current) {
    timings.push({ title: current, ms: Date.now() - currentAt });
    current = null;
  }

  const known = new Set(sections.map((s) => s.id));
  const unknown = [].concat([...onlySet], [...skipSet]).filter((id) => !known.has(id));
  if (unknown.length) {
    failed++;
    console.log('\n\u2718 未知的段落 id：' + unknown.join(', ') + '（--list 可以看到全部）');
  }

  const total = timings.reduce((sum, t) => sum + t.ms, 0);
  if (timings.length) {
    console.log('\n各段耗时（合计 ' + total + ' ms）');
    for (const t of timings) console.log('  ' + String(t.ms).padStart(6) + ' ms  ' + t.title);
  }

  const note = skipped.length ? '，跳过 ' + skipped.length + ' 段（' + skipped.join(' ') + '）' : '';
  console.log('\n' + (failed
    ? '\u2718 ' + failed + ' 项失败，' + passed + ' 项通过' + note
    : '\u2714 全部通过（' + passed + ' 项）' + note));
  process.exitCode = failed ? 1 : 0;
  return failed === 0;
}

/** 每次运行都从干净目录开始：上一次的残留不能让用例假通过 */
function freshDir(name) {
  const dir = path.join(TMP, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 目录链接：Windows 用 junction（不需要管理员），其他平台用 dir */
function linkDir(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return true;
    return false;
  }
}

module.exports = { ROOT, TMP, run, ok, eq, eqJson, done, freshDir, linkDir };
