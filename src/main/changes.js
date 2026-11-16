// Backup e "desfazer" de arquivos criados/editados pelo agente (write, edit, criar_documento).
// Antes de sobrescrever, o arquivo é copiado para <app>/data/backups/<sessão>/. Comandos de terminal (bash) não são rastreados.
const fs = require('fs');
const path = require('path');
const { dataDir } = require('./paths');

const dir = () => path.join(dataDir(), 'backups');
const idx = () => path.join(dir(), 'changes.jsonl');
const MAX_BYTES = 50 * 1024 * 1024; // acima disso não guarda cópia (o desfazer avisa)
let seq = 0;

function append(o) { fs.mkdirSync(dir(), { recursive: true }); fs.appendFileSync(idx(), JSON.stringify(o) + '\n'); }
function readAll() {
  try { return fs.readFileSync(idx(), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
}

/** Chamar ANTES de gravar em `file`. Guarda cópia se o arquivo já existe; registra criação se não existe. */
function snapshot(file, sessionId, agent) {
  const abs = path.resolve(file), id = `${Date.now()}_${++seq}`;
  let existed = false, backup = null, nobackup = false, size = 0;
  try {
    const st = fs.statSync(abs);
    if (st.isFile()) {
      existed = true; size = st.size;
      if (st.size <= MAX_BYTES) {
        backup = path.join(dir(), sessionId || 'geral', `${id}_${path.basename(abs)}`);
        fs.mkdirSync(path.dirname(backup), { recursive: true });
        fs.copyFileSync(abs, backup);
      } else nobackup = true;
    }
  } catch { /* não existe: será criado */ }
  append({ id, t: new Date().toISOString(), sessionId: sessionId || 'geral', agent: agent || '', path: abs, existed, backup, nobackup, size });
  return id;
}

/** Registra um arquivo que acabou de ser criado por uma ferramenta (já existe em disco). */
function created(file, sessionId, agent) {
  const id = `${Date.now()}_${++seq}`;
  append({ id, t: new Date().toISOString(), sessionId: sessionId || 'geral', agent: agent || '', path: path.resolve(file), existed: false, backup: null, nobackup: false, size: 0 });
  return id;
}

function list(sessionId) {
  const all = readAll(), undone = new Set(all.filter((x) => x.undo).map((x) => x.undo));
  return all.filter((x) => !x.undo && (!sessionId || x.sessionId === sessionId))
    .map((x) => ({ id: x.id, t: x.t, path: x.path, acao: x.existed ? 'editado' : 'criado', agent: x.agent, desfeito: undone.has(x.id), temCopia: !x.existed || !!x.backup, nobackup: !!x.nobackup }))
    .reverse();
}

/** Desfaz uma alteração: restaura a cópia (arquivo que existia) ou apaga o arquivo (que foi criado). */
function undo(id) {
  const all = readAll(), e = all.find((x) => x.id === id && !x.undo);
  if (!e) throw new Error('alteração não encontrada');
  if (all.some((x) => x.undo === id)) throw new Error('esta alteração já foi desfeita');
  if (e.existed) {
    if (!e.backup || !fs.existsSync(e.backup)) throw new Error(e.nobackup ? 'o arquivo era grande demais para guardar cópia' : 'a cópia de segurança não foi encontrada');
    fs.mkdirSync(path.dirname(e.path), { recursive: true });
    fs.copyFileSync(e.backup, e.path);
  } else if (fs.existsSync(e.path)) fs.rmSync(e.path, { force: true });
  append({ undo: id, t: new Date().toISOString() });
  return e.existed ? `Restaurado: ${e.path}` : `Arquivo criado removido: ${e.path}`;
}

/** Remove cópias com mais de `dias` dias (chamado ao abrir o app). */
function purge(dias = 30) {
  try {
    const corte = Date.now() - dias * 864e5, all = readAll(), keep = [];
    for (const x of all) {
      if (!x.undo && new Date(x.t).getTime() < corte) { if (x.backup) fs.rmSync(x.backup, { force: true }); } else keep.push(x);
    }
    if (keep.length !== all.length) fs.writeFileSync(idx(), keep.map((x) => JSON.stringify(x)).join('\n') + (keep.length ? '\n' : ''));
  } catch { /* melhor esforço */ }
}

module.exports = { snapshot, created, list, undo, purge };
