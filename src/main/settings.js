const { dataDir, legacyDir, baseDir } = require('./paths');
const fs = require('fs');
const path = require('path');

const BASE = [
  'Responda em português do Brasil, de forma clara e objetiva.',
  'Use as ferramentas para agir de verdade (ler/editar arquivos, rodar comandos) em vez de apenas explicar.',
  'Antes de alterar algo, leia o arquivo. Seja conciso no final: diga o que fez e o resultado.',
].join('\n');

const DEFAULT_AGENTS = [
  {
    name: 'loop', mode: 'primary', color: '#7fd4f5', canDelegate: true, steps: 30,
    description: 'Assistente principal que planeja e delega.',
    system: `Você é o Loop-AI, um assistente de desktop que atua como agente e orquestrador.\n${BASE}\n` +
      'Para tarefas simples, resolva você mesmo. Para tarefas grandes ou especializadas, divida em partes independentes e use a ferramenta `delegate` ' +
      '(várias delegações na mesma resposta rodam em paralelo). Depois sintetize os resultados dos subagentes numa resposta única.',
    tools: [], permissions: {},
  },
  {
    name: 'pesquisador', mode: 'subagent', color: '#9be37f', steps: 20,
    description: 'Pesquisa e explora código/arquivos/web somente leitura e resume achados.',
    system: `Você é um pesquisador. Investigue com read, glob, grep e webfetch e devolva um resumo objetivo com caminhos/linhas/fontes. Não modifique nada.\n${BASE}`,
    tools: ['read', 'glob', 'grep', 'webfetch'], permissions: {},
  },
  {
    name: 'programador', mode: 'subagent', color: '#ffb86b', steps: 30,
    description: 'Implementa mudanças: cria/edita arquivos e roda comandos/testes.',
    system: `Você é um programador sênior. Implemente exatamente a tarefa recebida, valide rodando o que for possível e relate os arquivos alterados.\n${BASE}`,
    tools: ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'todowrite'], permissions: {},
  },
  {
    name: 'revisor', mode: 'subagent', color: '#e08cf0', steps: 15,
    description: 'Revisa código/resultados procurando bugs, riscos e melhorias (somente leitura).',
    system: `Você é um revisor crítico. Leia o código indicado e liste problemas concretos por severidade, com arquivo:linha. Não edite.\n${BASE}`,
    tools: ['read', 'glob', 'grep'], permissions: {},
  },
];

const DEFAULTS = {
  providers: [],           // [{ id, name, baseURL, apiKey, models: [] }]
  defaultModel: '',        // "providerId/modelo"
  activeAgent: 'loop',
  agentsVersion: 5,
  contextLimit: 48000,    // tokens: acima disso a conversa é resumida automaticamente (0 = desligado)
  reasoningMode: 'limit', // raciocínio do modelo: 'free' (sem limite) | 'limit' (corta e manda agir) | 'off' (pede ao servidor para não raciocinar)
  reasoningLimit: 5000,   // tokens de raciocínio por passo no modo 'limit'
  vision: false,        // envia imagens anexadas ao modelo (só modelos com visão)
  permsVersion: 2,        // 2: escrita liberada dentro da pasta de trabalho
  agents: DEFAULT_AGENTS,
  permissions: { read: 'allow', write: 'allow', exec: 'ask', net: 'ask' }, // allow | ask | deny (escrita 'allow' vale só dentro das pastas de trabalho; fora delas pergunta)
  workDir: process.env.USERPROFILE || process.cwd(),
  outDir: '',              // pasta de saídas (projetos, relatórios); vazio = <app>/saidas
  alwaysOnTop: true,
  colors: { userBg: '#214a68', userText: '#e4f1fb', botBg: '', botText: '#cfe3f5', thinkText: '#8aa3b8' }, // botBg '' = sem fundo
  disabledSkills: [],
  disabledPlugins: [],
  petSize: 96,
  petOpacity: 1,   // 0.2 – 1
  chatOpacity: 1,  // 0.2 – 1
  petPos: null,
  settingsZoom: 0.9, // zoom da janela de Configurações (0.6 – 1.6)
  settingsWinSize: null, // { w, h } — tamanho da janela de Configurações, lembrado entre aberturas
};

/** Pasta onde cada pedido cria sua subpasta: "Pasta de saídas", senão a "Pasta de trabalho" escolhida, senão <app>/saidas.
 *  A pasta de trabalho padrão antiga (perfil do usuário) não conta como escolha. */
function outRoot(cfg) {
  if (cfg.outDir) return cfg.outDir;
  const w = cfg.workDir && path.resolve(cfg.workDir);
  const home = path.resolve(process.env.USERPROFILE || require('os').homedir());
  if (w && w.toLowerCase() !== home.toLowerCase()) return cfg.workDir;
  return path.join(baseDir(), 'saidas');
}

