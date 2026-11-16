// Modelos pequenos às vezes escrevem a chamada de ferramenta como TEXTO em vez de usar tool_calls:
//   <tool_call><function=bash><parameter=command>ls</parameter></function></tool_call>   (estilo Qwen/Hermes XML)
//   <tool_call>{"name":"write","arguments":{...}}</tool_call>
//   ```json {"name":"write","arguments":{...}} ```
// Sem este extrator a chamada vira só texto na tela e nada é executado. Só aceita nomes de ferramentas existentes.

let seq = 0;
const mk = (name, args) => ({ id: `txt_${Date.now()}_${seq++}`, name, args: JSON.stringify(args || {}) });

/** @returns {{calls:{id:string,name:string,args:string}[], texto:string}} texto = conteúdo sem os trechos extraídos */
function extrairChamadas(texto, nomes) {
  const permitidos = new Set(nomes);
  const calls = [];
  let out = String(texto || '');

  // 1) <function=nome><parameter=chave>valor</parameter>...</function>, com ou sem <tool_call> em volta
  out = out.replace(/(?:<tool_call>\s*)?<function=([\w.-]+)>([\s\S]*?)<\/function>(?:\s*<\/tool_call>)?/g, (todo, nome, corpo) => {
    if (!permitidos.has(nome)) return todo;
    const args = {};
    for (const m of corpo.matchAll(/<parameter=([\w.-]+)>([\s\S]*?)<\/parameter>/g)) args[m[1]] = m[2].replace(/^\n/, '').replace(/\n$/, '');
    calls.push(mk(nome, args));
    return '';
  });

  // 2) <tool_call>{json}</tool_call>  e  ```json {json}```  com {name|tool, arguments|args|parameters}
  const json = (corpo) => {
    let j; try { j = JSON.parse(corpo.trim()); } catch { return null; }
    const nome = j?.name ?? j?.tool;
    if (typeof nome !== 'string' || !permitidos.has(nome)) return null;
    let a = j.arguments ?? j.args ?? j.parameters ?? {};
    if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = {}; } }
    return mk(nome, a);
  };
  out = out.replace(/<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g, (todo, corpo) => { const c = json(corpo); if (!c) return todo; calls.push(c); return ''; });
  out = out.replace(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/g, (todo, corpo) => { const c = json(corpo); if (!c) return todo; calls.push(c); return ''; });

  return { calls, texto: out.trim() };
}

module.exports = { extrairChamadas };
