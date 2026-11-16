// Gera build/icon.ico a partir do próprio boneco (src/renderer/pet) — mesmo visual do app, sem inventar um ícone novo.
// Roda com Electron (precisa de janela pra renderizar SVG/CSS): npx electron scripts/make-icon.js
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { Jimp } = require('../node_modules/jimp');

const TAMANHOS = [16, 24, 32, 48, 64, 128, 256];
const OUT = path.join(__dirname, '..', 'build', 'icon.ico');

// ICO com entradas PNG (suportado desde o Windows Vista): bem mais simples que montar bitmaps AND/XOR.
function montarIco(pngsPorTamanho) {
  const n = pngsPorTamanho.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(n, 4);
  let offset = 6 + 16 * n;
  const entradas = [], dados = [];
  for (const { tamanho, png } of pngsPorTamanho) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(tamanho >= 256 ? 0 : tamanho, 0);
    entry.writeUInt8(tamanho >= 256 ? 0 : tamanho, 1);
    entry.writeUInt8(0, 2); entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8); entry.writeUInt32LE(offset, 12);
    entradas.push(entry); dados.push(png);
    offset += png.length;
  }
  return Buffer.concat([header, ...entradas, ...dados]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 256, height: 256, show: false, transparent: true, backgroundColor: '#00000000', frame: false,
    webPreferences: { sandbox: true },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'pet', 'index.html'));
  app.on('window-all-closed', () => {}); // não sai sozinho ao destruir a janela — ainda falta processar as imagens
  await new Promise((r) => setTimeout(r, 200)); // garante o 1º frame (sem o "mergulho" da animação de flutuar)
  const base = (await win.webContents.capturePage()).toPNG();
  win.destroy();

  const pngsPorTamanho = [];
  for (const tamanho of TAMANHOS) {
    const img = await Jimp.read(base);
    img.resize({ w: tamanho, h: tamanho });
    pngsPorTamanho.push({ tamanho, png: await img.getBuffer('image/png') });
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, montarIco(pngsPorTamanho));
  console.log('ícone gerado em', OUT, '-', fs.statSync(OUT).size, 'bytes');

  // PNG à parte (fora de build/, que não vai pro pacote): usado em tempo de execução pela bandeja/janelas
  const assetsDir = path.join(__dirname, '..', 'src', 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, 'icon.png'), pngsPorTamanho.find((p) => p.tamanho === 256).png);
  fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon-preview.png'), base);
  app.exit(0);
});