const file = () => path.join(dataDir(), 'settings.json');
const bakFile = () => file() + '.bak';
function readJsonSafe(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

// Primeira execução com a nova pasta: traz o settings.json antigo do AppData (copia; não apaga).
function migrate() {
  try {
    const old = path.join(legacyDir(), 'settings.json');
    if (!fs.existsSync(file()) && fs.existsSync(old)) {
      fs.mkdirSync(dataDir(), { recursive: true });
      fs.copyFileSync(old, file());
    }
  } catch { /* best-effort */ }
}

// Agentes padrão novos (por versão) são acrescentados sem sobrescrever os que o usuário já tem.
function upgradeAgents(cfg, savedVersion) {
  if (savedVersion >= DEFAULTS.agentsVersion) return cfg;
  // v5: diagnóstico e relatório de uso passaram a ser acionados pelo `loop` (roteamento automático); os agentes dedicados saíram
  if (savedVersion < 5) {
    cfg.agents = (cfg.agents || []).filter((a) => a.name !== 'diagnostico' && a.name !== 'auditoria');
    if (cfg.activeAgent === 'diagnostico' || cfg.activeAgent === 'auditoria') cfg.activeAgent = 'loop';
  }
  const have = new Set((cfg.agents || []).map((a) => a.name));
  cfg.agents = [...(cfg.agents || []), ...DEFAULT_AGENTS.filter((a) => !have.has(a.name))];
  cfg.agentsVersion = DEFAULTS.agentsVersion;
  return cfg;
}

const PERM_VALUES = ['allow', 'ask', 'deny'];

/** Garante uma lista de agentes utilizável (corrige arquivo editado à mão ou dados inválidos). Retorna { agents, ajustes }. */
function repairAgents(list) {
  const ajustes = [];
  const seen = new Set(), out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string' || !raw.name.trim()) { ajustes.push('agente sem nome removido'); continue; }
    const a = { ...raw, name: raw.name.trim() };
    if (seen.has(a.name)) { ajustes.push(`agente duplicado "${a.name}" removido`); continue; }
    seen.add(a.name);
    if (a.mode !== 'primary' && a.mode !== 'subagent') a.mode = 'primary';
    a.system = typeof a.system === 'string' ? a.system : '';
    a.description = typeof a.description === 'string' ? a.description : '';
    a.steps = Math.max(1, Math.min(100, Math.round(Number(a.steps)) || 25));
    a.canDelegate = !!a.canDelegate;
    a.tools = Array.isArray(a.tools) ? a.tools.filter((t) => typeof t === 'string' && t) : [];
    if (a.skills !== undefined && !Array.isArray(a.skills)) delete a.skills;
    if (a.model !== undefined && typeof a.model !== 'string') delete a.model;
    const perms = {};
    for (const [k, v] of Object.entries(a.permissions && typeof a.permissions === 'object' ? a.permissions : {})) if (['read', 'write', 'exec', 'net'].includes(k) && PERM_VALUES.includes(v)) perms[k] = v;
    a.permissions = perms;
    if (typeof a.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(a.color)) a.color = '#7fd4f5';
    out.push(a);
  }
  if (!out.some((a) => a.name === 'loop')) { out.unshift(JSON.parse(JSON.stringify(DEFAULT_AGENTS.find((a) => a.name === 'loop')))); ajustes.push('agente "loop" restaurado'); }
  if (!out.some((a) => a.mode === 'primary')) { const l = out.find((a) => a.name === 'loop'); l.mode = 'primary'; ajustes.push('nenhum agente principal: "loop" voltou a ser principal'); }
  return { agents: out, ajustes };
}

function load() {
  migrate();
  let saved = readJsonSafe(file());
  if (!saved) saved = readJsonSafe(bakFile()); // settings.json corrompido (queda de energia/travamento no meio da gravação, edição manual quebrada): usa a última cópia íntegra
  if (!saved) return { ...DEFAULTS };
  try { fs.mkdirSync(path.dirname(bakFile()), { recursive: true }); fs.writeFileSync(bakFile(), JSON.stringify(saved)); } catch { /* melhor esforço */ } // guarda esta versão (já comprovadamente válida) como próximo backup
  const cfg = upgradeAgents({ ...DEFAULTS, ...saved }, saved.agentsVersion || 1);
  cfg.agents = repairAgents(cfg.agents).agents;
  if ((saved.permsVersion || 1) < 2) { // antes a escrita perguntava sempre; agora é liberada na pasta de trabalho
    if (cfg.permissions?.write === 'ask') cfg.permissions = { ...cfg.permissions, write: 'allow' };
    cfg.permsVersion = 2;
  }
  if (!cfg.agents.some((a) => a.name === cfg.activeAgent && a.mode !== 'subagent')) cfg.activeAgent = cfg.agents.find((a) => a.mode !== 'subagent').name;
  return cfg;
}

// Grava num arquivo temporário e troca pelo definitivo (rename é atômico): uma queda/travamento no meio
// da gravação nunca deixa o settings.json pela metade/corrompido — ou fica a versão antiga, ou a nova.
function save(s) {
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  try { fs.renameSync(tmp, f); }
  catch { try { fs.copyFileSync(tmp, f); fs.rmSync(tmp, { force: true }); } catch { /* melhor esforço: não derruba o app por causa disso */ } }
}

// Importa provedores de um arquivo de configuração .jsonc existente (reaproveita o que o usuário já configurou).
function importOpencode(p) {
  const raw = fs.readFileSync(p, 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1');
  const j = JSON.parse(raw);
  return Object.entries(j.provider || {}).map(([id, v]) => ({
    id, name: v.name || id, baseURL: v.options?.baseURL || '', apiKey: v.options?.apiKey || '',
    models: Object.keys(v.models || {}),
  }));
}

module.exports = { outRoot, load, save, importOpencode, repairAgents, DEFAULTS, DEFAULT_AGENTS };
