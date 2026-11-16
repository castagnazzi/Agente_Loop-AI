// Servidor OpenAI-compatível falso (SSE) para testar o engine: node src/main/mock-llm.js 8099
const http = require('http');
const sse = (res, delta, fin) => res.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: fin || null }] })}\n\n`);
http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
    const j = JSON.parse(b);
    const sys = j.messages[0].content, last = j.messages[j.messages.length - 1];
    const hasTool = (n) => j.tools?.some((t) => t.function.name === n);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const call = (i, id, name, args) => sse(res, { tool_calls: [{ index: i, id, function: { name, arguments: JSON.stringify(args) } }] });
    if (last.role === 'tool') {
      if (sys.includes('pesquisador')) sse(res, { content: 'Achei package.json com nome loop-ai.' });
      else sse(res, { content: 'Síntese: o pesquisador e o programador concluíram. ' + last.content.slice(0, 60) });
    } else if (sys.includes('pesquisador')) call(0, 'c1', 'glob', { pattern: 'package.json' });
    else if (sys.includes('programador')) call(0, 'c2', 'write', { path: 'mock-out.txt', content: 'olá do subagente' });
    else if (hasTool('delegate')) { sse(res, { reasoning_content: 'Vou delegar em paralelo.' }); call(0, 'd1', 'delegate', { agent: 'pesquisador', task: 'ache package.json' }); call(1, 'd2', 'delegate', { agent: 'programador', task: 'crie mock-out.txt' }); }
    else sse(res, { content: 'sem ferramentas' });
    res.write('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\ndata: [DONE]\n\n'); res.end();
  });
}).listen(+process.argv[2] || 8099);
