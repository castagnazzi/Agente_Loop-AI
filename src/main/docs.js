// Documentos Office/PDF: leitura (pdf, docx, xlsx, pptx → texto) e criação (docx, xlsx, pptx, pdf).
// Bibliotecas JavaScript puras: funcionam offline e portáteis (sem Word/Excel/LibreOffice). O PDF é gerado pelo Chromium do Electron.
const fs = require('fs');
const path = require('path');

const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const decode = (t) => t.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

// ================================================================= LEITURA
async function lerPdf(file, opts = {}) {
  const pdfParse = require('pdf-parse/lib/pdf-parse.js');
  let n = 0;
  const pagerender = (pageData) => pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false }).then((tc) => {
    let last = null, lastEnd = 0, text = '';
    for (const it of tc.items) {
      const y = it.transform[5], x = it.transform[4];
      if (last === null) text += it.str;
      else if (last === y) text += (x - lastEnd > 1.5 && !/\s$/.test(text) && !/^\s/.test(it.str) ? '  ' : '') + it.str; // colunas/células separadas
      else text += '\n' + it.str;
      last = y; lastEnd = x + (it.width || 0);
    }
    return `\n\n=== Página ${++n} ===\n${text}`;
  });
  const data = await pdfParse(fs.readFileSync(file), { pagerender });
  let texto = data.text.trim();
  const semTexto = texto.replace(/=== Página \d+ ===/g, '').trim().length < 20;
  let meta = `PDF · ${data.numpages} página(s)${data.info?.Title ? ` · título: ${data.info.Title}` : ''}`;
  if (semTexto || opts.ocr) { // PDF digitalizado (ou OCR pedido): lê as páginas como imagem
    try {
      const o = await require('./ocr').ocrPdf(file, { paginas: opts.paginas, maxPaginas: opts.max_paginas_ocr || 15, signal: opts.signal });
      texto = o.texto;
      meta += ` · OCR em ${o.feitas.length} de ${o.total} página(s)`;
      if (o.feitas.length < o.total && !opts.paginas) texto += `\n\n…[OCR feito só nas páginas ${o.feitas[0]}–${o.feitas[o.feitas.length - 1]}; para continuar use paginas="${o.feitas[o.feitas.length - 1] + 1}-${Math.min(o.total, o.feitas[o.feitas.length - 1] + 15)}"]`;
      if (!texto.replace(/=== Página \d+ ===/g, '').trim()) texto = '(OCR não encontrou texto legível nas páginas processadas.)';
    } catch (e) {
      if (semTexto) texto = `(Este PDF não tem texto selecionável (é digitalizado) e o OCR falhou: ${e.message})`;
      else meta += ` · OCR falhou: ${e.message}`;
    }
  }
  return { meta, texto };
}

