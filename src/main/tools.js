// Ferramentas do agente: read, write, edit, glob, grep, bash, webfetch, todowrite.
// `delegate` (delegação a subagentes) é tratada no engine, pois precisa recursão.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const SKIP = new Set(['node_modules', '.git', 'dist', '.next', '__pycache__']);
const MAX_OUT = 20000;
const clip = (s) => (s.length > MAX_OUT ? s.slice(0, MAX_OUT) + `\n…[cortado ${s.length - MAX_OUT} chars]` : s);

// Acha `old` dentro de `t` tolerando diferenças de fim de linha (CRLF/LF), espaço em branco no FIM de
// cada linha, e "caracteres espertos" (aspas curvas, travessão/en-dash, espaços unicode não-quebráveis)
// que aparecem quando o texto foi copiado de Word/PDF/site e o modelo "retypa" de memória com indentação
// quase igual. Nunca ignora espaço no COMEÇO da linha (indentação): isso poderia casar o bloco errado.
// Primeiro tenta o casamento exato de sempre (comportamento inalterado); só cai na tolerância se
// o exato não achar nada. Retorna os índices de LINHA (início) de cada ocorrência tolerante, ou [].
function linhasDe(s) { return s.split(/\r\n|\r|\n/); }
const normEsperto = (l) => l
  .replace(/[‘’‚‛]/g, "'")
  .replace(/[“”„‟]/g, '"')
  .replace(/[‐-―−]/g, '-')
  .replace(/[  -   　]/g, ' ');
function acharBlocoTolerante(tLinhas, oldLinhas) {
  const norm = (l) => normEsperto(l).replace(/[ \t]+$/, '');
  const oldNorm = oldLinhas.map(norm);
  const achados = [];
  for (let i = 0; i + oldLinhas.length <= tLinhas.length; i++) {
    let bate = true;
    for (let j = 0; j < oldLinhas.length; j++) {
      if (norm(tLinhas[i + j]) !== oldNorm[j]) { bate = false; break; }
    }
    if (bate) achados.push(i);
  }
  return achados;
}

/** Mata o processo e TODOS os que ele iniciou (child.kill() no Windows mata só o PowerShell). */
function matarArvore(pid, sincrono = false) {
  if (!pid) return;
  try {
    if (sincrono) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); // ao fechar o app: não dá para esperar o evento
    else spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
  } catch { /* já encerrou */ }
}

// ---- servidores de teste (iniciar_servidor): ficam vivos até o fim do pedido ----
const servidores = new Set();
function pararServidores(sincrono = false) {
  const n = servidores.size;
  for (const s of servidores) matarArvore(s.child.pid, sincrono);
  servidores.clear();
  return n;
}
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
async function sonda(porta, caminho, ms = 4000) {
  let ultimo;
  for (const host of ['127.0.0.1', '[::1]']) { // servidor preso a "localhost" no Windows pode escutar só em IPv6
    try {
      const r = await fetch(`http://${host}:${porta}${caminho}`, { signal: AbortSignal.timeout(ms), redirect: 'manual' });
      return { status: r.status, corpo: (await r.text()).slice(0, 300) };
    } catch (e) { ultimo = e; }
  }
  return { erro: ultimo?.cause?.code || ultimo?.message || 'sem resposta' };
}

