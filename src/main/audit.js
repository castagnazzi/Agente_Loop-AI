// Registro de atividades: tudo o que o agente fez (comandos, arquivos, web, relatórios), gravado por sessão em
// <app>/data/logs/<sessão>.jsonl e exportável como HTML (para anexar ao laudo do cliente).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { dataDir } = require('./paths');
const D = require('./dashkit');
const { esc } = require('./reportkit');

const dir = () => path.join(dataDir(), 'logs');
const file = (id) => path.join(dir(), `${String(id).replace(/[^\w-]/g, '')}.jsonl`);
const MAX_BYTES = 3 * 1024 * 1024; // ~3 MB por sessão: cobre milhares de ações; evita um log gigante travando o relatório (ex.: sessão longa tentando corrigir o mesmo bug)
const MANTER_LINHAS = 3000;        // ao cortar, mantém as últimas N ações

// Arquivo passou do limite: mantém só o final (histórico recente é o que importa pro laudo) e
// deixa um aviso no início para o registro não parecer ter começado do nada.
function rotacionar(f) {
  try {
    const linhas = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
    const restante = linhas.slice(-MANTER_LINHAS);
    const aviso = JSON.stringify({
      t: new Date().toISOString(), agent: 'sistema', tool: '_rotacao',
      resumo: `Registro truncado automaticamente: mantidas as últimas ${restante.length} ações (o arquivo passou de ${(MAX_BYTES / 1024 / 1024).toFixed(0)} MB).`,
      estado: 'negado', aut: 'automática', ms: 0,
    });
    fs.writeFileSync(f, [aviso, ...restante].join('\n') + '\n');
  } catch { /* melhor esforço: pior caso é continuar crescendo até a próxima tentativa */ }
}

/** Resumo legível do que a ferramenta fez. */
function resumo(tool, a = {}) {
  const v = {
    bash: a.command, iniciar_servidor: a.command, parar_servidor: '', write: a.path, edit: a.path, read: a.path, ler_documento: a.path, glob: a.pattern, grep: a.pattern, webfetch: a.url,
    criar_documento: `${a.formato || ''} ${a.nome || ''}`.trim(), criar_projeto: a.nome, skill: a.name, delegate: `${a.agent || ''}: ${String(a.task || '').slice(0, 120)}`,
    diagnostico_pc: a.problema ? `problema: ${a.problema}` : 'varredura geral', relatorio_uso: `últimos ${a.dias || 30} dias`, registro_atividades: '',
    remover: a.path, estilizar_imagem: `${a.estilo || ''} ${a.nome || ''}`.trim(), gerar_imagem: a.nome, transcrever_video: a.url,
  }[tool];
  return String(v ?? JSON.stringify(a)).slice(0, 400);
}

