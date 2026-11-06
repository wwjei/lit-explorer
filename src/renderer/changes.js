/* 磁盘版本监测：只记录变化，重读由应用统一调度。 */
(function () {
  'use strict';
  PV.changes = {
    create({ pv, state, dirKnown, dirtyDirs, WEB_KIND, paintRescan, workspace = () => state.root }) {
      const CHANGE_POLL_MS = 5000;
      /** 连续这么久没回到前台就暂停扫描：窗口在后台放着时没必要每 5 秒唤醒磁盘 */
      const FOREGROUND_IDLE_MS = 10 * 60 * 1000;
      const directoryLoads = new Map();
      let changeTimer = 0;
      let changePolling = false;
      let lastForegroundAt = Date.now();

      /** 记下某个窗格「现在显示的是哪个版本」 */
      function noteLoaded(pane, node, info) {
        if (!pane || pane.lifecycle === 'destroyed' || !pane.node || !node || pane.node.path !== node.path) return;
        if (node.kind === WEB_KIND) return;
        if (info && typeof info.size === 'number' && typeof info.mtime === 'number') {
          pane.known = { path: node.path, size: info.size, mtime: info.mtime };
          pane.changed = false;
          return;
        }
        // 图片 / HTML / PDF / 文档的读取接口不给 mtime，单独问一次
        const path = node.path, epoch = workspace(), request = pane.reqId, baseline = pane.known;
        pv.stat(path).then((st) => {
          if (!st || st.error || epoch !== workspace() || pane.lifecycle === 'destroyed' || pane.reqId !== request || pane.node !== node || pane.known !== baseline) return;
          pane.known = { path: path, size: st.size, mtime: st.mtime };
          pane.changed = false;
        }).catch(() => {});
      }

      function markChanged(pane) {
        if (pane.changed) return;
        pane.changed = true;
        paintRescan();
        // 只重建头部，正文不动（内容身份没变，renderPane 会跳过正文）
        PV.pane.renderPane(pane, false);
      }

      async function pollPane(pane) {
        const node = pane.node, epoch = workspace(), request = pane.reqId, baseline = pane.known;
        if (!node || node.isDir || node.kind === WEB_KIND) return;
        let st;
        try {
          st = await pv.stat(node.path);
        } catch {
          return;   // 读不到就下一轮再试，变更监测不打扰用户
        }
        // 等待期间窗格可能已经换了文件或被关掉
        if (epoch !== workspace() || pane.lifecycle === 'destroyed' || pane.reqId !== request || pane.node !== node || pane.known !== baseline) return;
        if (!st || st.error) { markChanged(pane); return; }
        if (!pane.known || pane.known.path !== node.path) {
          // 正文还没落地（或刚换文件），这一轮先建立基线
          pane.known = { path: node.path, size: st.size, mtime: st.mtime };
          return;
        }
        if (st.size !== pane.known.size || Math.abs(st.mtime - pane.known.mtime) > 0.5) {
          markChanged(pane);
        }
      }

      /** 某个目录刚重新读过：收掉它的变更标记，并重新记 mtime 基线 */
      function noteDirLoaded(dir) {
        dirtyDirs.delete(dir);
        dirKnown.delete(dir);
        if (!dir) return;
        const epoch = workspace(), request = {};
        directoryLoads.set(dir, request);
        pv.stat(dir).then((st) => {
          if (!st || st.error || epoch !== workspace() || directoryLoads.get(dir) !== request) return;
          if (state.path.some((f) => f.path === dir)) dirKnown.set(dir, st.mtime);
        }).catch(() => {});
      }

      async function pollOpenDirs() {
        if (!state.path.length) return;
        const epoch = workspace();
        const open = new Set(state.path.map((f) => f.path));
        // 已经不在栏里的目录不再占着基线
        for (const key of directoryLoads.keys()) if (!open.has(key)) directoryLoads.delete(key);
        for (const key of Array.from(dirKnown.keys())) {
          if (!open.has(key)) { dirKnown.delete(key); directoryLoads.delete(key); }
        }
        for (const key of Array.from(dirtyDirs)) {
          if (!open.has(key)) dirtyDirs.delete(key);
        }

        for (const dir of open) {
          if (dirtyDirs.has(dir)) continue;
          const request = directoryLoads.get(dir);
          let st;
          try {
            st = await pv.stat(dir);
          } catch {
            continue;
          }
          if (epoch !== workspace()) return;
          if (directoryLoads.get(dir) !== request || !state.path.some((node) => node.path === dir)) continue;
          // 目录被删掉或暂时读不到：列表肯定已经不对了
          if (!st || st.error) { dirtyDirs.add(dir); continue; }
          if (!dirKnown.has(dir)) { dirKnown.set(dir, st.mtime); continue; }
          if (Math.abs(st.mtime - dirKnown.get(dir)) > 0.5) dirtyDirs.add(dir);
        }
        paintRescan();
      }

      async function checkForChanges() {
        if (changePolling || document.hidden) return;
        // 有焦点时一直算在前台；失焦后再给 10 分钟宽限，然后停到重新聚焦为止
        if (document.hasFocus()) lastForegroundAt = Date.now();
        else if (Date.now() - lastForegroundAt >= FOREGROUND_IDLE_MS) return;
        changePolling = true;
        try {
          await Promise.all([Promise.all(PV.pane.visiblePanes().map(pollPane)), pollOpenDirs()]);
        } finally {
          changePolling = false;
        }
      }

      function startChangeWatch() {
        if (changeTimer) return;
        changeTimer = setInterval(checkForChanges, CHANGE_POLL_MS);
        // 窗口重新可见 / 重新获得焦点时立刻补查一次，不用等下一个 5 s
        document.addEventListener('visibilitychange', () => {
          if (!document.hidden) checkForChanges();
        });
        window.addEventListener('focus', () => {
          lastForegroundAt = Date.now();
          checkForChanges();
        });
        checkForChanges();
      }

      return { noteLoaded, noteDirLoaded, pollPane, pollOpenDirs, startChangeWatch };
    }
  };
})();