async function iniciarServidor(a, ctx) {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', a.command], { cwd: ctx.cwd, windowsHide: true });
  const srv = { child }; servidores.add(srv);
  let log = '', saiu = null;
  const add = (d) => { log += d; if (log.length > 20000) log = log.slice(-20000); };
  child.stdout.on('data', add); child.stderr.on('data', add);
  child.on('close', (c) => { saiu = c; servidores.delete(srv); });
  child.on('error', (e) => { saiu = -1; add(e.message); servidores.delete(srv); });
  const fimEm = Date.now() + Math.min(a.espera_ms || 20000, 60000);
  let porta = a.port || null;
  let no = null;
  while (Date.now() < fimEm && saiu === null && !ctx.signal?.aborted) {
    if (!porta) { const m = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d{2,5})|\bport[a]?\s*[:=]?\s*(\d{2,5})/i.exec(log); if (m) porta = Number(m[1] || m[2]); }
    if (porta) { no = await sonda(porta, '/', 1500); if (!no.erro) break; }
    await dormir(500);
  }
  const cauda = (s) => s.trim().split(/\r?\n/).slice(-25).join('\n');
  if (saiu !== null) return clip(`FALHOU: o processo terminou (código ${saiu}) antes de subir o servidor. Corrija o erro e tente de novo.\n\nSaída:\n${cauda(log)}`);
  if (!porta || !no || no.erro) { matarArvore(child.pid); servidores.delete(srv); return clip(`FALHOU: o servidor não respondeu${porta ? ` na porta ${porta}` : ' (porta não identificada: informe `port`)'} em ${Math.round(Math.min(a.espera_ms || 20000, 60000) / 1000)} s. Verifique o log, a porta e se o comando está certo.\n\nSaída:\n${cauda(log)}`); }
  const linhas = [`Servidor no ar: http://localhost:${porta}`];
  let falhas = 0;
  for (const c of (a.verificar?.length ? a.verificar : ['/'])) {
    const r = await sonda(porta, c.startsWith('/') ? c : `/${c}`, 6000);
    const ok = !r.erro && r.status < 400;
    if (!ok) falhas++;
    linhas.push(`${ok ? '✔' : '✘'} GET ${c} → ${r.erro ? `erro (${r.erro})` : r.status}${ok ? '' : r.corpo ? ` | ${r.corpo.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`);
  }
  const erros = log.split(/\r?\n/).filter((l) => /error|erro|exception|traceback|cannot|unhandled|failed|falha/i.test(l)).slice(-8);
  if (erros.length) linhas.push('\nLinhas de erro no log do servidor:\n' + erros.join('\n'));
  linhas.push(falhas || erros.length ? '\nHÁ PROBLEMAS: corrija os arquivos e chame `iniciar_servidor` de novo (o anterior será encerrado ao fim do pedido; use `parar_servidor` antes se precisar liberar a porta).' : '\nTudo respondeu bem.');
  return clip(linhas.join('\n'));
}

function* walk(dir, depth = 0) {
  if (depth > 12) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, depth + 1);
    else yield p;
  }
}

// Converte um padrão glob em RegExp: * (sem /), ** (com /), **/ (zero ou mais pastas), ?, {a,b}. Insensível a maiúsculas.
function globToRegex(g) {
  g = g.replace(/\\/g, '/').replace(/^\.\//, '');
  const esc = (c) => c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { i++; if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{' && g.indexOf('}', i) > i) { const j = g.indexOf('}', i); re += '(?:' + g.slice(i + 1, j).split(',').map(esc).join('|') + ')'; i = j; }
    else re += esc(c);
  }
  return new RegExp(`^${re}$`, 'i');
}

const abs = (ctx, p) => (path.isAbsolute(p) ? p : path.join(ctx.cwd, p));


// ---- web: GET com limite de tempo, limite de tamanho, extração de texto e motores de busca (sem chave de API) ----
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_RESP_BYTES = 20 * 1024 * 1024; // 20 MiB — evita estourar memória/contexto com página gigante
async function httpGet(url, ctx, opts = {}) {
  const { ms = 20000 } = opts;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  const stop = () => ac.abort();
  ctx?.signal?.addEventListener('abort', stop);
  const limite = (msg) => { const e = new Error(msg); e._pronto = true; return e; };
  try {
    const r = await fetch(url, { signal: ac.signal, redirect: 'follow', headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.7', Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } });
    const declarado = Number(r.headers.get('content-length') || 0);
    if (declarado > MAX_RESP_BYTES) throw limite(`${url} é maior que ${(MAX_RESP_BYTES / 1024 / 1024) | 0} MiB — não é possível ler.`);
    if (!r.body) return { ok: r.ok, status: r.status, text: await r.text() };
    const reader = r.body.getReader(), dec = new TextDecoder();
    let total = 0, text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_RESP_BYTES) { reader.cancel().catch(() => {}); throw limite(`${url} passou de ${(MAX_RESP_BYTES / 1024 / 1024) | 0} MiB — leitura interrompida.`); }
      text += dec.decode(value, { stream: true });
    }
    text += dec.decode();
    return { ok: r.ok, status: r.status, text };
  } catch (e) {
    if (e._pronto) throw e;
    throw new Error(e.name === 'AbortError' && !ctx?.signal?.aborted ? `tempo esgotado (${ms / 1000} s) em ${url}` : `não foi possível acessar ${url} (${e.cause?.code || e.message})`);
  } finally { clearTimeout(t); ctx?.signal?.removeEventListener('abort', stop); }
}
const decodeHtml = (t) => t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)));
const semTags = (h) => decodeHtml(h.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
function htmlParaTexto(h) {
  const corpo = (/<main[\s\S]*?<\/main>|<article[\s\S]*?<\/article>/i.exec(h) || [h])[0]; // prefere o conteúdo principal
  return decodeHtml(corpo.replace(/<(script|style|noscript|svg|nav|footer|header|form|aside)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (m, l, t) => `\n\n${'#'.repeat(Number(l))} ${semTags(t)}\n`)
    .replace(/<li[^>]*>/gi, '\n- ').replace(/<\/(p|div|tr|br|section)>|<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
async function buscaDuckDuckGo(q, ctx) {
  const r = await httpGet(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=br-pt`, ctx);
  const out = [];
  for (const m of r.text.matchAll(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]*class="[^"]*result__a|$)/g)) {
    let url = decodeHtml(m[1]);
    const u = /[?&]uddg=([^&]+)/.exec(url);
    if (u) url = decodeURIComponent(u[1]); else if (url.startsWith('//')) url = 'https:' + url;
    const sn = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(m[3]);
    if (/^https?:/.test(url) && !/duckduckgo\.com\/y\.js/.test(url)) out.push({ titulo: semTags(m[2]), url, resumo: sn ? semTags(sn[1]) : '' });
  }
  return out;
}
async function buscaBing(q, ctx) {
  const r = await httpGet(`https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=pt-BR&cc=BR`, ctx);
  const out = [];
  for (const m of r.text.matchAll(/<li class="b_algo"[\s\S]*?<\/li>/g)) {
    const a = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(m[0]);
    if (!a || !/^https?:/.test(decodeHtml(a[1]))) continue;
    const p = /<p[^>]*>([\s\S]*?)<\/p>/.exec(m[0]);
    out.push({ titulo: semTags(a[2]), url: decodeHtml(a[1]), resumo: p ? semTags(p[1]) : '' });
  }
  return out;
}

