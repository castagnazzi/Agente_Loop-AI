const $ = (id) => document.getElementById(id);
const PERMS = ['allow', 'ask', 'deny'];
const KINDS = ['read', 'write', 'exec', 'net'];
const PRESETS = {
  '': { name: '(personalizado)', url: '' },
  nvidia: { name: 'NVIDIA', url: 'https://integrate.api.nvidia.com/v1' },
  openai: { name: 'OpenAI', url: 'https://api.openai.com/v1' },
  openrouter: { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1' },
  groq: { name: 'Groq', url: 'https://api.groq.com/openai/v1' },
  ollama: { name: 'Ollama (local)', url: 'http://localhost:11434/v1' },
  lmstudio: { name: 'LM Studio (local)', url: 'http://localhost:1234/v1' },
  llamacpp: { name: 'llama.cpp (local)', url: 'http://localhost:8080/v1' },
};

let state = { providers: [] };   // provedores: { id, name, baseURL, apiKey, models: [habilitados], available: [todos buscados] }
let sel = -1;                    // provedor em edição
const fill = (el, vals, cur) => el.replaceChildren(...vals.map((v) => Object.assign(document.createElement('option'), { value: v, textContent: v, selected: v === cur })));
const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'provedor';

// ---- abas ----
document.querySelectorAll('nav button').forEach((b) => (b.onclick = () => {
  document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('section').forEach((s) => s.classList.toggle('on', s.id === b.dataset.t));
  if (b.dataset.t === 'agents') { commitForm(); window.loop.extList().then((r) => { extInfo = r; renderAgentForm(); }); }
}));

// ---- provedores ----
function renderChips() {
  $('plist').replaceChildren(...state.providers.map((p, i) => {
    const c = Object.assign(document.createElement('span'), { className: 'pchip' + (i === sel ? ' on' : ''), textContent: `${p.name} (${p.models.length})` });
    c.onclick = () => { commitForm(); sel = i; renderForm(); };
    return c;
  }));
}

function allModels(p) { return [...new Set([...(p.available || []), ...p.models])].sort((a, b) => a.localeCompare(b)); }

function renderModels() {
  const p = state.providers[sel]; if (!p) return;
  const f = $('mfilter').value.toLowerCase();
  const vis = allModels(p).filter((m) => m.toLowerCase().includes(f));
  $('mlist').replaceChildren(...vis.map((m) => {
    const ehPadrao = state.defaultModel === `${p.id}/${m}`;
    const row = Object.assign(document.createElement('div'), { className: 'mrow' + (ehPadrao ? ' def' : ''), title: 'Clique para usar este modelo (vira o padrão)' });
    const cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: p.models.includes(m), title: 'Mostrar no seletor de modelos' });
    // marcar a caixinha também torna o modelo o padrão; desmarcar só o tira do seletor
    cb.onchange = () => { if (cb.checked) usarModelo(p, m); else { p.models = p.models.filter((x) => x !== m); renderModels(); } };
    cb.onclick = (e) => e.stopPropagation();
    const nome = Object.assign(document.createElement('span'), { className: 'name', textContent: m });
    const tag = Object.assign(document.createElement('span'), { className: ehPadrao ? 'badge' : 'use', textContent: ehPadrao ? '⭐ padrão' : 'usar' });
    row.onclick = () => usarModelo(p, m);
    row.append(cb, nome, tag);
    return row;
  }));
  updateCounts(vis.length);
}
/** Escolher um modelo = habilitá-lo e já defini-lo como o modelo padrão. */
function usarModelo(p, m) {
  if (!p.models.includes(m)) p.models = [...p.models, m];
  state.defaultModel = `${p.id}/${m}`;
  renderModels();
  $('msg').style.color = '#8be9a0'; $('msg').textContent = `⭐ ${m} agora é o modelo padrão — clique em Salvar para aplicar`;
}
function updateCounts(vis) {
  const p = state.providers[sel];
  if (p) $('mcount').textContent = `${p.models.length} marcado(s) de ${allModels(p).length}` + (vis != null ? ` · ${vis} visível(is)` : '');
  renderChips(); renderDefault();
}

