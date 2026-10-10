/**
 * db.js —— 基于 IndexedDB 的本地持久化
 * 表：employees（人员+人脸特征）、posts（岗位）、records（打卡记录）
 */
const DB = (() => {
  const DB_NAME = 'security-checkin';
  const DB_VERSION = 1;
  const STORES = ['employees', 'posts', 'records'];
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        STORES.forEach((s) => {
          if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' });
        });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  function store(name, mode = 'readonly') {
    return open().then((d) => d.transaction(name, mode).objectStore(name));
  }

  function wrap(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  return {
    async put(table, item) { await wrap((await store(table, 'readwrite')).put(item)); },
    async get(table, id) { return wrap((await store(table)).get(id)); },
    async getAll(table) { return wrap((await store(table)).getAll()); },
    async del(table, id) { await wrap((await store(table, 'readwrite')).delete(id)); },
  };
})();

/** 生成 ID（兼容无 crypto.randomUUID 的环境） */
function uid(prefix = '') {
  const rnd = (crypto && crypto.randomUUID)
    ? crypto.randomUUID().replace(/-/g, '')
    : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  return prefix + rnd;
}
