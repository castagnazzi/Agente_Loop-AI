// Testa de verdade uma página HTML gerada pelo agente: abre numa janela oculta do Electron e
// devolve os erros reais de console/execução (em vez de confiar na palavra do modelo de que "funcionou").
// Pensado para modelos fracos/quantizados que alucinam conclusão: aqui o feedback é determinístico.
const { BrowserWindow } = require('electron');

const NIVEL = ['verbose', 'info', 'aviso', 'erro'];

/** Carrega `filePath` numa janela oculta e coleta erros de console, falhas de carregamento e
 * travamentos por `esperaMs` depois do carregamento (dá tempo de erros assíncronos aparecerem,
 * ex.: dentro de requestAnimationFrame). Nunca rejeita: em caso de falha ao abrir, devolve o erro
 * como um achado comum, pra sempre virar texto útil pro modelo. */
function checarHtml(filePath, { esperaMs = 2000, timeoutMs = 9000 } = {}) {
  return new Promise((resolve) => {
    let win;
    try {
      win = new BrowserWindow({
        show: false, width: 1000, height: 700,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, offscreen: false },
      });
    } catch (e) { return resolve([`[não foi possível abrir uma janela de teste: ${e.message}]`]); }

    const erros = [];
    let resolvido = false;
    const terminar = (extra) => {
      if (resolvido) return;
      resolvido = true;
      clearTimeout(limite);
      if (extra) erros.push(extra);
      try { if (!win.isDestroyed()) win.destroy(); } catch { /* ignora */ }
      resolve(erros);
    };
    const limite = setTimeout(() => terminar('[tempo esgotado ao testar a página]'), timeoutMs);

    win.webContents.on('console-message', (_e, level, message) => {
      const msg = String(message);
      if (level >= 3 && !/Electron Security Warning/i.test(msg)) erros.push(`[console ${NIVEL[level] || level}] ${msg.slice(0, 500)}`);
    });
    win.webContents.on('did-fail-load', (_e, code, desc) => {
      if (code !== -3) terminar(`[falha ao carregar] ${desc} (${code})`); // -3 = ABORTED (comum e inofensivo)
    });
    win.webContents.on('render-process-gone', (_e, det) => terminar(`[processo travou ao abrir a página] ${det?.reason || ''}`));
    win.webContents.once('did-finish-load', () => setTimeout(() => terminar(), esperaMs));
    win.loadFile(filePath).catch((e) => terminar(`[erro ao abrir o arquivo] ${e.message}`));
  });
}

module.exports = { checarHtml };
