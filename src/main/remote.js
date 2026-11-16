// Adiciona skills / plugins / agentes a partir de um endereço do GitHub.
// Não clona o repositório (pode ter centenas de MB): lê a árvore pela API, detecta o que existe
// e baixa só os arquivos dos itens escolhidos (raw.githubusercontent.com).
const fs = require('fs');
const path = require('path');
const ext = require('./extensions');

const HEADERS = { 'User-Agent': 'Loop-AI' };
const MAX_ITEM_BYTES = 25 * 1024 * 1024;
const SKIP = /(^|\/)(node_modules|\.git)(\/|$)/;
const safe = (n) => n.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
const CLAUDE_TOOLS = { read: 'read', write: 'write', edit: 'edit', multiedit: 'edit', glob: 'glob', grep: 'grep', bash: 'bash', webfetch: 'webfetch', todowrite: 'todowrite' };

function parseUrl(input) {
  const s = String(input || '').trim().replace(/\.git$/, '').replace(/\/+$/, '');
  let m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/#?\s]+)(?:\/(?:tree|blob)\/([^/\s]+)(?:\/([^#?\s]*))?)?/i)
       || s.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!m) throw new Error('Endereço não reconhecido. Use algo como https://github.com/usuario/repositorio');
  let sub = (m[4] || '').replace(/\/+$/, '');
  if (/(^|\/)SKILL\.md$/i.test(sub)) sub = sub.replace(/\/?SKILL\.md$/i, '');
  return { owner: m[1], repo: m[2], ref: m[3] || 'HEAD', sub };
}

