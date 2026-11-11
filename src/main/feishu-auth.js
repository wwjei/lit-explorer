'use strict';
// 参考飞书官方 CLI 的公开协议；实验入口，不分发公共 App Secret。
const config = require('../shared/feishu-auth.json');
const fail = (code) => Object.assign(new Error(code), { code });
const secret = (v) => typeof v === 'string' && v.length > 0 && v.length <= 4096 && !/[\s\x00-\x1f\x7f]/.test(v);
function verificationURL(raw) {
  let u;
  try { u = new URL(raw); } catch { throw fail('BAD_RESPONSE'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !['accounts.feishu.cn', 'open.feishu.cn'].includes(u.hostname)) throw fail('UNSAFE_URL');
  return u.href;
}
function seconds(v, fallback, max) { return Number.isInteger(v) && v > 0 ? Math.min(v, max) : fallback; }
function createFeishuAuth({ fetch: fetcher = globalThis.fetch, now = Date.now } = {}) {
  const flows = new Map();
  async function post(path, values, signal, basic) {
    const control = new AbortController();
    const abort = () => control.abort();
    if (signal.aborted) throw fail('SUPERSEDED');
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 15000);
    try {
      const response = await fetcher(config.accountsOrigin + path, { method: 'POST', redirect: 'error', signal: control.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(basic ? { Authorization: 'Basic ' + Buffer.from(basic).toString('base64') } : {}) },
        body: new URLSearchParams(values).toString() });
      const reader = response.body.getReader(), chunks = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 65536) { await reader.cancel(); throw fail('BAD_RESPONSE'); }
        chunks.push(Buffer.from(value));
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('BAD_RESPONSE'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('BAD_RESPONSE');
      if (signal.aborted) throw fail('SUPERSEDED');
      if (response.status === 429) throw fail('RATE_LIMITED');
      if (!body.error && (!response.ok || (body.code !== undefined && body.code !== 0))) throw fail('AUTH_FAILED');
      return body;
    } catch (err) {
      if (err.code && /^[A-Z_]+$/.test(err.code)) throw err;
      throw fail(signal.aborted ? 'SUPERSEDED' : control.signal.aborted ? 'TIMEOUT' : 'NETWORK');
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }
  function checkError(body) {
    if (!body.error) return;
    throw fail(({ access_denied: 'AUTH_DENIED', expired_token: 'AUTH_EXPIRED', invalid_grant: 'AUTH_EXPIRED' })[body.error] || 'AUTH_FAILED');
  }
  function pending(f, body, registration) {
    if (!secret(body.device_code) || (registration && !secret(body.user_code))) throw fail('BAD_RESPONSE');
    f.deviceCode = body.device_code;
    f.phase = registration ? 'registration' : 'authorization';
    f.url = registration ? verificationURL('https://open.feishu.cn/page/cli?user_code=' + encodeURIComponent(body.user_code || ''))
      : verificationURL(body.verification_uri_complete || body.verification_uri);
    f.userCode = typeof body.user_code === 'string' ? body.user_code.slice(0, 128) : '';
    f.interval = seconds(body.interval, 5, 60);
    f.expiresAt = now() + seconds(body.expire_in || body.expires_in, 600, 1800) * 1000;
    f.nextAt = now() + f.interval * 1000;
  }
  function view(f) {
    return { authId: f.id, phase: f.phase, url: f.url, userCode: f.userCode, interval: f.interval, expiresAt: f.expiresAt };
  }
  async function authorize(f) {
    const body = await post(config.devicePath, { client_id: f.appId, scope: config.scopes }, f.abort.signal, f.appId + ':' + f.appSecret);
    checkError(body); pending(f, body, false);
  }
  function tokens(f, body) {
    checkError(body);
    if (!secret(body.access_token) || (body.refresh_token && !secret(body.refresh_token)) || !Number.isInteger(body.expires_in) || body.expires_in <= 0) throw fail('BAD_RESPONSE');
    // 不把需要 DPoP 私钥的令牌误当成 Bearer 使用。
    if (String(body.token_type || 'Bearer').toLowerCase() !== 'bearer') throw fail('AUTH_UNSUPPORTED');
    f.accessToken = body.access_token;
    f.refreshToken = body.refresh_token || '';
    f.tokenExpiresAt = now() + Math.min(body.expires_in, 86400) * 1000;
    f.phase = 'ready'; f.url = ''; f.userCode = ''; f.deviceCode = '';
  }
  async function start(input) {
    // 一次只允许一个连接表单；先登记再请求，关闭表单可中断 begin。
    clear();
    const id = input.attemptId;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw fail('BAD_REQUEST');
    const f = { id, abort: new AbortController(), busy: false };
    flows.set(id, f);
    try {
      if (input.mode === 'personal') {
        const body = await post(config.registrationPath, { action: 'begin', archetype: 'PersonalAgent', auth_method: 'client_secret', request_user_info: 'open_id tenant_brand' }, f.abort.signal);
        checkError(body); pending(f, body, true);
      } else if (input.mode === 'application' && /^cli_[a-zA-Z0-9]{1,252}$/.test(input.appId || '') && secret(input.appSecret)) {
        f.appId = input.appId; f.appSecret = input.appSecret; await authorize(f);
      } else throw fail('BAD_REQUEST');
      return view(f);
    } catch (err) { cancel(id); throw err; }
  }
  async function poll(id) {
    const f = flows.get(id);
    if (!f) throw fail('AUTH_REQUIRED');
    if (f.busy) throw fail('BUSY');
    if (f.phase === 'ready') return view(f);
    if (now() >= f.expiresAt) { cancel(id); throw fail('AUTH_EXPIRED'); }
    if (now() < f.nextAt) return view(f);
    f.busy = true;
    try {
      const body = f.phase === 'registration'
        ? await post(config.registrationPath, { action: 'poll', device_code: f.deviceCode }, f.abort.signal)
        : await post(config.tokenPath, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: f.deviceCode, client_id: f.appId, client_secret: f.appSecret }, f.abort.signal);
      if (now() >= f.expiresAt) throw fail('AUTH_EXPIRED');
      // V1 仅支持飞书中国区；不向动态返回的域名发送凭据。
      if (body.user_info && body.user_info.tenant_brand && body.user_info.tenant_brand !== 'feishu') throw fail('AUTH_UNSUPPORTED');
      if (body.error === 'authorization_pending' || body.error === 'slow_down') {
        if (body.error === 'slow_down') f.interval = Math.min(f.interval + 5, 60);
      } else {
        checkError(body);
        if (f.phase === 'registration') {
          if (secret(body.client_id) && secret(body.client_secret)) {
            f.appId = body.client_id; f.appSecret = body.client_secret; await authorize(f);
          }
        } else tokens(f, body);
      }
      f.nextAt = now() + f.interval * 1000;
      return view(f);
    } catch (err) { cancel(id); throw err; }
    finally { f.busy = false; }
  }
  function take(id) {
    const f = flows.get(id);
    if (!f || f.phase !== 'ready' || f.abort.signal.aborted) throw fail('AUTH_REQUIRED');
    flows.delete(id);
    let refreshing;
    return { async token(signal) {
      if (signal.aborted) throw fail('SUPERSEDED');
      if (now() < f.tokenExpiresAt - 30000) return f.accessToken;
      if (!f.refreshToken) {
        if (now() < f.tokenExpiresAt) return f.accessToken;
        throw fail('AUTH_REQUIRED');
      }
      if (!refreshing) refreshing = (async () => {
        const body = await post(config.tokenPath, { grant_type: 'refresh_token', refresh_token: f.refreshToken, client_id: f.appId, client_secret: f.appSecret }, signal);
        tokens(f, body);
        return f.accessToken;
      })().catch((err) => {
        if (['AUTH_EXPIRED', 'AUTH_DENIED', 'AUTH_FAILED', 'AUTH_UNSUPPORTED'].includes(err.code)) {
          f.accessToken = ''; f.refreshToken = ''; f.tokenExpiresAt = 0; throw fail('AUTH_REQUIRED');
        }
        throw err;
      }).finally(() => { refreshing = null; });
      const value = await refreshing;
      if (signal.aborted) throw fail('SUPERSEDED');
      return value;
    } };
  }
  function cancel(id) { const f = flows.get(id); if (f) f.abort.abort(); flows.delete(id); }
  function clear() { for (const id of flows.keys()) cancel(id); }
  return { start, poll, take, cancel, clear };
}
module.exports = { createFeishuAuth, verificationURL };
