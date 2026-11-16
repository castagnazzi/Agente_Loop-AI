// Sessões (conversas) salvas em <app>/data/sessions/<id>.json: permitem retomar depois de fechar o app.
const fs = require('fs');
const path = require('path');
const { dataDir } = require('./paths');

const dir = () => path.join(dataDir(), 'sessions');
const file = (id) => path.join(dir(), `${String(id).replace(/[^\w-]/g, '')}.json`);

function newId() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Imagens em base64 não vão para o disco: viram um marcador de texto. */
function stripImages(history) {
  return history.map((m) => (Array.isArray(m.content)
    ? { ...m, content: m.content.map((p) => (p.type === 'image_url' ? { type: 'text', text: `[imagem anexada: ${p._nome || 'imagem'}]` } : p)) }
    : m));
}

function save(s) {
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(file(s.id), JSON.stringify({ ...s, history: stripImages(s.history || []), updatedAt: Date.now() }));
}

function load(id) {
  try { return JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch { return null; }
}

function list() {
  try {
    return fs.readdirSync(dir()).filter((f) => f.endsWith('.json')).map((f) => {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(dir(), f), 'utf8'));
        return { id: s.id, title: s.title || '(sem título)', updatedAt: s.updatedAt || 0, createdAt: s.createdAt || 0, agent: s.agent || '', mensagens: (s.view || []).filter((v) => v.r === 'user').length, projectDir: s.projectDir || '' };
      } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
  } catch { return []; }
}

function remove(id) { try { fs.rmSync(file(id), { force: true }); } catch { /* já não existe */ } }

module.exports = { newId, save, load, list, remove };