function renderForm() {
  const p = state.providers[sel];
  $('pform').hidden = !p;
  renderChips();
  if (!p) return;
  $('pname').value = p.name; $('purl').value = p.baseURL; $('pkey').value = p.apiKey || '';
  $('mfilter').value = ''; $('mmsg').textContent = '';
  renderModels();
}
function uniqueId(name, self) {
  const base = slug(name);
  let id = base, n = 2;
  while (state.providers.some((q) => q !== self && q.id === id)) id = `${base}-${n++}`;
  return id;
}
function commitForm() {
  const p = state.providers[sel]; if (!p) return;
  p.name = $('pname').value.trim() || p.name;
  if (p._auto) { // provedor novo: o id acompanha o nome até ser salvo
    const old = p.id;
    p.id = uniqueId(p.name, p);
    if (old && old !== p.id && state.defaultModel.startsWith(old + '/')) state.defaultModel = p.id + state.defaultModel.slice(old.length);
  }
  p.baseURL = $('purl').value.trim();
  p.apiKey = $('pkey').value.trim();
}

function renderDefault() {
  const opts = state.providers.flatMap((p) => p.models.map((m) => `${p.id}/${m}`));
  const cur = state.defaultModel;
  fill($('defaultModel'), opts.length ? opts : [''], opts.includes(cur) ? cur : opts[0] || '');
  state.defaultModel = $('defaultModel').value;
  $('defname').textContent = state.defaultModel || '(nenhum modelo marcado)';
}
$('defaultModel').onchange = () => { state.defaultModel = $('defaultModel').value; $('defname').textContent = state.defaultModel; if (sel >= 0) renderModels(); };

$('preset').replaceChildren(...Object.entries(PRESETS).map(([k, v]) => Object.assign(document.createElement('option'), { value: k, textContent: v.name })));
$('preset').onchange = () => {
  const pr = PRESETS[$('preset').value];
  if (!pr.url) return;
  $('purl').value = pr.url;
  if (!$('pname').value.trim()) $('pname').value = pr.name;
};

$('newp').onclick = () => {
  commitForm();
  const p = { id: '', name: 'Novo provedor', baseURL: '', apiKey: '', models: [], available: [], _auto: true };
  p.id = uniqueId(p.name, p);
  state.providers.push(p);
  sel = state.providers.length - 1;
  renderForm();
  $('pname').select();
};
$('delp').onclick = () => {
  if (sel < 0) return;
  state.providers.splice(sel, 1); sel = -1;
  renderForm(); renderDefault();
};
$('mfilter').oninput = renderModels;
$('selvis').onclick = () => bulk(true);
$('clrvis').onclick = () => bulk(false);
function bulk(on) {
  const p = state.providers[sel]; if (!p) return;
  const f = $('mfilter').value.toLowerCase();
  const vis = allModels(p).filter((m) => m.toLowerCase().includes(f));
  p.models = on ? [...new Set([...p.models, ...vis])] : p.models.filter((m) => !vis.includes(m));
  renderModels();
}

$('fetch').onclick = async () => {
  commitForm();
  const p = state.providers[sel];
  if (!p?.baseURL) { $('mmsg').style.color = '#ff8a8a'; $('mmsg').textContent = 'Informe a URL da API.'; return; }
  $('mmsg').style.color = '#8aa3b8'; $('mmsg').textContent = 'buscando…';
  const r = await window.loop.fetchModels({ baseURL: p.baseURL, apiKey: p.apiKey });
  if (!r.ok) { $('mmsg').style.color = '#ff8a8a'; $('mmsg').textContent = r.error.slice(0, 120); return; }
  p.available = r.models;
  // descarta modelos marcados antes que este endpoint não oferece (ex.: URL trocada de outro provedor)
  const dropped = p.models.filter((m) => !r.models.includes(m));
  p.models = p.models.filter((m) => r.models.includes(m));
  $('mmsg').style.color = '#8be9a0'; $('mmsg').textContent = `${r.models.length} modelos encontrados — clique em um para usá-lo` + (dropped.length ? ` (removidos ${dropped.length} que não existem aqui)` : '');
  renderModels();
};

