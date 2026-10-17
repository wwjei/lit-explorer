const UNITS = ['B', 'KB', 'MB', 'GB'];

/**
 * 把字节数格式化成人类可读的大小。
 */
export function formatSize(bytes) {
  let n = Number(bytes) || 0;
  let i = 0;

  while (n >= 1024 && i < UNITS.length - 1) {
    n /= 1024;
    i += 1;
  }

  return `${n.toFixed(i === 0 ? 0 : 1)} ${UNITS[i]}`;
}

export function formatTime(input) {
  const d = new Date(input);
  const pad = (v) => String(v).padStart(2, '0');

  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
