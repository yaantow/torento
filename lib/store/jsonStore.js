const fs = require('fs');
const path = require('path');

/**
 * A tiny JSON-file store with debounced, atomic writes.
 * Callers mutate `store.data` directly, then call save()/saveNow().
 */
function createStore(filePath, initial = {}) {
  ensureDir(path.dirname(filePath));

  let data = load();
  let timer = null;
  const DEBOUNCE_MS = 800;

  function load() {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : structuredClone(initial);
    } catch {
      return structuredClone(initial);
    }
  }

  function write() {
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, filePath); // atomic on same filesystem
  }

  function save() {
    if (!timer) {
      timer = setTimeout(() => { timer = null; try { write(); } catch {} }, DEBOUNCE_MS);
    }
  }

  function saveNow() {
    if (timer) { clearTimeout(timer); timer = null; }
    write();
  }

  return {
    get data() { return data; },
    set data(v) { data = v; },
    save,
    saveNow,
  };
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

module.exports = { createStore, ensureDir };
