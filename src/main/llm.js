// Cliente de LLM compatível com OpenAI (/chat/completions) com streaming e tool calling.
// Cobre provedores compatíveis com OpenAI: ollama, llama.cpp, NVIDIA NIM, OpenAI etc.

const PRIMEIRO_BYTE_MS = 10 * 60 * 1000; // até o servidor terminar de ler o prompt e começar a responder
const INATIVO_MS = 10 * 60 * 1000;        // silêncio máximo entre pedaços da resposta

// O fetch nativo do Node (undici) derruba a conexão sozinho após 300 s sem cabeçalhos/dados ("terminated").
// Modelo local lendo um prompt grande sem cache passa disso (ex.: 88k tokens = 328 s). Quem vigia a
// inatividade é o `vigia` abaixo; aqui o limite do undici é desligado.
let _fetch = fetch, _dispatcher;
try {
  const u = require('undici');
  _dispatcher = new u.Agent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 30000 });
  _fetch = u.fetch;
} catch { /* sem undici: segue com o fetch padrão */ }

function joinUrl(base, p) {
  return base.replace(/\/+$/, '') + p;
}

/**
 * @param {{baseURL:string, apiKey?:string}} provider
 * @param {{model:string, messages:any[], tools?:any[], temperature?:number}} req
 * @param {{onText?:(s:string)=>void, onReasoning?:(s:string)=>void, signal?:AbortSignal}} hooks
 * @returns {Promise<{content:string, reasoning:string, toolCalls:{id:string,name:string,args:string}[], usage:any}>}
 */
// campos internos (começam com "_") nunca vão para a API
const limpa = (o) => (Array.isArray(o) ? o.map(limpa) : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [k, limpa(v)])) : o);

async function chat(provider, req, hooks = {}) {
  const base = provider.baseURL.replace(/\/+$/, '');
  // alguns baseURL já terminam em /v1, outros não (ngrok → servidor llama.cpp na raiz)
  const url = /\/v1$/.test(base) ? joinUrl(base, '/chat/completions') : joinUrl(base, '/v1/chat/completions');
  const body = {
    model: req.model,
    messages: limpa(req.messages),
    stream: true,
    stream_options: { include_usage: true },
    ...(req.temperature != null ? { temperature: req.temperature } : {}),
    ...(req.extraBody || {}),
    ...(req.tools?.length ? { tools: req.tools, tool_choice: 'auto' } : {}),
  };
  const t0 = Date.now();
  let tFirst = null; // instante do primeiro token gerado (separa o tempo de leitura do prompt)

  // Vigia de inatividade: servidor local/rede que para de enviar dados (sem fechar a conexão) deixava o
  // agente pendurado para sempre. Espera longa até o 1º byte (o servidor lê o prompt inteiro antes de
  // responder) e curta entre os pedaços seguintes. O botão parar (hooks.signal) também aborta na hora.
  const ac = new AbortController();
  let parou = false, timer = null;
  const vigia = (ms) => { clearTimeout(timer); timer = setTimeout(() => { parou = true; ac.abort(); }, ms); };
  const onAbort = () => ac.abort();
  if (hooks.signal?.aborted) ac.abort(); else hooks.signal?.addEventListener('abort', onAbort, { once: true });
  vigia(PRIMEIRO_BYTE_MS);
  try {
    return await ler();
  } catch (e) {
    if (parou && !hooks.signal?.aborted) throw new Error(`O servidor (${base}) parou de responder: sem dados há ${Math.round((tFirst === null ? PRIMEIRO_BYTE_MS : INATIVO_MS) / 1000)} s. Verifique se o modelo está rodando e tente de novo.`);
    // a conexão foi fechada/derrubada no meio (servidor caiu, travou ou reiniciou) — o fetch nativo só dá
    // mensagens genéricas ("terminated", "fetch failed", "other side closed"): troca por algo acionável.
    if (!hooks.signal?.aborted && /^(terminated|fetch failed)$|other side closed|ECONNRESET|ECONNREFUSED|socket hang ?up/i.test(e.message || '')) {
      throw new Error(`A conexão com o servidor (${base}) caiu ${tFirst === null ? 'antes de responder' : 'no meio da resposta'} (processo travou, reiniciou ou ficou sem memória/VRAM). Verifique se o servidor do modelo ainda está rodando e tente de novo.`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
    hooks.signal?.removeEventListener('abort', onAbort);
  }

  async function ler() {
  const res = await _fetch(url, {
    method: 'POST',
    signal: ac.signal,
    ...(_dispatcher ? { dispatcher: _dispatcher } : {}),
    headers: {
      'Content-Type': 'application/json',
      'ngrok-skip-browser-warning': '1',
      ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}: ${(await res.text()).slice(0, 400)}`);

  let content = '', reasoning = '', usage = null;
  const calls = []; // acumula tool_calls por índice
  const decoder = new TextDecoder();
  let buf = '', cortou = false, finish = null, verif = 0;
  // Modelos "pensadores" podem raciocinar por minutos sem nunca agir. Passou do limite sem nenhum texto
  // nem ferramenta: encerra o stream (o engine manda o modelo executar em seguida).
  const limiteRaciocinio = hooks.maxReasoningChars || 0;
  leitura: for await (const chunk of res.body) {
    vigia(INATIVO_MS);
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let j;
      try { j = JSON.parse(data); } catch { continue; }
      if (j.usage) usage = j.usage;
      if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason;
      const d = j.choices?.[0]?.delta;
      if (!d) continue;
      if (tFirst === null && (d.content || d.reasoning_content || d.reasoning || d.tool_calls?.length)) tFirst = Date.now();
      const r = d.reasoning_content ?? d.reasoning;
      if (r) {
        reasoning += r; hooks.onReasoning?.(r);
        if (reasoning.length > 400 && ++verif % 8 === 0 && achaRepeticao(reasoning) >= 0) { cortou = 'repeticao'; break leitura; }
        if (limiteRaciocinio && !content && !calls.length && reasoning.length > limiteRaciocinio) { cortou = true; break leitura; }
      }
      if (d.content) {
        content += d.content; hooks.onText?.(d.content);
        // laço de repetição (comum em modelos quantizados): o mesmo trecho 3x → corta e descarta as cópias
        if (content.length > 400 && ++verif % 8 === 0) {
          const corte = achaRepeticao(content);
          if (corte >= 0) { content = content.slice(0, corte); cortou = 'repeticao'; break leitura; }
        }
      }
      for (const tc of d.tool_calls || []) {
        const c = (calls[tc.index ?? 0] ??= { id: '', name: '', args: '' });
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.name += tc.function.name;
        if (tc.function?.arguments) c.args += tc.function.arguments;
      }
    }
  }
  const t1 = Date.now();
  const timing = { ttftMs: tFirst === null ? null : tFirst - t0, genMs: tFirst === null ? null : t1 - tFirst };
  return { content, reasoning, toolCalls: calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${Date.now()}_${i}` })), usage, timing, cortou, finish };
  }
}

