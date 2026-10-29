/* 通用目录插件界面：远程 node id 永远不进入本地文件系统导航。 */
(function () {
  'use strict';
  const esc = PV.highlight.escapeAttr;
  const errors = {
    AUTH_REQUIRED: '连接已过期，请重新输入访问令牌', FORBIDDEN: '没有权限，请检查应用权限和文档共享范围',
    NOT_FOUND: '目录或文档已不存在', RATE_LIMITED: '服务请求过于频繁，请稍后重试',
    NETWORK: '无法连接服务，请检查网络后重试', TIMEOUT: '请求超时，请重试',
    OUTSIDE_MOUNT: '该对象不属于当前挂载的已发现目录', UNSAFE_URL: '服务返回了不允许打开的链接',
    BAD_RESPONSE: '服务返回的数据不符合插件约定', PROVIDER_ERROR: '云服务拒绝了请求，请核对权限和根目录标识',
    LIMIT: '目录数据或挂载数量超过上限', BUSY: '请求处理中，请稍后重试'
  };
  let project = '', epoch = 0, requestId = 0;
  let pendingAttempt = '';
  let mounts = [], providers = [], hooks = {}, current = null;
  const trails = new Map();
  const dialog = document.createElement('dialog');
  dialog.className = 'cloud-dialog';
  document.body.appendChild(dialog);
  async function call(method, args = {}) {
    const response = await pv.directoryCall(method, args);
    if (response.error) throw Object.assign(new Error(errors[response.error] || response.error), { code: response.error });
    return response.value;
  }
  function close() {
    if (pendingAttempt) { pv.directoryCall('cancel', { attemptId: pendingAttempt }).catch(() => {}); pendingAttempt = ''; }
    requestId++;
    current = null;
    dialog.close();
    dialog.textContent = '';
    if (PV.web) PV.web.setOccluded(false);
  }
  function show(html) {
    dialog.innerHTML = '<div class="cloud-toolbar"><strong>参考来源</strong><button class="btn-quiet" data-cloud-close>关闭</button></div>' + html;
    if (!dialog.open) dialog.showModal();
    if (PV.web) PV.web.setOccluded(true);
  }
  function message(text) {
    const box = dialog.querySelector('.cloud-message');
    if (box) { box.textContent = text; box.setAttribute('role', 'status'); }
  }
  async function reloadMounts() {
    const seq = epoch;
    const list = await call('mounts');
    if (seq !== epoch) return;
    mounts = list;
    hooks.changed();
  }
  async function setProject(root) {
    const seq = ++epoch;
    project = root;
    mounts = [];
    trails.clear();
    close();
    try {
      const [list, plugins] = await Promise.all([call('mounts'), call('providers')]);
      if (seq !== epoch) return;
      mounts = list; providers = plugins; hooks.changed();
    } catch (err) { if (seq === epoch) hooks.toast(err.message); }
  }
  function rows() {
    return mounts.map((m) => '<div class="row fav-row cloud-fav" data-cloud-mount="' + esc(m.id) + '" role="button" tabindex="0" title="'
      + esc(m.name + (m.connected ? '（已连接）' : '（需要重新连接）')) + '">'
      + PV.icons.icon('globe', '', 14) + '<span class="nm">' + esc(m.name)
      + (m.connected ? '' : ' · 未连接') + '</span><button class="iconbtn" data-cloud-remove="' + esc(m.id)
      + '" title="移除此来源" aria-label="移除此来源">' + PV.icons.icon('close', '', 12) + '</button></div>').join('');
  }
  function connectForm(mount) {
    if (!project) { hooks.toast('请先打开项目'); return; }
    requestId++;
    current = null;
    const options = providers.map((p) => '<option value="' + esc(p.id) + '"' + (mount && mount.providerId === p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('');
    show('<form class="cloud-connect"><h3>' + (mount ? '重新连接 ' + esc(mount.name) : '添加云文档或 Wiki 目录') + '</h3>'
      + '<label>目录插件<select name="providerId"' + (mount ? ' disabled' : '') + '>' + options + '</select></label>'
      + '<label>名称<input name="name" maxlength="120" required value="' + esc(mount ? mount.name : '云文档') + '"' + (mount ? ' readonly' : '') + '></label>'
      + '<label>文档或目录链接 / 标识<input name="rootId" maxlength="4096" required value="' + esc(mount ? mount.rootId : '') + '"' + (mount ? ' readonly' : '') + '></label>'
      + '<p class="cloud-input-hint"></p><p>令牌需具备对应的云文档 / 知识库读取权限，并能访问选择的文档或目录。单文档入口只打开该文档；Wiki 节点可以浏览子项，也能打开节点自身的文档。</p>'
      + '<label>访问令牌<input name="token" type="password" maxlength="4096" required autocomplete="off" spellcheck="false"></label>'
      + '<p>令牌仅在本次连接会话中保留；切换项目或重启后需重新连接。目录 API 的身份与网页登录账号分别管理。</p>'
      + '<div class="cloud-message" aria-live="polite"></div><button class="btn-primary" type="submit">连接目录</button></form>');
    dialog.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const seq = epoch, req = ++requestId, form = event.target;
      pendingAttempt = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
      const input = { attemptId: pendingAttempt, id: mount && mount.id, providerId: form.elements.providerId.value,
        name: form.elements.name.value.trim(), rootId: form.elements.rootId.value.trim(), token: form.elements.token.value.trim() };
      form.elements.token.value = '';
      const button = form.querySelector('[type=submit]'); button.disabled = true;
      message('正在验证目录连接…');
      try {
        const job = call('connect', input);
        input.token = '';
        const result = await job;
        if (pendingAttempt === input.attemptId) pendingAttempt = '';
        if (seq !== epoch || req !== requestId) return;
        await reloadMounts();
        await browse(result);
      } catch (err) { input.token = ''; if (pendingAttempt === input.attemptId) pendingAttempt = ''; if (seq === epoch && req === requestId) { message(err.message); button.disabled = false; } }
    });
    const updateHint = () => { const provider = providers.find((p) => p.id === dialog.querySelector('[name=providerId]').value); dialog.querySelector('.cloud-input-hint').textContent = provider && provider.inputHint || '填写此来源的链接或标识'; };
    dialog.querySelector('[name=providerId]').addEventListener('change', updateHint); updateHint();
    dialog.querySelector('[name=token]').focus();
  }
  async function browse(mount) {
    if (!mount.connected) { connectForm(mount); return; }
    current = { mount, trail: trails.get(mount.id) || [{ id: mount.rootId, name: mount.name }], entries: [], next: '', directory: { id: mount.rootId, kind: mount.rootKind, name: mount.name } };
    if (mount.rootKind === 'document') { show('<div class="cloud-message" aria-live="polite"></div>'); await openNode(-1, false); return; }
    show('<div class="cloud-navigation"><button class="btn-quiet" data-cloud-up>上一级</button><strong class="cloud-path"></strong>'
      + '<button class="btn-quiet" data-cloud-current-document hidden>打开当前文档</button><button class="btn-quiet" data-cloud-refresh>刷新</button></div><div class="cloud-message" aria-live="polite"></div>'
      + '<div class="cloud-entries"></div><button class="btn-quiet" data-cloud-next hidden>加载更多</button><pre class="cloud-details" hidden></pre>');
    await load(false);
  }
  async function load(append, refresh = false) {
    const state = current;
    if (!state) return;
    const seq = epoch, req = ++requestId;
    const node = state.trail[state.trail.length - 1];
    const nextButton = dialog.querySelector('[data-cloud-next]'); nextButton.disabled = true;
    dialog.querySelector('.cloud-path').textContent = state.trail.map((n) => n.name).join(' / ');
    dialog.querySelector('[data-cloud-up]').disabled = state.trail.length <= 1;
    message('正在加载…');
    try {
      const result = await call('list', { mountId: state.mount.id, nodeId: node.id, cursor: append ? state.next : '', refresh });
      if (seq !== epoch || req !== requestId || current !== state) return;
      state.entries = [...new Map([...(append ? state.entries : []), ...result.entries].map((n) => [n.id, n])).values()];
      state.next = result.nextCursor;
      state.directory = result.directory;
      dialog.querySelector('[data-cloud-current-document]').hidden = !state.directory.documentId;
      trails.set(state.mount.id, state.trail.slice());
      dialog.querySelector('.cloud-entries').innerHTML = state.entries.map((n, i) => '<div class="cloud-entry"><button class="btn-quiet cloud-entry-open" data-cloud-entry="' + i + '">'
        + PV.icons.icon(n.kind === 'directory' ? 'folder' : 'file', '', 15) + '<span>' + esc(n.name) + '</span></button>'
        + (n.documentId && n.kind === 'directory' ? '<button class="btn-quiet" data-cloud-document="' + i + '">打开文档</button>' : '')
        + '<button class="btn-quiet" data-cloud-detail="' + i + '">详情</button></div>').join('');
      nextButton.hidden = !state.next;
      message(state.entries.length ? '' : '此目录为空');
      dialog.querySelector('.cloud-details').hidden = true;
    } catch (err) {
      if (seq === epoch && req === requestId) {
        message(err.message);
        if (err.code === 'AUTH_REQUIRED') { await reloadMounts(); state.mount.connected = false;
          dialog.querySelector('.cloud-message').insertAdjacentHTML('beforeend', ' <button class="btn-quiet" data-cloud-reconnect>重新连接</button>'); }
      }
    } finally { if (seq === epoch && req === requestId) nextButton.disabled = false; }
  }
  async function openNode(index, detailsOnly, forceDocument = false) {
    const state = current, node = state && (index < 0 ? state.directory : state.entries[index]);
    if (!node) return;
    if (!detailsOnly && !forceDocument && node.kind === 'directory') { state.trail.push({ id: node.id, name: node.name }); await load(false); return; }
    const seq = epoch, req = ++requestId;
    message(detailsOnly ? '正在查询详情…' : '正在获取文档链接…');
    try {
      const result = await call(detailsOnly ? 'details' : 'open', { mountId: state.mount.id, nodeId: node.id });
      if (seq !== epoch || req !== requestId || current !== state) return;
      if (detailsOnly) {
        const box = dialog.querySelector('.cloud-details'); box.hidden = false;
        box.textContent = JSON.stringify(result, null, 2); message('');
      } else { close(); hooks.openWeb({ url: result.url, name: result.name, kind: 'web', isDir: false, cloudMountId: state.mount.id, cloudNodeId: node.id }); }
    } catch (err) { if (seq === epoch && req === requestId) { message(err.message); if (err.code === 'AUTH_REQUIRED') { await reloadMounts(); state.mount.connected = false; dialog.querySelector('.cloud-message').insertAdjacentHTML('beforeend', ' <button class="btn-quiet" data-cloud-reconnect>重新连接</button>'); } } }
  }
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  dialog.addEventListener('keydown', (event) => event.stopPropagation());
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-cloud-add],[data-cloud-mount],[data-cloud-remove],[data-cloud-close],[data-cloud-up],[data-cloud-next],[data-cloud-refresh],[data-cloud-entry],[data-cloud-detail],[data-cloud-document],[data-cloud-current-document],[data-cloud-reconnect]');
    if (!target) return;
    const run = async () => {
      if (target.hasAttribute('data-cloud-close')) { close(); return; }
      if (target.hasAttribute('data-cloud-add')) { connectForm(); return; }
      if (target.hasAttribute('data-cloud-remove')) {
        const seq = epoch, mountId = target.dataset.cloudRemove;
        await call('remove', { mountId });
        if (seq !== epoch) return;
        // 已交给预览的网页也要关闭，不能在移除挂载后保留内容。
        hooks.clearPreviews(mountId); trails.delete(mountId); close(); await reloadMounts(); return;
      }
      if (target.hasAttribute('data-cloud-mount')) { const mount = mounts.find((m) => m.id === target.dataset.cloudMount); if (mount) await browse(mount); return; }
      if (target.hasAttribute('data-cloud-reconnect') && current) { connectForm(current.mount); return; }
      if (target.hasAttribute('data-cloud-up') && current && current.trail.length > 1) { current.trail.pop(); await load(false); return; }
      if (target.hasAttribute('data-cloud-next')) { await load(true); return; }
      if (target.hasAttribute('data-cloud-refresh')) { await load(false, true); return; }
      if (target.hasAttribute('data-cloud-current-document')) { await openNode(-1, false, true); return; }
      if (target.hasAttribute('data-cloud-document')) { await openNode(+target.dataset.cloudDocument, false, true); return; }
      if (target.hasAttribute('data-cloud-entry')) { await openNode(+target.dataset.cloudEntry, false); return; }
      if (target.hasAttribute('data-cloud-detail')) await openNode(+target.dataset.cloudDetail, true);
    };
    run().catch((err) => hooks.toast(err.message));
  });
  document.addEventListener('keydown', (event) => {
    const row = event.target.closest('[data-cloud-mount]');
    if (row && !event.target.closest('button') && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); event.stopImmediatePropagation(); row.click(); }
  });
  PV.cloud = { init: (options) => { hooks = options; }, setProject, rows,
    refresh: () => current ? current.mount.rootKind === 'document' ? openNode(-1, false, true) : load(false, true) : Promise.resolve() };
})();