$('import').onclick = async () => {
  commitForm();
  for (const f of await window.loop.importOpencode()) {
    const i = state.providers.findIndex((p) => p.id === f.id);
    const prev = state.providers[i];
    const merged = { ...f, available: prev?.available || [], models: [...new Set([...(prev?.models || []), ...f.models])] };
    if (i >= 0) state.providers[i] = merged; else state.providers.push(merged);
  }
  sel = state.providers.length ? 0 : -1;
  renderForm(); renderDefault();
};

// ---- agentes (formulário; a lista é validada aqui e de novo ao salvar) ----
const PERM_LABEL = [['', '(padrão geral)'], ['allow', 'Liberado'], ['ask', 'Perguntar'], ['deny', 'Bloqueado']];
const MODE_LABEL = [['primary', 'Principal (conversa com você)'], ['subagent', 'Ajudante (recebe tarefas)']];
const TOOL_LABEL = {
  read: 'Ler arquivos', glob: 'Procurar arquivos', grep: 'Procurar texto', write: 'Criar arquivos', edit: 'Editar arquivos', bash: 'Executar comandos',
  webfetch: 'Acessar a web', todowrite: 'Lista de tarefas', diagnostico_pc: 'Diagnóstico do PC', relatorio_uso: 'Relatório de uso do PC',
};
const NAME_RE = /^[\p{L}\p{N}_-]{1,30}$/u;
let agents = [], asel = 0, defaultAgents = [], extInfo = { skills: [], plugins: [] };
const fillKV = (el, pairs, cur) => el.replaceChildren(...pairs.map(([v, t]) => Object.assign(document.createElement('option'), { value: v, textContent: t, selected: v === cur })));
const isLoop = (a) => a && a.name === 'loop';
const clone = (o) => JSON.parse(JSON.stringify(o));

function nameProblem(a, i) {
  if (!a.name.trim()) return 'Dê um nome ao agente.';
  if (!NAME_RE.test(a.name.trim())) return 'Use só letras, números, - e _ (sem espaços), até 30 caracteres.';
  if (agents.some((o, j) => j < i && o.name.trim() === a.name.trim())) return 'Já existe um agente com este nome.';
  return '';
}

function renderAchips() {
  $('alist').replaceChildren(...agents.map((a, i) => {
    const c = Object.assign(document.createElement('span'), { className: 'pchip' + (i === asel ? ' on' : ''), textContent: `${a.name || '(sem nome)'}${a.mode === 'subagent' ? ' · ajudante' : ''}` });
    if (nameProblem(a, i)) c.style.borderColor = '#ff8a8a';
    c.onclick = () => { commitAgent(); asel = i; renderAgentForm(); };
    return c;
  }));
}

function refreshActive() {
  const cur = $('activeAgent').value || $('activeAgent').dataset.cur;
  const names = agents.filter((a) => a.mode !== 'subagent' && a.name.trim()).map((a) => a.name.trim());
  fill($('activeAgent'), names, names.includes(cur) ? cur : names[0]);
  $('activeAgent').dataset.cur = $('activeAgent').value;
}

function checkBox(group, value, label, checked, onchange) {
  const l = document.createElement('label');
  const cb = Object.assign(document.createElement('input'), { type: 'checkbox', value, checked });
  cb.dataset.g = group; cb.onchange = onchange;
  l.append(cb, ' ' + label);
  return l;
}

