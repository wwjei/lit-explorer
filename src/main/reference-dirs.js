'use strict';

// 参考目录由原生选择框授权，独立于页面可写的 favorites 设置。
function createReferenceDirs({ fsApi, store, pick }) {
  let root = null;
  let dirs = [];
  let generation = 0;
  let mutations = Promise.resolve();
  const key = (p) => process.platform === 'win32' ? p.toLowerCase() : p;
  async function resolve(dir) {
    const real = await fsApi.resolveReal(dir);
    const fs = require('node:fs/promises');
    if (!(await fs.stat(real)).isDirectory()) throw new Error('不是目录');
    return real;
  }
  async function prepare(project) {
    const saved = (await store.load()).referenceDirs || {};
    const raw = Array.isArray(saved[key(project)]) ? saved[key(project)].slice(0, 32) : [];
    const resolved = await Promise.all(raw.map((p) => typeof p === 'string' ? resolve(p).catch(() => null) : null));
    return [...new Set(resolved.filter(Boolean))];
  }
  function activate(project, references) {
    generation++;
    root = project;
    dirs = references;
    for (const dir of dirs) fsApi.allowReferenceRoot(dir);
  }
  function list() { return dirs.slice(); }
  function mutate(fn) {
    const job = mutations.then(fn);
    mutations = job.catch(() => {});
    return job;
  }
  async function save(project, next) {
    const saved = { ...((await store.load()).referenceDirs || {}) };
    saved[key(project)] = next;
    await store.patch({ referenceDirs: saved });
  }
  async function add() {
    const project = root;
    const seq = generation;
    if (!project) return { error: 'NO_WORKSPACE' };
    const selected = await pick();
    if (!selected) return { canceled: true };
    const real = await resolve(selected);
    return mutate(async () => {
      if (root !== project || generation !== seq) return { error: 'SUPERSEDED' };
      if (dirs.length >= 32) return { error: 'LIMIT', message: '最多添加 32 个参考目录' };
      const next = dirs.some((p) => key(p) === key(real)) || key(real) === key(project) ? dirs.slice() : [...dirs, real];
      await save(project, next);
      if (root !== project || generation !== seq) return { error: 'SUPERSEDED' };
      dirs = next;
      fsApi.allowReferenceRoot(real);
      return { dirs: list() };
    });
  }
  function remove(dir) {
    const project = root;
    const seq = generation;
    return mutate(async () => {
      if (!project || root !== project || generation !== seq) return { error: 'SUPERSEDED' };
      const next = dirs.filter((p) => key(p) !== key(String(dir)));
      await save(project, next);
      if (root !== project || generation !== seq) return { error: 'SUPERSEDED' };
      dirs = next;
      fsApi.resetAllowedRoots();
      fsApi.allowResolvedRoot(project);
      dirs.forEach((p) => fsApi.allowReferenceRoot(p));
      return { dirs: list() };
    });
  }
  return { prepare, activate, list, add, remove };
}
module.exports = { createReferenceDirs };