const strip = (h) => decode(h.replace(/<strong>([\s\S]*?)<\/strong>/g, '**$1**').replace(/<em>([\s\S]*?)<\/em>/g, '*$1*').replace(/<br\s*\/?>/g, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
function htmlToMd(h) {
  h = h.replace(/<table[\s\S]*?<\/table>/g, (t) => {
    const rows = [...t.matchAll(/<tr[\s\S]*?<\/tr>/g)].map((r) => '| ' + [...r[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => strip(c[1])).join(' | ') + ' |');
    if (rows.length > 1) rows.splice(1, 0, '| ' + rows[0].split('|').slice(1, -1).map(() => '---').join(' | ') + ' |');
    return '\n' + rows.join('\n') + '\n';
  });
  h = h.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g, (m, l, t) => `\n\n${'#'.repeat(Number(l))} ${strip(t)}\n`);
  const inl = (t) => decode(t.replace(/<strong>([\s\S]*?)<\/strong>/g, '**$1**').replace(/<em>([\s\S]*?)<\/em>/g, '*$1*').replace(/<[^>]+>/g, ''));
  const stack = []; let out = '';
  for (const part of h.split(/(<\/?(?:ul|ol|li|p)(?:\s[^>]*)?>|<br\s*\/?>)/)) {
    if (/^<ul/.test(part)) stack.push({ ordered: false, n: 0 });
    else if (/^<ol/.test(part)) stack.push({ ordered: true, n: 0 });
    else if (/^<\/(ul|ol)/.test(part)) { stack.pop(); out += '\n'; }
    else if (/^<li/.test(part)) { const top = stack[stack.length - 1] || { ordered: false, n: 0 }; top.n++; out += '\n' + '  '.repeat(Math.max(0, stack.length - 1)) + (top.ordered ? `${top.n}. ` : '- '); }
    else if (/^<\/p/.test(part)) out += stack.length ? '' : '\n\n';
    else if (/^<br/.test(part)) out += '\n';
    else if (!/^<\/?(li|p)/.test(part)) out += inl(part);
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}
async function lerDocx(file) {
  const mammoth = require('mammoth');
  const r = await mammoth.convertToHtml({ path: file });
  return { meta: 'Word (.docx)' + (r.messages.length ? ` · ${r.messages.length} aviso(s) de conversão` : ''), texto: htmlToMd(r.value) };
}

const cellText = (v) => {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (v.formula !== undefined || v.sharedFormula !== undefined) return v.result !== undefined && v.result !== null ? cellText(v.result) : `=${v.formula || ''}`;
    if (v.richText) return v.richText.map((x) => x.text).join('');
    if (v.text !== undefined) return cellText(v.text);
    if (v.error) return String(v.error);
    return JSON.stringify(v);
  }
  return String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
};
async function lerXlsx(file, { linhas = 200 } = {}) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  if (/\.csv$/i.test(file)) await wb.csv.readFile(file); else await wb.xlsx.readFile(file);
  const out = [];
  wb.eachSheet((ws) => {
    const total = ws.actualRowCount, cols = ws.actualColumnCount;
    out.push(`## Planilha: ${ws.name} (${total} linha(s) × ${cols} coluna(s))`);
    let n = 0;
    ws.eachRow({ includeEmpty: false }, (row, i) => {
      if (n >= linhas) return;
      const cells = []; for (let c = 1; c <= cols; c++) cells.push(cellText(row.getCell(c).value));
      out.push(`| ${cells.join(' | ')} |`);
      if (n === 0) out.push(`| ${cells.map(() => '---').join(' | ')} |`);
      n++;
    });
    if (total > linhas) out.push(`… (mostrando ${linhas} de ${total} linhas; use o parâmetro "linhas" para ver mais)`);
    out.push('');
  });
  return { meta: `${/\.csv$/i.test(file) ? 'CSV' : 'Excel'} · ${wb.worksheets.length} planilha(s)`, texto: out.join('\n').trim() };
}

async function lerPptx(file) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const num = (n) => Number(/(\d+)\.xml$/.exec(n)[1]);
  const names = (re) => Object.keys(zip.files).filter((n) => re.test(n)).sort((a, b) => num(a) - num(b));
  const textOf = async (n) => {
    const x = await zip.file(n).async('string');
    return [...x.matchAll(/<a:p[ >][\s\S]*?<\/a:p>/g)].map((p) => decode([...p[0].matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map((t) => t[1]).join(''))).filter((t) => t.trim()).join('\n');
  };
  const slides = names(/^ppt\/slides\/slide\d+\.xml$/), notas = names(/^ppt\/notesSlides\/notesSlide\d+\.xml$/);
  const notaDe = new Map();
  for (const n of notas) { // a nota aponta para o slide pelo arquivo de relações
    const rel = zip.file(n.replace('notesSlides/', 'notesSlides/_rels/') + '.rels');
    const m = rel && /slides\/slide(\d+)\.xml/.exec(await rel.async('string'));
    if (m) notaDe.set(Number(m[1]), await textOf(n));
  }
  const out = [];
  for (const s of slides) {
    const i = num(s);
    const corpo = (await textOf(s)).split('\n'); if (corpo.length > 1 && corpo[corpo.length - 1].trim() === String(i)) corpo.pop(); // remove o número do slide
    out.push(`=== Slide ${i} ===\n${corpo.join('\n')}`);
    const nota = (notaDe.get(i) || '').replace(/^\d+$/gm, '').trim(); // remove o número do slide que vem na nota
    if (nota) out.push(`[Notas do apresentador] ${nota}`);
  }
  return { meta: `PowerPoint · ${slides.length} slide(s)`, texto: out.join('\n\n') };
}

/** Lê um documento e devolve { meta, texto } (já paginado por `inicio`/`max_chars`). */
async function ler(file, opts = {}) {
  const { inicio = 0, max_chars = 30000, linhas = 200 } = opts;
  if (!fs.existsSync(file)) throw new Error(`arquivo não encontrado: ${file}`);
  const ext = path.extname(file).toLowerCase();
  let r;
  if (ext === '.pdf') r = await lerPdf(file, opts);
  else if (require('./ocr').IMAGENS.has(ext)) { const t = await require('./ocr').ocrImagem(file); r = { meta: `imagem (${ext.slice(1)}) · texto por OCR`, texto: t || '(OCR não encontrou texto legível na imagem.)' }; }
  else if (ext === '.docx') r = await lerDocx(file);
  else if (['.xlsx', '.xlsm', '.csv'].includes(ext)) r = await lerXlsx(file, { linhas });
  else if (ext === '.pptx') r = await lerPptx(file);
  else if (['.doc', '.xls', '.ppt'].includes(ext)) throw new Error(`formato antigo (${ext}) não é suportado. Abra no Office/LibreOffice e salve como ${ext}x (docx/xlsx/pptx) ou PDF.`);
  else r = { meta: `texto (${ext || 'sem extensão'})`, texto: fs.readFileSync(file, 'utf8') };
  const total = r.texto.length, ini = Math.max(0, Number(inicio) || 0), lim = Math.max(1000, Math.min(200000, Number(max_chars) || 30000));
  const trecho = r.texto.slice(ini, ini + lim);
  const resto = total - (ini + trecho.length);
  return `${path.basename(file)} — ${r.meta} — ${total} caracteres\n\n${trecho}` + (resto > 0 ? `\n\n…[faltam ${resto} caracteres; chame de novo com inicio=${ini + trecho.length}]` : '');
}

// ================================================================= CRIAÇÃO
// Markdown simples → blocos. Suporta #, listas (-, 1.), tabelas |a|b|, blocos de código, --- e negrito/itálico/código em linha.
function parseMd(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const blocks = [];
  let para = [], i = 0;
  const flush = () => { if (para.length) { blocks.push({ t: 'p', text: para.join(' ') }); para = []; } };
  while (i < lines.length) {
    const ln = lines[i];
    let m;
    if (/^\s*```/.test(ln)) { flush(); const code = []; i++; while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]); i++; blocks.push({ t: 'code', text: code.join('\n') }); continue; }
    if ((m = /^(#{1,6})\s+(.*)$/.exec(ln))) { flush(); blocks.push({ t: 'h', level: m[1].length, text: m[2].trim() }); i++; continue; }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(ln)) { flush(); blocks.push({ t: 'hr' }); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(ln)) {
      flush(); const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()); if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells); i++; }
      blocks.push({ t: 'table', rows }); continue;
    }
    if ((m = /^(\s*)[-*•]\s+(.*)$/.exec(ln))) { flush(); blocks.push({ t: 'li', ordered: false, level: m[1].length >= 2 ? 1 : 0, text: m[2] }); i++; continue; }
    if ((m = /^(\s*)\d+[.)]\s+(.*)$/.exec(ln))) { flush(); blocks.push({ t: 'li', ordered: true, level: m[1].length >= 2 ? 1 : 0, text: m[2] }); i++; continue; }
    if (!ln.trim()) { flush(); i++; continue; }
    para.push(ln.trim()); i++;
  }
  flush();
  return blocks;
}
const inline = (s) => String(s).split(/(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`)/).filter(Boolean).map((p) => (
  /^\*\*[^*]+\*\*$/.test(p) ? { text: p.slice(2, -2), bold: true } : /^\*[^*]+\*$/.test(p) ? { text: p.slice(1, -1), italics: true } : /^`[^`]+`$/.test(p) ? { text: p.slice(1, -1), code: true } : { text: p }));

async function criarDocx(texto, titulo) {
  const D = require('docx');
  const runs = (s, extra = {}) => inline(s).map((r) => new D.TextRun({ text: r.text, bold: r.bold || extra.bold, italics: r.italics, font: r.code ? 'Consolas' : undefined, ...extra }));
  const H = [D.HeadingLevel.HEADING_1, D.HeadingLevel.HEADING_1, D.HeadingLevel.HEADING_2, D.HeadingLevel.HEADING_3, D.HeadingLevel.HEADING_4, D.HeadingLevel.HEADING_5, D.HeadingLevel.HEADING_6];
  const children = [];
  let inst = 0, prev = null;
  for (const b of parseMd(texto)) {
    if (b.t !== 'li' || !b.ordered) prev = b.t === 'li' ? prev : null;
    if (b.t === 'h') children.push(new D.Paragraph({ heading: H[b.level], children: runs(b.text), spacing: { before: 240, after: 80 } }));
    else if (b.t === 'p') children.push(new D.Paragraph({ children: runs(b.text), spacing: { after: 120 } }));
    else if (b.t === 'li') {
      if (b.ordered) { if (prev !== 'ol') inst++; prev = 'ol'; } else prev = 'ul';
      children.push(new D.Paragraph({ children: runs(b.text), spacing: { after: 40 }, ...(b.ordered ? { numbering: { reference: 'num', level: b.level, instance: inst } } : { bullet: { level: b.level } }) }));
    } else if (b.t === 'code') b.text.split('\n').forEach((l) => children.push(new D.Paragraph({ children: [new D.TextRun({ text: l || ' ', font: 'Consolas', size: 20 })], shading: { type: D.ShadingType.CLEAR, fill: 'F2F2F2' } })));
    else if (b.t === 'hr') children.push(new D.Paragraph({ border: { bottom: { style: D.BorderStyle.SINGLE, size: 6, color: 'AAAAAA', space: 1 } }, spacing: { after: 120 } }));
    else if (b.t === 'table') {
      const cols = Math.max(...b.rows.map((r) => r.length));
      children.push(new D.Table({
        width: { size: 100, type: D.WidthType.PERCENTAGE },
        rows: b.rows.map((r, ri) => new D.TableRow({ tableHeader: ri === 0, children: Array.from({ length: cols }, (_, ci) => new D.TableCell({
          width: { size: 100 / cols, type: D.WidthType.PERCENTAGE },
          shading: ri === 0 ? { type: D.ShadingType.CLEAR, fill: 'D9E2F3' } : undefined,
          margins: { top: 40, bottom: 40, left: 80, right: 80 },
          children: [new D.Paragraph({ children: runs(r[ci] ?? '', ri === 0 ? { bold: true } : {}) })],
        })) })),
      }));
      children.push(new D.Paragraph({ text: '' }));
    }
  }
  const doc = new D.Document({
    title: titulo, creator: 'Loop-AI',
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    numbering: { config: [{ reference: 'num', levels: [0, 1].map((level) => ({ level, format: D.LevelFormat.DECIMAL, text: `%${level + 1}.`, alignment: D.AlignmentType.LEFT, style: { paragraph: { indent: { left: 720 + level * 360, hanging: 360 } } } })) }] },
    sections: [{ properties: { page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } }, children }],
  });
  return D.Packer.toBuffer(doc);
}

async function criarXlsx(planilhas) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook(); wb.creator = 'Loop-AI'; wb.created = new Date(); wb.calcProperties = { fullCalcOnLoad: true }; // fórmulas são calculadas ao abrir no Excel
  const lista = Array.isArray(planilhas) && planilhas.length ? planilhas : [];
  if (!lista.length) throw new Error('informe "planilhas": [{ nome, colunas: [...], linhas: [[...]] }]');
  const usados = new Set();
  lista.forEach((p, idx) => {
    let nome = String(p.nome || `Planilha${idx + 1}`).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || `Planilha${idx + 1}`, n = 2;
    while (usados.has(nome.toLowerCase())) nome = `${nome.slice(0, 28)}_${n++}`;
    usados.add(nome.toLowerCase());
    const ws = wb.addWorksheet(nome, { views: [{ state: 'frozen', ySplit: p.colunas?.length ? 1 : 0 }] });
    const cols = Array.isArray(p.colunas) ? p.colunas : [];
    const linhas = Array.isArray(p.linhas) ? p.linhas : [];
    if (cols.length) {
      const h = ws.addRow(cols);
      h.font = { bold: true, color: { argb: 'FFFFFFFF' } }; h.alignment = { vertical: 'middle' };
      h.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F5496' } }; });
    }
    for (const l of linhas) ws.addRow((Array.isArray(l) ? l : [l]).map((v) => (typeof v === 'string' && /^=.+/.test(v) ? { formula: v.slice(1) } : v)));
    const width = Math.max(cols.length, ...linhas.map((l) => (Array.isArray(l) ? l.length : 1)), 1);
    for (let c = 1; c <= width; c++) {
      let w = String(cols[c - 1] ?? '').length;
      for (const l of linhas.slice(0, 500)) { const v = Array.isArray(l) ? l[c - 1] : c === 1 ? l : ''; w = Math.max(w, String(v ?? '').length); }
      ws.getColumn(c).width = Math.min(60, Math.max(8, w + 2));
    }
    if (cols.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: width } };
  });
  return wb.xlsx.writeBuffer();
}

async function criarPptx(slides, titulo) {
  const Pptx = require('pptxgenjs');
  if (!Array.isArray(slides) || !slides.length) throw new Error('informe "slides": [{ titulo, topicos: [...], notas?, tabela?: [[...]] }]');
  const p = new Pptx(); p.layout = 'LAYOUT_WIDE'; p.author = 'Loop-AI'; p.title = titulo;
  const COR = '1F3864', TXT = '222222';
  slides.forEach((s, idx) => {
    const sl = p.addSlide();
    const capa = idx === 0 && !(s.topicos?.length || s.tabela?.length);
    if (capa) {
      sl.background = { color: COR };
      sl.addText(String(s.titulo || titulo || ''), { x: 0.8, y: 2.3, w: 11.7, h: 1.5, fontSize: 40, bold: true, color: 'FFFFFF', fontFace: 'Calibri', fit: 'shrink' });
      if (s.subtitulo) sl.addText(String(s.subtitulo), { x: 0.8, y: 3.9, w: 11.7, h: 1, fontSize: 22, color: 'C9D6EE', fontFace: 'Calibri', fit: 'shrink' });
    } else {
      sl.addShape(p.ShapeType.rect, { x: 0, y: 0, w: 13.33, h: 1.1, fill: { color: COR }, line: { color: COR } });
      sl.addText(String(s.titulo || ''), { x: 0.5, y: 0.1, w: 12.3, h: 0.9, fontSize: 28, bold: true, color: 'FFFFFF', fontFace: 'Calibri', fit: 'shrink' });
      const tem = s.topicos?.length, tab = s.tabela?.length;
      if (tem) {
        const itens = s.topicos.map((t) => { const sub = /^\s{2,}|^\t/.test(String(t)); return { text: String(t).trim(), options: { bullet: true, indentLevel: sub ? 1 : 0, breakLine: true } }; });
        sl.addText(itens, { x: 0.6, y: 1.4, w: tab ? 6 : 12.1, h: 5.5, fontSize: itens.length > 8 ? 18 : 22, color: TXT, fontFace: 'Calibri', valign: 'top', fit: 'shrink', paraSpaceAfter: 8 });
      }
      if (tab) {
        const rows = s.tabela.map((r, ri) => r.map((c) => ({ text: String(c ?? ''), options: { bold: ri === 0, color: ri === 0 ? 'FFFFFF' : TXT, fill: { color: ri === 0 ? '2F5496' : ri % 2 ? 'F2F5FA' : 'FFFFFF' } } })));
        sl.addTable(rows, { x: tem ? 6.9 : 0.6, y: 1.5, w: tem ? 5.9 : 12.1, fontSize: 14, fontFace: 'Calibri', border: { type: 'solid', color: 'BFC8D8', pt: 0.5 }, autoPage: false });
      }
      sl.addText(`${idx + 1}`, { x: 12.4, y: 7.0, w: 0.6, h: 0.3, fontSize: 11, color: '888888', align: 'right' });
    }
    if (s.notas) sl.addNotes(String(s.notas));
  });
  return p.write({ outputType: 'nodebuffer' });
}

const CSS_PDF = `body{font:11pt/1.5 "Segoe UI",Calibri,Arial,sans-serif;color:#1b2430;margin:0}h1{font-size:22pt;color:#1F3864;border-bottom:2px solid #2F5496;padding-bottom:4px;margin:18px 0 10px}h2{font-size:16pt;color:#1F3864;margin:16px 0 6px}h3{font-size:13pt;color:#2F5496;margin:12px 0 4px}h4,h5,h6{font-size:11pt;margin:10px 0 4px}
p{margin:6px 0}ul,ol{margin:6px 0;padding-left:24px}li{margin:2px 0}table{border-collapse:collapse;width:100%;margin:10px 0;font-size:10pt}th{background:#D9E2F3;text-align:left}th,td{border:1px solid #b9c3d3;padding:5px 8px;vertical-align:top}
pre{background:#f2f2f2;padding:8px 10px;border-radius:4px;font:9.5pt Consolas,monospace;white-space:pre-wrap}code{font-family:Consolas,monospace;background:#f2f2f2;padding:0 3px}hr{border:0;border-top:1px solid #bbb;margin:14px 0}tr,pre,h1,h2,h3{break-inside:avoid}`;
function mdToHtml(texto, titulo) {
  const il = (s) => inline(s).map((r) => (r.bold ? `<b>${esc(r.text)}</b>` : r.italics ? `<i>${esc(r.text)}</i>` : r.code ? `<code>${esc(r.text)}</code>` : esc(r.text))).join('');
  const out = []; let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const b of parseMd(texto)) {
    if (b.t !== 'li') close();
    if (b.t === 'h') out.push(`<h${b.level}>${il(b.text)}</h${b.level}>`);
    else if (b.t === 'p') out.push(`<p>${il(b.text)}</p>`);
    else if (b.t === 'li') { const tag = b.ordered ? 'ol' : 'ul'; if (list !== tag) { close(); out.push(`<${tag}>`); list = tag; } out.push(`<li${b.level ? ' style="margin-left:18px"' : ''}>${il(b.text)}</li>`); }
    else if (b.t === 'code') out.push(`<pre>${esc(b.text)}</pre>`);
    else if (b.t === 'hr') out.push('<hr>');
    else if (b.t === 'table') out.push('<table>' + b.rows.map((r, ri) => `<tr>${r.map((c) => `<${ri ? 'td' : 'th'}>${il(c)}</${ri ? 'td' : 'th'}>`).join('')}</tr>`).join('') + '</table>');
  }
  close();
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${esc(titulo)}</title><style>${CSS_PDF}</style></head><body>${out.join('\n')}</body></html>`;
}
async function criarPdf(texto, titulo) {
  let electron = null;
  try { electron = require('electron'); } catch { /* fora do Electron */ }
  if (!electron || !electron.BrowserWindow) throw new Error('gerar PDF só funciona dentro do app Loop-AI (usa o Chromium do Electron). Gere um .docx ou HTML neste contexto.');
  const win = new electron.BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(mdToHtml(texto, titulo)));
    return await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { top: 0.7, bottom: 0.7, left: 0.7, right: 0.7 } });
  } finally { win.destroy(); }
}

const FORMATOS = { docx: '.docx', xlsx: '.xlsx', pptx: '.pptx', pdf: '.pdf' };
/** Cria o arquivo em `dir` e retorna o caminho. a: { formato, nome, texto, planilhas, slides, titulo } */
async function criar(a, dir) {
  const formato = String(a.formato || '').toLowerCase().replace(/^\./, '');
  if (!FORMATOS[formato]) throw new Error(`formato inválido "${a.formato}". Use: docx, xlsx, pptx ou pdf.`);
  const base = String(a.nome || a.titulo || 'documento').normalize('NFC').replace(/\.[A-Za-z0-9]{2,4}$/, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').trim().slice(0, 80) || 'documento';
  const titulo = String(a.titulo || base);
  let buf;
  if (formato === 'docx') { if (!a.texto) throw new Error('informe "texto" (Markdown) para docx'); buf = await criarDocx(a.texto, titulo); }
  else if (formato === 'pdf') { if (!a.texto) throw new Error('informe "texto" (Markdown) para pdf'); buf = await criarPdf(a.texto, titulo); }
  else if (formato === 'xlsx') buf = await criarXlsx(a.planilhas);
  else buf = await criarPptx(a.slides, titulo);
  fs.mkdirSync(dir, { recursive: true });
  let file = path.join(dir, base + FORMATOS[formato]), n = 2;
  while (fs.existsSync(file)) file = path.join(dir, `${base}-${n++}${FORMATOS[formato]}`);
  fs.writeFileSync(file, Buffer.from(buf));
  return file;
}

module.exports = { ler, criar, parseMd, mdToHtml };
