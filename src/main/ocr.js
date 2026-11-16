// OCR offline (tesseract.js + dados de idioma em <app>/ocr): imagens e PDF digitalizado.
// PDF: as páginas são desenhadas pelo pdf.js numa janela oculta do Electron e lidas página a página (só funciona dentro do app).
const fs = require('fs');
const path = require('path');
const { baseDir } = require('./paths');

const LANGS = ['por', 'eng'];
const temIdioma = (d) => LANGS.every((l) => { try { return fs.statSync(path.join(d, `${l}.traineddata`)).size > 100000; } catch { return false; } });
// pasta "ocr" ao lado do app; no pacote também vale <resources>/ocr (extraResources); se faltar, é baixada para a primeira
const langDir = () => {
  const ao = path.join(baseDir(), 'ocr'), res = process.resourcesPath ? path.join(process.resourcesPath, 'ocr') : '';
  return temIdioma(ao) || !res || !temIdioma(res) ? ao : res;
};
const MAX_PDF_BYTES = 80 * 1024 * 1024;

/** Garante os arquivos de idioma; baixa (tessdata_fast) se faltarem. */
async function ensureLang() {
  fs.mkdirSync(langDir(), { recursive: true });
  for (const l of LANGS) {
    const f = path.join(langDir(), `${l}.traineddata`);
    if (fs.existsSync(f) && fs.statSync(f).size > 100000) continue;
    try {
      const r = await fetch(`https://github.com/tesseract-ocr/tessdata_fast/raw/main/${l}.traineddata`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      throw new Error(`faltam os dados de idioma do OCR (${l}.traineddata). Copie a pasta "ocr" do Loop-AI para junto do aplicativo, ou conecte à internet para baixar (${e.message}).`);
    }
  }
}

async function newWorker() {
  await ensureLang();
  const { createWorker } = require('tesseract.js');
  return createWorker(LANGS.join('+'), 1, { langPath: langDir(), gzip: false, cacheMethod: 'readOnly', cachePath: langDir() });
}

/** Lê o texto de uma imagem (caminho de arquivo). */
async function ocrImagem(file) {
  const w = await newWorker();
  try { return (await w.recognize(file)).data.text.trim(); } finally { await w.terminate(); }
}

/** "1-3,7" → [1,2,3,7] (limitado a total). */
function paginasDe(spec, total) {
  if (!spec) return null;
  const set = new Set();
  for (const part of String(spec).split(',')) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
    if (!m) continue;
    const a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
    for (let p = Math.min(a, b); p <= Math.max(a, b) && p <= total; p++) if (p >= 1) set.add(p);
  }
  return [...set].sort((x, y) => x - y);
}

/** OCR de PDF. opts: { paginas: "1-5", maxPaginas: 15, signal }. Retorna { texto, total, feitas: [n...] }. */
async function ocrPdf(file, { paginas, maxPaginas = 15, signal } = {}) {
  let electron = null;
  try { electron = require('electron'); } catch { /* fora do Electron */ }
  if (!electron || !electron.BrowserWindow) throw new Error('OCR de PDF só funciona dentro do app Loop-AI (usa o Chromium do Electron). Em imagens (.png/.jpg) o OCR funciona em qualquer contexto.');
  const size = fs.statSync(file).size;
  if (size > MAX_PDF_BYTES) throw new Error(`PDF muito grande para OCR (${Math.round(size / 1048576)} MB; limite ${MAX_PDF_BYTES / 1048576} MB). Use o parâmetro paginas em um PDF menor ou divida o arquivo.`);
  const win = new electron.BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, offscreen: false } });
  let worker = null;
  try {
    await win.loadFile(path.join(__dirname, 'ocr', 'render.html'));
    const total = await win.webContents.executeJavaScript(`loadPdf(${JSON.stringify(fs.readFileSync(file).toString('base64'))})`);
    const sel = paginasDe(paginas, total);
    if (paginas && !sel.length) throw new Error(`paginas "${paginas}" inválido: o PDF tem ${total} página(s). Use por exemplo "1-5" ou "3,7".`);
    let lista = sel || Array.from({ length: total }, (_, i) => i + 1);
    const cortado = lista.length > maxPaginas;
    if (cortado) lista = lista.slice(0, maxPaginas);
    worker = await newWorker();
    const partes = [], feitas = [];
    for (const n of lista) {
      if (signal?.aborted) throw new Error('OCR interrompido pelo usuário');
      const b64 = await win.webContents.executeJavaScript(`renderPage(${n}, 2.5)`);
      const { data } = await worker.recognize(Buffer.from(b64, 'base64'));
      partes.push(`=== Página ${n} ===\n${data.text.trim()}`);
      feitas.push(n);
    }
    return { texto: partes.join('\n\n'), total, feitas, cortado };
  } finally {
    if (worker) await worker.terminate().catch(() => {});
    win.destroy();
  }
}

const IMAGENS = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.webp', '.tif', '.tiff']);
module.exports = { ocrImagem, ocrPdf, IMAGENS, paginasDe, ensureLang };
