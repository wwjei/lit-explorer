'use strict';
// 按官方公开授权脚本与目录协议实现，只暴露四个读取工具，不依赖 CLI / MCP 客户端。
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const protocol = require('../shared/kdocs-skill.json');
const fail = (code) => Object.assign(new Error(code), { code });
const secret = (v) => typeof v === 'string' && v.length > 0 && v.length <= 16384 && !/[\s\x00-\x1f\x7f]/.test(v);
const fingerprint = (token) => createHash('sha256').update(token).digest('hex');
function createKdocsPlugin({ fetch: fetcher = globalThis.fetch, credentials, now = Date.now } = {}) {
  let credential = null, loaded = false, epoch = 0, mutations = Promise.resolve();
  const attempts = new Map();
  const clientId = randomBytes(8).toString('hex');
  const mutate = (fn) => { const job = mutations.then(fn); mutations = job.catch(() => {}); return job; };
  async function ensure(signal) {
    if (signal?.aborted) throw fail('SUPERSEDED');
    await mutate(async () => {
      if (loaded) return;
      credential = await credentials?.load() || null; loaded = true;
      if (!secret(credential?.token) || !Number.isSafeInteger(credential?.expiresAt) || credential.expiresAt <= now()) credential = null;
      else credential.persistent = true;
    });
    if (signal?.aborted) throw fail('SUPERSEDED');
  }
  async function identity(signal) {
    await ensure(signal);
    if (!credential || credential.expiresAt <= now()) throw fail('AUTH_REQUIRED');
    return fingerprint(credential.token);
  }
  async function post(endpoint, body, signal, token, limit = 2 * 1024 * 1024) {
    const control = new AbortController(), abort = () => control.abort();
    if (signal?.aborted) throw fail('SUPERSEDED');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 15000);
    try {
      const response = await fetcher(endpoint, { method: 'POST', redirect: 'error', signal: control.signal,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token, 'X-Cli-Version': protocol.version, 'X-Client-Id': clientId, 'X-Run-Id': randomBytes(8).toString('hex'), 'X-Client-Source': 'lit-explorer', 'X-Request-Source': 'lit-explorer' } : {}) },
        body: JSON.stringify(body) });
      // 认证被拒 / 取消时不解析或回显可能包含敏感信息的原始正文。
      if (response.status === 401) throw fail('AUTH_REQUIRED');
      if (response.status === 403) throw fail(endpoint === protocol.exchangeEndpoint ? 'KDOCS_PERSONAL_ONLY' : 'FORBIDDEN');
      if (response.status === 409) throw fail('AUTH_DENIED');
      if (response.status === 429) throw fail('RATE_LIMITED');
      if (!response.ok) throw fail('NETWORK');
      const reader = response.body.getReader(), chunks = []; let size = 0;
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length; if (size > limit) { await reader.cancel(); throw fail('RESPONSE_TOO_LARGE'); }
        chunks.push(Buffer.from(value));
      }
      let result;
      try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('BAD_RESPONSE'); }
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw fail('BAD_RESPONSE');
      if (signal?.aborted) throw fail('SUPERSEDED');
      return result;
    } catch (err) {
      if (/^[A-Z_]+$/.test(err.code || '')) throw err;
      throw fail(signal?.aborted ? 'SUPERSEDED' : control.signal.aborted ? 'TIMEOUT' : 'NETWORK');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  function cancel(id) { const a = attempts.get(id); if (a) a.abort.abort(); attempts.delete(id); }
  function clear() { epoch++; for (const id of attempts.keys()) cancel(id); }
  async function start(input) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.attemptId || '')) throw fail('BAD_REQUEST');
    clear();
    const a = { code: randomUUID(), phase: 'authorization', abort: new AbortController(), expiresAt: now() + 300000, nextAt: now() + 1000, busy: false, epoch };
    attempts.set(input.attemptId, a);
    try {
      await ensure(a.abort.signal);
      if (!input.forceLogin && credential && credential.expiresAt > now() + 30000) a.phase = 'ready';
      return view(input.attemptId, a);
    } catch (err) { cancel(input.attemptId); throw err; }
  }
  function view(id, a) {
    return { authId: id, phase: a.phase, url: a.phase === 'ready' ? '' : protocol.authorizationPage + '?auth_code=' + encodeURIComponent(a.code), interval: 1, expiresAt: a.expiresAt, persistent: !!credential?.persistent };
  }
  async function poll(id) {
    const a = attempts.get(id); if (!a) throw fail('AUTH_REQUIRED');
    if (a.busy) throw fail('BUSY');
    if (a.phase === 'ready') return view(id, a);
    if (now() >= a.expiresAt) { cancel(id); throw fail('AUTH_EXPIRED'); }
    if (now() < a.nextAt) return view(id, a);
    a.busy = true;
    try {
      const body = await post(protocol.exchangeEndpoint, { code: a.code }, a.abort.signal, '', 65536);
      if (now() >= a.expiresAt) throw fail('AUTH_EXPIRED');
      const code = body.data?.code ?? body.code;
      if (code === 202) { a.nextAt = now() + 1000; return view(id, a); }
      if (code === 403 || code === 403001) throw fail('KDOCS_PERSONAL_ONLY');
      if (code === 409) throw fail('AUTH_DENIED');
      if (code !== 200) throw fail('AUTH_FAILED');
      const token = body.data?.token || body.token, expires = body.data?.expires_in ?? body.expires_in;
      if (!secret(token) || !Number.isInteger(expires) || expires <= 0 || expires > 366 * 86400) throw fail('BAD_RESPONSE');
      await mutate(async () => {
        if (a.abort.signal.aborted || a.epoch !== epoch) throw fail('SUPERSEDED');
        const next = { token, expiresAt: now() + expires * 1000 };
        // 系统保护不可用或写入失败时仍允许本次登录，不落明文。
        let persistent = false;
        try { persistent = !!await credentials?.save(next); } catch {}
        if (!persistent) { try { await credentials?.remove(); } catch { throw fail('CREDENTIAL_STORAGE'); } }
        if (a.abort.signal.aborted || a.epoch !== epoch) { await credentials?.remove(); throw fail('SUPERSEDED'); }
        credential = { ...next, persistent }; a.phase = 'ready';
      });
      return view(id, a);
    } catch (err) { cancel(id); throw err; }
    finally { a.busy = false; }
  }
  async function logout() { clear(); await mutate(async () => { credential = null; loaded = true; await credentials?.remove(); }); return true; }
  async function invoke(operation, node, cursor, signal, expectedIdentity) {
    const identityNow = await identity(signal);
    if (expectedIdentity && expectedIdentity !== identityNow) throw fail('AUTH_REQUIRED');
    const token = credential.token;
    let tool, args;
    if (operation === 'list') {
      tool = node.id === '@my-documents' ? 'list_my_files' : 'list_files';
      args = { page_size: 100, ...(cursor ? { page_token: cursor } : {}), ...(tool === 'list_files' ? { parent_id: node.id, ...(node.scopeId ? { drive_id: node.scopeId } : {}) } : {}) };
    } else if (operation === 'details' || operation === 'open') { tool = operation === 'details' ? 'get_file_info' : 'get_file_link'; args = { file_id: node.id }; }
    else throw fail('BAD_REQUEST');
    try {
      const body = await post(protocol.toolEndpoint, { tool, args }, signal, token);
      if (body.code === 400006 || body.code === 401 || body.code === 401001) throw fail('AUTH_REQUIRED');
      if (body.code === 403001) throw fail('KDOCS_PERSONAL_ONLY');
      if (body.code === 403) throw fail('FORBIDDEN');
      if (body.code === 404) throw fail('NOT_FOUND');
      if (body.code === 429) throw fail('RATE_LIMITED');
      if (body.code !== 0) throw fail('PROVIDER_ERROR');
      if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) throw fail('BAD_RESPONSE');
      if (operation === 'list') return { code: 0, data: { ...body.data, has_more: !!body.data.next_page_token } };
      if (operation === 'details') return { code: 0, data: { items: [body.data] } };
      return body;
    } catch (err) {
      if (err.code === 'AUTH_REQUIRED') await mutate(async () => {
        if (credential && fingerprint(credential.token) === identityNow) { credential = null; await credentials?.remove(); }
      });
      throw err;
    }
  }
  return { ensure, identity, start, poll, cancel, clear, logout, invoke };
}
module.exports = { createKdocsPlugin };
