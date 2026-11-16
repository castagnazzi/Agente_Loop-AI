const $ = (id) => document.getElementById(id);
const log = $('log'), think = $('think'), input = $('input'), status = $('status');
let files = [], current = null, thinkStarted = false, lastModel = '';

function addMsg(text, cls) {
  const d = document.createElement('div');
  d.className = `msg ${cls}`;
  d.textContent = text;
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
  return d;
}

function renderChips() {
  $('chips').replaceChildren(...files.map((f, i) => {
    const c = document.createElement('span');
    c.className = 'chip';
    c.textContent = `📎 ${f.split(/[\\/]/).pop()} ✕`;
    c.onclick = () => { files.splice(i, 1); renderChips(); };
    return c;
  }));
}

async function submit() {
  const text = input.value.trim();
  if (!text || !$('stop').hidden) return;
  addMsg(text, 'user');
  input.value = '';
  const sent = files; files = []; renderChips();
  current = null; thinkStarted = false;
  think.textContent = '';
  status.textContent = '⏳ pensando…';
  await window.loop.send(text, sent);
}

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
});
$('close').onclick = () => window.loop.hideChat();
$('settings').onclick = () => window.loop.openSettings();
$('stop').onclick = () => window.loop.cancel();
$('clear').onclick = () => { window.loop.newSession(); reset(); };
$('attach').onclick = async () => { files.push(...(await window.loop.pickFiles())); renderChips(); };

function reset() {
  log.replaceChildren();
  working = null;
  addMsg('Nova conversa iniciada.', 'bot');
  think.textContent = 'O raciocínio e o código aparecem aqui…';
  status.textContent = '📊 aguardando a primeira resposta…';
}

// arrastar arquivos para a janela. Registrado em CAPTURA (3º argumento) e também direto no #input:
// um <textarea> tem ação padrão própria de "inserir o que foi solto como texto" (por isso aparecia
// o caminho file:// colado na pergunta) — sem capturar antes dele e sem repetir ali, o preventDefault
// podia chegar tarde demais pra cancelar essa ação padrão do campo de texto.
function aceitarArrasto(e) { e.preventDefault(); document.body.classList.add('dropping'); }
function soltarArquivos(e) {
  e.preventDefault();
  e.stopPropagation();
  document.body.classList.remove('dropping');
  for (const f of e.dataTransfer.files) files.push(window.loop.pathForFile(f));
  renderChips();
}
for (const ev of ['dragenter', 'dragover']) {
  addEventListener(ev, aceitarArrasto, true);
  input.addEventListener(ev, aceitarArrasto);
}
addEventListener('dragleave', () => document.body.classList.remove('dropping'), true);
addEventListener('drop', soltarArquivos, true);
input.addEventListener('drop', soltarArquivos);

// ---- tema (cores personalizáveis) ----
function applyTheme(c) {
  if (!c) return;
  const r = document.documentElement.style;
  r.setProperty('--user-bg', c.userBg || '#214a68');
  r.setProperty('--user-text', c.userText || '#e4f1fb');
  r.setProperty('--bot-bg', c.botBg || 'transparent');
  r.setProperty('--bot-text', c.botText || '#cfe3f5');
  r.setProperty('--think-text', c.thinkText || '#8aa3b8');
}
window.loop.getSettings().then((s) => applyTheme(s.colors));

// ---- eventos do engine ----
const agents = new Map(); // id -> { name, color, parent, bubble }
const label = (id) => { const a = agents.get(id); return a ? `[${a.name}]` : ''; };
const addThink = (t) => { think.textContent += t; think.scrollTop = think.scrollHeight; };

// indicador de "continua trabalhando" na conversa principal — evita a sensação de
// espaço vazio entre uma permissão respondida (ou uma ferramenta) e a próxima fala
let working = null;
function setWorking(text) {
  if (!working) working = addMsg(text, 'bot working');
  else { working.textContent = text; log.scrollTop = log.scrollHeight; }
}
function clearWorking() { if (working) { working.remove(); working = null; } }