function renderAgentForm() {
  const a = agents[asel];
  $('aform').hidden = !a;
  renderAchips();
  if (!a) return;
  const lock = isLoop(a);
  $('a_name').value = a.name; $('a_name').disabled = lock;
  fillKV($('a_mode'), MODE_LABEL, a.mode); $('a_mode').disabled = lock;
  $('a_desc').value = a.description || ''; $('a_system').value = a.system || '';
  const models = state.providers.flatMap((p) => p.models.map((m) => `${p.id}/${m}`));
  const cur = a.model && models.includes(a.model) ? a.model : a.model || '';
  fillKV($('a_model'), [['', '(usar o modelo padrão)'], ...[...new Set([...models, ...(cur ? [cur] : [])])].map((m) => [m, m])], cur);
  // ferramentas
  const tools = a.tools || [], pick = tools.length > 0;
  document.querySelector('input[name=a_toolsMode][value=' + (pick ? 'pick' : 'all') + ']').checked = true;
  const known = [...Object.keys(TOOL_LABEL), ...extInfo.plugins.map((p) => p.id)];
  const labelOf = (v) => TOOL_LABEL[v] || 'Plugin: ' + (extInfo.plugins.find((p) => p.id === v)?.name || v);
  const all = [...known, ...tools.filter((t) => !known.includes(t))];
  $('a_tools').replaceChildren(...all.map((v) => checkBox('tools', v, labelOf(v), tools.includes(v), onAgentInput)));
  $('a_tools').hidden = !pick;
  // skills
  const sk = Array.isArray(a.skills) ? a.skills : null;
  document.querySelector('input[name=a_skillsMode][value=' + (sk ? 'pick' : 'all') + ']').checked = true;
  const skAll = [...extInfo.skills.map((s) => [s.id, s.name]), ...(sk || []).filter((id) => !extInfo.skills.some((s) => s.id === id)).map((id) => [id, id + ' (não instalada)'])];
  $('a_skills').replaceChildren(...(skAll.length ? skAll.map(([id, n]) => checkBox('skills', id, n, !!sk && sk.includes(id), onAgentInput)) : [Object.assign(document.createElement('div'), { className: 'hint', textContent: 'Nenhuma skill instalada.' })]));
  $('a_skills').hidden = !sk;
  // permissões, delegação, passos, cor
  for (const k of KINDS) fillKV($('a_' + k), PERM_LABEL, a.permissions?.[k] || '');
  $('a_deleg').checked = !!a.canDelegate; $('a_steps').value = a.steps || 25; $('a_color').value = /^#[0-9a-f]{6}$/i.test(a.color) ? a.color : '#7fd4f5';
  $('delAgent').hidden = lock;
  $('a_nameErr').textContent = nameProblem(a, asel);
}

/** Lê o formulário para o agente selecionado (mantém campos que o formulário não mostra). */
function commitAgent() {
  const a = agents[asel]; if (!a || $('aform').hidden) return;
  if (!isLoop(a)) { a.name = $('a_name').value.trim(); a.mode = $('a_mode').value; }
  a.description = $('a_desc').value.trim(); a.system = $('a_system').value;
  if ($('a_model').value) a.model = $('a_model').value; else delete a.model;
  const toolsPick = document.querySelector('input[name=a_toolsMode]:checked').value === 'pick';
  a.tools = toolsPick ? [...document.querySelectorAll('#a_tools input:checked')].map((c) => c.value) : [];
  if (toolsPick && !a.tools.length) a._vazio = true; else delete a._vazio; // "só as marcadas" sem nenhuma marcada
  if (document.querySelector('input[name=a_skillsMode]:checked').value === 'pick') a.skills = [...document.querySelectorAll('#a_skills input:checked')].map((c) => c.value); else delete a.skills;
  a.permissions = {};
  for (const k of KINDS) if ($('a_' + k).value) a.permissions[k] = $('a_' + k).value;
  a.canDelegate = $('a_deleg').checked;
  a.steps = Math.max(1, Math.min(100, Math.round(Number($('a_steps').value)) || 25));
  a.color = $('a_color').value;
}

