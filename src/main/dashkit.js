// Kit de dashboard HTML (offline, sem CDN): barra lateral por grupos, KPIs, gráficos em SVG/CSS, tabelas com busca e ordenação,
// remoção de seções, impressão/PDF. Usado pelo relatório de uso.
const { arr, esc } = require('./reportkit');

const PAL = ['#4361ee', '#4cc9f0', '#06d6a0', '#f72585', '#ffd166', '#ef476f', '#7209b7', '#4895ef', '#f3722c', '#90be6d', '#43aa8b', '#f8961e'];
const n = (v) => Number(v || 0).toLocaleString('pt-BR');

// ------------------------------------------------------------------ gráficos
function line(labels, values, { h = 220 } = {}) {
  if (!labels.length) return '<p class="no-data">Sem dados no período.</p>';
  const W = 640, H = h, L = 38, R = 10, T = 12, B = 26, max = Math.max(...values, 1);
  const x = (i) => L + (labels.length === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (labels.length - 1));
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => { const yy = y(max * f); return `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" class="gl"/><text x="${L - 5}" y="${yy + 3}" class="ax" text-anchor="end">${Math.round(max * f)}</text>`; }).join('');
  const step = Math.ceil(labels.length / 9);
  const xl = labels.map((l, i) => (i % step === 0 ? `<text x="${x(i)}" y="${H - 8}" class="ax" text-anchor="middle">${esc(l)}</text>` : '')).join('');
  const dots = values.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="3.2" fill="#4cc9f0"><title>${esc(labels[i])}: ${n(v)}</title></circle>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="svg">${grid}${xl}<polygon points="${L},${H - B} ${pts.join(' ')} ${x(labels.length - 1)},${H - B}" fill="rgba(67,97,238,.12)"/>` +
    `<polyline points="${pts.join(' ')}" fill="none" stroke="#4361ee" stroke-width="2.2" stroke-linejoin="round"/>${dots}</svg>`;
}

function columns(labels, values, { h = 220, every = 3 } = {}) {
  const W = 640, H = h, L = 38, R = 8, T = 12, B = 26, max = Math.max(...values, 1), bw = (W - L - R) / labels.length;
  const grid = [0, 0.5, 1].map((f) => { const yy = T + (H - T - B) * (1 - f); return `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" class="gl"/><text x="${L - 5}" y="${yy + 3}" class="ax" text-anchor="end">${Math.round(max * f)}</text>`; }).join('');
  const bars = values.map((v, i) => {
    const bh = (H - T - B) * (v / max);
    return `<rect x="${L + i * bw + 2}" y="${T + (H - T - B) - bh}" width="${Math.max(bw - 4, 2)}" height="${bh}" rx="3" fill="rgba(67,97,238,${(0.3 + 0.7 * (v / max)).toFixed(2)})"><title>${esc(labels[i])}: ${n(v)}</title></rect>` +
      (i % every === 0 ? `<text x="${L + i * bw + bw / 2}" y="${H - 8}" class="ax" text-anchor="middle">${esc(labels[i])}</text>` : '');
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="svg">${grid}${bars}</svg>`;
}

function hbars(items, { fmt = n } = {}) {
  if (!items.length) return '<p class="no-data">Sem dados no período.</p>';
  const max = Math.max(...items.map((i) => i.v), 1);
  return `<div class="hb">${items.map((i, k) => `<div class="hb-r" title="${esc(i.l)}: ${fmt(i.v)}"><span class="hb-l">${esc(i.l)}</span>` +
    `<span class="hb-t"><i style="width:${Math.max((i.v / max) * 100, 1.5).toFixed(1)}%;background:${PAL[k % PAL.length]}"></i></span><b>${fmt(i.v)}</b></div>`).join('')}</div>`;
}

function donut(items, { label = 'visitas' } = {}) {
  const tot = items.reduce((s, i) => s + i.v, 0);
  if (!tot) return '<p class="no-data">Sem dados no período.</p>';
  const r = 52, c = 2 * Math.PI * r;
  let off = 0;
  const seg = items.map((i, k) => {
    const len = (i.v / tot) * c, s = `<circle cx="70" cy="70" r="${r}" fill="none" stroke="${i.c || PAL[k % PAL.length]}" stroke-width="22" stroke-dasharray="${len.toFixed(2)} ${(c - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 70 70)"><title>${esc(i.l)}: ${n(i.v)}</title></circle>`;
    off += len; return s;
  }).join('');
  return `<div class="donut"><svg viewBox="0 0 140 140" width="150" height="150">${seg}<text x="70" y="68" text-anchor="middle" class="dn">${n(tot)}</text><text x="70" y="84" text-anchor="middle" class="ax">${esc(label)}</text></svg>` +
    `<ul class="lg">${items.map((i, k) => `<li><i style="background:${i.c || PAL[k % PAL.length]}"></i>${esc(i.l)} <b>${n(i.v)}</b> <small>${Math.round((i.v / tot) * 100)}%</small></li>`).join('')}</ul></div>`;
}

function disks(vols) {
  if (!vols.length) return '<p class="no-data">Sem dados.</p>';
  return vols.map((d) => {
    const p = d.totalGB ? Math.round((d.usadoGB / d.totalGB) * 100) : 0;
    return `<div class="disk"><div class="disk-h"><b>${esc(d.letra)}</b> ${esc(d.nome || '')}<span>${n(d.usadoGB)} GB usados de ${n(d.totalGB)} GB · ${n(d.livreGB)} GB livres (${p}%)</span></div>` +
      `<div class="prog"><i style="width:${p}%;background:${p > 90 ? '#ef476f' : p > 75 ? '#ffd166' : '#06d6a0'}"></i></div></div>`;
  }).join('');
}

function timeline(items) {
  if (!items.length) return '<p class="no-data">Sem eventos no período.</p>';
  return `<div class="tl">${items.map((e) => `<div class="tl-i ${e.cls}"><span>${e.ico}</span><b>${esc(e.rot)}</b><time>${esc(e.quando)}</time></div>`).join('')}</div>`;
}

// ------------------------------------------------------------------ blocos
const kpi = (ico, v, l) => `<div class="kpi-card"><div class="kpi-ico">${ico}</div><div class="kpi-val">${esc(typeof v === 'number' ? n(v) : v)}</div><div class="kpi-lbl">${esc(l)}</div></div>`;
const card = (title, html, cls = '') => `<div class="chart-card ${cls}"><div class="chart-title">${title}</div>${html}</div>`;
const info = (pairs) => `<div class="info-grid">${pairs.filter((p) => p[1] !== undefined && p[1] !== '').map(([l, v]) => `<div class="info-item"><div class="info-lbl">${esc(l)}</div><div class="info-val">${esc(v)}</div></div>`).join('')}</div>`;

let tseq = 0;
/** Tabela com busca e ordenação. cols: [chave, rótulo, formatador(linha) → HTML já escapado (opcional)]. */
function dtable(cols, rows, { max = 1500, placeholder = 'Pesquisar…' } = {}) {
  rows = arr(rows);
  if (!rows.length) return '<p class="no-data">Nenhum registro encontrado.</p>';
  const id = `t${++tseq}`;
  const shown = rows.slice(0, max);
  const head = cols.map((c, i) => `<th onclick="srt('${id}',${i})">${esc(c[1])} <small>↕</small></th>`).join('');
  const body = shown.map((r) => `<tr>${cols.map((c) => `<td>${c[2] ? c[2](r) : esc(typeof r === 'object' ? r[c[0]] : r)}</td>`).join('')}</tr>`).join('');
  return `<div class="tbl-wrap"><div class="tbl-toolbar"><input class="search-box" placeholder="🔍 ${esc(placeholder)}" oninput="ft('${id}',this.value)">` +
    `<span class="rec-count" id="c-${id}">${n(shown.length)} registros${rows.length > max ? ` (de ${n(rows.length)}; o restante está no .json)` : ''}</span></div>` +
    `<div class="scr"><table class="dtbl" id="${id}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div></div>`;
}

const SECTION_ICON_DEFAULT = '📄';
/** Seção do dashboard. */
const section = (id, ico, title, sub, html) =>
  `<section class="section" id="${id}"><div class="sec-header"><div class="sec-icon">${ico || SECTION_ICON_DEFAULT}</div><div><div class="sec-title">${esc(title)}</div>` +
  `<div class="sec-sub">${sub || ''}</div></div></div>${html}</section>`;

// ------------------------------------------------------------------ página
const CSS = `
:root{--bg:#0d1117;--bg2:#161b22;--bg3:#21262d;--border:#30363d;--primary:#4361ee;--primary2:#4cc9f0;--secondary:#3a0ca3;--success:#06d6a0;--danger:#ef476f;--warning:#ffd166;--info:#4cc9f0;--text:#e6edf3;--text2:#8b949e}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
#sidebar{position:fixed;left:0;top:0;width:240px;height:100vh;background:var(--bg2);border-right:1px solid var(--border);overflow-y:auto;z-index:900;display:flex;flex-direction:column}
.sb-logo{padding:16px 20px;border-bottom:1px solid var(--border)}.sb-logo h1{font-size:1.1rem;font-weight:700;background:linear-gradient(90deg,var(--primary),var(--primary2));-webkit-background-clip:text;-webkit-text-fill-color:transparent}.sb-logo p{font-size:.7rem;color:var(--text2);margin-top:2px}
.sb-section{padding:12px 20px 4px;font-size:.65rem;text-transform:uppercase;letter-spacing:2px;color:var(--text2);font-weight:600}
.sb-link{display:flex;align-items:center;gap:10px;padding:8px 20px;color:var(--text2);text-decoration:none;font-size:.84rem;border-radius:6px;margin:1px 8px;transition:all .15s}
.sb-link:hover,.sb-link.active{color:var(--text);background:rgba(67,97,238,.15)}.sb-link.active{border-left:3px solid var(--primary);padding-left:17px}
.sb-meta{padding:16px 20px;font-size:.7rem;color:var(--text2);border-top:1px solid var(--border);margin-top:auto;line-height:1.7}
#topbar{position:fixed;left:240px;right:0;top:0;height:64px;background:var(--bg2);border-bottom:1px solid var(--border);z-index:899;display:flex;align-items:center;padding:0 28px;gap:16px}
.topbar-title{font-size:1rem;font-weight:600}.topbar-sub{font-size:.75rem;color:var(--text2)}.topbar-actions{margin-left:auto;display:flex;gap:8px}
.btn{background:linear-gradient(135deg,var(--primary),var(--secondary));color:#fff;border:none;padding:8px 16px;border-radius:8px;font-size:.8rem;cursor:pointer;transition:all .2s;white-space:nowrap}
.btn.sec{background:transparent;border:1px solid var(--border);color:var(--text2)}.btn.sec:hover{color:var(--text);border-color:var(--primary)}.btn:hover{transform:translateY(-2px)}
#main{margin-left:240px;padding:84px 28px 40px}
.section{scroll-margin-top:80px;margin-bottom:52px}
.sec-header{display:flex;align-items:center;gap:14px;margin-bottom:22px;padding-bottom:14px;border-bottom:2px solid rgba(67,97,238,.2)}
.sec-icon{width:44px;height:44px;border-radius:10px;background:linear-gradient(135deg,var(--primary),var(--secondary));display:flex;align-items:center;justify-content:center;font-size:1.4rem;flex-shrink:0}
.sec-title{font-size:1.3rem;font-weight:700}.sec-sub{font-size:.8rem;color:var(--text2)}
.sec-close{margin-left:auto;background:transparent;border:1px solid var(--border);color:var(--text2);width:28px;height:28px;border-radius:50%;cursor:pointer;opacity:.6;transition:all .18s}
.sec-close:hover{background:var(--danger);color:#fff;border-color:var(--danger);opacity:1}
.grid{display:grid;gap:14px;margin-bottom:16px}.g6{grid-template-columns:repeat(auto-fit,minmax(118px,1fr))}.g2{grid-template-columns:2fr 1fr}.g2e{grid-template-columns:1fr 1fr}.g3{grid-template-columns:repeat(3,1fr)}
@media(max-width:1100px){.g2,.g2e,.g3{grid-template-columns:1fr}}
.kpi-card{background:var(--bg2);border:1px solid var(--border);border-radius:14px;padding:18px;transition:all .2s}.kpi-card:hover{border-color:var(--primary);transform:translateY(-3px)}
.kpi-val{font-size:1.9rem;font-weight:700;background:linear-gradient(90deg,var(--primary),var(--primary2));-webkit-background-clip:text;-webkit-text-fill-color:transparent;line-height:1.1;word-break:break-word}
.kpi-lbl{font-size:.78rem;color:var(--text2);margin-top:4px}.kpi-ico{font-size:1.5rem;margin-bottom:6px}
.chart-card{background:var(--bg2);border:1px solid var(--border);border-radius:14px;padding:20px;min-width:0}.chart-title{font-size:.95rem;font-weight:600;margin-bottom:14px}
.svg{width:100%;height:auto}.gl{stroke:rgba(255,255,255,.07)}.ax{fill:#8b949e;font-size:10px}.dn{fill:#e6edf3;font-size:20px;font-weight:700}
.hb-r{display:flex;align-items:center;gap:10px;margin:7px 0;font-size:.8rem}.hb-l{width:34%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text2)}
.hb-t{flex:1;background:rgba(255,255,255,.06);border-radius:5px;height:12px;overflow:hidden}.hb-t i{display:block;height:100%;border-radius:5px}.hb-r b{min-width:42px;text-align:right}
.donut{display:flex;align-items:center;gap:18px;flex-wrap:wrap}.lg{list-style:none;font-size:.8rem}.lg li{margin:4px 0}.lg i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:7px}.lg small{color:var(--text2)}
.tbl-wrap{background:var(--bg2);border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:14px}
.tbl-toolbar{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--border);flex-wrap:wrap}
.search-box{background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:7px 14px;font-size:.85rem;flex:1;min-width:200px;max-width:420px}.search-box:focus{border-color:var(--primary);outline:none}
.rec-count{font-size:.75rem;color:var(--text2);background:var(--bg3);padding:4px 12px;border-radius:20px}
.scr{overflow:auto;max-height:560px}table.dtbl{width:100%;border-collapse:collapse}
table.dtbl thead th{position:sticky;top:0;background:#1b2340;color:var(--info);font-size:.72rem;text-transform:uppercase;letter-spacing:.8px;padding:10px 14px;text-align:left;white-space:nowrap;cursor:pointer;user-select:none}
table.dtbl tbody tr{border-bottom:1px solid rgba(255,255,255,.04)}table.dtbl tbody tr:hover{background:rgba(67,97,238,.08)}
table.dtbl tbody td{padding:8px 14px;font-size:.82rem;vertical-align:top;word-break:break-word;max-width:520px}
.h3{font-size:.8rem;text-transform:uppercase;letter-spacing:1px;color:var(--text2);margin:18px 0 8px}.no-data{padding:24px;text-align:center;color:var(--text2);font-size:.85rem}.mut{color:var(--text2)}.mono{font-family:Consolas,monospace;font-size:.78rem}
.badge{background:rgba(67,97,238,.15);color:var(--info);padding:2px 7px;border-radius:5px;font-size:.72rem;white-space:nowrap}
.ev{padding:3px 8px;border-radius:5px;font-size:.78rem;white-space:nowrap}.ev-on{background:rgba(6,214,160,.15);color:var(--success)}.ev-off{background:rgba(239,71,111,.15);color:var(--danger)}
.ev-warn{background:rgba(255,209,102,.15);color:var(--warning)}.ev-lock{background:rgba(76,201,240,.15);color:var(--info)}.ev-other{background:rgba(255,255,255,.08);color:var(--text2)}
.info-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}.info-item{background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:14px}
.info-lbl{font-size:.68rem;text-transform:uppercase;letter-spacing:1px;color:var(--text2);margin-bottom:4px}.info-val{font-size:.92rem;font-weight:500;word-break:break-word}
.disk{background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:10px}.disk-h{font-size:.85rem;margin-bottom:8px;display:flex;gap:8px;flex-wrap:wrap}.disk-h span{margin-left:auto;color:var(--text2);font-size:.75rem}
.prog{height:7px;background:rgba(255,255,255,.08);border-radius:10px;overflow:hidden}.prog i{display:block;height:100%;border-radius:10px}
.tl{max-height:300px;overflow-y:auto}.tl-i{display:flex;align-items:center;gap:12px;padding:8px 12px;border-left:3px solid;margin:4px 0;border-radius:0 8px 8px 0;font-size:.83rem}
.tl-i b{font-weight:500;min-width:110px}.tl-i time{margin-left:auto;color:var(--text2);font-size:.78rem}.tl-on{border-color:var(--success);background:rgba(6,214,160,.04)}.tl-off{border-color:var(--danger);background:rgba(239,71,111,.04)}.tl-crash{border-color:var(--warning);background:rgba(255,209,102,.05)}
.fd{background:var(--bg2);border:1px solid var(--border);border-left:5px solid #8b949e;border-radius:10px;padding:14px 18px;margin:12px 0;break-inside:avoid}
.fd.alta{border-left-color:#ef476f}.fd.média{border-left-color:#ffd166}.fd.baixa{border-left-color:#4cc9f0}
.fd h4{font-size:.98rem;margin-bottom:6px}.sev{font-size:.62rem;font-weight:700;text-transform:uppercase;padding:2px 8px;border-radius:10px;color:#0d1117;background:#8b949e;margin-right:8px;vertical-align:middle}
.fd.alta .sev{background:#ef476f;color:#fff}.fd.média .sev{background:#ffd166}.fd.baixa .sev{background:#4cc9f0}
.fd .t{display:block;font-size:.68rem;text-transform:uppercase;letter-spacing:1px;color:var(--text2);margin:10px 0 3px}.fd .evid{font-size:.85rem}
.section ul,.section ol{padding-left:22px;font-size:.85rem;line-height:1.6;margin:4px 0}.vazio{color:var(--text2);font-size:.85rem;margin:4px 0}.ok{color:var(--success);font-size:.85rem;margin:6px 0}.nao{color:var(--text2);font-size:.85rem;margin:6px 0}
.alert{background:rgba(255,209,102,.08);border:1px solid rgba(255,209,102,.3);border-radius:10px;padding:12px 16px;color:var(--warning);font-size:.85rem;margin-bottom:18px}
.alert.info{background:rgba(76,201,240,.07);border-color:rgba(76,201,240,.3);color:var(--info)}
::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-track{background:var(--bg2)}::-webkit-scrollbar-thumb{background:rgba(67,97,238,.4);border-radius:3px}
@media(max-width:800px){#sidebar{display:none}#topbar{left:0}#main{margin-left:0}}
@media print{
  :root{--bg:#fff;--bg2:#fff;--bg3:#f3f5f8;--border:#d5dbe3;--text:#1b2430;--text2:#5b6b7c;--info:#1e4fb8}
  #sidebar,#topbar,.sec-close,.search-box,.btn{display:none!important}#main{margin:0;padding:0}.section{page-break-inside:auto;margin-bottom:24px}
  .kpi-val,.sb-logo h1{-webkit-text-fill-color:#1e4fb8;background:none}.scr{max-height:none;overflow:visible}.tl{max-height:none}table.dtbl thead th{position:static;background:#eef2f7}
  .chart-card,.kpi-card,.disk{break-inside:avoid}.sec-icon{background:#1e4fb8}}`;

const JS = `
function ft(id,q){var t=document.getElementById(id),k=0;q=q.toLowerCase();t.querySelectorAll('tbody tr').forEach(function(r){var s=r.textContent.toLowerCase().indexOf(q)>=0;r.style.display=s?'':'none';if(s)k++});var c=document.getElementById('c-'+id);if(c)c.textContent=k.toLocaleString('pt-BR')+' registros'}
function dk(x){var m=/^(\\d\\d)\\/(\\d\\d)\\/(\\d{4})(.*)$/.exec(x);return m?m[3]+m[2]+m[1]+m[4]:x}
function srt(id,i){var t=document.getElementById(id),b=t.tBodies[0],d=t.dataset.d==='1'?-1:1;t.dataset.d=d===1?'1':'0';var rs=[].slice.call(b.rows);
rs.sort(function(a,c){var x=a.cells[i].textContent.trim(),y=c.cells[i].textContent.trim(),nx=parseFloat(x.replace(/\\./g,'').replace(',','.')),ny=parseFloat(y.replace(/\\./g,'').replace(',','.'));
if(!isNaN(nx)&&!isNaN(ny)&&/^[\\d.,\\s]+$/.test(x)&&/^[\\d.,\\s]+$/.test(y))return(nx-ny)*d;return dk(x).localeCompare(dk(y),'pt-BR')*d});rs.forEach(function(r){b.appendChild(r)})}
var secs=[].slice.call(document.querySelectorAll('.section'));
window.addEventListener('scroll',function(){var cur='';secs.forEach(function(s){if(s.isConnected&&window.scrollY>=s.offsetTop-130)cur=s.id});document.querySelectorAll('.sb-link').forEach(function(l){l.classList.toggle('active',l.getAttribute('href')==='#'+cur)})},{passive:true});
var KEY='loop_hidden_'+location.pathname;
function lerO(){try{return JSON.parse(localStorage.getItem(KEY)||'[]')}catch(e){return[]}}
function salvarO(a){try{localStorage.setItem(KEY,JSON.stringify(a))}catch(e){}}
function remover(id,ask){var s=document.getElementById(id);if(!s)return;
if(ask){var t=s.querySelector('.sec-title').textContent;if(!confirm('Remover a seção "'+t+'" do relatório?\\nA remoção fica salva neste navegador; use "Resetar" para restaurar.'))return;var a=lerO();if(a.indexOf(id)<0){a.push(id);salvarO(a)}}
var l=document.querySelector('.sb-link[href="#'+id+'"]');if(l)l.remove();s.remove()}
function resetar(){var a=lerO();if(!a.length){alert('Nada para restaurar.');return}if(confirm('Restaurar '+a.length+' seção(ões)?')){try{localStorage.removeItem(KEY)}catch(e){}location.reload()}}
function limpo(){var c=document.documentElement.cloneNode(true);c.setAttribute('data-limpo','1');c.querySelectorAll('.sec-close,.btn.sec').forEach(function(e){e.remove()});
var b=new Blob(['<!DOCTYPE html>\\n'+c.outerHTML],{type:'text/html;charset=utf-8'}),a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=(location.pathname.split('/').pop()||'relatorio').replace(/\\.html?$/i,'')+'_limpo.html';document.body.appendChild(a);a.click();a.remove()}
if(!document.documentElement.hasAttribute('data-limpo')){lerO().forEach(function(id){remover(id,false)});
document.querySelectorAll('.section').forEach(function(s){var h=s.querySelector('.sec-header'),b=document.createElement('button');b.className='sec-close';b.title='Remover esta seção';b.textContent='✕';b.onclick=function(){remover(s.id,true)};h.appendChild(b)})}`;

/** groups: [{ label, items: [{ id, ico, title, sub, html }] }] */
function page({ title, brand, tagline = 'Relatório de uso do PC', subtitle, meta, alerta, groups }) {
  const nav = groups.map((g) => `<div class="sb-section">${esc(g.label)}</div>` +
    g.items.map((i) => `<a class="sb-link" href="#${i.id}">${i.ico || ''} ${esc(i.nav || i.title)}</a>`).join('')).join('');
  const secs = groups.flatMap((g) => g.items).map((i) => section(i.id, i.ico, i.title, i.sub, i.html)).join('\n');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body>` +
    `<nav id="sidebar"><div class="sb-logo"><h1>🔁 ${esc(brand)}</h1><p>${esc(tagline)}</p></div>${nav}<div class="sb-meta">${arr(meta).map((m) => `<div>${esc(m)}</div>`).join('')}</div></nav>` +
    `<div id="topbar"><div><div class="topbar-title">${esc(title)}</div><div class="topbar-sub">${subtitle}</div></div><div class="topbar-actions">` +
    `<button class="btn sec" onclick="resetar()" title="Restaurar seções removidas">🔄 Resetar</button><button class="btn sec" onclick="limpo()" title="Baixar uma cópia sem as seções removidas">💾 Baixar limpo</button>` +
    `<button class="btn" onclick="window.print()">🖨️ Imprimir / PDF</button></div></div>` +
    `<main id="main">${alerta || ''}${secs}</main><script>${JS}</script></body></html>`;
}

module.exports = { PAL_SEV: { alta: '#ef476f', 'média': '#ffd166', baixa: '#4cc9f0' }, line, columns, hbars, donut, disks, timeline, kpi, card, info, dtable, page, n, PAL };