window.loop.onEvent((ev) => {
  switch (ev.type) {
    case 'busy':
      $('stop').hidden = !ev.value;
      if (ev.value) { agents.clear(); current = null; setWorking('⏳ trabalhando…'); }
      else { clearWorking(); if (status.textContent.startsWith('⏳')) status.textContent = '✅ concluído'; }
      break;
    case 'theme': applyTheme(ev.colors); break;
    case 'cleared': reset(); break;
    case 'agent_start':
      agents.set(ev.id, { name: ev.agent, parent: ev.parent, bubble: null, model: ev.model, local: ev.local });
      lastModel = `${ev.model} (${ev.local ? 'local' : 'nuvem'})`;
      if (ev.parent) { addThink(`\n▶ ${ev.agent} iniciou (${ev.model} ${ev.local ? '🔒' : '☁'})\n`); setWorking(`🧩 ${ev.agent} trabalhando…`); }
      else { status.textContent = `⏳ ${ev.agent} · ${ev.model} · ${ev.local ? '🔒 local' : '☁ nuvem'}`; setWorking('⏳ trabalhando…'); }
      break;
    case 'agent_end':
      if (agents.get(ev.id)?.parent) addThink(`\n■ ${agents.get(ev.id).name} terminou\n`);
      break;
    case 'reasoning': addThink(ev.text); break;
    case 'text': {
      const a = agents.get(ev.id);
      if (!a) break;
      if (a.parent) { addThink(ev.text); break; }       // fala de subagente vai ao painel
      if (!a.bubble) {
        if (!ev.text.trim()) break; // ignora pedaço só com espaço/quebra de linha antes de haver texto de verdade (evita bolha vazia)
        clearWorking();
        a.bubble = addMsg('', 'bot');
      }
      a.bubble.textContent += ev.text;
      log.scrollTop = log.scrollHeight;
      break;
    }
    case 'tool': {
      const icon = { running: '🔧', done: '✔', error: '✖' }[ev.status];
      if (ev.status === 'running') {
        const arg = JSON.stringify(ev.args ?? {}).slice(0, 160);
        addThink(`\n${icon} ${label(ev.id)} ${ev.name} ${arg}\n`);
        setWorking(`🔧 ${label(ev.id)} executando ${ev.name}…`);
      } else {
        addThink(`${icon} ${ev.name}: ${String(ev.output ?? '').split('\n')[0].slice(0, 200)}\n`);
        setWorking('⏳ trabalhando…');
      }
      // nova bolha para o próximo texto do primário, depois de uma ferramenta
      const a = agents.get(ev.id); if (a) a.bubble = null;
      break;
    }
    case 'usage': {
      const u = ev.usage, a = agents.get(ev.id);
      const m = a ? `${a.model} ${a.local ? '🔒' : '☁'} · ` : '';
      status.textContent = `📊 ${m}tokens: entrada ${u.prompt_tokens ?? 0} · saída ${u.completion_tokens ?? 0}` +
        (ev.tps != null ? ` · ⚡ ${ev.tps.toLocaleString('pt-BR')} tok/s` : '') + (ev.ttftMs != null ? ` · 1º token ${ev.ttftMs < 1000 ? ev.ttftMs + ' ms' : (ev.ttftMs / 1000).toFixed(1).replace('.', ',') + ' s'}` : '');
      break;
    }
    case 'permission': permissionCard(ev); break;
    case 'permission_done': { // pedido cancelado com o cartão ainda aberto
      const b = log.querySelector(`.perm[data-perm="${ev.id}"] .btns`);
      if (b) b.textContent = 'Cancelado';
      break;
    }
    case 'project': projectCard(ev); break;
    case 'contexto_detectado':
      addThink(`\n📏 Contexto detectado em ${ev.model}: ${ev.nCtx} tokens (limite de uso: ${ev.limite})\n`);
      break;
    case 'compact': {
      addThink(`\n🗜️ Contexto reduzido (${ev.antes} → ${ev.depois} tokens estimados${ev.resumo ? '; o começo da conversa foi resumido' : ''})\n`);
      status.textContent = '🗜️ conversa longa: o início foi condensado para caber no contexto';
      break;
    }
    case 'nudge':
      addThink(
        ev.motivo === 'pesquisa' ? '\n⏱ pesquisa suficiente: o agente foi orientado a escrever o resultado agora\n' :
        ev.motivo === 'alegacao' ? `\n⚠ o agente disse que já tinha feito, sem usar nenhuma ferramenta; mandei executar de verdade (${ev.n})\n` :
        ev.motivo === 'teste' ? '\n🧪 projeto ainda não foi executado; mandei testar e corrigir antes de entregar\n' :
        ev.motivo === 'raciocinio' ? `\n✂ raciocínio longo demais sem agir; cortei e mandei executar (${ev.n})\n` :
        ev.motivo === 'arquivos' ? '\n📁 o agente mostrou o código só no chat; mandei criar a pasta e os arquivos\n' :
        `\n↻ o agente parou antes de agir; mandei continuar (${ev.n})\n`
      );
      setWorking(ev.motivo === 'pesquisa' ? '⏳ escrevendo o resultado…' : ev.motivo === 'alegacao' ? '⚠ executando de verdade…' : ev.motivo === 'arquivos' ? '📁 criando os arquivos…' : '↻ continuando…');
      break;
    case 'waiting': setWorking(`⏳ aguardando o modelo… ${ev.secs}s sem resposta (servidor lendo o prompt ou travado — dá para parar)`); break;
    case 'skill_loaded': addThink(`\n📚 skill carregada: ${ev.id}\n`); break;
    case 'error': addMsg(ev.text || 'erro', 'bot err'); break;
  }
});