function onAgentInput() {
  const wasSkills = !$('a_skills').hidden, wasTools = !$('a_tools').hidden;
  const toolsPick = document.querySelector('input[name=a_toolsMode]:checked').value === 'pick';
  const skillsPick = document.querySelector('input[name=a_skillsMode]:checked').value === 'pick';
  $('a_tools').hidden = !toolsPick; $('a_skills').hidden = !skillsPick;
  if (toolsPick && !wasTools && !document.querySelector('#a_tools input:checked')) ['read', 'glob', 'grep'].forEach((v) => { const c = document.querySelector(`#a_tools input[value=${v}]`); if (c) c.checked = true; }); // começa só com leitura
  commitAgent();
  const bad = nameProblem(agents[asel], asel);
  $('a_nameErr').textContent = bad;
  renderAchips(); refreshActive();
}
['a_name', 'a_mode', 'a_desc', 'a_system', 'a_model', 'a_read', 'a_write', 'a_exec', 'a_net', 'a_deleg', 'a_steps', 'a_color'].forEach((id) => ($(id).oninput = onAgentInput));
document.querySelectorAll('input[name=a_toolsMode],input[name=a_skillsMode]').forEach((r) => (r.onchange = onAgentInput));

$('newAgent').onclick = () => {
  commitAgent();
  let n = 1; while (agents.some((a) => a.name === `agente${n}`)) n++;
  agents.push({ name: `agente${n}`, mode: 'subagent', color: '#c9a7ff', steps: 20, description: '', system: 'Você é um assistente especializado. Descreva aqui o que ele deve fazer e como.', tools: ['read', 'glob', 'grep'], permissions: {} });
  asel = agents.length - 1; renderAgentForm(); refreshActive(); $('a_name').select();
};
$('delAgent').onclick = () => {
  const a = agents[asel]; if (!a || isLoop(a)) return;
  if (!confirm(`Remover o agente "${a.name}"?`)) return;
  agents.splice(asel, 1); asel = 0; renderAgentForm(); refreshActive();
};
$('resetAgents').onclick = () => {
  if (!confirm('Restaurar os agentes padrão (loop, pesquisador, programador, revisor) ao original?\nOs agentes que você criou são mantidos.')) return;
  commitAgent();
  const names = new Set(defaultAgents.map((d) => d.name));
  agents = [...clone(defaultAgents), ...agents.filter((a) => !names.has(a.name))];
  asel = 0; renderAgentForm(); refreshActive();
};

/** Validação ao salvar. Retorna texto do problema ou ''. */
function validateAgents() {
  commitAgent();
  for (let i = 0; i < agents.length; i++) {
    const p = nameProblem(agents[i], i) || (agents[i]._vazio ? 'marque ao menos uma ferramenta ou escolha "Todas".' : '');
    if (p) { asel = i; renderAgentForm(); return `Agente "${agents[i].name || i + 1}": ${p}`; }
  }
  if (!agents.some((a) => a.mode !== 'subagent')) return 'É preciso haver ao menos um agente principal.';
  return '';
}

$('activeAgent').onchange = () => ($('activeAgent').dataset.cur = $('activeAgent').value);