async function http(url) {
  const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
  if (r.status === 403 || r.status === 429) throw new Error('Limite da API do GitHub atingido (60 consultas/hora sem login). Tente mais tarde.');
  if (r.status === 404) throw new Error('Não encontrado. O repositório existe e é público?');
  if (!r.ok) throw new Error(`GitHub respondeu HTTP ${r.status}`);
  return r;
}
const rawUrl = (a, p) => `https://raw.githubusercontent.com/${a.owner}/${a.repo}/${a.ref}/${p.split('/').map(encodeURIComponent).join('/')}`;
const rawText = async (a, p) => (await http(rawUrl(a, p))).text();

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// Preferência entre cópias da mesma skill (repos copiam a skill p/ .claude, .agents, .cursor…).
const rank = (p) => (/^skills\//.test(p) ? 0 : /^\.claude\/skills\//.test(p) ? 1 : /(^|\/)\./.test(p) ? 3 : 2);
const best = (list) => list.sort((x, y) => rank(x.dir) - rank(y.dir) || x.dir.length - y.dir.length)[0];

const cache = new Map(); // analysisId -> { addr, items }
let seq = 0;

async function analyze(input) {
  const addr = parseUrl(input);
  const tree = await (await http(`https://api.github.com/repos/${addr.owner}/${addr.repo}/git/trees/${addr.ref}?recursive=1`)).json();
  const under = (p) => !addr.sub || p === addr.sub || p.startsWith(addr.sub + '/');
  const blobs = (tree.tree || []).filter((t) => t.type === 'blob' && under(t.path) && !SKIP.test(t.path));
  const filesIn = (dir) => blobs.filter((b) => (dir ? b.path.startsWith(dir + '/') : true));
  const sizeOf = (fs_) => fs_.reduce((n, f) => n + (f.size || 0), 0);
  const items = [];

  // ---- skills: pastas com SKILL.md ----
  const groups = new Map();
  for (const b of blobs) {
    if (path.posix.basename(b.path) !== 'SKILL.md') continue;
    const dir = path.posix.dirname(b.path) === '.' ? '' : path.posix.dirname(b.path);
    const id = safe(dir ? path.posix.basename(dir) : addr.repo);
    (groups.get(id) || groups.set(id, []).get(id)).push({ dir, id });
  }
  const skillDirs = [];
  for (const [id, list] of groups) {
    const c = best(list);
    const files = filesIn(c.dir);
    skillDirs.push(c.dir);
    items.push({ kind: 'skill', id, dir: c.dir, files, bytes: sizeOf(files), copies: list.length });
  }

  // ---- plugins: pastas com index.js + package.json/plugin.json, fora das skills ----
  const has = (dir, name) => blobs.some((b) => b.path === (dir ? `${dir}/${name}` : name));
  for (const b of blobs) {
    if (path.posix.basename(b.path) !== 'index.js') continue;
    const dir = path.posix.dirname(b.path) === '.' ? '' : path.posix.dirname(b.path);
    if (dir.split('/').length > 3 || /(^|\/)\./.test(dir)) continue;
    if (skillDirs.some((s) => s && (dir === s || dir.startsWith(s + '/')))) continue;
    if (!has(dir, 'plugin.json') && !has(dir, 'package.json')) continue;
    const files = dir ? filesIn(dir) : blobs;
    items.push({ kind: 'plugin', id: safe(dir ? path.posix.basename(dir) : addr.repo), dir, files, bytes: sizeOf(files) });
  }

  // ---- agentes (formato agents/*.md com frontmatter) ----
  const agentBlobs = blobs.filter((b) => /\.md$/i.test(b.path) && path.posix.basename(path.posix.dirname(b.path)) === 'agents' && !/readme/i.test(b.path));

  // metadados (descrição/nome) em paralelo
  await pool(items, 8, async (it) => {
    try {
      if (it.kind === 'skill') {
        const { meta } = ext.frontmatter(await rawText(addr, it.dir ? `${it.dir}/SKILL.md` : 'SKILL.md'));
        it.name = meta.name || it.id; it.description = meta.description || '';
      } else {
        const f = has(it.dir, 'plugin.json') ? 'plugin.json' : 'package.json';
        const j = JSON.parse(await rawText(addr, it.dir ? `${it.dir}/${f}` : f));
        it.name = j.name || it.id; it.description = j.description || '';
      }
    } catch { it.name = it.id; it.description = ''; }
  });
  const agents = new Map();
  await pool(agentBlobs, 8, async (b) => {
    try {
      const { meta, body } = ext.frontmatter(await rawText(addr, b.path));
      if (!meta.name || !meta.description || agents.has(meta.name)) return;
      const mapped = (meta.tools || '').split(',').map((t) => CLAUDE_TOOLS[t.trim().toLowerCase()]).filter(Boolean);
      agents.set(meta.name, {
        kind: 'agent', id: meta.name, name: meta.name, description: meta.description.slice(0, 300), bytes: b.size || 0, files: [b],
        def: { name: safe(meta.name), mode: 'subagent', description: meta.description.slice(0, 300), system: body.trim(), steps: 25, permissions: {},
          tools: mapped.length ? [...new Set(mapped)] : ['read', 'glob', 'grep'] }, // sem lista = somente leitura (mais seguro)
      });
    } catch { /* ignora arquivo ilegível */ }
  });
  items.push(...agents.values());

  items.forEach((it) => { it.tooBig = it.bytes > MAX_ITEM_BYTES; });
  const id = `an_${++seq}`;
  cache.clear(); cache.set(id, { addr, items });
  return {
    analysisId: id, repo: `${addr.owner}/${addr.repo}`, truncated: !!tree.truncated,
    items: items.map((it, key) => ({ key, kind: it.kind, id: it.id, name: it.name, description: it.description, files: it.files.length, bytes: it.bytes, tooBig: it.tooBig, copies: it.copies || 1, path: it.dir })),
  };
}

async function download(addr, file, dest) {
  const buf = Buffer.from(await (await http(rawUrl(addr, file))).arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
}

/** Instala os itens escolhidos. Skills/plugins vão para as pastas do app; agentes voltam como definição. */
async function install(analysisId, keys) {
  const a = cache.get(analysisId);
  if (!a) throw new Error('Análise expirada. Clique em Analisar novamente.');
  const done = [], agents = [];
  for (const key of keys) {
    const it = a.items[key];
    if (!it || it.tooBig) continue;
    if (it.kind === 'agent') { agents.push(it.def); done.push(`agente ${it.name}`); continue; }
    const root = it.kind === 'skill' ? ext.skillsDir() : ext.pluginsDir();
    const target = path.join(root, safe(it.id));
    fs.rmSync(target, { recursive: true, force: true }); // reinstalar = atualizar
    await pool(it.files, 8, async (f) => {
      const rel = it.dir ? f.path.slice(it.dir.length + 1) : f.path;
      const dest = path.join(target, ...rel.split('/'));
      if (!path.resolve(dest).startsWith(path.resolve(target) + path.sep)) throw new Error('caminho inválido no repositório');
      await download(a.addr, f.path, dest);
    });
    done.push(`${it.kind} ${it.id}`);
  }
  return { done, agents };
}

module.exports = { analyze, install, parseUrl };
