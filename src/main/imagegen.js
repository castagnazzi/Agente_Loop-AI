// Geração de imagem por IA a partir de texto, sem chave de API (serviço gratuito Pollinations).
const fs = require('fs');
const path = require('path');

async function gerar(a, dir) {
  const prompt = String(a.prompt || '').trim();
  if (!prompt) throw new Error('informe a descrição da imagem em "prompt"');
  const largura = Math.min(1536, Math.max(256, Math.round(Number(a.largura)) || 1024));
  const altura = Math.min(1536, Math.max(256, Math.round(Number(a.altura)) || 1024));
  const seed = Math.floor(Math.random() * 1e9); // sem seed fixo, o serviço às vezes devolve sempre a mesma imagem em cache
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${largura}&height=${altura}&seed=${seed}&nologo=true`;
  let r;
  try {
    r = await fetch(url, { signal: AbortSignal.timeout(90000), headers: { 'User-Agent': 'Mozilla/5.0' } });
  } catch (e) {
    throw new Error(e.name === 'TimeoutError' ? 'tempo esgotado gerando a imagem (o serviço pode estar sobrecarregado; tente de novo)' : `não foi possível acessar o serviço de geração de imagem (${e.message})`);
  }
  if (!r.ok) throw new Error(`o serviço de geração de imagem respondeu HTTP ${r.status}`);
  const tipo = r.headers.get('content-type') || '';
  if (!tipo.startsWith('image/')) throw new Error('o serviço não devolveu uma imagem (reformule a descrição e tente de novo)');
  const ext = tipo.includes('png') ? '.png' : '.jpg';
  const base = String(a.nome || 'imagem').replace(/[\\/:*?"<>|]/g, '-').replace(/\.(png|jpe?g|webp)$/i, '');
  const f = path.join(dir, base + ext);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
  return f;
}

module.exports = { gerar };
