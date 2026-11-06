/* 最新内容串行保存：期望版本、正在写入版本和已落盘版本分别管理。 */
(function () {
  'use strict';
  function create({ initial, write, onState, onSaved, onError }) {
    let desired = initial, persisted = initial;
    let revision = 0, persistedRevision = 0, inFlightRevision = null;
    let phase = 'idle', running = null;
    function transition(next) { phase = next; onState(next); }
    async function drain() {
      while (phase !== 'disposed' && desired !== persisted) {
        const value = desired, mine = revision;
        inFlightRevision = mine;
        transition('writing');
        let result;
        try { result = await write(value); }
        catch (err) { result = { error: 'EWRITE', message: String(err.message || err) }; }
        inFlightRevision = null;
        if (phase === 'disposed') return;
        if (!result || !result.ok) {
          transition(result && result.error === 'CONFLICT' ? 'conflict' : 'error');
          onError(result || { error: 'EWRITE' });
          return; // 冲突须重载；普通失败由下一次 submit 重试，不在后台无限重试。
        }
        persisted = value;
        persistedRevision = mine;
        onSaved(result);
      }
      if (phase !== 'disposed') { persistedRevision = revision; transition('idle'); }
    }
    return {
      submit(value) {
        if (phase === 'disposed' || phase === 'conflict') return running || Promise.resolve();
        desired = value; revision++;
        if (!running) {
          if (desired === persisted) { persistedRevision = revision; transition('idle'); return Promise.resolve(); }
          transition('writing');
          running = Promise.resolve().then(drain).finally(() => { running = null; });
        }
        return running;
      },
      dispose() { transition('disposed'); },
      state() { return { phase, revision, persistedRevision, inFlightRevision }; }
    };
  }
  window.PV = window.PV || {};
  PV.saveQueue = { create };
})();