/** Lista os modelos de um provedor (GET /models). Tenta com e sem /v1. */
async function listModels(provider) {
  const base = provider.baseURL.replace(/\/+$/, '');
  const urls = /\/v1$/.test(base) ? [base + '/models'] : [base + '/v1/models', base + '/models'];
  let lastErr;
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(20000),
        headers: { 'ngrok-skip-browser-warning': '1', ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}) },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
      const j = await res.json();
      const arr = Array.isArray(j) ? j : j.data || j.models || [];
      const ids = arr.map((m) => (typeof m === 'string' ? m : m.id || m.name || m.model)).filter(Boolean);
      if (ids.length) return ids.sort((a, b) => a.localeCompare(b));
      lastErr = new Error(`Resposta sem modelos em ${url}`);
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

/** Tenta descobrir o tamanho real do contexto do servidor/modelo, testando os formatos conhecidos
 * (llama.cpp, LM Studio, Ollama, e o campo que alguns servidores OpenAI-compatíveis devolvem em
 * /v1/models), um de cada vez — nunca várias conexões simultâneas: isto roda em segundo plano (não
 * atrasa a conversa), então não há pressa, e evitar várias buscas de DNS/sockets ao mesmo tempo
 * evita disputar recursos com o resto do app caso o endereço configurado não responda.
 * Nunca lança: nem todo servidor expõe isso, então devolve null nesse caso — quem chama decide o padrão. */
async function detectContextLimit(provider, model) {
  const base = provider.baseURL.replace(/\/+$/, '').replace(/\/v1$/, '');
  const headers = { 'ngrok-skip-browser-warning': '1', ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}) };
  const getJson = async (url, opts = {}) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(2500), ...opts, headers: { ...headers, ...(opts.headers || {}) } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };
  const numOk = (n) => Number.isFinite(n) && n >= 512 && n <= 4_000_000;

  try { // llama.cpp server: GET /props
    const j = await getJson(base + '/props');
    const n = j?.default_generation_settings?.n_ctx ?? j?.n_ctx;
    if (numOk(n)) return n;
  } catch { /* não é llama.cpp, ou o endpoint não existe */ }

  try { // LM Studio: GET /api/v0/models (contexto do modelo carregado)
    const j = await getJson(base + '/api/v0/models');
    const arr = j?.data || [];
    const m = arr.find((x) => x.id === model) || arr[0];
    const n = m?.loaded_context_length ?? m?.max_context_length;
    if (numOk(n)) return n;
  } catch { /* não é LM Studio */ }

  try { // Ollama: POST /api/show
    const j = await getJson(base + '/api/show', { method: 'POST', body: JSON.stringify({ model }), headers: { 'Content-Type': 'application/json' } });
    const info = j?.model_info || {};
    const chave = Object.keys(info).find((k) => k.endsWith('.context_length'));
    if (chave && numOk(info[chave])) return info[chave];
    const m = /num_ctx\s+(\d+)/.exec(j?.parameters || '');
    if (m && numOk(Number(m[1]))) return Number(m[1]);
  } catch { /* não é Ollama */ }

  for (const url of [base + '/v1/models', base + '/models']) { // genérico: alguns servidores informam o contexto por modelo aqui
    try {
      const j = await getJson(url);
      const arr = Array.isArray(j) ? j : j.data || j.models || [];
      const m = arr.find((x) => (x.id || x.name || x.model) === model) || arr[0];
      const n = m?.context_length ?? m?.max_model_len ?? m?.context_window ?? m?.n_ctx_train;
      if (numOk(n)) return n;
    } catch { /* tenta a próxima */ }
  }
  return null;
}

module.exports = { chat, listModels, detectContextLimit };

// Procura um trecho (≥80 chars) que termina o texto e já apareceu 2+ vezes antes. Devolve o índice onde
// a 2ª ocorrência começa (mantém a 1ª cópia) ou -1.
function achaRepeticao(t) {
  const n = 80;
  if (t.length < n * 3) return -1;
  const cauda = t.slice(-n);
  const primeira = t.indexOf(cauda);
  if (primeira < 0 || primeira >= t.length - n) return -1;
  const segunda = t.indexOf(cauda, primeira + n);
  if (segunda < 0 || segunda >= t.length - n) return -1;
  return segunda;
}
