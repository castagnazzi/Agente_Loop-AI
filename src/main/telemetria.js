// Telemetria das chamadas ao modelo, para diagnosticar travamentos e comparar modelos: uma linha por chamada em
// <app>/data/telemetria/chamadas.jsonl (modelo, tempos, tokens, motivo de parada, resposta vazia/cortada, erros).
// Separada do registro de atividades (audit.js), que alimenta o laudo em HTML. Nunca guarda texto do usuário nem do modelo.
const fs = require('fs');
const path = require('path');
const { dataDir } = require('./paths');

const dir = () => path.join(dataDir(), 'telemetria');
const file = () => path.join(dir(), 'chamadas.jsonl');
const MAX_BYTES = 2 * 1024 * 1024;
const MANTER_LINHAS = 2000;

function registrar(e) {
  try {
    fs.mkdirSync(dir(), { recursive: true });
    const f = file();
    const linha = JSON.stringify({ t: new Date().toISOString(), ...e }) + '\n';
    let tam = 0;
    try { tam = fs.statSync(f).size; } catch { /* arquivo novo */ }
    if (tam + linha.length > MAX_BYTES) {
      const restante = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).slice(-MANTER_LINHAS);
      fs.writeFileSync(f, restante.join('\n') + '\n');
    }
    fs.appendFileSync(f, linha);
  } catch { /* a telemetria nunca derruba o agente */ }
}

function ler(limite = 200) {
  try {
    return fs.readFileSync(file(), 'utf8').split('\n').filter(Boolean).slice(-limite)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/** Resumo por modelo (para olhar rápido qual se comportou melhor): chamadas, falhas, vazias, tempo e velocidade médios. */
function resumoPorModelo(limite = 2000) {
  const por = {};
  for (const c of ler(limite)) {
    const m = (por[c.modelo] ??= { chamadas: 0, erros: 0, vazias: 0, cortadas: 0, ttft: [], tps: [] });
    m.chamadas++;
    if (c.erro) m.erros++;
    if (c.vazia) m.vazias++;
    if (c.cortou) m.cortadas++;
    if (c.ttftMs != null) m.ttft.push(c.ttftMs);
    if (c.tps != null) m.tps.push(c.tps);
  }
  const media = (a) => (a.length ? Math.round((a.reduce((s, x) => s + x, 0) / a.length) * 10) / 10 : null);
  return Object.entries(por).map(([modelo, m]) => ({ modelo, chamadas: m.chamadas, erros: m.erros, vazias: m.vazias, cortadas: m.cortadas, ttftMedioMs: media(m.ttft), tpsMedio: media(m.tps) }));
}

module.exports = { registrar, ler, resumoPorModelo, arquivo: file };
