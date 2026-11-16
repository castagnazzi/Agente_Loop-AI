// Skills e plugins do Loop-AI.
//  Skill  = pasta com SKILL.md (frontmatter name/description + instruções). O agente vê só o catálogo
//           e carrega o conteúdo completo com a ferramenta `skill` (formato SKILL.md, compatível com o de outros agentes).
//  Plugin = pasta com index.js (CommonJS) exportando { name, description, tools: { nome: {kind, description, parameters, run} } }.
//           As ferramentas aparecem para os agentes como `<plugin>_<nome>`.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const { baseDir, legacyDir } = require('./paths');

const dir = (k) => {
  const d = path.join(baseDir(), k);
  fs.mkdirSync(d, { recursive: true });
  migrateLegacy(k, d);
  return d;
};

// Versões anteriores guardavam em %APPDATA%\loop-ai\<k>: move o que existir para a nova pasta (uma vez).
const migrated = new Set();
function migrateLegacy(k, d) {
  if (migrated.has(k)) return;
  migrated.add(k);
  try {
    const old = path.join(legacyDir(), k);
    if (path.resolve(old) === path.resolve(d) || !fs.existsSync(old)) return;
    for (const e of fs.readdirSync(old, { withFileTypes: true })) {
      const to = path.join(d, e.name);
      if (!fs.existsSync(to)) fs.cpSync(path.join(old, e.name), to, { recursive: true });
    }
    fs.rmSync(old, { recursive: true, force: true });
  } catch { /* migração é best-effort */ }
}

const skillsDir = () => dir('skills');
const pluginsDir = () => dir('plugins');

function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return { meta, body: m[2] };
}

const safe = (n) => n.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'item';

function listSkills() {
  const out = [];
  for (const e of fs.readdirSync(skillsDir(), { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const f = path.join(skillsDir(), e.name, 'SKILL.md');
    if (!fs.existsSync(f)) continue;
    const { meta } = frontmatter(fs.readFileSync(f, 'utf8'));
    out.push({ id: e.name, name: meta.name || e.name, description: meta.description || '(sem descrição)' });
  }
  return out;
}

function readSkill(id) {
  const d = path.join(skillsDir(), id);
  const { meta, body } = frontmatter(fs.readFileSync(path.join(d, 'SKILL.md'), 'utf8'));
  const files = [];
  (function walk(p, rel) {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(p, e.name), r);
      else if (r !== 'SKILL.md') files.push(r);
    }
  })(d, '');
  return { name: meta.name || id, dir: d, body, files };
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === 'node_modules' && src.includes('skills')) continue;
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    e.isDirectory() ? copyDir(s, d) : fs.copyFileSync(s, d);
  }
}

/** Aceita pasta com SKILL.md ou um .md solto. Retorna o id criado. */
function addSkill(src) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    if (!fs.existsSync(path.join(src, 'SKILL.md'))) throw new Error('A pasta precisa conter um arquivo SKILL.md');
    const id = safe(path.basename(src));
    copyDir(src, path.join(skillsDir(), id));
    return id;
  }
  const text = fs.readFileSync(src, 'utf8');
  const { meta } = frontmatter(text);
  const id = safe(meta.name || path.basename(src, path.extname(src)));
  fs.mkdirSync(path.join(skillsDir(), id), { recursive: true });
  fs.writeFileSync(path.join(skillsDir(), id, 'SKILL.md'), text);
  return id;
}

function removeDirOf(kind, id) {
  const root = kind === 'skill' ? skillsDir() : pluginsDir();
  const target = path.join(root, id);
  if (path.dirname(target) !== root) throw new Error('id inválido');
  fs.rmSync(target, { recursive: true, force: true });
}

// ---- plugins ----
function listPlugins() {
  const out = [];
  for (const e of fs.readdirSync(pluginsDir(), { withFileTypes: true })) {
    if (!e.isDirectory() || !fs.existsSync(path.join(pluginsDir(), e.name, 'index.js'))) continue;
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(pluginsDir(), e.name, 'plugin.json'), 'utf8')); } catch { /* opcional */ }
    out.push({ id: e.name, name: meta.name || e.name, description: meta.description || '' });
  }
  return out;
}

function addPlugin(src) {
  if (!fs.statSync(src).isDirectory() || !fs.existsSync(path.join(src, 'index.js'))) throw new Error('A pasta do plugin precisa conter index.js');
  const id = safe(path.basename(src));
  copyDir(src, path.join(pluginsDir(), id));
  return id;
}

/** Carrega os plugins habilitados e devolve { 'plugin_tool': {...def, plugin} }. Erros viram `errors`. */
function loadPluginTools(disabled = []) {
  const tools = {}, errors = {};
  for (const p of listPlugins()) {
    if (disabled.includes(p.id)) continue;
    const entry = path.join(pluginsDir(), p.id, 'index.js');
    try {
      for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(pluginsDir(), p.id))) delete require.cache[k];
      const mod = require(entry);
      for (const [n, t] of Object.entries(mod.tools || {})) {
        if (typeof t.run !== 'function') continue;
        tools[`${safe(p.id)}_${safe(n)}`] = {
          kind: ['read', 'write', 'exec', 'net', 'none'].includes(t.kind) ? t.kind : 'exec', // desconhecido = mais restritivo
          description: `[plugin ${p.name}] ${t.description || n}`,
          parameters: t.parameters || { type: 'object', properties: {} },
          run: t.run, plugin: p.id,
        };
      }
    } catch (e) { errors[p.id] = e.message; }
  }
  return { tools, errors };
}

module.exports = { frontmatter, skillsDir, pluginsDir, listSkills, readSkill, addSkill, removeDirOf, listPlugins, addPlugin, loadPluginTools };