function permissionCard(ev) {
  const box = document.createElement('div');
  box.className = 'msg perm';
  box.dataset.perm = ev.id;
  const detail = ev.args.command ?? ev.args.path ?? ev.args.url ?? JSON.stringify(ev.args);
  box.innerHTML = '<b></b><code></code><div class="btns"></div>';
  box.querySelector('b').textContent = `🔐 ${ev.agent} quer usar "${ev.tool}"${ev.aviso ? " — " + ev.aviso : ""}`;
  box.querySelector('code').textContent = String(detail).slice(0, 600);
  const done = (reply, txt) => { window.loop.replyPermission(ev.id, reply); box.querySelector('.btns').textContent = txt; setWorking('⏳ continuando…'); };
  for (const [reply, txt] of [['once', 'Permitir'], ['always', 'Sempre (sessão)'], ['reject', 'Negar']]) {
    const b = document.createElement('button');
    b.textContent = txt;
    b.onclick = () => done(reply, `${txt} ✓`);
    box.querySelector('.btns').appendChild(b);
  }
  log.appendChild(box);
  log.scrollTop = log.scrollHeight;
}

// ---- exportar conversa em HTML (imprimível / "Salvar como PDF") ----
const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
$('export').onclick = async () => {
  const body = [...log.children].map((n) => {
    if (n.classList.contains('perm')) return `<div class="perm">${esc(n.innerText)}</div>`;
    return `<div class="msg ${n.classList.contains('user') ? 'user' : 'bot'}"><span class="who">${n.classList.contains('user') ? 'Pergunta' : 'Resposta'}</span>${esc(n.textContent)}</div>`;
  }).join('\n');
  const r = await window.loop.exportHtml({ body, activity: think.textContent.trim(), model: lastModel });
  if (r?.path) status.textContent = `💾 salvo: ${r.path}`;
};

function projectCard(ev) {
  const box = document.createElement('div');
  box.className = 'msg proj';
  const t = document.createElement('div');
  t.textContent = `📁 Pasta do trabalho: ${ev.path}`;
  const b = Object.assign(document.createElement('button'), { textContent: 'Abrir pasta' });
  b.onclick = () => window.loop.openPath(ev.path);
  box.append(t, b);
  log.appendChild(box);
  log.scrollTop = log.scrollHeight;
}


