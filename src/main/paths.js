// Locais de dados do Loop-AI. Tudo fica junto do app para o conjunto ser portátil (pendrive / outro PC):
//   <app>/data      configurações (settings.json), cache do Electron
//   <app>/skills    skills
//   <app>/plugins   plugins
// Desenvolvimento: <app> = raiz do projeto. Empacotado: pasta do executável (PORTABLE_EXECUTABLE_DIR no modo portable).
const { app } = require('electron');
const path = require('path');

function baseDir() {
  if (process.env.LOOP_HOME) return process.env.LOOP_HOME;
  if (app.isPackaged) return process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
  return path.resolve(__dirname, '..', '..');
}

const dataDir = () => path.join(baseDir(), 'data');
// Local usado por versões anteriores (para migrar o que já existia).
const legacyDir = () => path.join(app.getPath('appData'), 'loop-ai');

module.exports = { baseDir, dataDir, legacyDir };