// ---- YouTube: transcrição via legenda própria do vídeo (sem baixar áudio/vídeo, sem IA local) ----
function extrairIdYoutube(url) {
  const s = String(url || '').trim();
  const m = /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|shorts\/|embed\/|v\/))([\w-]{11})/.exec(s);
  return m ? m[1] : (/^[\w-]{11}$/.test(s) ? s : null);
}
async function legendasYoutube(id, ctx) {
  const r = await httpGet(`https://www.youtube.com/watch?v=${id}&hl=pt-BR`, ctx);
  const tituloM = /"title":"((?:[^"\\]|\\.)*)"/.exec(r.text);
  let titulo = ''; try { titulo = tituloM ? JSON.parse(`"${tituloM[1]}"`) : ''; } catch { /* mantém vazio */ }
  const tracksM = /"captionTracks":(\[.*?\])/.exec(r.text);
  if (!tracksM) throw new Error('este vídeo não tem legenda disponível — só é possível transcrever vídeos do YouTube com legenda (manual ou automática)');
  let tracks;
  try { tracks = JSON.parse(tracksM[1]); } catch { throw new Error('não foi possível ler as legendas deste vídeo'); }
  if (!Array.isArray(tracks) || !tracks.length) throw new Error('este vídeo não tem legenda disponível');
  const prioridade = (t) => (/^pt/i.test(t.languageCode) ? 0 : /^en/i.test(t.languageCode) ? 1 : 2) + (t.kind === 'asr' ? 10 : 0);
  tracks.sort((a, b) => prioridade(a) - prioridade(b));
  const track = tracks[0];
  const base = String(track.baseUrl).replace(/\\u0026/g, '&');
  let texto = '', recebeuAlgo = false;
  try {
    const j = await httpGet(base + '&fmt=json3', ctx);
    recebeuAlgo = recebeuAlgo || j.text.length > 0;
    const dados = JSON.parse(j.text);
    texto = (dados.events || []).map((e) => (e.segs || []).map((s) => s.utf8 || '').join('')).join('');
  } catch {
    try {
      const x = await httpGet(base, ctx); // formato XML de legenda, como alternativa
      recebeuAlgo = recebeuAlgo || x.text.length > 0;
      texto = decodeHtml(x.text.replace(/<[^>]+>/g, ' '));
    } catch { /* trata como resposta vazia abaixo */ }
  }
  texto = texto.replace(/\s+/g, ' ').trim();
  if (!texto) {
    throw new Error(recebeuAlgo
      ? 'não foi possível interpretar a legenda deste vídeo (formato inesperado)'
      : 'o YouTube devolveu a legenda vazia (não é que o vídeo não tenha legenda: o servidor de legendas do YouTube às vezes bloqueia pedidos automáticos vindos de fora do navegador — tente de novo mais tarde ou em outra rede)');
  }
  return { titulo, idioma: track.languageCode, autoGerada: track.kind === 'asr', texto };
}