// ---- retomar conversa, painéis de conversas salvas e de desfazer, registro, colar imagem ----
function renderView(view, title) {
  log.replaceChildren(); think.textContent = ''; working = null;
  addMsg(`🕘 Conversa retomada: ${title || '(sem título)'}`, 'bot');
  for (const v of view || []) {
    if (v.r === 'user') addMsg(v.t + (v.f?.length ? `\n📎 ${v.f.join(', ')}` : ''), 'user');
    else if (v.r === 'bot') addMsg(v.t, 'bot');
    else if (v.r === 'tool') addThink(`🔧 ${v.n} ${v.a || ''} ${v.e === 'ok' ? '✔' : v.e === 'negado' ? '⛔' : '✖'}\n`);
    else if (v.r === 'proj') projectCard({ path: v.p });
  }
  status.textContent = '🕘 conversa retomada — continue de onde parou';
  log.scrollTop = log.scrollHeight;
}
window.loop.sessionCurrent().then((r) => { if (r) renderView(r.view, r.title); });

const when = (v) => new Date(v).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
function openPanel(title) { $('ovtitle').textContent = title; $('ovbody').replaceChildren(); $('overlay').hidden = false; return $('ovbody'); }
$('ovclose').onclick = () => { $('overlay').hidden = true; };
function row(titulo, pequeno, botoes) {
  const d = document.createElement('div'); d.className = 'ovrow';
  const t = document.createElement('div'); t.className = 't'; t.textContent = titulo;
  const sm = document.createElement('small'); sm.textContent = pequeno; t.appendChild(sm);
  d.append(t, ...botoes);
  return d;
}
const btn = (txt, fn, cls = '') => Object.assign(document.createElement('button'), { textContent: txt, className: cls, onclick: fn });

async function showSessions() {
  const body = openPanel('🕘 Conversas salvas');
  const draw = (lista) => {
    body.replaceChildren(...(lista.length ? lista.map((s) => row(`${s.atual ? '● ' : ''}${s.title}`, `${when(s.updatedAt)} · ${s.mensagens} pedido(s)${s.agent ? ' · ' + s.agent : ''}`, [
      btn('Abrir', async () => { const r = await window.loop.sessionOpen(s.id); if (r) { renderView(r.view, r.title); $('overlay').hidden = true; } }),
      ...(s.atual ? [] : [btn('Apagar', async () => { if (confirm(`Apagar a conversa "${s.title}"?`)) draw(await window.loop.sessionDelete(s.id)); }, 'del')]),
    ])) : [Object.assign(document.createElement('div'), { className: 'ovnote', textContent: 'Nenhuma conversa salva ainda.' })]));
  };
  draw(await window.loop.sessionList());
}
$('sessions').onclick = showSessions;

async function showUndo() {
  const body = openPanel('↩ Alterações em arquivos (esta conversa)');
  const draw = async () => {
    const lista = await window.loop.changesList();
    body.replaceChildren(Object.assign(document.createElement('div'), { className: 'ovnote', textContent: 'Desfaz arquivos criados ou editados pelo agente (write, edit, documentos). Comandos de terminal não são desfeitos.' }),
      ...(lista.length ? lista.map((c) => row(c.path.split(/[\\/]/).pop(), `${c.acao} · ${new Date(c.t).toLocaleTimeString('pt-BR')} · ${c.path}${c.desfeito ? ' · desfeito' : c.temCopia ? '' : ' · sem cópia (arquivo grande)'}`, [
        btn(c.acao === 'criado' ? 'Remover' : 'Restaurar', async () => { const r = await window.loop.changesUndo(c.id); status.textContent = r.ok ? `↩ ${r.msg}` : `⚠ ${r.error}`; draw(); }),
      ].map((b) => { b.disabled = c.desfeito || !c.temCopia; return b; }))) : [Object.assign(document.createElement('div'), { className: 'ovnote', textContent: 'Nenhuma alteração registrada nesta conversa.' })]));
  };
  draw();
}
$('undo').onclick = showUndo;
$('audit').onclick = async () => { const r = await window.loop.auditExport(); if (r?.path) status.textContent = `📋 registro de atividades salvo: ${r.path}`; };

// colar imagem (Ctrl+V) no campo de texto
input.addEventListener('paste', async (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.kind === 'file' && i.type.startsWith('image/'));
  if (!item) return;
  e.preventDefault();
  const f = item.getAsFile();
  const b64 = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.readAsDataURL(f); });
  files.push(await window.loop.savePastedImage(b64, (item.type.split('/')[1] || 'png').replace('jpeg', 'jpg')));
  renderChips();
});
