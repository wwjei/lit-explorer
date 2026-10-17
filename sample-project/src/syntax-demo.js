/**
 * 语法高亮演示：下面这些构造跨越多行。
 * 逐行正则高亮会在这些地方出错，有状态的 TextMate 语法才能处理正确。
 */

/* 跨行块注释
   第二行仍然是注释颜色
   const notCode = "这一行不应该被当成代码";
   结束 */

const template = `
  模板字符串跨行，
  里面的 ${interpolation} 与普通文本都要正确着色
  第 3 行
`;

const sql = `
  SELECT id, name
  FROM users
  WHERE created_at > '2026-01-01'
  ORDER BY id DESC;
`;

// 正则里的斜杠不会误判成注释
const urlPattern = /^https?:\/\/[^/]+\/(.*)$/;

export function highlightTargets() {
  const obj = { a: 1, b: [2, 3], c: { d: '4' } };
  return Object.keys(obj).map((k) => `${k}:${typeof obj[k]}`);
}

class Counter {
  #count = 0;

  increment(step = 1) {
    this.#count += step;
    return this.#count;
  }

  get value() {
    return this.#count;
  }
}

export default Counter;