// "kind" alimenta a política de permissão: read | write | exec | net | none
const TOOLS = {
  read: {
    kind: 'read',
    description: 'Lê um arquivo de texto. Retorna o conteúdo com números de linha.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, required: ['path'] },
    run: async (a, ctx) => {
      const lines = fs.readFileSync(abs(ctx, a.path), 'utf8').split(/\r?\n/);
      const o = Math.max(0, (a.offset || 1) - 1), l = a.limit || 2000;
      return clip(lines.slice(o, o + l).map((t, i) => `${o + i + 1}\t${t}`).join('\n'));
    },
  },
  write: {
    kind: 'write',
    description: 'Cria ou sobrescreve um arquivo com o conteúdo informado.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    run: async (a, ctx) => {
      if (!path.isAbsolute(a.path)) ctx.ensureProject?.(path.parse(a.path).name); // entrega nova sem pasta de projeto: cria uma automaticamente
      const p = abs(ctx, a.path);
      ctx.beforeWrite?.(p); // cópia de segurança (desfazer)
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, a.content);
      return `Escrito ${a.content.length} caracteres em ${p}`;
    },
  },
  edit: {
    kind: 'write',
    description: 'Substitui um trecho exato (old) por new em um arquivo. `old` deve ser único, ou use replace_all. ' +
      'Pequenas diferenças de espaço no fim da linha e de aspas/travessão "espertos" são toleradas automaticamente; a indentação precisa bater.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['path', 'old', 'new'] },
    run: async (a, ctx) => {
      const p = abs(ctx, a.path);
      const t = fs.readFileSync(p, 'utf8');
      const n = t.split(a.old).length - 1;
      if (n > 0) {
        // casamento exato: comportamento de sempre, sem mudança
        if (n > 1 && !a.replace_all) throw new Error(`trecho aparece ${n}x; seja mais específico ou use replace_all`);
        ctx.beforeWrite?.(p);
        fs.writeFileSync(p, a.replace_all ? t.split(a.old).join(a.new) : t.replace(a.old, () => a.new));
        return `Editado ${p} (${a.replace_all ? n : 1} substituição)`;
      }
      // exato não achou: tenta tolerando espaço no fim de linha / CRLF-LF (não toca no resto do arquivo)
      const eol = t.includes('\r\n') ? '\r\n' : '\n';
      const tLinhas = linhasDe(t), oldLinhas = linhasDe(a.old), newLinhas = linhasDe(a.new);
      const achados = acharBlocoTolerante(tLinhas, oldLinhas);
      if (achados.length === 0) throw new Error('trecho `old` não encontrado');
      if (achados.length > 1 && !a.replace_all) throw new Error(`trecho aparece ${achados.length}x (com espaços em branco diferentes); seja mais específico ou use replace_all`);
      ctx.beforeWrite?.(p);
      for (const i of [...achados].reverse()) tLinhas.splice(i, oldLinhas.length, ...newLinhas); // de trás pra frente: índices anteriores continuam válidos
      fs.writeFileSync(p, tLinhas.join(eol));
      return `Editado ${p} (${achados.length} substituição${achados.length > 1 ? 'ões' : ''}, ajustando espaço em branco no fim da linha)`;
    },
  },
  glob: {
    kind: 'read',
    description: 'Lista arquivos que casam com um padrão glob (ex.: src/**/*.js).',
    parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] },
    run: async (a, ctx) => {
      let root = abs(ctx, a.path || '.'), pat = String(a.pattern);
      if (path.isAbsolute(pat)) { // padrão com caminho absoluto: a pasta fixa vira a raiz da busca
        const p = pat.replace(/\\/g, '/'), w = p.search(/[*?{]/), corte = w < 0 ? p.lastIndexOf('/') : p.lastIndexOf('/', w);
        root = p.slice(0, Math.max(corte, 0)) || root; pat = p.slice(corte + 1);
      }
      const re = globToRegex(pat);
      const out = [];
      for (const f of walk(root)) {
        if (re.test(path.relative(root, f).replace(/\\/g, '/'))) out.push(f);
        if (out.length >= 500) break;
      }
      return out.join('\n') || '(nenhum arquivo)';
    },
  },
  grep: {
    kind: 'read',
    description: 'Busca por regex no conteúdo dos arquivos. Retorna arquivo:linha:texto.',
    parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, include: { type: 'string', description: 'glob de arquivos, ex.: *.js' } }, required: ['pattern'] },
    run: async (a, ctx) => {
      const root = abs(ctx, a.path || '.');
      const re = new RegExp(a.pattern, 'i');
      const inc = a.include ? globToRegex('**/' + a.include) : null;
      const out = [];
      for (const f of walk(root)) {
        if (inc && !inc.test(f.replace(/\\/g, '/'))) continue;
        let text;
        try { if (fs.statSync(f).size > 2e6) continue; text = fs.readFileSync(f, 'utf8'); } catch { continue; }
        text.split(/\r?\n/).forEach((l, i) => { if (re.test(l) && out.length < 300) out.push(`${f}:${i + 1}:${l.slice(0, 200)}`); });
        if (out.length >= 300) break;
      }
      return out.join('\n') || '(sem resultados)';
    },
  },
  bash: {
    kind: 'exec',
    description: 'Executa um comando no PowerShell 5.1 (Windows) na pasta de trabalho. Timeout padrão 60s. NÃO existem head, tail, grep, cat, sed, awk, wget nem curl com opções do Linux (curl é alias de Invoke-WebRequest): use Select-Object -First/-Last, Select-String, Get-Content, Invoke-WebRequest. Para pesquisar na web use a ferramenta websearch, não este comando.',
    parameters: { type: 'object', properties: { command: { type: 'string' }, timeout_ms: { type: 'integer' } }, required: ['command'] },
    run: (a, ctx) => new Promise((resolve) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', a.command], { cwd: ctx.cwd, windowsHide: true });
      let out = '', fim = false;
      // Encerra e DEVOLVE na hora. Antes só se matava o PowerShell e se esperava o evento `close`: um servidor iniciado
      // pelo comando (node server.js, npm start) herdava os canais de saída, o `close` nunca vinha e o agente ficava
      // preso em "executando bash…" para sempre (o botão parar tinha o mesmo problema).
      const terminar = (aviso) => {
        if (fim) return; fim = true;
        clearTimeout(timer); ctx.signal?.removeEventListener('abort', aoAbortar);
        if (aviso) { matarArvore(child.pid); out += `\n${aviso}`; }
        resolve(clip(`${out}\n[exit ${aviso ? 'null' : codigo}]`));
      };
      let codigo = null;
      const timer = setTimeout(() => terminar('[timeout] comando ainda em execução e foi encerrado (com os processos que ele iniciou). Servidor ou app que não termina NÃO deve rodar aqui: use a ferramenta `iniciar_servidor`.'), a.timeout_ms || 60000);
      const aoAbortar = () => terminar('[interrompido]');
      ctx.signal?.addEventListener('abort', aoAbortar, { once: true });
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.on('close', (code) => { codigo = code; terminar(''); });
      child.on('error', (e) => { if (fim) return; fim = true; clearTimeout(timer); resolve(`erro: ${e.message}`); });
    }),
  },
  iniciar_servidor: {
    kind: 'exec',
    description: 'Inicia em SEGUNDO PLANO um servidor/app que não termina (npm start, node server.js, python app.py, flask run, uvicorn…) na pasta do projeto, ESPERA ele subir e TESTA os endereços indicados (GET), devolvendo status, trechos das respostas e o log de erros. Use depois de instalar as dependências para verificar se o projeto realmente funciona; se houver erro, corrija os arquivos e chame de novo. O servidor é encerrado sozinho ao fim do pedido (ou com `parar_servidor`).',
    parameters: { type: 'object', properties: {
      command: { type: 'string', description: 'comando para iniciar, ex.: node server.js' },
      port: { type: 'integer', description: 'porta em que o servidor escuta (se omitida, tenta descobrir pelo log)' },
      verificar: { type: 'array', items: { type: 'string' }, description: 'caminhos a testar com GET, ex.: ["/", "/api/produtos"] (padrão: ["/"])' },
      espera_ms: { type: 'integer', description: 'quanto esperar o servidor subir (padrão 20000, máximo 60000)' },
    }, required: ['command'] },
    run: async (a, ctx) => iniciarServidor(a, ctx),
  },
  parar_servidor: {
    kind: 'none',
    description: 'Encerra os servidores iniciados com `iniciar_servidor` neste pedido (e os processos filhos deles).',
    parameters: { type: 'object', properties: {} },
    run: async () => { const n = pararServidores(); return n ? `${n} servidor(es) encerrado(s).` : 'Nenhum servidor em execução.'; },
  },
  webfetch: {
    kind: 'net',
    description: 'Baixa uma página da web (GET) e devolve o texto principal. Use nas melhores fontes achadas com websearch. Páginas muito longas são cortadas (use `inicio` para continuar).',
    parameters: { type: 'object', properties: {
      url: { type: 'string' },
      inicio: { type: 'integer', description: 'caractere inicial (continuar uma página longa)' },
      timeout_ms: { type: 'integer', description: 'tempo máximo de espera em milissegundos (padrão 20000, máximo 120000) — aumente para sites lentos' },
    }, required: ['url'] },
    run: async (a, ctx) => {
      const r = await httpGet(a.url, ctx, { ms: Math.max(1000, Math.min(120000, Number(a.timeout_ms) || 20000)) });
      if (!r.ok) return `erro: a página respondeu HTTP ${r.status}. Tente outra fonte.`;
      const t = htmlParaTexto(r.text);
      const ini = Math.max(0, Number(a.inicio) || 0), lim = 15000;
      const trecho = t.slice(ini, ini + lim);
      if (t.length < 200 && !ini) return `(a página tem pouco texto: provavelmente é carregada por JavaScript; tente outra fonte)\n${t}`;
      return (trecho || '(página sem texto legível)') + (t.length > ini + lim ? `\n…[faltam ${t.length - ini - lim} caracteres; chame de novo com inicio=${ini + lim}]` : '');
    },
  },
  remover: {
    kind: 'write',
    description: 'Apaga um arquivo ou pasta — mas manda para a Lixeira do Windows, NÃO é definitivo (dá pra restaurar pela Lixeira se for engano, igual um Delete normal). Use esta ferramenta em vez de apagar pelo terminal (bash).',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    run: (a, ctx) => new Promise((resolve, reject) => {
      const alvo = abs(ctx, a.path);
      if (!fs.existsSync(alvo)) return reject(new Error(`não encontrado: ${alvo}`));
      const esc = alvo.replace(/'/g, "''");
      const ps = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName Microsoft.VisualBasic; ` +
        `if ((Get-Item -LiteralPath '${esc}') -is [System.IO.DirectoryInfo]) ` +
        `{ [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${esc}', 'OnlyErrorDialogs', 'SendToRecycleBin') } ` +
        `else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${esc}', 'OnlyErrorDialogs', 'SendToRecycleBin') }`;
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
      let err = '';
      child.stderr.on('data', (d) => (err += d));
      child.on('close', (code) => (code === 0 ? resolve(`Movido para a Lixeira: ${alvo}`) : reject(new Error(err.trim() || `código de saída ${code}`))));
      child.on('error', reject);
    }),
  },
  transcrever_video: {
    kind: 'net',
    description: 'Transcreve um vídeo do YouTube a partir da URL, lendo a legenda que o próprio vídeo já tem (manual ou automática) — NÃO baixa áudio/vídeo e NÃO funciona com vídeo local nem de outros sites. ' +
      'Prefere legenda em português, depois inglês, depois qualquer outra. Texto longo vem paginado (use `inicio` para continuar).',
    parameters: { type: 'object', properties: { url: { type: 'string', description: 'URL do vídeo do YouTube (ou o ID de 11 caracteres)' }, inicio: { type: 'integer', description: 'caractere inicial (continuar uma transcrição longa)' } }, required: ['url'] },
    run: async (a, ctx) => {
      const id = extrairIdYoutube(a.url);
      if (!id) throw new Error('URL do YouTube não reconhecida');
      const r = await legendasYoutube(id, ctx);
      const ini = Math.max(0, Number(a.inicio) || 0), lim = 15000;
      const trecho = r.texto.slice(ini, ini + lim);
      const cab = `Vídeo: ${r.titulo || id}\nLegenda: ${r.idioma}${r.autoGerada ? ' (gerada automaticamente pelo YouTube — pode ter erros de transcrição)' : ''}\n\n`;
      return (ini ? '' : cab) + trecho + (r.texto.length > ini + lim ? `\n…[faltam ${r.texto.length - ini - lim} caracteres; chame de novo com inicio=${ini + lim}]` : '');
    },
  },
  websearch: {
    kind: 'net',
    description: 'Pesquisa na internet e devolve os melhores resultados (título, endereço e resumo). Faça 1 a 3 pesquisas objetivas (pode usar português) e depois leia as 3 a 5 melhores páginas com webfetch. Não tente raspar o Google com comandos: use esta ferramenta.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'termos da pesquisa' }, max_results: { type: 'integer', description: 'de 3 a 10 (padrão 8)' } }, required: ['query'] },
    run: async (a, ctx) => {
      const q = String(a.query || '').trim();
      if (!q) throw new Error('informe a pesquisa em "query"');
      const n = Math.min(10, Math.max(3, Number(a.max_results) || 8));
      let res = [], erro = '';
      for (const motor of [buscaDuckDuckGo, buscaBing]) {
        try { res = await motor(q, ctx); } catch (e) { erro = e.message; }
        if (res.length) break;
      }
      if (!res.length) return `Nenhum resultado${erro ? ` (${erro})` : ''}. Reformule a pesquisa com outros termos.`;
      return res.slice(0, n).map((r, i) => `${i + 1}. ${r.titulo}\n   ${r.url}\n   ${r.resumo}`).join('\n\n');
    },
  },
  todowrite: {
    kind: 'none',
    description: 'Registra/atualiza a lista de tarefas do plano atual (substitui a lista inteira).',
    parameters: { type: 'object', properties: { todos: { type: 'array', items: { type: 'object', properties: { content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } }, required: ['content', 'status'] } } }, required: ['todos'] },
    run: async (a, ctx) => { ctx.todos = a.todos; return 'Lista de tarefas atualizada.'; },
  },
};

module.exports = { TOOLS, pararServidores, matarArvore };
