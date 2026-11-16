// Autoteste: verifica, no próprio aplicativo (inclusive empacotado), se as peças principais funcionam neste PC.
// Uso: Loop-AI.exe --selftest   (grava selftest.txt ao lado do aplicativo e encerra; código de saída 0 = tudo certo)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const { baseDir, dataDir } = require('./paths');

async function run() {
  const out = [], falhas = [];
  const t = async (nome, fn) => {
    const t0 = Date.now();
    try { const r = await fn(); out.push(`✔ ${nome}${r ? ' — ' + r : ''} (${Date.now() - t0} ms)`); }
    catch (e) { falhas.push(nome); out.push(`✖ ${nome} — ${String(e.message || e).split('\n')[0]}`); }
  };
  out.push(`Loop-AI autoteste · ${new Date().toLocaleString('pt-BR')} · ${os.hostname()}`);
  out.push(`Electron ${process.versions.electron} · Node ${process.versions.node} · empacotado: ${app.isPackaged} · pasta do app: ${baseDir()}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-selftest-'));

  await t('Bibliotecas do aplicativo', async () => { // carrega cada dependência (pega módulos que faltam no pacote)
    const deps = Object.keys(JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')).dependencies || {}).filter((d) => d !== 'pdfjs-dist');
    const ruins = [];
    for (const d of deps) { try { require(d); } catch (e) { ruins.push(`${d} (${String(e.message).split('\n')[0]})`); } }
    if (ruins.length) throw new Error(ruins.join('; '));
    return `${deps.length} carregadas`;
  });
  await t('Pasta de dados gravável', async () => { fs.mkdirSync(dataDir(), { recursive: true }); const f = path.join(dataDir(), '.selftest'); fs.writeFileSync(f, 'ok'); fs.rmSync(f); return dataDir(); });
  await t('Configurações', async () => { const s = require('./settings').load(); return `${s.agents.length} agentes, ${s.providers.length} provedor(es)`; });
  const docs = require('./docs');
  await t('Word (criar e ler)', async () => { const f = await docs.criar({ formato: 'docx', nome: 't', texto: '# Título\n\n- item um\n- item dois' }, tmp); if (!/item dois/.test(await docs.ler(f))) throw new Error('texto não voltou'); });
  await t('Excel (criar e ler)', async () => { const f = await docs.criar({ formato: 'xlsx', nome: 't', planilhas: [{ nome: 'A', colunas: ['x', 'y'], linhas: [[1, 2]] }] }, tmp); if (!/\| 1 \| 2 \|/.test(await docs.ler(f))) throw new Error('dados não voltaram'); });
  await t('PowerPoint (criar e ler)', async () => { const f = await docs.criar({ formato: 'pptx', nome: 't', slides: [{ titulo: 'Capa' }, { titulo: 'Slide', topicos: ['ponto'] }] }, tmp); if (!/ponto/.test(await docs.ler(f))) throw new Error('slides não voltaram'); });
  let pdf = null;
  await t('PDF (criar e ler)', async () => { pdf = await docs.criar({ formato: 'pdf', nome: 't', texto: '# Relatório\n\nTexto de teste' }, tmp); if (!/Texto de teste/.test(await docs.ler(pdf))) throw new Error('texto não voltou'); });

  // OCR: desenha um texto numa janela oculta, captura como imagem e lê; depois faz um PDF só de imagem
  await t('OCR de imagem e de PDF digitalizado', async () => {
    const w = new BrowserWindow({ show: false, width: 700, height: 160, webPreferences: { sandbox: true } });
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<body style="margin:0;padding:24px;background:#fff;font:30px Arial">LAUDO TÉCNICO Nº 2026<br>Disco com defeito</body>'));
    await new Promise((r) => setTimeout(r, 300));
    const png = (await w.webContents.capturePage()).toPNG(); w.destroy();
    const imgF = path.join(tmp, 'o.png'); fs.writeFileSync(imgF, png);
    const a = await docs.ler(imgF);
    if (!/LAUDO/i.test(a)) throw new Error('imagem: texto não reconhecido');
    const w2 = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    await w2.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<body style="margin:0"><img style="width:100%" src="data:image/png;base64,${png.toString('base64')}"></body>`));
    await new Promise((r) => setTimeout(r, 300));
    const pdfF = path.join(tmp, 'scan.pdf'); fs.writeFileSync(pdfF, await w2.webContents.printToPDF({ pageSize: 'A4' })); w2.destroy();
    const b = await docs.ler(pdfF);
    if (!/LAUDO/i.test(b)) throw new Error('PDF digitalizado: texto não reconhecido');
  });

  await t('Estilizar foto (cartoon/lápis/pintura)', async () => {
    const { Jimp } = require('jimp');
    const { estilizar } = require('./stylize');
    const origF = path.join(tmp, 'foto.png');
    await (await new Jimp({ width: 120, height: 120, color: 0xffffffff })).write(origF);
    for (const estilo of ['cartoon', 'lapis', 'pintura']) {
      const saida = path.join(tmp, `foto_${estilo}.png`);
      await estilizar(origF, saida, estilo);
      if (!fs.existsSync(saida) || fs.statSync(saida).size < 50) throw new Error(`${estilo}: saída inválida`);
    }
  });
  await t('Teste automático de página (webcheck)', async () => {
    const { checarHtml } = require('./webcheck');
    const bomF = path.join(tmp, 'bom.html');
    fs.writeFileSync(bomF, '<html><body>ok</body></html>');
    const semErro = await checarHtml(bomF, { esperaMs: 300, timeoutMs: 5000 });
    if (semErro.length) throw new Error(`página sem erro acusou erro: ${semErro.join(' | ')}`);
    const ruimF = path.join(tmp, 'ruim.html');
    fs.writeFileSync(ruimF, '<html><body><script>naoExiste.metodo();</script></body></html>');
    const comErro = await checarHtml(ruimF, { esperaMs: 300, timeoutMs: 5000 });
    if (!comErro.length) throw new Error('não detectou o erro de JavaScript injetado');
    return `detectou ${comErro.length} erro(s) na página ruim e 0 na boa`;
  });
  await t('SQLite (histórico dos navegadores)', async () => { const init = require('sql.js'); const SQL = await init({ locateFile: (f) => path.join(path.dirname(require.resolve('sql.js/dist/sql-wasm.js')), f) }); const db = new SQL.Database(); db.run('create table a(x)'); db.close(); });
  await t('PowerShell', async () => { const r = await require('./reportkit').runPS("[Console]::OutputEncoding=[Text.Encoding]::UTF8; @{ ok = $true; v = $PSVersionTable.PSVersion.ToString() } | ConvertTo-Json -Compress"); if (!r.ok) throw new Error('sem retorno'); return `v${r.v}`; });
  if (process.argv.includes('--selftest=full')) {
    await t('Relatório de uso (1 dia)', async () => { const r = await require('./uso').run({ days: 1 }); return `${Math.round(r.html.length / 1024)} KB`; });
    await t('Diagnóstico do PC', async () => { const r = await require('./diagnostico').run({ days: 7, problema: 'teste' }); return `${Math.round(r.html.length / 1024)} KB`; });
  }
  out.push(falhas.length ? `\nRESULTADO: ${falhas.length} falha(s): ${falhas.join(', ')}` : '\nRESULTADO: tudo certo ✔');
  fs.rmSync(tmp, { recursive: true, force: true });
  try { fs.writeFileSync(path.join(baseDir(), 'selftest.txt'), out.join('\n'), 'utf8'); } catch { /* pasta somente leitura */ }
  console.log(out.join('\n'));
  return falhas.length ? 1 : 0;
}

module.exports = { run };
