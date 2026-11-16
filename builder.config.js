// Configuração do electron-builder. A lista de arquivos de produção é calculada a partir da árvore REAL de node_modules
// (o coletor automático do builder reorganiza algumas dependências e quebra módulos, ex.: exceljs). Uso: npm run pack | npm run dist
const fs = require('fs');
const path = require('path');
const pkg = require('./package.json');

function dependenciasDeProducao() {
  const dirs = new Set();
  const achar = (nome, de) => {
    for (let d = de; ; d = path.dirname(d)) {
      const p = path.join(d, 'node_modules', nome);
      if (fs.existsSync(path.join(p, 'package.json'))) return p;
      if (path.dirname(d) === d) return null;
    }
  };
  const visitar = (nome, de) => {
    const dir = achar(nome, de);
    if (!dir || dirs.has(dir)) return;
    dirs.add(dir);
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    for (const d of Object.keys({ ...j.dependencies, ...j.optionalDependencies })) visitar(d, dir);
  };
  for (const d of Object.keys(pkg.dependencies)) visitar(d, __dirname);
  return [...dirs].map((d) => path.relative(__dirname, d).replace(/\\/g, '/')).filter((d) => !d.includes('@types/') && !d.includes('undici-types'));
}

module.exports = {
  appId: 'br.turisky.loopai',
  productName: 'Loop-AI',
  asar: true,
  files: [
    'src/**/*', '!src/main/*-test.js', '!src/main/mock-llm.js',
    ...dependenciasDeProducao().map((d) => `${d}/**/*`),
    '!**/*.map', '!**/*.d.ts', '!node_modules/pdfjs-dist/{web,legacy,image_decoders}/**',
  ],
  asarUnpack: ['node_modules/tesseract.js/**', 'node_modules/tesseract.js-core/**'], // o worker do OCR precisa de arquivos reais
  extraResources: [{ from: 'ocr', to: 'ocr' }], // dados de idioma do OCR
  win: { target: 'portable', signExecutable: false, icon: 'build/icon.ico' },
  portable: { artifactName: 'Loop-AI.exe' }, // nome fixo: os .bat (iniciar, autoteste) procuram Loop-AI.exe
};
