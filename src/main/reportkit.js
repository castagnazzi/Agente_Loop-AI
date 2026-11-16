// Utilitários compartilhados pelos relatórios (diagnóstico e uso): execução de PowerShell e HTML imprimível.
const { spawn } = require('child_process');

/** Executa um script PowerShell (via -EncodedCommand) e devolve o JSON impresso no stdout. */
function runPS(script, env = {}, timeoutMs = 240000) {
  return new Promise((resolve, reject) => {
    const enc = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], {
      windowsHide: true, env: { ...process.env, ...env },
    });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Tempo esgotado na coleta (${Math.round(timeoutMs / 1000)} s).`)); }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(out.slice(out.indexOf('{')), (k, v) => (v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length ? [] : v))); } // {} vazio do PowerShell = lista vazia
      catch { reject(new Error('Falha ao ler a coleta: ' + (err || out).slice(0, 300))); }
    });
  });
}

const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function table(cols, rows, max = 100) {
  rows = arr(rows);
  if (!rows.length) return '<p class="vazio">Nenhum registro.</p>';
  const head = cols.map((c) => `<th>${esc(c[1])}</th>`).join('');
  const body = rows.slice(0, max).map((r) => `<tr>${cols.map((c) => `<td>${esc(typeof r === 'object' ? r[c[0]] : r)}</td>`).join('')}</tr>`).join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>` +
    (rows.length > max ? `<p class="vazio">… e mais ${rows.length - max} registro(s) (veja o arquivo .json).</p>` : '');
}
const list = (items) => (arr(items).length ? `<ul>${arr(items).map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '<p class="vazio">Nenhum registro.</p>');
const kpi = (l, v) => `<div class="kpi"><span>${esc(l)}</span><b>${esc(v)}</b></div>`;
const sec = (id, title, html) => `<section id="${id}"><h2>${esc(title)}</h2>${html}</section>`;

const CSS = `
body{font:13px/1.45 "Segoe UI",Arial,sans-serif;color:#1b2430;margin:0;background:#f4f6f9}
header{background:#14253b;color:#fff;padding:18px 28px}header h1{margin:0;font-size:20px}header p{margin:4px 0 0;color:#b4c5da;font-size:12px}
nav{display:flex;flex-wrap:wrap;gap:4px 12px;padding:8px 28px;background:#fff;border-bottom:1px solid #d8dee6;position:sticky;top:0}nav a{color:#2b6fd6;text-decoration:none;font-size:12px}
main{max-width:1100px;margin:0 auto;padding:12px 28px 40px}section{background:#fff;border:1px solid #d8dee6;border-radius:8px;padding:6px 18px 14px;margin:14px 0}
h2{font-size:15px;margin:12px 0 8px;color:#14253b;border-bottom:2px solid #2b6fd6;padding-bottom:4px}h3{font-size:12px;margin:14px 0 4px;color:#5b6b7c;text-transform:uppercase}
table{border-collapse:collapse;width:100%;font-size:12px}th{background:#eef2f7;text-align:left}th,td{border:1px solid #e1e6ed;padding:4px 7px;vertical-align:top;word-break:break-word}
.kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:6px 0 10px}.kpi{background:#f4f6f9;border-radius:6px;padding:8px 10px}.kpi span{display:block;font-size:11px;color:#5b6b7c}.kpi b{font-size:13px}
.vazio{color:#7f8ea0;margin:4px 0}ul{margin:4px 0;padding-left:20px}
.card{border-left:5px solid #8aa0b5;background:#f6f8fa;border-radius:6px;padding:8px 12px;margin:10px 0;page-break-inside:avoid}
.card h4{margin:0 0 4px;font-size:13px}.card .sev{font-size:10px;font-weight:700;text-transform:uppercase;padding:1px 6px;border-radius:8px;color:#fff;background:#8aa0b5;margin-right:6px}
.card.alta{border-color:#d32f2f;background:#fdeceb}.card.alta .sev{background:#d32f2f}.card.média{border-color:#f59e0b;background:#fff7e6}.card.média .sev{background:#f59e0b}
.card.baixa{border-color:#2b6fd6;background:#eef4ff}.card.baixa .sev{background:#2b6fd6}.card.info{border-color:#8aa0b5}
.card .evid{font-size:12px;color:#33414f}.card b.t{font-size:11px;color:#5b6b7c;text-transform:uppercase}
.ok{color:#1b7f4b}.nao{color:#7f8ea0}
@media print{nav{display:none}body{background:#fff}main{padding:0}section{border:0;padding:0 4px}.card{page-break-inside:avoid}}`;

/** Monta a página HTML completa a partir das seções (cada uma criada com sec()). */
function page({ title, subtitle, sections }) {
  const nav = sections.map((p) => p.match(/<section id="([^"]+)"><h2>([^<]+)/)).filter(Boolean).map((m) => `<a href="#${m[1]}">${m[2]}</a>`).join('');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${CSS}</style></head><body>` +
    `<header><h1>${esc(title)}</h1><p>${subtitle}</p></header><nav>${nav}</nav><main>${sections.join('\n')}</main></body></html>`;
}

module.exports = { runPS, arr, esc, table, list, kpi, sec, page };
