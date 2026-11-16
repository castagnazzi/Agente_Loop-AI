// Núcleo do agente Loop-AI:
//   Agent.Info { name, description, mode: primary|subagent, model, system, steps, permissions }
//   loop LLM -> tool_calls -> permissão (allow|ask|deny; resposta once|always|reject) -> resultado -> LLM
//   subagente = chamada de ferramenta que roda outro agente com contexto limpo e devolve só o resultado.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chat, detectContextLimit } = require('./llm');
const { TOOLS: BASE_TOOLS, pararServidores } = require('./tools');
const ext = require('./extensions');
const diagnostico = require('./diagnostico');
const uso = require('./uso');
const docs = require('./docs');
const changes = require('./changes');
const audit = require('./audit');
const telemetria = require('./telemetria');
const { extrairChamadas } = require('./toolparse');
const imagegen = require('./imagegen');
const stylize = require('./stylize');
const session = require('./session');
const { baseDir } = require('./paths');
const webcheck = require('./webcheck');


// Comandos de PowerShell/CMD que apenas consultam (sem alterar nada) rodam sem pedir confirmação.
const VERBOS_SEGUROS = /^(get-[\w-]+|test-[\w-]+|select-object|where-object|sort-object|measure-object|format-[\w-]+|out-string|group-object|compare-object|convertto-json|convertfrom-json|resolve-dnsname|dir|ls|gci|type|cat|gc|findstr|ping|ipconfig|systeminfo|whoami|hostname|netstat|tasklist|where|echo|write-output|write-host|tree|vol|ver|nslookup|tracert|getmac|driverquery)$/i;
const PERIGOSO = /(^|[\s;|&({])(remove|set|new|add|clear|rename|move|copy|invoke|start|stop|restart|install|uninstall|disable|enable|register|unregister|out-file|export|import|expand|compress|update|push|pop)-\w+|\b(del|erase|rd|rmdir|rm|mv|cp|ren|format|diskpart|reg|net|sc|taskkill|shutdown|powershell|pwsh|cmd|iex|curl|wget|iwr|certutil|bitsadmin)\b|[>`]|\$\(|&&|\|\||(^|\s)&\s/i;
function comandoSomenteLeitura(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim() || cmd.length > 600 || PERIGOSO.test(cmd)) return false;
  return cmd.split(/[;|\n]/).map((x) => x.trim()).filter(Boolean).every((seg) => VERBOS_SEGUROS.test(seg.split(/\s+/)[0]));
}

const MAX_DEPTH = 2;
const WEB_MAX = 8;    // consultas à web (websearch + webfetch) por pedido antes de exigir a entrega
const MAX_BUSCAS = 3; // pesquisas (websearch) por pedido; depois só leitura de páginas
const IMG_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const ALWAYS_ALLOWED = new Set(['skill', 'criar_projeto', 'registro_atividades', 'iniciar_servidor', 'parar_servidor']); // ferramentas internas inofensivas, liberadas a todo agente

// Arquivo de segredo (.env e variantes, ex. .env.local): mesmo com a ação liberada (allow/"sempre"), sempre confirma.
const ARQUIVO_SENSIVEL = /(^|[\\/])\.env(\.[^\\/]*)?$/i;

// ---- reparo de argumentos de tool-call contra o JSON Schema da ferramenta (modelo
// fraco/quantizado às vezes manda "5" em vez de 5, "true" em vez de true, ou um objeto serializado como string) ----
function repararValor(v, schema) {
  if (!schema || v == null) return v;
  const tipos = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (typeof v === 'string') {
    const s = v.trim();
    if ((tipos.includes('number') || tipos.includes('integer')) && /^-?\d+(\.\d+)?$/.test(s)) {
      const n = Number(s);
      return tipos.includes('integer') ? Math.round(n) : n;
    }
    if (tipos.includes('boolean') && (s === 'true' || s === 'false')) return s === 'true';
    if ((tipos.includes('array') || tipos.includes('object')) && /^[[{]/.test(s)) {
      try { v = JSON.parse(s); } catch { return v; }
    } else return v;
  }
  if (tipos.includes('object') && schema.properties && v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, sub] of Object.entries(schema.properties)) if (k in v) v[k] = repararValor(v[k], sub);
  }
  if (tipos.includes('array') && schema.items && Array.isArray(v)) v = v.map((item) => repararValor(item, schema.items));
  return v;
}
function repararArgs(args, schema) {
  if (!schema?.properties || !args || typeof args !== 'object') return args;
  for (const [k, sub] of Object.entries(schema.properties)) if (k in args) args[k] = repararValor(args[k], sub);
  return args;
}

// Rede local/privada = os dados não saem da sua rede. (Túneis como ngrok são remotos.)
function isLocalHost(url) {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h.endsWith('.local') || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h === '::1';
  } catch { return false; }
}

const slug = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'projeto';
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
let seq = 0;

class Engine {
  /** @param getCfg ()=>settings  @param emit (ev)=>void  @param ask (req)=>Promise<'once'|'always'|'reject'> */
  constructor(getCfg, emit, ask) {
    this.getCfg = getCfg;
    this.emit = emit;
    this.ask = ask;
    this.history = [];       // conversa do agente primário
    this.always = new Set(); // "<agente>:<tipo>" aprovados com "sempre" (tipo = read|write|exec|net)
    this.abort = null;
    this.projectDir = null;  // pasta de saída da tarefa atual (compartilhada com os subagentes)
    this.sessionId = session.newId(); this.title = ''; this.createdAt = Date.now();
    this.view = [];          // o que a tela mostra (para redesenhar uma conversa retomada)
    this.modelsUsed = new Set();
    this.authInfo = new Map(); // toolId -> como foi autorizada (registro de atividades)
    this.calib = 1;          // proporção real tokens/estimativa
    this.turn = 0; this.projectTurn = -1; // nº do pedido atual e do pedido em que a pasta do projeto foi criada
    this.ctxCache = new Map(); // "<provider>/<modelo>" -> limite de contexto já detectado nesta sessão do app
  }

  /** Limite de contexto a usar para compactação: se o usuário deixou o valor padrão, tenta detectar
   * o tamanho real do servidor/modelo (llama.cpp, LM Studio, Ollama...) e passa a usar ~90% dele, com
   * folga para a resposta; se não conseguir detectar, ou se o usuário mudou o valor (inclusive para 0,
   * desligando), respeita a configuração manual. NUNCA espera a rede: a detecção roda em segundo
   * plano (uma vez por provedor+modelo por execução) e só passa a valer no próximo turno/passo —
   * o turno atual sempre usa o valor já disponível na hora, sem atraso. */
  resolveContextLimit(provider, model) {
    const cfg = this.getCfg();
    if (cfg.contextLimit !== require('./settings').DEFAULTS.contextLimit) return cfg.contextLimit;
    const key = `${provider.id}/${model}`;
    if (!this.ctxCache.has(key)) {
      this.ctxCache.set(key, cfg.contextLimit); // valor provisório: nada fica esperando a detecção
      detectContextLimit(provider, model).then((nCtx) => {
        if (!nCtx) return;
        const limite = Math.round(nCtx * 0.9);
        this.ctxCache.set(key, limite);
        this.emit({ type: 'contexto_detectado', provider: provider.id, model, nCtx, limite });
      }).catch(() => {});
    }
    return this.ctxCache.get(key);
  }

  outRoot() { return require('./settings').outRoot(this.getCfg()); }

  /** Cria <saídas>/<nome> e passa a usá-la como pasta de trabalho. Com `comData` (diagnósticos e
   * relatórios) o nome ganha o prefixo <AAAA-MM-DD_HHMM>_. Se a pasta já existe, acrescenta -2, -3… */
  createProject(nome, { comData = false } = {}) {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    const carimbo = comData ? `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}_` : '';
    const base = path.join(this.outRoot(), `${carimbo}${slug(nome)}`);
    let dir = base, n = 2;
    while (fs.existsSync(dir)) dir = `${base}-${n++}`;
    fs.mkdirSync(dir, { recursive: true });
    this.projectDir = dir; this.projectTurn = this.turn;
    this.emit({ type: 'project', path: dir, name: path.basename(dir) });
    this.view.push({ r: 'proj', p: dir });
    return dir;
  }

  /** Ferramentas base + internas + plugins habilitados. Recalculado a cada chamada (barato). */
  tools(agent) {
    const cfg = this.getCfg();
    const all = { ...BASE_TOOLS, ...ext.loadPluginTools(cfg.disabledPlugins).tools };

    all.criar_projeto = {
      kind: 'none',
      description: 'Cria a pasta do trabalho atual dentro da pasta de saídas (só o nome, sem data) e passa a usá-la como pasta de trabalho. ' +
        'Chame ANTES de gerar qualquer entrega (projeto, código, documento, análise, relatório, resumo de vídeo). Retorna o caminho.',
      parameters: { type: 'object', properties: { nome: { type: 'string', description: 'nome curto e descritivo, ex.: jogo-da-velha, analise-vendas' } }, required: ['nome'] },
      run: async (a) => {
        // já existe uma pasta de trabalho nesta conversa: reutiliza (atualização/correção/melhoria do
        // mesmo projeto, mesmo em pedidos separados). Só abre pasta nova numa conversa nova (🧹), que já
        // limpa projectDir.
        if (this.projectDir && fs.existsSync(this.projectDir)) {
          return `A pasta deste trabalho já existe: ${this.projectDir}\nContinue salvando tudo nela (caminhos relativos). NÃO crie outra pasta — nem para uma atualização, correção ou melhoria do mesmo projeto.`;
        }
        return `Pasta criada: ${this.createProject(a.nome || 'projeto')}\nSalve todos os arquivos do resultado aqui (use caminhos relativos).`;
      },
    };

    all.ler_documento = {
      kind: 'read',
      description: 'Lê PDF, Word (.docx), Excel (.xlsx/.csv), PowerPoint (.pptx) e IMAGENS (.png/.jpg/.bmp/.webp/.tif) e devolve o conteúdo em texto (tabelas e planilhas em formato de tabela; slides numerados com notas). ' +
        'PDF digitalizado e imagens passam por OCR automaticamente (português+inglês, offline; ~3–10 s por página). ' +
        'Use no lugar de `read` para esses formatos. Textos longos vêm paginados: se aparecer "faltam N caracteres", chame de novo com `inicio`. PDF digitalizado (imagem) não tem texto.',
      parameters: { type: 'object', properties: {
        path: { type: 'string', description: 'caminho do arquivo (absoluto ou relativo à pasta de trabalho)' },
        inicio: { type: 'integer', description: 'caractere inicial (para continuar a leitura de um texto longo)' },
        max_chars: { type: 'integer', description: 'máximo de caracteres por chamada (padrão 30000)' },
        linhas: { type: 'integer', description: 'planilhas: máximo de linhas por aba (padrão 200)' },
        paginas: { type: 'string', description: 'PDF com OCR: páginas a ler, ex.: "1-5" ou "3,7" (padrão: as 15 primeiras)' },
        ocr: { type: 'boolean', description: 'PDF: força OCR mesmo havendo texto (use se o texto extraído vier ilegível/corrompido)' },
      }, required: ['path'] },
      run: async (a, ctx) => docs.ler(path.isAbsolute(a.path) ? a.path : path.join(ctx.cwd, a.path), { ...a, signal: ctx.signal }),
    };
    all.criar_documento = {
      kind: 'write',
      description: 'Cria um documento Office/PDF na pasta do trabalho (chame `criar_projeto` antes). formato: "docx" e "pdf" usam `texto` em Markdown (# títulos, - listas, 1. numeradas, | tabelas |, **negrito**, *itálico*, ``` código ```, --- linha); ' +
        '"xlsx" usa `planilhas`; "pptx" usa `slides`. Retorna o caminho do arquivo.',
      parameters: { type: 'object', properties: {
        formato: { type: 'string', enum: ['docx', 'xlsx', 'pptx', 'pdf'] },
        nome: { type: 'string', description: 'nome do arquivo sem extensão, ex.: laudo-notebook-dell' },
        titulo: { type: 'string', description: 'título do documento (opcional)' },
        texto: { type: 'string', description: 'docx/pdf: conteúdo em Markdown' },
        planilhas: { type: 'array', description: 'xlsx: abas. Valores iniciados por "=" viram fórmulas.', items: { type: 'object', properties: { nome: { type: 'string' }, colunas: { type: 'array', items: { type: 'string' } }, linhas: { type: 'array', items: { type: 'array', items: {} } } }, required: ['linhas'] } },
        slides: { type: 'array', description: 'pptx: o 1º slide só com titulo/subtitulo vira capa. Subtópico = item com 2 espaços no início.', items: { type: 'object', properties: { titulo: { type: 'string' }, subtitulo: { type: 'string' }, topicos: { type: 'array', items: { type: 'string' } }, tabela: { type: 'array', items: { type: 'array', items: {} } }, notas: { type: 'string' } } } },
      }, required: ['formato', 'nome'] },
      run: async (a, ctx) => { ctx.ensureProject?.(a.nome); const f = await docs.criar(a, ctx.cwd); changes.created(f, this.sessionId, agent?.name); return `Documento criado: ${f}`; },
    };

    all.gerar_imagem = {
      kind: 'net',
      description: 'Gera uma imagem a partir de uma descrição em texto (IA de geração de imagem, grátis, sem chave) e salva na pasta do trabalho (chame `criar_projeto` antes). ' +
        'Use para ilustrações, capas, ícones, mockups visuais etc. — não serve para editar fotos/imagens existentes.',
      parameters: { type: 'object', properties: {
        prompt: { type: 'string', description: 'descrição da imagem desejada (funciona melhor em inglês, mas pode ser em português)' },
        nome: { type: 'string', description: 'nome do arquivo, sem extensão' },
        largura: { type: 'integer', description: 'padrão 1024' },
        altura: { type: 'integer', description: 'padrão 1024' },
      }, required: ['prompt', 'nome'] },
      run: async (a, ctx) => { ctx.ensureProject?.(a.nome); const f = await imagegen.gerar(a, ctx.cwd); changes.created(f, this.sessionId, agent?.name); return `Imagem gerada: ${f}`; },
    };

    all.estilizar_imagem = {
      kind: 'write',
      description: 'Aplica um efeito artístico numa foto/imagem já existente (cartoon, esboço a lápis ou pintura) e salva o resultado na pasta do trabalho (chame `criar_projeto` antes). ' +
        'Processamento clássico de imagem (rápido, local, sem IA) — não serve para gerar imagem do zero (para isso use `gerar_imagem`) nem para editar conteúdo da foto.',
      parameters: { type: 'object', properties: {
        path: { type: 'string', description: 'caminho da foto/imagem de origem (absoluto ou relativo à pasta de trabalho)' },
        estilo: { type: 'string', enum: ['cartoon', 'lapis', 'pintura'] },
        nome: { type: 'string', description: 'nome do arquivo de saída, sem extensão' },
      }, required: ['path', 'estilo', 'nome'] },
      run: async (a, ctx) => {
        ctx.ensureProject?.(a.nome);
        const origem = path.isAbsolute(a.path) ? a.path : path.join(ctx.cwd, a.path);
        const saida = path.join(ctx.cwd, `${String(a.nome).replace(/[\\/:*?"<>|]/g, '-')}_${a.estilo}.png`);
        await stylize.estilizar(origem, saida, a.estilo);
        changes.created(saida, this.sessionId, agent?.name);
        return `Imagem estilizada (${a.estilo}) salva em: ${saida}`;
      },
    };

    all.registro_atividades = {
      kind: 'none',
      description: 'Gera o REGISTRO DE ATIVIDADES desta conversa em HTML (comandos executados, arquivos criados/alterados, relatórios gerados, acessos à web, com data/hora e autorização), para anexar ao laudo do cliente. ' +
        'Use quando o usuário pedir o registro, histórico ou comprovação do que foi feito no PC. Salva na pasta do trabalho.',
      parameters: { type: 'object', properties: {} },
      run: async () => {
        const dir = this.projectDir || this.createProject('registro-atividades', { comData: true });
        const f = path.join(dir, 'registro-atividades.html');
        fs.writeFileSync(f, audit.html(this.sessionId, { titulo: this.title, modelos: [...this.modelsUsed] }), 'utf8');
        return `Registro de atividades gerado em: ${f}`;
      },
    };

    all.diagnostico_pc = {
      kind: 'none', // somente leitura e cria apenas a pasta do relatório: roda sem cartão de confirmação
      description: 'DIAGNÓSTICO do PC atual (somente leitura, offline): varre problemas (disco/SMART, desligamentos inesperados, telas azuis, erros de log, RAM/CPU, temperatura, ' +
        'rede/DNS, Defender/firewall, proxy/hosts, Windows Update, impressora, programas travando, inicialização, bateria) e, para cada achado, mostra evidência, causas possíveis e COMO CORRIGIR. ' +
        'Informe em `problema` o sintoma relatado pelo cliente (ex.: "lento e reinicia sozinho") para priorizar as verificações. Gera pasta com diagnostico.html (imprimível) e dados.json e ' +
        'devolve um RESUMO. NÃO lê histórico de navegação nem uso (para isso há relatorio_uso). forense=true inclui tarefas agendadas, serviços de terceiros e ameaças do Defender.',
      parameters: { type: 'object', properties: { problema: { type: 'string', description: 'problema relatado, com as palavras do cliente' }, dias: { type: 'integer', description: 'período dos logs (padrão 30)' }, forense: { type: 'boolean', description: 'SOMENTE se o usuário citar suspeita de vírus, invasão, malware ou acesso indevido. Para lentidão, travamentos, tela azul, reinícios etc. deixe false/omita.' } } },
      run: async (a) => {
        const r = await diagnostico.run({ days: Math.max(1, Math.min(365, Number(a.dias) || 30)), forense: !!a.forense, problema: String(a.problema || '') });
        const dir = this.createProject(`diagnostico-${os.hostname()}${a.forense ? '-forense' : ''}`, { comData: true });
        fs.writeFileSync(path.join(dir, 'diagnostico.html'), r.html, 'utf8');
        fs.writeFileSync(path.join(dir, 'dados.json'), JSON.stringify(r.dados, null, 2), 'utf8');
        return `Diagnóstico gerado em: ${path.join(dir, 'diagnostico.html')}\nDados brutos: ${path.join(dir, 'dados.json')}\n\n${r.resumo}\n\n` +
          'RESPONDA AGORA ao usuário, em português: resumo do estado do PC, achados por prioridade (alta, média, baixa) com a evidência, causas prováveis e o que fazer para corrigir, e cite o caminho do relatório HTML. ' +
          'O relatório já cobre as verificações: NÃO execute outros comandos nem leia outros arquivos agora; só aprofunde se o usuário pedir mais detalhes depois.';
      },
    };

    all.relatorio_uso = {
      kind: 'none', // somente leitura: roda sem cartão de confirmação
      description: 'RELATÓRIO DE USO do PC atual (somente leitura, offline): histórico dos navegadores (Chrome, Edge, Brave, Firefox, Opera, Vivaldi), sites mais visitados, pesquisas, ' +
        'downloads, arquivos e pastas acessados (com caminho completo), programas executados, sessões (ligar/desligar/suspender/logon), USB conectados, cache DNS e janelas abertas. ' +
        'NÃO avalia problemas do PC (para isso há diagnostico_pc) e NÃO lê senhas. Dados MUITO sensíveis: use só em equipamento que o usuário está autorizado a auditar. ' +
        'Cria pasta com relatorio-uso.html (imprimível) e dados.json e devolve um RESUMO.',
      parameters: { type: 'object', properties: { dias: { type: 'integer', description: 'período em dias (padrão 30)' } } },
      run: async (a) => {
        const r = await uso.run({ days: Math.max(1, Math.min(365, Number(a.dias) || 30)) });
        const dir = this.createProject(`relatorio-uso-${os.hostname()}`, { comData: true });
        fs.writeFileSync(path.join(dir, 'relatorio-uso.html'), r.html, 'utf8');
        fs.writeFileSync(path.join(dir, 'dados.json'), JSON.stringify(r.dados, null, 2), 'utf8');
        return `Relatório de uso gerado em: ${path.join(dir, 'relatorio-uso.html')}\nDados brutos: ${path.join(dir, 'dados.json')}\n\n${r.resumo}\n\n` +
          'RESPONDA AGORA ao técnico, em português, com um resumo do uso do PC (sites, pesquisas, arquivos, programas, horários) e cite o caminho do relatório HTML. ' +
          'NÃO execute outros comandos nem leia outros arquivos agora; só aprofunde se o usuário pedir mais detalhes depois.';
      },
    };

    if (this.skills(agent).length) {
      all.skill = {
        kind: 'none',
        description: 'Carrega as instruções completas de uma skill pelo nome. Use quando a tarefa casar com a descrição de uma skill do catálogo.',
        parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        run: async (a) => {
          const sk = this.skills(agent).find((x) => x.id === a.name || x.name === a.name);
          if (!sk) throw new Error(`skill "${a.name}" não existe`);
          const r = ext.readSkill(sk.id);
          const apoio = r.files.length ? `Arquivos de apoio (leia com read): ${r.files.join(', ')}\n` : '';
          return `# Skill: ${r.name}\nPasta: ${r.dir}\n${apoio}\n${r.body}`;
        },
      };
    }
    return all;
  }

  skills(agent) {
    const off = this.getCfg().disabledSkills || [];
    return ext.listSkills().filter((x) => !off.includes(x.id) && (!agent?.skills || agent.skills.includes(x.id)));
  }

  allowedTool(agent, name, tool) {
    if (ALWAYS_ALLOWED.has(name)) return true;
    if (!agent.tools?.length) return true;
    return agent.tools.includes(name) || (tool.plugin && agent.tools.includes(tool.plugin));
  }

  reset() {
    this.cancel(); this.saveSession(); // a conversa atual fica salva e pode ser retomada
    this.history = []; this.view = []; this.always.clear(); this.projectDir = null; this.calib = 1;
    this.sessionId = session.newId(); this.title = ''; this.createdAt = Date.now(); this.modelsUsed = new Set();
  }
  cancel() { this.abort?.abort(); this.abort = null; pararServidores(); }

  /** A pasta do projeto tem algo que roda (servidor/app/script)? Páginas HTML soltas já são testadas no navegador (webcheck). */
  projetoExecutavel() {
    const dir = this.projectDir;
    if (!dir) return false;
    const marcas = ['package.json', 'requirements.txt', 'app.py', 'main.py', 'server.js', 'manage.py', 'pom.xml'];
    const acha = (d) => marcas.some((m) => fs.existsSync(path.join(d, m)));
    if (acha(dir)) return true;
    try { return fs.readdirSync(dir, { withFileTypes: true }).some((e) => e.isDirectory() && !['node_modules', '.git'].includes(e.name) && acha(path.join(dir, e.name))); } catch { return false; }
  }

  resolveModel(agent) {
    const cfg = this.getCfg();
    const ref = agent.model || cfg.defaultModel; // "providerId/modelo"
    if (!ref) throw new Error('Nenhum modelo configurado. Abra Configurações e defina o provedor/modelo padrão.');
    const i = ref.indexOf('/');
    const provider = cfg.providers.find((p) => p.id === ref.slice(0, i));
    if (!provider) throw new Error(`Provedor "${ref.slice(0, i)}" não encontrado (modelo ${ref}).`);
    return { provider, model: ref.slice(i + 1) };
  }

  toolDefs(agent, depth) {
    const cfg = this.getCfg();
    const T = this.tools(agent);
    const defs = Object.keys(T).filter((n) => this.allowedTool(agent, n, T[n])).map((n) => ({
      type: 'function', function: { name: n, description: T[n].description, parameters: T[n].parameters },
    }));
    const subs = cfg.agents.filter((a) => a.mode === 'subagent' && a.name !== agent.name);
    if (agent.canDelegate && depth < MAX_DEPTH && subs.length) {
      defs.push({
        type: 'function',
        function: {
          name: 'delegate',
          description: 'Delega uma tarefa autocontida a um subagente especialista e devolve o resultado final dele. ' +
            'O subagente NÃO vê esta conversa: descreva a tarefa por completo. Várias chamadas na mesma resposta rodam em paralelo.\n' +
            'Agentes disponíveis:\n' + subs.map((a) => `- ${a.name}: ${a.description}`).join('\n'),
          parameters: {
            type: 'object',
            properties: { agent: { type: 'string', enum: subs.map((a) => a.name) }, task: { type: 'string' } },
            required: ['agent', 'task'],
          },
        },
      });
    }
    return defs;
  }

  policy(agent, tool) {
    const cfg = this.getCfg();
    const kind = this.tools(agent)[tool]?.kind ?? 'exec';
    if (kind === 'none') return 'allow';
    return agent.permissions?.[kind] ?? cfg.permissions?.[kind] ?? 'ask';
  }

  /** O caminho que a ferramenta de escrita vai tocar está fora das pastas de trabalho/saídas? */
  escritaForaDoTrabalho(tool, args) {
    if (!['write', 'edit'].includes(tool) || !args?.path) return false; // criar_documento etc. gravam sempre na pasta do projeto
    const cfg = this.getCfg(), home = path.resolve(process.env.USERPROFILE || os.homedir()).toLowerCase();
    const roots = [this.projectDir, this.outRoot(), cfg.workDir].filter(Boolean).map((r) => path.resolve(r).toLowerCase()).filter((r) => r !== home);
    const alvo = path.resolve(path.isAbsolute(args.path) ? args.path : path.join(this.projectDir || cfg.workDir || '.', args.path)).toLowerCase();
    return !roots.some((r) => alvo === r || alvo.startsWith(r + path.sep));
  }

  async authorize(agent, id, tool, args) {
    const kind = this.tools(agent)[tool]?.kind ?? 'exec';
    let p = this.policy(agent, tool);
    const via = (v, ok) => { this.authInfo.set(id, v); return ok; };
    if (p === 'deny') return via('bloqueada pela configuração', false);
    const sensivel = args?.path && ARQUIVO_SENSIVEL.test(String(args.path));
    if (sensivel && p === 'allow') p = 'ask'; // .env e variantes: sempre confirma, mesmo com a ação liberada
    if (this.always.has(`${agent.name}:${kind}`) && !sensivel) return via('usuário (sempre na sessão)', true); // "Sempre" vale por tipo de ação até limpar a conversa
    if (p === 'allow' && !this.escritaForaDoTrabalho(tool, args)) return via('automática', true);
    if (tool === 'bash' && comandoSomenteLeitura(args?.command)) return via('automática (comando de consulta)', true);
    const fora = p === 'allow'; // liberado, mas fora da pasta de trabalho: avisa
    const reply = await this.ask({ id: `per_${++seq}`, agent: agent.name, tool, args, ...(sensivel ? { aviso: 'Arquivo sensível (.env)' } : fora ? { aviso: 'Fora da pasta de trabalho' } : {}) });
    if (reply === 'always' && !sensivel) this.always.add(`${agent.name}:${kind}`);
    return via(reply === 'reject' ? 'negada pelo usuário' : reply === 'always' ? 'usuário (sempre na sessão)' : 'usuário', reply !== 'reject');
  }

  /** Instruções fixas sobre onde salvar entregas (valem para todos os agentes). */
  rules(toolNames = []) {
    const has = n => toolNames.includes(n);
    let roteio = '';
    if (has('diagnostico_pc') || has('relatorio_uso')) {
      roteio = '\n\nROTEAMENTO: o usuário não escolhe agente; você decide pelo pedido e executa direto, sem pedir confirmação do pedido. ' +
        (has('diagnostico_pc') ? 'Pedido de diagnóstico, procurar falhas/problemas, "o que há de errado", PC lento/travando/reiniciando/tela azul/sem internet → chame `diagnostico_pc` na hora, ' +
          'passando em `problema` o sintoma citado (vazio se não citou) e forense=true só para suspeita de vírus/invasão. Depois apresente resumo, achados por prioridade, causas e como corrigir. NÃO leia histórico de uso nesse caso. ' : '') +
        (has('relatorio_uso') ? 'Pedido de relatório de uso, histórico, o que foi acessado/aberto/baixado, atividade do PC → chame `relatorio_uso` na hora (período pedido; padrão 30 dias). ' +
          'NÃO avalie defeitos nem leia senhas. ' : '') +
        'Se o pedido pedir os dois, rode os dois em sequência. Pergunte só se o pedido for realmente ambíguo.';
    }
    const doc = has('ler_documento') || has('criar_documento')
      ? '\n\nDOCUMENTOS: para LER PDF/Word/Excel/PowerPoint use `ler_documento` (não `read`). Para CRIAR Word, Excel, PowerPoint ou PDF use `criar_documento` (depois de `criar_projeto`); ' +
        'redija o conteúdo completo e bem estruturado (títulos, listas, tabelas) e não peça ao usuário para montar o arquivo. ' +
        'Se o usuário pedir o registro/comprovação do que foi feito no PC, use `registro_atividades`.'
      : '';
    const pesq = (has('websearch') ? ' PESQUISA NA INTERNET: use `websearch` (1 a 3 buscas objetivas) e `webfetch` nas 3 a 5 melhores páginas; depois escreva o resultado COMPLETO em um arquivo na pasta do projeto (documento com criar_documento ou .md com write) e resuma na resposta. Faça as leituras em paralelo (várias chamadas de webfetch na mesma resposta), no máximo 3 buscas e ~8 consultas no total; não repita buscas parecidas e não raspe o Google pelo terminal.' : '') +
      (has('transcrever_video') ? ' VÍDEO: para resumir ou transcrever um vídeo, use `transcrever_video` com a URL — funciona SÓ com vídeos do YouTube (lê a legenda do próprio vídeo; não baixa áudio/vídeo). Para vídeo local ou de outro site, explique que só é possível transcrever vídeos do YouTube. Depois de obter o texto, escreva o resumo/transcrição pedido (documento ou .md) na pasta do projeto.' : '') +
      (has('gerar_imagem') ? ' IMAGEM: para gerar uma ilustração a partir de uma descrição, use `gerar_imagem` (depois de criar_projeto); não serve para editar foto/imagem já existente.' : '') +
      (has('estilizar_imagem') ? ' ESTILIZAR FOTO: para aplicar efeito de cartoon/lápis/pintura numa foto já existente, use `estilizar_imagem` (depois de criar_projeto).' : '') +
      (has('remover') ? ' APAGAR ARQUIVO: para apagar um arquivo ou pasta use `remover` (vai para a Lixeira, não apague pelo terminal/bash).' : '') +
      ' CONCLUSÃO: nunca encerre um turno apenas anunciando o que vai fazer ("vou criar…"): faça a ação com as ferramentas no mesmo turno e entregue o resultado.';
    return 'ENTREGAS: quando o pedido for criar/desenvolver algo (site, jogo, programa, sistema, documento, planilha, apresentação), analisar algo, ' +
      'gerar relatório, ou resumir/transcrever um vídeo, PRIMEIRO chame `criar_projeto` com um nome curto e descritivo (só o nome, sem data) e salve TODOS os arquivos do resultado ' +
      'EM DISCO com `write`, sem o usuário precisar pedir. Um prompt colado com requisitos, especificação ou lista de arquivos/pastas É um pedido para criar a pasta e todos os arquivos: ' +
      'crie a estrutura completa e grave cada arquivo com seu conteúdo inteiro. ' +
      (has('iniciar_servidor') ? 'TESTE ANTES DE ENTREGAR (obrigatório para projeto com backend/servidor/script): depois de gravar os arquivos, instale as dependências, suba com `iniciar_servidor` (passe em `verificar` a página inicial e as rotas/APIs principais) e corrija TODO erro que aparecer (log, status 4xx/5xx, módulo faltando) testando de novo, até tudo responder bem. Nunca rode servidor/app que não termina com `bash` (trava): use `iniciar_servidor`. Entregue só depois de testado e diga como executar e o que foi verificado; se não conseguir corrigir, diga com clareza o que ainda falha. ' : '') +
      'Não gaste tempo planejando: no máximo um plano curto, e logo comece a gravar os arquivos, um `write` por vez. NUNCA entregue código apenas no texto da resposta (blocos ```), a não ser que o usuário peça só uma explicação ou um trecho. ' +
      'dentro dessa pasta (caminhos relativos). Ao terminar, diga o caminho da pasta e o que há nela. Toda atualização, correção ou melhoria do MESMO projeto ' +
      'nesta conversa (mesmo em pedidos separados) reaproveita essa mesma pasta — NÃO chame `criar_projeto` de novo, só continue editando os arquivos nela. ' +
      'Só crie uma pasta nova se o pedido for claramente outro projeto, sem relação com o anterior. Perguntas simples de conversa não precisam de pasta.' + pesq + doc + roteio;
  }

  // ------------------------------------------------------------------ contexto: estimativa e compactação
  /** Estimativa de tokens (caracteres ÷ 3,3), calibrada pelo uso real informado pelo provedor. */
  estimate(messages, sys) {
    let n = String(sys?.content || '').length;
    for (const m of messages) {
      if (Array.isArray(m.content)) for (const p of m.content) n += p.type === 'image_url' ? 4000 : String(p.text || '').length;
      else n += String(m.content || '').length;
      if (m.tool_calls) n += JSON.stringify(m.tool_calls).length;
    }
    return Math.round((n / 3.3) * (this.calib || 1));
  }

  /** Etapa 1: reduz saídas de ferramentas e imagens antigas (fora das últimas `manter` mensagens). */
  shrinkOld(messages, manter = 8) {
    for (let i = 0; i < messages.length - manter; i++) {
      const m = messages[i];
      if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > 1500) m.content = `${m.content.slice(0, 700)}\n…[saída antiga reduzida; tinha ${m.content.length} caracteres]`;
      if (Array.isArray(m.content)) m.content = m.content.map((p) => (p.type === 'image_url' ? { type: 'text', text: '[imagem anterior omitida]' } : p));
    }
  }

  async summarizeHead(provider, model, head, signal) {
    const txt = head.map((m) => {
      if (m.role === 'tool') return `[resultado] ${String(m.content).slice(0, 800)}`;
      if (m.role === 'assistant') return `ASSISTENTE: ${m.content || ''}${m.tool_calls ? ` [chamou: ${m.tool_calls.map((c) => `${c.function.name} ${String(c.function.arguments).slice(0, 200)}`).join('; ')}]` : ''}`;
      return `USUÁRIO: ${typeof m.content === 'string' ? m.content : m.content.map((p) => p.text || '[imagem]').join(' ')}`;
    }).join('\n').slice(0, 60000);
    const r = await chat(provider, { model, messages: [
      { role: 'system', content: 'Você resume conversas entre um usuário e um assistente que usa ferramentas. Seja fiel e objetivo.' },
      { role: 'user', content: `Resuma a conversa abaixo em português (até ~500 palavras), preservando: objetivo do usuário, decisões, caminhos completos de arquivos e pastas criados ou alterados, resultados e números importantes, erros e como foram resolvidos, pendências e preferências do usuário. Não invente nada.\n\n${txt}` },
    ] }, { signal });
    return (r.content || '').trim();
  }

  /** Mantém a conversa no limite de contexto: 1) reduz saídas antigas; 2) resume o começo. force = o provedor recusou por tamanho. */
  async compactIfNeeded(provider, model, messages, sys, signal, force = false) {
    const limit = await this.resolveContextLimit(provider, model);
    if (!limit && !force) return;
    const antes = this.estimate(messages, sys);
    const alvo = force ? Math.round(antes * 0.6) : limit;
    if (antes <= alvo) return;
    this.shrinkOld(messages, 8);
    if (this.estimate(messages, sys) <= alvo) return this.emit({ type: 'compact', antes, depois: this.estimate(messages, sys), resumo: false });
    const users = messages.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i >= 0);
    const corte = users.length >= 2 ? users[users.length - 2] : 0; // mantém os dois últimos pedidos
    if (corte > 0) {
      const resumo = await this.summarizeHead(provider, model, messages.slice(0, corte), signal);
      if (resumo) {
        const bloco = `[Resumo automático: o começo desta conversa foi condensado para caber no contexto]\n${resumo}`;
        messages.splice(0, corte);
        const m0 = messages[0];
        if (typeof m0.content === 'string') m0.content = `${bloco}\n\n---\n${m0.content}`;
        else m0.content = [{ type: 'text', text: bloco }, ...m0.content];
      }
    }
    this.shrinkOld(messages, 2);
    const depois = this.estimate(messages, sys);
    if (depois < antes * 0.97) this.emit({ type: 'compact', antes, depois, resumo: corte > 0 }); // só avisa se realmente reduziu
  }

  // ------------------------------------------------------------------ sessões
  saveSession() {
    if (!this.history.length) return;
    try {
      session.save({ id: this.sessionId, title: this.title, createdAt: this.createdAt, agent: this.getCfg().activeAgent, projectDir: this.projectDir, history: this.history, view: this.view, modelos: [...this.modelsUsed] });
    } catch { /* salvar a sessão nunca derruba o agente */ }
  }

  /** Abre uma conversa salva (a atual é salva antes). Retorna o que a tela precisa para redesenhar. */
  loadSession(id) {
    const s = session.load(id);
    if (!s) return null;
    this.cancel(); this.saveSession();
    this.sessionId = s.id; this.title = s.title || ''; this.createdAt = s.createdAt || Date.now();
    this.history = s.history || []; this.view = s.view || []; this.modelsUsed = new Set(s.modelos || []);
    this.projectDir = s.projectDir && fs.existsSync(s.projectDir) ? s.projectDir : null;
    this.always.clear(); this.calib = 1;
    return { view: this.view, title: this.title, projectDir: this.projectDir };
  }

  // ------------------------------------------------------------------ execução
  /** A resposta só anuncia uma ação futura ("vou criar…") sem executá-la? (ou veio vazia depois de usar ferramentas) */
  anunciouSemAgir(texto, usouFerramenta) {
    const t = String(texto || '').trim();
    if (!t) return usouFerramenta;
    if (t.length > 700 || /\?/.test(t)) return false; // respostas longas ou perguntas ao usuário são respostas de verdade
    const intencao = /\b(vou|vamos|irei|em seguida|a seguir|let me|i'?ll|i will|i'm going to|now i)\b/i.test(t);
    const acao = /(cri(ar|ando)|ger(ar|ando)|elabor|escrev|mont(ar|ando)|produz|salv|pesquis|busc|execut|fazer|prepar|compil|organiz|desenvolv|document|create|write|generate|build|search|prepare|compile|make)/i.test(t);
    return intencao && acao;
  }

  /** A resposta alega que algo já foi feito/corrigido, mas NENHUMA ferramenta foi usada no pedido inteiro?
   * Comum em modelos pequenos: "alucinam" a conclusão em vez de executar e comprovar. Diferente de
   * `anunciouSemAgir` (que pega "vou fazer..." e parou): aqui é "já fiz..." sem ter feito nada de verdade. */
  alegouSemFazer(texto, usouFerramenta) {
    if (usouFerramenta) return false; // alguma ferramenta já rodou neste pedido: a alegação tem lastro
    const t = String(texto || '').trim();
    if (!t || t.length > 700 || /\?/.test(t)) return false;
    return /\b(corrigi|corrigid[oa]s?|consertei|consertad[oa]s?|resolvi|resolvid[oa]s?|ajustei|ajustad[oa]s?|implementei|implementad[oa]s?|atualizei|atualizad[oa]s?|cri(e|ei)|criad[oa]s?|gerei|gerad[oa]s?|salvei|salv[oa]s?|finalizei|finalizad[oa]s?|conclu[íi]|conclu[íi]d[oa]s?|terminei|terminad[oa]s?|apliquei|aplicad[oa]s?|removi|removid[oa]s?|adicionei|adicionad[oa]s?|editei|editad[oa]s?|modifiquei|modificad[oa]s?|feito|fixed|resolved|corrected|implemented|updated|created|generated|saved|finished|completed|\bdone\b|applied|removed|added|edited|modified)\b/i.test(t);
  }

  /** A resposta despeja código/arquivos no chat (blocos ```) sem que nenhum arquivo tenha sido gravado no pedido?
   * Acontece quando o usuário cola um prompt longo e o modelo "mostra" o projeto em vez de criá-lo. */
  codigoSemArquivo(texto, gravou) {
    if (gravou) return false;
    const blocos = [...String(texto || '').matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]);
    const linhas = blocos.reduce((n, b) => n + b.split('\n').filter((l) => l.trim()).length, 0);
    return linhas >= 15;
  }

  /** Executa um agente até concluir. Retorna o texto final. */
  async runAgent(agent, messages, { depth = 0, parent = null, signal }) {
    const id = `ag_${++seq}`;
    const { provider, model } = this.resolveModel(agent);
    const self = this;
    const rCfg = this.getCfg(), rModo = rCfg.reasoningMode || 'limit', rLimite = rCfg.reasoningLimit || 5000;
    this.modelsUsed.add(`${provider.id}/${model}`);
    // cwd dinâmico: muda quando algum agente chama criar_projeto
    const ctx = { get cwd() { return self.projectDir || self.getCfg().workDir; }, signal, todos: [], sessionId: this.sessionId, beforeWrite: (p) => changes.snapshot(p, self.sessionId, agent.name), ensureProject: (nome) => { if (!self.projectDir) self.createProject(nome || 'projeto'); }, bloqueadas: new Set() };
    const tools = this.toolDefs(agent, depth);
    const sk = this.skills(agent);
    const catalog = sk.length
      ? `\n\nSkills disponíveis (carregue com a ferramenta \`skill\` quando relevante):\n${sk.map((x) => `- ${x.id}: ${x.description}`).join('\n')}`
      : '';
    const system = () => ({
      role: 'system',
      content: `${agent.system}${catalog}\n\n${this.rules(tools.map((t) => t.function.name))}\n\nPasta de trabalho atual: ${ctx.cwd}\nPasta de saídas: ${this.outRoot()}\nSistema: Windows (PowerShell).`,
    });
    this.emit({ type: 'agent_start', id, parent, agent: agent.name, color: agent.color, model: `${provider.id}/${model}`, local: isLocalHost(provider.baseURL) });
    let extraOk = rModo === 'off' && isLocalHost(provider.baseURL), errosSeguidos = 0;
    let vazio = null, final = '', nudges = 0, cortes = 0, nudgeArquivos = 0, nudgeTeste = 0, testou = false, gravou = false, usouFerramenta = false, buscas = 0, leituras = 0, semBusca = false, semWeb = false, ferramentas = tools;
    try {
      for (let step = 0; step < (agent.steps || 25); step++) {
        const sysMsg = system();
        await this.compactIfNeeded(provider, model, messages, sysMsg, signal);
        const calibAntes = this.calib; this.calib = 1; const bruto = this.estimate(messages, sysMsg); this.calib = calibAntes;
        let atividade = Date.now();
        // teto de raciocínio adaptativo: `reasoningLimit` é o MÁXIMO configurado, mas numa conversa já grande
        // (muito prompt/histórico) sobra menos espaço — reserva sempre uma folga pra resposta/ação final em vez
        // de tentar usar o teto inteiro e estourar o contexto do servidor.
        const limiteCtxAtual = this.ctxCache.get(`${provider.id}/${model}`);
        const RESERVA_RESPOSTA = 4000;
        const folgaRaciocinio = limiteCtxAtual ? Math.max(500, limiteCtxAtual - bruto - RESERVA_RESPOSTA) : rLimite;
        const hooks = {
          signal,
          maxReasoningChars: rModo === 'free' ? 0 : rModo === 'off' ? 2000 : Math.round(Math.min(rLimite, folgaRaciocinio) * 3.3), // 'off': o corte vale só se o servidor ignorar o pedido
          onText: (t) => { atividade = Date.now(); this.emit({ type: 'text', id, text: t }); },
          onReasoning: (t) => { atividade = Date.now(); this.emit({ type: 'reasoning', id, text: t }); },
        };
        // sinal de vida: servidor lendo um prompt grande não manda nada por minutos e o chat parecia travado
        const espera = setInterval(() => { const s = Math.round((Date.now() - atividade) / 1000); if (s >= 10 && depth === 0) this.emit({ type: 'waiting', id, secs: s }); }, 5000);
        // último passo permitido: sem ferramentas e com aviso, para o usuário sempre receber uma resposta em texto
        const ultimo = (agent.steps || 25) > 2 && step === (agent.steps || 25) - 1;
        const sysFinal = ultimo ? { ...sysMsg, content: `${sysMsg.content}\n\nATENÇÃO: este é o ÚLTIMO passo disponível. Não use ferramentas. Responda agora ao usuário resumindo o que foi feito, os resultados e o que ficou pendente.` } : sysMsg;
        let r;
        const tChamada = Date.now();
        const base = { sessao: this.sessionId, agente: agent.name, modelo: `${provider.id}/${model}`, passo: step, msgs: messages.length, promptEst: bruto, raciocinio: rModo };
        for (let tentativa = 0; ; tentativa++) {
          try { r = await chat(provider, { model, messages: [sysFinal, ...messages], tools: ultimo ? [] : ferramentas, temperature: agent.temperature, ...(extraOk ? { extraBody: { chat_template_kwargs: { enable_thinking: false }, reasoning_effort: 'none' } } : {}) }, hooks); break; }
          catch (e) {
            // o servidor recusou os campos extras do modo "Desligar raciocínio": refaz sem eles (e não os envia mais neste pedido)
            if (extraOk && e.name !== 'AbortError' && /HTTP 4(00|22)/.test(e.message) && !/context|too long|too large|exceed/i.test(e.message)) { extraOk = false; continue; }
            // o provedor recusou por tamanho: compacta mais forte e tenta uma vez
            if (e.name !== 'AbortError' && tentativa === 0 && /context|too long|too large|maximum|max.?tokens|exceed|413/i.test(e.message)) { await this.compactIfNeeded(provider, model, messages, sysMsg, signal, true); continue; }
            telemetria.registrar({ ...base, ms: Date.now() - tChamada, erro: e.name === 'AbortError' ? 'interrompido' : String(e.message).slice(0, 200), interrompido: e.name === 'AbortError' });
            throw e;
          } finally { clearInterval(espera); }
        }
        {
          const out = r.usage?.completion_tokens ?? Math.round(((r.content || '').length + (r.reasoning || '').length) / 4), g = r.timing?.genMs;
          telemetria.registrar({
            ...base, ms: Date.now() - tChamada, ttftMs: r.timing?.ttftMs ?? null, finish: r.finish || null,
            promptTokens: r.usage?.prompt_tokens ?? null, saidaTokens: r.usage?.completion_tokens ?? null,
            tps: g >= 300 && out >= 5 ? Math.round((out / (g / 1000)) * 10) / 10 : null,
            chars: (r.content || '').length, raciocinioChars: (r.reasoning || '').length, ferramentas: r.toolCalls.map((c) => c.name),
            vazia: !r.content && !r.toolCalls.length, cortou: !!r.cortou,
          });
        }
        // chamada de ferramenta escrita como texto (modelos pequenos): converte numa chamada de verdade
        if (!r.toolCalls.length && r.content && !ultimo) {
          const x = extrairChamadas(r.content, tools.map((t) => t.function.name));
          if (x.calls.length) { r.toolCalls = x.calls; r.content = x.texto; }
        }
        if (r.usage) {
          if (bruto > 200 && r.usage.prompt_tokens) this.calib = Math.min(2.5, Math.max(0.5, r.usage.prompt_tokens / bruto)); // aprende a proporção real
          // velocidade de geração = tokens de saída / tempo desde o primeiro token (sem contar a leitura do prompt)
          const out = r.usage.completion_tokens ?? Math.round(((r.content || '').length + (r.reasoning || '').length) / 4);
          const g = r.timing?.genMs;
          const tps = g >= 300 && out >= 5 ? Math.round((out / (g / 1000)) * 10) / 10 : null;
          this.emit({ type: 'usage', id, usage: r.usage, tps, ttftMs: r.timing?.ttftMs ?? null });
        }
        // resposta totalmente vazia (só raciocínio) NÃO entra no histórico: mensagem assistant sem conteúdo
        // nem ferramenta confunde o template de vários modelos e eles passam a responder vazio de novo
        if (r.content || r.toolCalls.length) messages.push({
          role: 'assistant', content: r.content || null,
          ...(r.toolCalls.length ? { tool_calls: r.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })) } : {}),
        });
        vazio = !r.content && !r.toolCalls.length ? { finish: r.finish, raciocinio: (r.reasoning || '').length } : null;
        // modelo preso repetindo o mesmo texto: corta e manda agir de forma diferente (até 3 vezes)
        if (r.cortou === 'repeticao' && !r.toolCalls.length && !ultimo && cortes < 3) {
          cortes++;
          this.emit({ type: 'nudge', id, n: cortes, motivo: 'raciocinio' });
          messages.push({ role: 'user', content: '[Sistema] Você entrou em laço, repetindo o mesmo raciocínio. PARE de analisar. Escolha UMA ação concreta diferente das anteriores e execute agora com uma ferramenta: leia o arquivo que ainda não leu, rode o teste, ou corrija o código. Se uma abordagem já falhou duas vezes, mude de abordagem ou diga ao usuário o que descobriu e o que falta.' });
          continue;
        }
        // raciocinou além do limite sem agir: descarta o pensamento e manda executar já (até 3 vezes por pedido)
        if (r.cortou && !r.content && !r.toolCalls.length) {
          if (cortes < 3 && !ultimo) {
            cortes++;
            this.emit({ type: 'nudge', id, n: cortes, motivo: 'raciocinio' });
            messages.push({ role: 'user', content: '[Sistema] Você passou tempo demais só raciocinando, sem agir. PARE de planejar. Execute AGORA: chame `criar_projeto` (se ainda não houver pasta) e grave os arquivos com `write`, UM por vez, começando pelos essenciais. Não repita o plano; escreva o arquivo direto.' });
            continue;
          }
        }
        if (depth === 0 && r.content) this.view.push({ r: 'bot', t: r.content });
        final = r.content;
        if (r.toolCalls.length) usouFerramenta = true;
        if (r.toolCalls.some((c) => ['write', 'edit', 'criar_documento', 'gerar_imagem', 'estilizar_imagem'].includes(c.name))) gravou = true;
        // "testou" = subiu o servidor de teste ou rodou o programa (node/python/npm start|test…) depois de escrever arquivos
        if (r.toolCalls.some((c) => c.name === 'iniciar_servidor' || (c.name === 'bash' && /\b(node|python|py|npm\s+(start|test|run)|npx|pytest|uvicorn|flask|dotnet|go\s+run|java)\b/i.test(c.args || '')))) testou = true;
        if (!r.toolCalls.length) {
          // projeto com código que roda, entregue sem nunca ter sido executado/testado: manda testar e corrigir (1 vez)
          if (nudgeTeste < 1 && gravou && !testou && step < (agent.steps || 25) - 3 && this.projetoExecutavel() && tools.some((t) => t.function.name === 'iniciar_servidor' || t.function.name === 'bash')) {
            nudgeTeste++;
            this.emit({ type: 'nudge', id, n: nudgeTeste, motivo: 'teste' });
            messages.push({ role: 'user', content: '[Sistema] Você criou o projeto mas ainda NÃO o executou nem testou. Antes de entregar: (1) instale as dependências (npm install / pip install -r requirements.txt); (2) suba o projeto com `iniciar_servidor` passando em `verificar` as rotas principais (página inicial e as APIs); (3) se algo falhar (erro no log, status 4xx/5xx, módulo faltando), corrija os arquivos e teste de novo, até funcionar (no máximo 3 ciclos); (4) só então responda, dizendo como executar e o que foi testado. Se o projeto não for executável, explique em uma linha.' });
            continue;
          }
          // entregou o código só no chat (sem gravar arquivo algum): manda criar a pasta e os arquivos de verdade (1 vez)
          if (nudgeArquivos < 1 && step < (agent.steps || 25) - 2 && tools.some((t) => t.function.name === 'write') && this.codigoSemArquivo(r.content, gravou)) {
            nudgeArquivos++;
            this.emit({ type: 'nudge', id, n: nudgeArquivos, motivo: 'arquivos' });
            messages.push({ role: 'user', content: '[Sistema] Você mostrou o código no chat, mas não gravou nenhum arquivo. O usuário espera o projeto PRONTO em disco, sem precisar pedir. Se o pedido era criar/desenvolver algo: chame `criar_projeto` (se ainda não existir pasta) e grave AGORA cada arquivo com `write` (caminhos relativos, estrutura completa de pastas), sem repetir o código no texto. Ao final, diga o caminho da pasta e liste os arquivos criados. Se o pedido era só uma explicação ou um trecho curto, apenas responda de novo em poucas linhas.' });
            continue;
          }
          // alegou que já fez/corrigiu algo sem nunca ter usado ferramenta (alucinação de conclusão, comum
          // em modelos pequenos) OU anunciou o que ia fazer ("Vou criar o documento...") e parou: manda
          // continuar de verdade (no máximo 2 empurrões no total, pra não entrar em loop)
          const semLastro = this.alegouSemFazer(r.content, usouFerramenta);
          if (nudges < 2 && step < (agent.steps || 25) - 2 && (semLastro || this.anunciouSemAgir(r.content, usouFerramenta))) {
            nudges++;
            this.emit({ type: 'nudge', id, n: nudges, motivo: semLastro ? 'alegacao' : undefined });
            messages.push({ role: 'user', content: semLastro
              ? '[Sistema] Você disse que isso já foi feito, mas não chamou NENHUMA ferramenta neste pedido — ou seja, ainda não foi feito de verdade. Use as ferramentas agora (leia o que existe se precisar, depois escreva/edite/execute de fato) e só confirme a conclusão depois de ter executado.'
              : '[Sistema] Seu turno terminou sem executar o que você disse que faria. Continue AGORA: use as ferramentas para realizar a ação (por exemplo criar_documento ou write para entregar o arquivo) e só depois responda com o resultado. Não peça confirmação e não repita o plano.' });
            continue;
          }
          break;
        }
        const results = await Promise.all(r.toolCalls.map((c) => this.callTool(agent, id, c, ctx, depth, signal)));
        results.forEach((out, i) => messages.push({ role: 'tool', tool_call_id: r.toolCalls[i].id, content: out }));
        // a geração foi cortada pelo limite de tokens/contexto do servidor ENQUANTO chamava write/edit: o
        // conteúdo gravado quase certamente está incompleto. Sem isto, o modelo só descobre sozinho depois
        // de "testar" (perdendo passos) ou nem percebe — avisa já, no mesmo passo.
        if (r.finish === 'length' && r.toolCalls.some((c) => c.name === 'write' || c.name === 'edit')) {
          messages.push({ role: 'user', content: '[Sistema] A geração anterior foi cortada pelo limite de tokens/contexto do servidor NO MEIO da chamada de `write`/`edit` — o conteúdo gravado provavelmente está incompleto (não é um bug da ferramenta: ela grava exatamente o que você mandou). Releia o arquivo para confirmar e, se estiver cortado, complete/corrija-o — se o pedido for grande demais para uma única resposta, construa por partes.' });
        }
        // falhas seguidas: o modelo repete o mesmo comando quebrado até esgotar os passos. Avisa na 3ª e para na 6ª.
        const falhou = (o) => /^erro:/.test(o) || /\[exit (?!0\])\d+\]\s*$/.test(o);
        errosSeguidos = results.every(falhou) ? errosSeguidos + 1 : 0;
        if (errosSeguidos === 3) messages.push({ role: 'user', content: '[Sistema] As últimas 3 ações falharam em sequência. NÃO repita a mesma abordagem: leia a mensagem de erro, mude a estratégia (outro comando, outro caminho, ferramenta `write` em vez de terminal) e tente de forma diferente.' });
        if (errosSeguidos >= 6) {
          final = '⚠ Parei: as últimas 6 ações falharam em sequência. Veja o erro acima, ajuste o pedido ou troque de modelo e envie "continue".';
          this.emit({ type: 'text', id, text: final });
          if (depth === 0) this.view.push({ r: 'bot', t: final });
          break;
        }
        // orçamento de pesquisa: no máximo 3 buscas (depois só leitura de páginas) e WEB_MAX consultas no total; depois exige a entrega
        buscas += r.toolCalls.filter((c) => c.name === 'websearch').length;
        leituras += r.toolCalls.filter((c) => c.name === 'webfetch').length;
        const sem = (nomes) => tools.filter((t) => !nomes.includes(t.function.name));
        if (buscas + leituras >= WEB_MAX && !semWeb && tools.some((t) => /^web(search|fetch)$/.test(t.function.name))) {
          semWeb = true; ferramentas = sem(['websearch', 'webfetch']); ctx.bloqueadas.add('websearch').add('webfetch');
          messages.push({ role: 'user', content: `[Sistema] Você já fez ${buscas + leituras} consultas na web: é o suficiente. As ferramentas de pesquisa foram desativadas para este pedido. ESCREVA AGORA o resultado completo (documento com criar_documento, ou arquivo com write) usando o que reuniu e seu conhecimento técnico, e depois resuma ao usuário. Não peça confirmação.` });
          this.emit({ type: 'nudge', id, n: 0, motivo: 'pesquisa' });
        } else if (buscas >= MAX_BUSCAS && !semBusca && !semWeb && tools.some((t) => t.function.name === 'websearch')) {
          semBusca = true; ferramentas = sem(['websearch']); ctx.bloqueadas.add('websearch');
          messages.push({ role: 'user', content: `[Sistema] Você já fez ${buscas} pesquisas: chega de buscar. Agora leia as 3 a 4 páginas mais úteis (chame webfetch várias vezes na MESMA resposta, em paralelo) e em seguida escreva o resultado completo. Se já tiver o suficiente, escreva direto.` });
        }
        if (step === (agent.steps || 25) - 1) final += '\n[limite de passos atingido]';
      }
      // o modelo terminou sem escrever nada: antes o chat ficava mudo e parecia travado — explica o que houve
      if (vazio && !String(final || '').trim()) {
        const motivo = vazio.finish === 'length'
          ? 'a resposta foi cortada pelo limite de tokens/contexto do servidor (aumente o contexto do servidor ou reduza o raciocínio nas Configurações)'
          : vazio.raciocinio ? `ele só raciocinou (${vazio.raciocinio} caracteres) e não escreveu resposta nem chamou ferramenta` : 'ele não devolveu nenhum conteúdo';
        final = `⚠ O modelo ${provider.id}/${model} terminou sem responder: ${motivo}. Envie "continue" para tentar de novo ou troque de modelo.`;
        this.emit({ type: 'text', id, text: final });
        if (depth === 0) this.view.push({ r: 'bot', t: final });
      }
    } finally {
      this.emit({ type: 'agent_end', id });
    }
    return final;
  }

  /** Se `tocadoRel` (caminho que acabou de ser escrito/editado) faz parte de uma página web, devolve
   * o .html a testar (ele mesmo, ou o único/index.html da mesma pasta). Fora desse caso, null — não
   * testa documentos, scripts avulsos, etc. */
  htmlParaChecar(ctx, tocadoRel) {
    const ext = path.extname(String(tocadoRel)).toLowerCase();
    if (!['.html', '.htm', '.js', '.css'].includes(ext)) return null;
    const tocado = path.isAbsolute(tocadoRel) ? tocadoRel : path.join(ctx.cwd, tocadoRel);
    if (ext === '.html' || ext === '.htm') return fs.existsSync(tocado) ? tocado : null;
    const dir = path.dirname(tocado);
    const idx = path.join(dir, 'index.html');
    if (fs.existsSync(idx)) return idx;
    try {
      const htmls = fs.readdirSync(dir).filter((f) => /\.html?$/i.test(f));
      if (htmls.length === 1) return path.join(dir, htmls[0]);
    } catch { /* pasta ilegível: não testa */ }
    return null;
  }

  async callTool(agent, agentId, call, ctx, depth, signal) {
    let args;
    try { args = repararArgs(JSON.parse(call.args || '{}'), this.tools(agent)[call.name]?.parameters); } catch { return 'erro: argumentos JSON inválidos'; }
    const toolId = call.id;
    this.emit({ type: 'tool', id: agentId, toolId, name: call.name, args, status: 'running' });
    const t0 = Date.now();
    let out, estado = 'ok';
    try {
      if (call.name === 'delegate') {
        const sub = this.getCfg().agents.find((a) => a.name === args.agent && a.mode === 'subagent');
        if (!sub) throw new Error(`subagente "${args.agent}" não existe`);
        out = (await this.runAgent(sub, [{ role: 'user', content: args.task }], { depth: depth + 1, parent: agentId, signal })) || '(sem resposta)';
      } else if (ctx.bloqueadas?.has(call.name)) {
        out = call.name === 'websearch'
          ? 'Ferramenta desativada neste pedido: o limite de pesquisas foi atingido. Leia as páginas já encontradas com webfetch (várias na mesma resposta) ou escreva o resultado agora.'
          : 'Ferramentas de pesquisa desativadas neste pedido: o limite de consultas foi atingido. ESCREVA AGORA o resultado completo (criar_documento ou write).';
        estado = 'negado';
      } else if (!this.tools(agent)[call.name] || !this.allowedTool(agent, call.name, this.tools(agent)[call.name])) {
        throw new Error(`ferramenta "${call.name}" indisponível para ${agent.name}`);
      } else if (!(await this.authorize(agent, toolId, call.name, args))) {
        out = 'Permissão negada pelo usuário. Não repita; peça outra abordagem ou explique.';
        estado = 'negado';
      } else {
        out = String(await this.tools(agent)[call.name].run(args, ctx));
        if ((call.name === 'write' || call.name === 'edit') && args?.path) {
          const alvo = this.htmlParaChecar(ctx, args.path);
          if (alvo) {
            const achados = await webcheck.checarHtml(alvo);
            out += achados.length
              ? `\n\n[Teste automático no navegador: ${path.basename(alvo)}] Abri a página e encontrei ERRO(S) — corrija antes de dar a tarefa por concluída:\n${achados.join('\n')}`
              : `\n\n[Teste automático no navegador: ${path.basename(alvo)}] Abri a página: carregou sem erros no console.`;
          }
        }
      }
      this.emit({ type: 'tool', id: agentId, toolId, name: call.name, status: 'done', output: out.slice(0, 1500) });
    } catch (e) {
      out = `erro: ${e.message}`;
      estado = 'erro';
      this.emit({ type: 'tool', id: agentId, toolId, name: call.name, status: 'error', output: out });
    }
    const resumo = audit.resumo(call.name, args);
    audit.log(this.sessionId, { agent: agent.name, tool: call.name, kind: this.tools(agent)[call.name]?.kind || (call.name === 'delegate' ? 'delegate' : ''), resumo, estado, aut: this.authInfo.get(toolId) || 'automática', ms: Date.now() - t0, saida: out.slice(0, 300) });
    this.authInfo.delete(toolId);
    if (depth === 0) this.view.push({ r: 'tool', n: call.name, a: resumo.slice(0, 140), e: estado });
    return out;
  }

  /** Skills pedidas explicitamente: "/nome" ou "skill nome". Têm precedência sobre o filtro do agente. */
  explicitSkills(text) {
    const off = this.getCfg().disabledSkills || [];
    return ext.listSkills().filter((x) => !off.includes(x.id)
      && new RegExp(`(?:^|[\\s(])(?:/|skill:?\\s+["'«]?)${escRe(x.id)}(?![\\w-])`, 'i').test(text));
  }

  /** Entrada do usuário → agente primário ativo. */
  async send(text, files = []) {
    const cfg = this.getCfg();
    const agent = cfg.agents.find((a) => a.name === cfg.activeAgent && a.mode !== 'subagent') || cfg.agents.find((a) => a.mode !== 'subagent');
    this.cancel();
    this.turn++;
    this.abort = new AbortController();
    // imagens: enviadas ao modelo só se a opção "visão" estiver ligada; senão o agente usa OCR (ler_documento)
    const imgs = [], outros = [];
    for (const f of files) {
      const mime = IMG_MIME[path.extname(f).toLowerCase()];
      if (cfg.vision && mime) {
        try {
          if (fs.statSync(f).size <= 6 * 1024 * 1024) { imgs.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${fs.readFileSync(f).toString('base64')}` }, _nome: path.basename(f) }); continue; }
        } catch { /* ilegível: cai para a lista de arquivos */ }
      }
      outros.push(f);
    }
    const att = outros.length ? `\n\nArquivos anexados (PDF, Word, Excel e PowerPoint: leia com a ferramenta ler_documento; imagens também (OCR); os demais com read):\n${outros.map((f) => `- ${f}`).join('\n')}` : '';
    const imgNote = imgs.length ? `\n\n(${imgs.length} imagem(ns) anexada(s) a esta mensagem: ${imgs.map((i) => i._nome).join(', ')}.)` : '';
    let skillText = '';
    for (const sk of this.explicitSkills(text)) {
      try {
        const r = ext.readSkill(sk.id);
        const apoio = r.files.length ? `\nArquivos de apoio em ${r.dir}: ${r.files.join(', ')}` : '';
        skillText += `\n\n[Skill "${sk.id}" carregada a pedido do usuário. Siga estas instruções:]${apoio}\n${r.body.slice(0, 30000)}`;
        this.emit({ type: 'skill_loaded', id: sk.id });
      } catch { /* skill ilegível: segue sem ela */ }
    }
    const textoFinal = text + att + imgNote + skillText;
    this.view.push({ r: 'user', t: text, f: files.map((f) => path.basename(f)) });
    if (!this.title) this.title = text.replace(/\s+/g, ' ').trim().slice(0, 60);
    const mark = this.history.length;
    this.history.push({ role: 'user', content: imgs.length ? [{ type: 'text', text: textoFinal }, ...imgs] : textoFinal });
    try {
      // corrida com o sinal de parar: mesmo que algo (ferramenta, servidor) não reaja ao abort, a UI é liberada
      const sinal = this.abort.signal;
      const parado = new Promise((_, rej) => sinal.addEventListener('abort', () => rej(Object.assign(new Error('Interrompido'), { name: 'AbortError' })), { once: true }));
      parado.catch(() => {});
      await Promise.race([this.runAgent(agent, this.history, { signal: sinal }), parado]);
    } catch (e) {
      if (e.name === 'AbortError') this.emit({ type: 'error', text: 'Interrompido.' });
      else this.emit({ type: 'error', text: e.message });
      if (e.name !== 'AbortError' && this.history.length === mark + 1) this.history.length = mark; // não envenena o histórico
    } finally {
      this.abort = null;
      pararServidores(); // servidores de teste (iniciar_servidor) não ficam vivos depois do pedido
      this.saveSession();
    }
  }
}

module.exports = { comandoSomenteLeitura, Engine };