(async () => {
  const s = await window.loop.getSettings();
  state = {
    providers: (s.providers || []).map((p) => ({ available: [], ...p })),
    defaultModel: s.defaultModel || '',
  };
  sel = state.providers.length ? 0 : -1;
  agents = clone(s.agents || []); defaultAgents = s.defaultAgents || []; asel = 0;
  extInfo = await window.loop.extList();
  $('activeAgent').dataset.cur = s.activeAgent;
  KINDS.forEach((k) => fill($('p_' + k), PERMS, s.permissions?.[k]));
  $('workDir').value = s.workDir || '';
  $('outDir').value = s.outDir || '';
  $('contextLimit').value = s.contextLimit ?? 48000; $('vision').checked = !!s.vision;
  $('reasoningMode').value = s.reasoningMode || 'limit'; $('reasoningLimit').value = s.reasoningLimit || 5000;
  const syncRaciocinio = () => { $('reasoningLimit').disabled = $('reasoningMode').value !== 'limit'; };
  $('reasoningMode').onchange = syncRaciocinio; syncRaciocinio();
  $('petSize').value = $('petSizeR').value = s.petSize; $('sizeV').textContent = s.petSize;
  $('petOpacity').value = Math.round((s.petOpacity ?? 1) * 100); $('chatOpacity').value = Math.round((s.chatOpacity ?? 1) * 100);
  syncLabels();
  $('alwaysOnTop').checked = !!s.alwaysOnTop;
  refreshActive(); renderAgentForm(); renderForm(); renderDefault();
  if (!state.providers.length) $('newp').click();
})();

function syncLabels() { $('poV').textContent = $('petOpacity').value; $('coV').textContent = $('chatOpacity').value; }
// pré-visualização ao vivo: salva só os campos visuais enquanto arrasta
const live = () => window.loop.saveSettings({
  petSize: Number($('petSize').value) || 96,
  petOpacity: Number($('petOpacity').value) / 100, chatOpacity: Number($('chatOpacity').value) / 100,
});
$('petSizeR').oninput = () => { $('petSize').value = $('petSizeR').value; $('sizeV').textContent = $('petSize').value; live(); };
$('petSize').onchange = () => { $('petSizeR').value = $('petSize').value; $('sizeV').textContent = $('petSize').value; live(); };
['petOpacity', 'chatOpacity'].forEach((id) => ($(id).oninput = () => { syncLabels(); live(); }));

$('save').onclick = async () => {
  commitForm();
  const bad = validateAgents();
  if (bad) { document.querySelector('nav button[data-t=agents]').click(); $('msg').style.color = '#ff8a8a'; $('msg').textContent = bad; return; }
  const agentsOut = agents.map(({ _vazio, ...a }) => a);
  const providers = state.providers.filter((p) => p.baseURL)
    .map((p) => ({ id: p.id, name: p.name, baseURL: p.baseURL, apiKey: p.apiKey, models: p.models }));
  state.providers.forEach((p) => delete p._auto); // ids passam a ser fixos
  if (!providers.some((p) => state.defaultModel.startsWith(p.id + '/'))) renderDefault();
  await window.loop.saveSettings({
    providers, agents: agentsOut,
    defaultModel: state.defaultModel,
    permissions: Object.fromEntries(KINDS.map((k) => [k, $('p_' + k).value])),
    activeAgent: $('activeAgent').value,
    workDir: $('workDir').value.trim(),
    outDir: $('outDir').value.trim(),
    contextLimit: Number.isFinite(Number($('contextLimit').value)) && $('contextLimit').value !== '' ? Math.max(0, Math.round(Number($('contextLimit').value))) : 48000,
    vision: $('vision').checked,
    reasoningMode: $('reasoningMode').value,
    reasoningLimit: Math.max(500, Math.round(Number($('reasoningLimit').value)) || 5000),
    petSize: Number($('petSize').value) || 96,
    petOpacity: Number($('petOpacity').value) / 100,
    chatOpacity: Number($('chatOpacity').value) / 100,
    colors: readColors(),
    alwaysOnTop: $('alwaysOnTop').checked,
  });
  $('msg').style.color = '#8be9a0'; $('msg').textContent = 'Salvo ✓';
};

$('close').onclick = () => window.close();

