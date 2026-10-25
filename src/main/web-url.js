'use strict';

/**
 * 网页快捷方式的地址校验。
 *
 * 渲染进程与主进程共用这一份规则：渲染进程用它做表单的即时反馈，主进程用它做
 * 唯一可信的判定（持久化白名单与 web:sync 都过这里）。只放行 http(s)：
 *   - file: 能读本机文件；
 *   - javascript: / data: 是脚本入口；
 *   - ms-msdt: 这类自定义协议会拉起本机程序。
 * 地址里带账号密码的一律拒绝，避免把凭据写进 state.json。
 */

const MAX_URL_CHARS = 2048;

/** 返回规范化后的地址；不可用返回空字符串 */
function normalizeWebUrl(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s || s.length > MAX_URL_CHARS) return '';
  // 浏览器解析地址时会忽略 C0 控制字符（尤其制表符 / 换行），
  // 所以必须先拒绝，不能指望 URL 解析器报错
  if (/[\u0000-\u001f\u007f]/.test(s)) return '';
  let u;
  try {
    u = new URL(s);
  } catch {
    return '';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  if (u.username || u.password) return '';
  return u.toString();
}

/** 名称留空时的默认名：去掉 www. 的主机名 */
function webHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

module.exports = { MAX_URL_CHARS, normalizeWebUrl, webHost };
