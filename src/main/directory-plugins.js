'use strict';

const { randomUUID } = require('node:crypto');
const catalog = require('../shared/directory-providers.json');
const get = (object, path) => String(path || '').split('.').reduce((v, k) => v && v[k], object);
const fail = (code) => Object.assign(new Error(code), { code });
const text = (v, max = 256) => typeof v === 'string' && v.length <= max && !/[\x00-\x1f\x7f]/.test(v) ? v : '';
const remoteID = (v) => text(v) && v !== '.' && v !== '..' && !/[\/\\\s?#]/.test(v) ? v : '';
const id = (v) => /^[A-Za-z0-9_-]{1,256}$/.test(v || '') ? v : '';

// 只从应用自带的清单注册插件；页面不能注册 API 域名或请求模板。
function providers(manifest = catalog) {
  if (manifest.apiVersion !== 1 || !Array.isArray(manifest.providers)) throw fail('PLUGIN_VERSION');
  const registry = new Map();
  for (const p of manifest.providers) {
    const url = new URL(p.apiOrigin);
    if (!id(p.id) || registry.has(p.id) || url.protocol !== 'https:' || url.origin !== p.apiOrigin
      || url.username || !Array.isArray(p.documentHosts) || !p.documentHosts.length || !p.success || !p.success.field || !p.root || !['directory', 'document'].includes(p.root.kind)) throw fail('PLUGIN_MANIFEST');
    for (const op of [p.list, p.details, ...(p.initialize ? [p.initialize] : [])]) {
      if (!op || !['GET', 'POST'].includes(op.method) || !/^\/(?!\/)[a-z0-9_/$:.-]+$/i.test(op.path) || op.path.split('/').includes('..')
        || !op.fields || !op.entries) throw fail('PLUGIN_MANIFEST');
    }
    registry.set(p.id, p);
  }
  return registry;
}
function substitute(value, vars) {
  if (typeof value === 'string') {
    if (value.startsWith('$')) { if (!(value.slice(1) in vars)) throw fail('PLUGIN_TEMPLATE'); return vars[value.slice(1)]; }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, vars)]));
  return value;
}
function safeDocumentUrl(raw, provider) {
  if (!text(raw, 4096)) throw fail('UNSAFE_URL');
  let url;
  try { url = new URL(raw); } catch { throw fail('UNSAFE_URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
    || !provider.documentHosts.some((host) => url.hostname === host || url.hostname.endsWith('.' + host))) throw fail('UNSAFE_URL');
  return url.toString();
}
function normalize(raw, provider, fields) {
  const node = {};
  for (const [key, field] of Object.entries(fields)) {
    const value = field.startsWith('=') ? field.slice(1) : get(raw, field);
    node[key] = key === 'hasChildren' && typeof value === 'boolean' ? value : text(value, key === 'url' ? 4096 : 256);
  }
  if (!remoteID(node.id) || !remoteID(node.type) || !node.name) throw fail('BAD_RESPONSE');
  for (const key of ['scopeId', 'documentId', 'documentType']) if (node[key] && !remoteID(node[key])) throw fail('BAD_RESPONSE');
  node.kind = node.type === provider.directoryType && node.hasChildren !== false ? 'directory' : 'document';
  // 不把 API 返回的任意链接直接交给网页视图。
  if (node.url) node.url = safeDocumentUrl(node.url, provider);
  return node;
}

function rootConfig(provider, raw) {
  let rootId = raw, rootType = provider.root.defaultType;
  if (/^https:/i.test(raw || '')) {
    const url = new URL(safeDocumentUrl(raw, provider));
    const path = url.pathname.replace(/^\/|\/$/g, '');
    const prefix = Object.keys(provider.root.urlTypes).find((p) => path.startsWith(p + '/'));
    if (!prefix) throw fail('BAD_REQUEST');
    rootType = provider.root.urlTypes[prefix];
    try { rootId = decodeURIComponent(path.slice(prefix.length + 1)); } catch { throw fail('BAD_REQUEST'); }
  }
  if (!remoteID(rootId) || !remoteID(rootType)) throw fail('BAD_REQUEST');
  return { rootId, rootType };
}

function createDirectoryPlugins({ store, fetch: fetcher = globalThis.fetch, manifest = catalog, authNow }) {
  const registry = providers(manifest);
  const auth = require('./feishu-auth').createFeishuAuth({ fetch: fetcher, now: authNow });
  let project = '';
  let generation = 0;
  let saved = [];
  const sessions = new Map();
  const connecting = new Set();
  let mutations = Promise.resolve();
  const key = (p) => process.platform === 'win32' ? p.toLowerCase() : p;
  function disconnectAll() { auth.clear(); for (const s of [...sessions.values(), ...connecting]) s.abort.abort(); sessions.clear(); connecting.clear(); }
  function activate(root) { disconnectAll(); project = root; generation++; saved = []; }
  async function mounts() {
    const root = project, seq = generation;
    const state = await store.load();
    if (seq !== generation) throw fail('SUPERSEDED');
    const list = state.directoryMounts && state.directoryMounts[key(root)];
    saved = (Array.isArray(list) ? list : []).filter((m) => m && id(m.id) && registry.has(m.providerId) && remoteID(m.rootId) && text(m.name)).slice(0, 32);
    return saved.map((m) => ({ ...m, rootKind: registry.get(m.providerId).root.kind, connected: sessions.has(m.id) }));
  }
  async function persist(next) {
    const root = project, seq = generation;
    const state = await store.load();
    if (seq !== generation) throw fail('SUPERSEDED');
    await store.patch({ directoryMounts: { ...(state.directoryMounts || {}), [key(root)]: next } });
    if (seq === generation) saved = next;
  }
  function mutate(fn) { const job = mutations.then(fn); mutations = job.catch(() => {}); return job; }
  function session(mountId) {
    const s = sessions.get(mountId);
    if (!s) throw fail('AUTH_REQUIRED');
    return s;
  }
  function nodeFor(s, nodeId) {
    const node = s.nodes.get(nodeId);
    if (!node) throw fail('OUTSIDE_MOUNT');
    return node;
  }
  async function request(s, op, node, cursor = '') {
    if (s.abort.signal.aborted) throw fail('SUPERSEDED');
    if (s.pending >= 4) throw fail('BUSY');
    const vars = { nodeId: node.id, nodeType: node.type, cursor, scopeId: node.scopeId || s.scopeId || '', documentId: node.documentId || node.id, documentType: node.documentType || node.type };
    const requestPath = op.path.replace(/\$(nodeId|nodeType|scopeId|documentId|documentType)\b/g, (_m, key) => { if (!remoteID(vars[key])) throw fail('BAD_RESPONSE'); return encodeURIComponent(vars[key]); });
    const url = new URL(requestPath, s.provider.apiOrigin);
    for (const [k, v] of Object.entries(substitute(op.query || {}, vars))) if (v !== '') url.searchParams.set(k, String(v));
    const controller = new AbortController();
    const abort = () => controller.abort();
    s.abort.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 15000);
    s.pending++;
    try {
      const response = await fetcher(url.toString(), { method: op.method, redirect: 'error', signal: controller.signal,
        headers: { Authorization: 'Bearer ' + (s.credential ? await s.credential.token(s.abort.signal) : s.token), 'Content-Type': 'application/json' },
        ...(op.body ? { body: JSON.stringify(substitute(op.body, vars)) } : {}) });
      if (response.status === 401) throw fail('AUTH_REQUIRED');
      if (response.status === 403) throw fail('FORBIDDEN');
      if (response.status === 404) throw fail('NOT_FOUND');
      if (response.status === 429) throw fail('RATE_LIMITED');
      if (!response.ok) throw fail('NETWORK');
      // 流式限制响应体，避免先分配一个无上限的大 JSON。
      const reader = response.body.getReader();
      let size = 0;
      const chunks = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 2 * 1024 * 1024) { await reader.cancel(); throw fail('RESPONSE_TOO_LARGE'); }
        chunks.push(Buffer.from(value));
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('BAD_RESPONSE'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('BAD_RESPONSE');
      if ((s.provider.authCodes || []).includes(get(body, s.provider.success.field))) throw fail('AUTH_REQUIRED');
      if (get(body, s.provider.success.field) !== s.provider.success.value) throw fail('PROVIDER_ERROR');
      if (s.abort.signal.aborted) throw fail('SUPERSEDED');
      return body;
    } catch (err) {
      if (err.code === 'AUTH_REQUIRED') {
        for (const [mountId, current] of sessions) if (current === s) { s.abort.abort(); sessions.delete(mountId); }
      }
      if (err.code && /^[A-Z_]+$/.test(err.code)) throw err;
      throw fail(s.abort.signal.aborted ? 'SUPERSEDED' : controller.signal.aborted ? 'TIMEOUT' : 'NETWORK');
    } finally { clearTimeout(timer); s.abort.signal.removeEventListener('abort', abort); s.pending--; }
  }
  async function page(s, nodeId, cursor = '', refresh = false) {
    const node = nodeFor(s, nodeId);
    if (node.kind !== 'directory' || !text(cursor, 2048)) {
      if (node.kind !== 'directory' || cursor !== '') throw fail('BAD_REQUEST');
    }
    if (cursor && !(s.cursors.get(nodeId) || new Set()).has(cursor)) throw fail('OUTSIDE_MOUNT');
    const cacheKey = nodeId + ':' + cursor;
    const cached = s.cache.get(cacheKey);
    if (!refresh && cached && cached.until > Date.now()) return cached.value;
    const body = await request(s, s.provider.list, node, cursor);
    const raw = get(body, s.provider.list.entries);
    if (!Array.isArray(raw) || raw.length > 200) throw fail('BAD_RESPONSE');
    const entries = raw.map((entry) => normalize(entry, s.provider, s.provider.list.fields));
    const nextCursor = get(body, s.provider.list.hasMore) ? text(get(body, s.provider.list.cursor), 2048) : '';
    if (get(body, s.provider.list.hasMore) && (!nextCursor || nextCursor === cursor)) throw fail('BAD_RESPONSE');
    if (s.nodes.size + entries.length > 10000) throw fail('LIMIT');
    entries.forEach((entry) => s.nodes.set(entry.id, entry));
    if (nextCursor) { if (!s.cursors.has(nodeId)) s.cursors.set(nodeId, new Set()); s.cursors.get(nodeId).add(nextCursor); }
    const value = { directory: node, entries, nextCursor };
    if (s.cache.size >= 128) s.cache.delete(s.cache.keys().next().value);
    s.cache.set(cacheKey, { until: Date.now() + 60000, value });
    return value;
  }
  async function connect(input) {
    const seq = generation;
    if (!project) throw fail('NO_WORKSPACE');
    await mounts();
    const previous = input.id && saved.find((m) => m.id === input.id);
    if (input.id && !previous) throw fail('NOT_FOUND');
    const provider = registry.get(previous ? previous.providerId : input.providerId);
    if (!provider || (!input.authId && (!text(input.token, 4096) || /\s/.test(input.token))) || (input.authId && (provider.apiOrigin !== 'https://open.feishu.cn' || !provider.id.startsWith('feishu-')))) throw fail('BAD_REQUEST');
    const config = previous || { id: randomUUID(), providerId: input.providerId,
      ...rootConfig(provider, input.rootId), name: text(input.name) || provider.name };
    if (!previous && saved.length >= 32) throw fail('LIMIT');
    let root = { id: config.rootId, name: config.name, type: config.rootType || provider.root.defaultType, kind: provider.root.kind };
    const credential = input.authId ? auth.take(input.authId) : null;
    const s = { provider, credential, attemptId: text(input.attemptId, 128), token: input.token, nodes: new Map([[root.id, root]]), cache: new Map(), cursors: new Map(), abort: new AbortController(), pending: 0 };
    // 先验证凭据和根目录，成功才保存挂载；失败不覆盖已有连接。
    connecting.add(s);
    try {
      if (provider.initialize) {
        const body = await request(s, provider.initialize, root);
        const resolved = normalize(get(body, provider.initialize.node), provider, provider.initialize.fields);
        if (resolved.id !== root.id) throw fail('BAD_RESPONSE');
        root = { ...resolved, name: config.name, kind: provider.root.kind };
        s.nodes.set(root.id, root); s.scopeId = root.scopeId;

      }
      if (root.kind === 'directory') await page(s, root.id);
      else { const detail = await documentDetails(s, root); safeDocumentUrl(detail.url, provider); }
      return await mutate(async () => {
        if (seq !== generation) throw fail('SUPERSEDED');
        if (previous && !saved.some((m) => m.id === previous.id)) throw fail('NOT_FOUND');
        if (!previous && saved.length >= 32) throw fail('LIMIT');
        const next = previous ? saved.slice() : [...saved, config];
        await persist(next);
        if (seq !== generation) throw fail('SUPERSEDED');
        const old = sessions.get(config.id);
        if (old) old.abort.abort();
        sessions.set(config.id, s);
        return { ...config, rootKind: provider.root.kind, connected: true };
      });
    } catch (err) { s.abort.abort(); throw err; }
    finally { connecting.delete(s); }
  }
  async function documentDetails(s, node) {
    const body = await request(s, s.provider.details, node);
    const entries = get(body, s.provider.details.entries);
    if (!Array.isArray(entries) || !entries.length) throw fail('FORBIDDEN');
    const detail = normalize(entries[0], s.provider, s.provider.details.fields);
    if (detail.id !== (node.documentId || node.id) || detail.type !== (node.documentType || node.type)) throw fail('BAD_RESPONSE');
    return { ...node, name: detail.name, modifiedAt: detail.modifiedAt, url: detail.url };
  }
  async function details(mountId, nodeId) {
    const s = session(mountId), node = nodeFor(s, nodeId);
    if (node.kind !== 'directory') return documentDetails(s, node);
    if (!s.provider.initialize) return { ...node };
    const body = await request(s, s.provider.initialize, node);
    const detail = normalize(get(body, s.provider.initialize.node), s.provider, s.provider.initialize.fields);
    if (detail.id !== node.id) throw fail('BAD_RESPONSE');
    return detail;
  }
  async function remove(mountId) {
    const seq = generation;
    return mutate(async () => {
      if (seq !== generation) throw fail('SUPERSEDED');
      await mounts();
      await persist(saved.filter((m) => m.id !== mountId));
      if (seq !== generation) throw fail('SUPERSEDED');
      const s = sessions.get(mountId); if (s) s.abort.abort(); sessions.delete(mountId);
    });
  }
  return {
    activate, mounts, connect, details, remove,
    authStart: (input) => { if (!project) throw fail('NO_WORKSPACE'); return auth.start(input); },
    authPoll: (input) => auth.poll(input.authId),
    cancel: (attemptId) => { auth.cancel(attemptId); for (const s of connecting) if (s.attemptId === attemptId) s.abort.abort(); return true; },
    providers: () => [...registry.values()].map(({ id, name, version, root, inputHint }) => ({ id, name, version, rootKind: root.kind, inputHint, apiVersion: 1 })),
    list: (mountId, nodeId, cursor, refresh) => page(session(mountId), nodeId, cursor, refresh),
    open: async (mountId, nodeId) => {
      const s = session(mountId), node = nodeFor(s, nodeId);
      if (node.kind !== 'document' && !node.documentId) throw fail('BAD_REQUEST');
      const detail = await documentDetails(s, node);
      return { name: detail.name, url: safeDocumentUrl(detail.url, s.provider) };
    }
  };
}
// 单一桥接分派口，Electron IPC 与契约测试复用；不暴露通用 HTTP 请求。
async function invokeDirectoryPlugin(service, method, args = {}) {
  try {
    let value;
    if (method === 'providers') value = service.providers();
    else if (method === 'mounts') value = await service.mounts();
    else if (method === 'authStart') value = await service.authStart(args);
    else if (method === 'authPoll') value = await service.authPoll(args);
    else if (method === 'connect') value = await service.connect(args);
    else if (method === 'cancel') value = service.cancel(args.attemptId);
    else if (method === 'list') value = await service.list(args.mountId, args.nodeId, args.cursor || '', args.refresh === true);
    else if (method === 'details') value = await service.details(args.mountId, args.nodeId);
    else if (method === 'open') value = await service.open(args.mountId, args.nodeId);
    else if (method === 'remove') { await service.remove(args.mountId); value = true; }
    else return { error: 'BAD_REQUEST' };
    return { value };
  } catch (err) { return { error: /^[A-Z_]+$/.test(err.code || '') ? err.code : 'BAD_REQUEST' }; }
}
module.exports = { createDirectoryPlugins, invokeDirectoryPlugin, providers, safeDocumentUrl, substitute };