// ---- extensões (skills / plugins) ----
function renderExt(r) {
  const row = (kind, x) => {
    const d = document.createElement('div'); d.className = 'xi';
    const cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: x.enabled, title: 'Habilitada' });
    cb.onchange = async () => renderExt(await window.loop.extToggle(kind, x.id, cb.checked));
    const t = document.createElement('div'); t.className = 't';
    t.append(Object.assign(document.createElement('b'), { textContent: x.name }));
    t.append(Object.assign(document.createElement('small'), { textContent: x.description || '' }));
    if (kind === 'plugin' && r.errors[x.id]) t.append(Object.assign(document.createElement('small'), { className: 'err', textContent: 'Erro: ' + r.errors[x.id] }));
    const del = Object.assign(document.createElement('button'), { className: 'b del', textContent: 'Remover' });
    del.onclick = async () => { if (confirm(`Remover "${x.name}"?`)) renderExt(await window.loop.extRemove(kind, x.id)); };
    d.append(cb, t, del);
    return d;
  };
  const empty = (txt) => Object.assign(document.createElement('div'), { className: 'hint', textContent: txt });
  $('skillList').replaceChildren(...(r.skills.length ? r.skills.map((x) => row('skill', x)) : [empty('Nenhuma skill adicionada.')]));
  $('pluginList').replaceChildren(...(r.plugins.length ? r.plugins.map((x) => row('plugin', x)) : [empty('Nenhum plugin adicionado.')]));
}
async function addExt(kind, mode) {
  const r = await window.loop.extAdd(kind, mode);
  renderExt(r);
  $('extMsg').style.color = r.error ? '#ff8a8a' : '#8be9a0';
  $('extMsg').textContent = r.error || (r.added ? `"${r.added}" adicionado ✓` : '');
}
$('addSkillDir').onclick = () => addExt('skill', 'dir');
$('addSkillFile').onclick = () => addExt('skill', 'file');
$('addPlugin').onclick = () => addExt('plugin', 'dir');
$('openSkills').onclick = () => window.loop.extOpenFolder('skill');
$('openPlugins').onclick = () => window.loop.extOpenFolder('plugin');
window.loop.extList().then(renderExt);

// ---- adicionar por endereço (GitHub) ----
let analysis = null;
const fmtSize = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
const KIND_LABEL = { skill: 'Skill', plugin: 'Plugin', agent: 'Agente' };
const remoteMsg = (t, ok) => { $('remoteMsg').style.color = ok === false ? '#ff8a8a' : ok ? '#8be9a0' : '#8aa3b8'; $('remoteMsg').textContent = t; };

function updateRemoteSel() {
  const n = document.querySelectorAll('#remoteItems input:checked').length;
  $('remoteSel').textContent = `${n} selecionado(s)`;
  $('remoteAdd').disabled = !n;
}

async function analyzeRemote() {
  const url = $('remoteUrl').value.trim();
  if (!url) return remoteMsg('Cole o endereço do projeto.', false);
  $('remoteGo').disabled = true; $('remoteRes').hidden = true;
  remoteMsg('analisando o repositório…');
  const r = await window.loop.remoteAnalyze(url);
  $('remoteGo').disabled = false;
  if (!r.ok) return remoteMsg(r.error, false);
  analysis = r;
  if (!r.items.length) return remoteMsg(`Nada encontrado em ${r.repo}: não há SKILL.md, plugin (index.js + package.json) nem agentes (agents/*.md).`, false);
  remoteMsg(`${r.repo}: ${r.items.length} item(ns) encontrado(s)` + (r.truncated ? ' (repositório muito grande: lista pode estar incompleta)' : ''), true);
  $('remoteItems').replaceChildren(...r.items.map((it) => {
    const d = document.createElement('label'); d.className = 'xi';
    const cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !it.tooBig && it.kind !== 'plugin', disabled: it.tooBig });
    cb.dataset.key = it.key; cb.dataset.kind = it.kind; cb.onchange = updateRemoteSel;
    const t = document.createElement('div'); t.className = 't';
    t.append(Object.assign(document.createElement('b'), { textContent: `${KIND_LABEL[it.kind]} · ${it.name || it.id}` }));
    t.append(Object.assign(document.createElement('small'), { textContent: it.description || '(sem descrição)' }));
    const extra = it.kind === 'agent' ? 'vira subagente' : `${it.files} arquivo(s) · ${fmtSize(it.bytes)}` + (it.copies > 1 ? ` · ${it.copies} cópias no repositório, usa a principal` : '');
    t.append(Object.assign(document.createElement('small'), { textContent: it.tooBig ? `grande demais (${fmtSize(it.bytes)}), não pode ser adicionado` : extra, className: it.tooBig ? 'err' : '' }));
    d.append(cb, t);
    return d;
  }));
  $('remoteRes').hidden = false;
  updateRemoteSel();
}