function log(sessionId, e) {
  try {
    fs.mkdirSync(dir(), { recursive: true });
    const f = file(sessionId);
    const linha = JSON.stringify({ t: new Date().toISOString(), ...e }) + '\n';
    let tam = 0;
    try { tam = fs.statSync(f).size; } catch { /* arquivo novo */ }
    if (tam + linha.length > MAX_BYTES) rotacionar(f);
    fs.appendFileSync(f, linha);
  } catch { /* o registro nunca derruba o agente */ }
}
function read(sessionId) {
  try { return fs.readFileSync(file(sessionId), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
}
function remove(sessionId) { try { fs.rmSync(file(sessionId), { force: true }); } catch { /* já não existe */ } }

const CAT = (t) => (['bash', 'iniciar_servidor', 'parar_servidor'].includes(t) ? 'cmd' : ['write', 'edit', 'criar_documento', 'remover', 'estilizar_imagem', 'gerar_imagem'].includes(t) ? 'arq' : ['webfetch', 'transcrever_video'].includes(t) ? 'web' : ['diagnostico_pc', 'relatorio_uso'].includes(t) ? 'rel' : ['read', 'ler_documento', 'glob', 'grep'].includes(t) ? 'leit' : 'outro');
const br = (iso) => new Date(iso).toLocaleString('pt-BR');
const estado = (r) => `<span class="ev ${r.estado === 'ok' ? 'ev-on' : r.estado === 'negado' ? 'ev-warn' : 'ev-off'}">${esc(r.estado)}</span>`;

/** Gera o HTML do registro da sessão. meta: { titulo, modelos: [] } */
function html(sessionId, meta = {}) {
  const rows = read(sessionId).map((r) => ({ ...r, cat: CAT(r.tool), quando: br(r.t) }));
  const por = (c) => rows.filter((r) => r.cat === c);
  const col = (r) => `<span class="mono">${esc(r.resumo)}</span>`;
  const tab = (cols, rs) => D.dtable(cols, rs, { max: 2000, placeholder: 'Pesquisar…' });
  const base = [['quando', 'Data/hora'], ['agent', 'Agente']];
  const fim = [['aut', 'Autorização'], ['estado', 'Resultado', estado]];
  const first = rows[0]?.t, last = rows[rows.length - 1]?.t;
  const negadas = rows.filter((r) => r.estado === 'negado').length, erros = rows.filter((r) => r.estado === 'erro').length;
  const grupos = [
    { label: 'Registro', items: [
      { id: 'resumo', ico: '📋', title: 'Resumo da atividade', sub: `${rows.length} ação(ões) registrada(s)`, html:
        `<div class="grid g6">${D.kpi('⚙️', rows.length, 'Ações')}${D.kpi('💻', por('cmd').length, 'Comandos')}${D.kpi('📝', por('arq').length, 'Arquivos criados/alterados')}${D.kpi('📊', por('rel').length, 'Relatórios gerados')}${D.kpi('🌐', por('web').length, 'Acessos à web')}${D.kpi('⛔', negadas, 'Negadas')}${D.kpi('✖', erros, 'Com erro')}</div>` +
        D.info([['Computador', os.hostname()], ['Usuário do Windows', os.userInfo().username], ['Conversa', meta.titulo || sessionId], ['Início', first ? br(first) : '-'], ['Última ação', last ? br(last) : '-'], ['Modelos usados', (meta.modelos || []).join(', ') || '-']]) +
        '<div class="alert info" style="margin-top:14px">ℹ️ Registro gerado automaticamente pelo Loop-AI com as ações executadas pelo agente de IA nesta conversa. Leituras de arquivos e consultas são listadas na cronologia; o conteúdo dos arquivos não é gravado.</div>' },
    ] },
    { label: 'Ações', items: [
      { id: 'comandos', ico: '💻', title: 'Comandos executados', sub: 'PowerShell', html: tab([...base, ['resumo', 'Comando', col], ...fim], por('cmd')) },
      { id: 'arquivos', ico: '📝', title: 'Arquivos criados ou alterados', sub: 'Cópias de segurança permitem desfazer (botão ↩ no chat)', html: tab([...base, ['tool', 'Ação'], ['resumo', 'Arquivo', col], ...fim], por('arq')) },
      { id: 'relatorios', ico: '📊', title: 'Relatórios e diagnósticos gerados', sub: '', html: tab([...base, ['tool', 'Ferramenta'], ['resumo', 'Detalhe'], ['saida', 'Resultado', (r) => `<span class="mono">${esc(String(r.saida || '').split('\n')[0].slice(0, 200))}</span>`], ...fim], por('rel')) },
      { id: 'web', ico: '🌐', title: 'Acessos à web', sub: '', html: tab([...base, ['resumo', 'Endereço', col], ...fim], por('web')) },
      { id: 'leitura', ico: '📖', title: 'Arquivos lidos e buscas', sub: '', html: tab([...base, ['tool', 'Ferramenta'], ['resumo', 'Alvo', col]], por('leit')) },
    ] },
    { label: 'Completo', items: [
      { id: 'cronologia', ico: '🕒', title: 'Cronologia completa', sub: 'Todas as ações, em ordem', html: tab([...base, ['tool', 'Ferramenta'], ['resumo', 'Detalhe', col], ['ms', 'ms'], ...fim], rows) },
    ] },
  ];
  return D.page({ title: `Registro de atividades — ${os.hostname()}`, brand: 'Loop-AI', tagline: 'Registro de atividades do agente', subtitle: `📅 Gerado: ${br(new Date().toISOString())}`, meta: [`📅 ${br(new Date().toISOString())}`, `🖥️ ${os.hostname()}`, `🤖 ${rows.length} ação(ões)`], groups: grupos });
}

module.exports = { log, read, html, resumo, remove };
