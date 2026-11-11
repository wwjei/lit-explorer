'use strict';
// 仅接受宿主指定的固定文件与系统保护器；不可用时只保留内存，不降级明文。
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
function protectedCredentials({ file, available, encrypt, decrypt } = {}) {
  return {
    async load() {
      if (!file || !available?.()) return null;
      try { const raw = await fs.readFile(file); if (raw.length > 65536) return null; return JSON.parse(decrypt(raw)); } catch { return null; }
    },
    async save(value) {
      if (!file || !available?.()) return false;
      const raw = encrypt(JSON.stringify(value));
      const temporary = file + '.' + randomUUID() + '.tmp';
      try {
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await fs.writeFile(temporary, raw, { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, file); return true;
      } finally { await fs.rm(temporary, { force: true }); }
    },
    async remove() { try { if (file) await fs.rm(file, { force: true }); } catch { throw Object.assign(new Error('CREDENTIAL_STORAGE'), { code: 'CREDENTIAL_STORAGE' }); } }
  };
}
module.exports = { protectedCredentials };