async function installRemote() {
  const boxes = [...document.querySelectorAll('#remoteItems input:checked')];
  if (!boxes.length) return;
  $('remoteAdd').disabled = true;
  remoteMsg('baixando…');
  const r = await window.loop.remoteInstall(analysis.analysisId, boxes.map((b) => Number(b.dataset.key)), boxes.some((b) => b.dataset.kind === 'plugin'));
  if (!r.ok) { remoteMsg(r.error, false); return updateRemoteSel(); }
  renderExt(r);
  let msg = `Adicionado: ${r.done.join(', ')}.`;
  if (r.agents.length) { // agentes entram na lista da aba Agentes; vale após Salvar
    commitAgent();
    for (const a of r.agents) { const i = agents.findIndex((x) => x.name === a.name); if (i >= 0) agents[i] = a; else agents.push(a); }
    renderAgentForm(); refreshActive();
    msg += ' Clique em Salvar para ativar os agentes.';
  }
  remoteMsg(msg, true);
  $('remoteRes').hidden = true;
}
$('remoteGo').onclick = analyzeRemote;
$('remoteUrl').onkeydown = (e) => { if (e.key === 'Enter') analyzeRemote(); };
$('remoteAdd').onclick = installRemote;

// ---- cores do chat ----
const COLOR_DEFAULTS = { userBg: '#214a68', userText: '#e4f1fb', botBg: '', botText: '#cfe3f5', thinkText: '#8aa3b8' };
const readColors = () => ({
  userBg: $('c_userBg').value, userText: $('c_userText').value, botText: $('c_botText').value, thinkText: $('c_thinkText').value,
  botBg: $('c_botNone').checked ? '' : $('c_botBg').value,
});
function writeColors(c) {
  $('c_userBg').value = c.userBg; $('c_userText').value = c.userText; $('c_botText').value = c.botText; $('c_thinkText').value = c.thinkText;
  $('c_botBg').value = c.botBg || '#1b2a3f'; $('c_botNone').checked = !c.botBg;
  $('c_botBg').disabled = !c.botBg;
}
['c_userBg', 'c_userText', 'c_botBg', 'c_botText', 'c_thinkText', 'c_botNone'].forEach((id) => {
  $(id).oninput = () => { $('c_botBg').disabled = $('c_botNone').checked; window.loop.saveSettings({ colors: readColors() }); };
});
$('colorsReset').onclick = () => { writeColors(COLOR_DEFAULTS); window.loop.saveSettings({ colors: COLOR_DEFAULTS }); };
window.loop.getSettings().then((s) => writeColors({ ...COLOR_DEFAULTS, ...(s.colors || {}) }));


// ---- zoom do texto/janela (A− / A+ ; também Ctrl +/−/0 e Ctrl+roda) ----
(() => {
  const zv = document.getElementById('zv');
  const mostra = (z) => { zv.textContent = Math.round(z * 100) + '%'; };
  window.loop.onSettingsZoom(mostra);
  window.loop.getSettings().then((c) => mostra(c.settingsZoom || 0.9));
  document.getElementById('zm').onclick = () => window.loop.settingsZoom(-0.05);
  document.getElementById('zp').onclick = () => window.loop.settingsZoom(0.05);
  zv.onclick = () => window.loop.settingsZoom(0);
})();
