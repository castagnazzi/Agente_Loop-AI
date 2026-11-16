const { app, shell, BrowserWindow, ipcMain, screen, Menu, Tray, dialog, nativeImage } = require('electron');
const path = require('path');
const settings = require('./settings');
const { dataDir, baseDir } = require('./paths');
const os = require('os');
const fs = require('fs');

app.setPath('userData', dataDir()); // tudo portátil: cache e configurações junto do app
const { Engine } = require('./engine');
const { listModels } = require('./llm');
const ext = require('./extensions');
const remote = require('./remote');
const sessions = require('./session');
const changes = require('./changes');
const audit = require('./audit');

const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');
const R = (...p) => path.join(__dirname, '..', 'renderer', ...p);
const ICON = path.join(__dirname, '..', 'assets', 'icon.png'); // o próprio boneco (gerado por scripts/make-icon.js)
const CHAT = { w: 560, h: 480, gap: 8 };

let cfg, pet, chat, settingsWin, tray, engine;
const pending = new Map(); // pedidos de permissão aguardando resposta

function baseWebPrefs() {
  return { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: false };
}

function createPet() {
  const size = cfg.petSize;
  const wa = screen.getPrimaryDisplay().workArea;
  const pos = cfg.petPos || { x: wa.x + wa.width - size - 40, y: wa.y + wa.height - size - 20 };
  pet = new BrowserWindow({
    x: pos.x, y: pos.y, width: size, height: size,
    frame: false, transparent: true, resizable: false, hasShadow: false,
    skipTaskbar: true, alwaysOnTop: cfg.alwaysOnTop, focusable: true, icon: ICON,
    webPreferences: baseWebPrefs(),
  });
  pet.setAlwaysOnTop(cfg.alwaysOnTop, 'screen-saver'); // fica acima de janelas fullscreen
  pet.setOpacity(cfg.petOpacity);
  pet.loadFile(R('pet', 'index.html'));
  pet.on('moved', () => { const [x, y] = pet.getPosition(); cfg.petPos = { x, y }; settings.save(cfg); });
  pet.on('closed', () => app.quit());
}

function createChat() {
  chat = new BrowserWindow({
    width: CHAT.w, height: CHAT.h, show: false,
    frame: false, transparent: true, resizable: true, hasShadow: false,
    skipTaskbar: true, alwaysOnTop: cfg.alwaysOnTop, minWidth: 380, minHeight: 320, icon: ICON,
    webPreferences: baseWebPrefs(),
  });
  chat.setAlwaysOnTop(cfg.alwaysOnTop, 'screen-saver');
  chat.setOpacity(cfg.chatOpacity);
  chat.loadFile(R('chat', 'index.html'));
}

// Posiciona o chat acima do pet, mantendo-o dentro da tela.
function placeChat() {
  const pb = pet.getBounds();
  const wa = screen.getDisplayMatching(pb).workArea;
  const [w, h] = chat.getSize();
  let x = pb.x + pb.width / 2 - w / 2;
  let y = pb.y - h - CHAT.gap;
  if (y < wa.y) y = pb.y + pb.height + CHAT.gap; // sem espaço acima: abre abaixo
  x = Math.max(wa.x, Math.min(x, wa.x + wa.width - w));
  chat.setPosition(Math.round(x), Math.round(y));
}

function toggleChat() {
  if (chat.isVisible()) return chat.hide();
  placeChat();
  chat.show();
  chat.focus();
}

function setSettingsZoom(z, salvar = true) {
  z = Math.round(Math.max(0.6, Math.min(1.6, z)) * 100) / 100;
  cfg.settingsZoom = z;
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.setZoomFactor(z);
    settingsWin.webContents.send('settings:zoom', z);
  }
  if (salvar) settings.save(cfg);
  return z;
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) return settingsWin.focus();
  // tamanho: usa o que o usuário deixou da última vez, limitado ao espaço livre da tela
  // (numa tela pequena, 620px fixo cortava o fim da aba Modelos sem dar nenhuma pista visual)
  const wa = screen.getPrimaryDisplay().workAreaSize;
  const saved = cfg.settingsWinSize || {};
  const width = Math.max(480, Math.min(saved.w || 800, wa.width - 40));
  const height = Math.max(420, Math.min(saved.h || 660, wa.height - 40));
  settingsWin = new BrowserWindow({
    width, height, minWidth: 480, minHeight: 420, title: 'Loop-AI - Configurações', autoHideMenuBar: true,
    backgroundColor: '#0f1724', alwaysOnTop: cfg.alwaysOnTop, icon: ICON, webPreferences: baseWebPrefs(),
  });
  settingsWin.loadFile(R('settings', 'index.html'));
  // zoom da janela (texto + layout): lembrado entre aberturas; Ctrl +/−/0 e Ctrl+roda também ajustam
  settingsWin.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});
  settingsWin.webContents.on('did-finish-load', () => setSettingsZoom(cfg.settingsZoom || 0.9, false));
  settingsWin.webContents.on('before-input-event', (e, i) => {
    if (i.type !== 'keyDown' || !i.control) return;
    if (i.key === '+' || i.key === '=') { e.preventDefault(); setSettingsZoom((cfg.settingsZoom || 0.9) + 0.05); }
    else if (i.key === '-') { e.preventDefault(); setSettingsZoom((cfg.settingsZoom || 0.9) - 0.05); }
    else if (i.key === '0') { e.preventDefault(); setSettingsZoom(0.9); }
  });
  settingsWin.webContents.on('zoom-changed', (_e, dir) => setSettingsZoom((cfg.settingsZoom || 0.9) + (dir === 'in' ? 0.05 : -0.05)));
  settingsWin.on('resized', () => {
    const [w, h] = settingsWin.getSize();
    cfg.settingsWinSize = { w, h };
    settings.save(cfg);
  });
}

function petMenu() {
  Menu.buildFromTemplate([
    { label: chat.isVisible() ? 'Ocultar chat' : 'Abrir chat', click: toggleChat },
    { label: 'Agente', submenu: cfg.agents.filter((a) => a.mode !== 'subagent').map((a) => ({
      label: a.name, type: 'radio', checked: a.name === cfg.activeAgent,
      click: () => { cfg.activeAgent = a.name; settings.save(cfg); engine.reset(); chat.webContents.send('chat:event', { type: 'cleared' }); },
    })) },
    { label: 'Nova conversa', click: () => { engine.reset(); chat.webContents.send('chat:event', { type: 'cleared' }); } },
    { label: 'Configurações…', click: openSettings },
    { type: 'separator' },
    { label: 'Tamanho +', click: () => setPetSize(cfg.petSize + 16) },
    { label: 'Tamanho -', click: () => setPetSize(cfg.petSize - 16) },
    { label: 'Sempre no topo', type: 'checkbox', checked: cfg.alwaysOnTop, click: (i) => applyTop(i.checked) },
    { label: 'Recentralizar boneco', click: () => { const wa = screen.getPrimaryDisplay().workArea; pet.setPosition(wa.x + wa.width - cfg.petSize - 40, wa.y + wa.height - cfg.petSize - 20); } },
    { type: 'separator' },
    { label: 'Sair', click: () => app.quit() },
  ]).popup({ window: pet });
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Redimensiona o boneco mantendo o centro no mesmo lugar.
function setPetSize(n) {
  n = Math.round(clamp(Number(n) || 96, 48, 320));
  const b = pet.getBounds();
  cfg.petSize = n;
  pet.setBounds({ x: Math.round(b.x + (b.width - n) / 2), y: Math.round(b.y + (b.height - n) / 2), width: n, height: n });
  settings.save(cfg);
  if (chat.isVisible()) placeChat();
}

function applyOpacity() {
  cfg.petOpacity = clamp(Number(cfg.petOpacity) || 1, 0.2, 1);
  cfg.chatOpacity = clamp(Number(cfg.chatOpacity) || 1, 0.2, 1);
  pet.setOpacity(cfg.petOpacity);
  chat.setOpacity(cfg.chatOpacity);
}

function applyTop(v) {
  cfg.alwaysOnTop = v; settings.save(cfg);
  for (const w of [pet, chat]) w.setAlwaysOnTop(v, 'screen-saver');
}

function createTray() {
  const img = nativeImage.createFromPath(ICON).resize({ width: 32, height: 32 });
  tray = new Tray(img);
  tray.setToolTip('Loop-AI');
  tray.on('click', toggleChat);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir chat', click: toggleChat },
    { label: 'Configurações…', click: openSettings },
    { label: 'Sair', click: () => app.quit() },
  ]));
}

// ---- eventos do engine -> janelas ----
function emit(ev) {
  chat.webContents.send('chat:event', ev);
  pet.webContents.send('chat:event', ev);
}
function askPermission(req) {
  return new Promise((resolve) => {
    pending.set(req.id, resolve);
    if (!chat.isVisible()) toggleChat();
    emit({ type: 'permission', ...req });
  });
}

// ---- IPC ----
let drag = null;
ipcMain.on('pet:drag-start', () => { drag = { origin: pet.getPosition() }; });
ipcMain.on('pet:drag-move', (_e, dx, dy) => {
  if (!drag) return;
  pet.setPosition(Math.round(drag.origin[0] + dx), Math.round(drag.origin[1] + dy));
  if (chat.isVisible()) placeChat(); // o chat acompanha o boneco
});
ipcMain.on('pet:drag-end', () => { drag = null; });
ipcMain.on('pet:click', toggleChat);
ipcMain.on('pet:wheel', (_e, dy) => setPetSize(cfg.petSize * (dy < 0 ? 1.08 : 1 / 1.08))); // scroll p/ cima aumenta
ipcMain.on('pet:menu', petMenu);
ipcMain.on('chat:open-path', (_e, p) => {
  // só abre pastas dentro da pasta de saídas (o renderer não escolhe caminhos arbitrários)
  const root = path.resolve(settings.outRoot(cfg));
  const target = path.resolve(String(p));
  if (target === root || target.startsWith(root + path.sep)) shell.openPath(target);
});
ipcMain.on('chat:hide', () => chat.hide());
ipcMain.on('chat:cancel', () => {
  // pedidos de permissão em aberto nunca resolviam ao parar: o agente ficava esperando para sempre
  for (const [id, resolve] of pending) { resolve('reject'); emit({ type: 'permission_done', id }); }
  pending.clear();
  engine.cancel();
});
ipcMain.on('chat:new', () => engine.reset());
ipcMain.on('permission:reply', (_e, id, reply) => { pending.get(id)?.(reply); pending.delete(id); });
ipcMain.on('settings:open', openSettings);
ipcMain.handle('settings:zoom', (_e, delta) => setSettingsZoom(delta === 0 ? 0.9 : (cfg.settingsZoom || 0.9) + delta));

ipcMain.handle('chat:send', async (_e, text, files) => {
  emit({ type: 'busy', value: true });
  await engine.send(text, files);
  emit({ type: 'busy', value: false });
});
ipcMain.handle('chat:export-html', async (_e, { body, activity, model }) => {
  const now = new Date();
  const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, (c) => (c === 'T' ? '_' : ''));
  const dir = path.join(settings.outRoot(cfg), 'conversas');
  fs.mkdirSync(dir, { recursive: true });
  const r = await dialog.showSaveDialog(chat, {
    title: 'Exportar conversa', defaultPath: path.join(dir, `loop-ai_${stamp}.html`), filters: [{ name: 'HTML', extensions: ['html'] }],
  });
  if (r.canceled || !r.filePath) return null;
  const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Loop-AI - Relatório da conversa</title><style>
body{font:14px/1.5 "Segoe UI",Arial,sans-serif;max-width:860px;margin:24px auto;padding:0 16px;color:#1b2430}
h1{font-size:20px;margin:0 0 4px} .meta{color:#5b6b7c;font-size:12px;margin-bottom:18px;border-bottom:1px solid #d8dee6;padding-bottom:10px}
.msg{padding:8px 12px;margin:8px 0;border-radius:8px;white-space:pre-wrap;word-break:break-word;page-break-inside:avoid}
.msg.user{background:#e8f1fb;border-left:4px solid #2b6fd6}.msg.bot{background:#f6f8fa;border-left:4px solid #8aa0b5}
.who{display:block;font-size:11px;font-weight:600;color:#5b6b7c;text-transform:uppercase;margin-bottom:2px}
.perm{font-size:12px;color:#7a5a00;background:#fff8e1;padding:6px 10px;border-radius:6px;margin:6px 0;white-space:pre-wrap}
details{margin-top:20px} summary{cursor:pointer;font-weight:600} pre{font:11px Consolas,monospace;background:#f1f3f5;padding:10px;border-radius:6px;white-space:pre-wrap;word-break:break-word}
@media print{body{margin:0;max-width:none}.noprint{display:none}}
</style></head><body><h1>Loop-AI — Relatório da conversa</h1>
<div class="meta">Computador: ${esc(os.hostname())} · Data: ${now.toLocaleString('pt-BR')} · Modelo: ${esc(model || '-')}<span class="noprint"> · Dica: Ctrl+P → "Salvar como PDF"</span></div>
${body}
${activity ? `<details open><summary>Atividade do agente (ferramentas e raciocínio)</summary><pre>${esc(activity)}</pre></details>` : ''}
</body></html>`;
  fs.writeFileSync(r.filePath, html, 'utf8');
  shell.openPath(r.filePath);
  return { path: r.filePath };
});
ipcMain.handle('chat:pick-files', async () => {
  const r = await dialog.showOpenDialog(chat, { properties: ['openFile', 'multiSelections'] });
  return r.canceled ? [] : r.filePaths;
});
// ---- conversas salvas, desfazer, registro de atividades, imagem colada ----
ipcMain.handle('session:list', () => sessions.list().map((s) => ({ ...s, atual: s.id === engine.sessionId })));
ipcMain.handle('session:open', (_e, id) => engine.loadSession(id));
ipcMain.handle('session:delete', (_e, id) => { if (id !== engine.sessionId) { sessions.remove(id); audit.remove(id); } return sessions.list().map((s) => ({ ...s, atual: s.id === engine.sessionId })); });
ipcMain.handle('session:current', () => (engine.history.length ? { view: engine.view, title: engine.title, projectDir: engine.projectDir } : null));
ipcMain.handle('changes:list', () => changes.list(engine.sessionId));
ipcMain.handle('changes:undo', (_e, id) => { try { return { ok: true, msg: changes.undo(String(id)) }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('audit:export', () => {
  const dir = engine.projectDir || path.join(settings.outRoot(cfg), 'registros');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'registro-atividades.html');
  fs.writeFileSync(f, audit.html(engine.sessionId, { titulo: engine.title, modelos: [...engine.modelsUsed] }), 'utf8');
  shell.openPath(f);
  return { path: f };
});
ipcMain.handle('chat:save-pasted-image', (_e, b64, ext) => {
  const d = path.join(dataDir(), 'tmp');
  fs.mkdirSync(d, { recursive: true });
  const f = path.join(d, `colado_${Date.now()}.${/^(png|jpg|jpeg|gif|webp)$/.test(ext) ? ext : 'png'}`);
  fs.writeFileSync(f, Buffer.from(String(b64), 'base64'));
  return f;
});
ipcMain.handle('settings:get', () => ({ ...cfg, defaultAgents: settings.DEFAULT_AGENTS }));
ipcMain.handle('settings:save', (_e, next) => {
  if (next.agents) { // nunca grava lista de agentes inválida
    const r = settings.repairAgents(next.agents);
    next = { ...next, agents: r.agents };
    if (!r.agents.some((a) => a.name === (next.activeAgent || cfg.activeAgent) && a.mode !== 'subagent')) next.activeAgent = r.agents.find((a) => a.mode !== 'subagent').name;
  }
  const size = next.petSize;
  cfg = { ...cfg, ...next, petSize: cfg.petSize, settingsZoom: cfg.settingsZoom, settingsWinSize: cfg.settingsWinSize };
  applyOpacity(); applyTop(cfg.alwaysOnTop); // applyTop já grava
  chat.webContents.send('chat:event', { type: 'theme', colors: cfg.colors });
  if (size && size !== cfg.petSize) setPetSize(size);
  return cfg;
});
ipcMain.handle('settings:fetch-models', async (_e, provider) => {
  try { return { ok: true, models: await listModels(provider) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
// ---- skills e plugins ----
const extList = () => ({
  skills: ext.listSkills().map((x) => ({ ...x, enabled: !(cfg.disabledSkills || []).includes(x.id) })),
  plugins: ext.listPlugins().map((x) => ({ ...x, enabled: !(cfg.disabledPlugins || []).includes(x.id) })),
  errors: ext.loadPluginTools(cfg.disabledPlugins).errors,
  skillsDir: ext.skillsDir(), pluginsDir: ext.pluginsDir(),
});
ipcMain.handle('ext:list', extList);
ipcMain.handle('ext:add', async (_e, kind, mode) => {
  const isDir = kind === 'plugin' || mode === 'dir';
  const r = await dialog.showOpenDialog(settingsWin, {
    title: kind === 'skill' ? 'Escolha a pasta da skill (com SKILL.md) ou um arquivo .md' : 'Escolha a pasta do plugin (com index.js)',
    properties: [isDir ? 'openDirectory' : 'openFile'],
    filters: isDir ? undefined : [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (r.canceled) return { ...extList(), added: null };
  try {
    if (kind === 'plugin') {
      const c = await dialog.showMessageBox(settingsWin, {
        type: 'warning', buttons: ['Adicionar', 'Cancelar'], defaultId: 1, cancelId: 1, title: 'Plugin executa código',
        message: 'Plugins rodam código JavaScript com acesso total ao seu computador.',
        detail: `Adicione apenas plugins de fonte confiável.\n\n${r.filePaths[0]}`,
      });
      if (c.response !== 0) return { ...extList(), added: null };
    }
    const id = kind === 'skill' ? ext.addSkill(r.filePaths[0]) : ext.addPlugin(r.filePaths[0]);
    return { ...extList(), added: id };
  } catch (e) { return { ...extList(), added: null, error: e.message }; }
});
ipcMain.handle('remote:analyze', async (_e, url) => {
  try { return { ok: true, ...(await remote.analyze(url)) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('remote:install', async (_e, analysisId, keys, hasPlugin) => {
  try {
    if (hasPlugin) {
      const c = await dialog.showMessageBox(settingsWin, {
        type: 'warning', buttons: ['Adicionar', 'Cancelar'], defaultId: 1, cancelId: 1, title: 'Plugin executa código',
        message: 'Plugins rodam código JavaScript com acesso total ao seu computador.',
        detail: 'Adicione apenas plugins de fonte confiável.',
      });
      if (c.response !== 0) return { ok: false, error: 'Cancelado.' };
    }
    const r = await remote.install(analysisId, keys);
    return { ok: true, ...r, ...extList() };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('ext:remove', (_e, kind, id) => { ext.removeDirOf(kind, id); return extList(); });
ipcMain.handle('ext:toggle', (_e, kind, id, on) => {
  const key = kind === 'skill' ? 'disabledSkills' : 'disabledPlugins';
  const set = new Set(cfg[key] || []);
  if (on) set.delete(id); else set.add(id);
  cfg[key] = [...set]; settings.save(cfg);
  return extList();
});
ipcMain.on('ext:open-folder', (_e, kind) => shell.openPath(kind === 'skill' ? ext.skillsDir() : ext.pluginsDir()));

ipcMain.handle('settings:import-opencode', async () => {
  const r = await dialog.showOpenDialog(settingsWin, {
    defaultPath: path.join(process.env.USERPROFILE || '', '.config', 'opencode'),
    filters: [{ name: 'opencode config', extensions: ['json', 'jsonc'] }], properties: ['openFile'],
  });
  if (r.canceled) return [];
  return settings.importOpencode(r.filePaths[0]);
});

app.whenReady().then(async () => {
  if (process.argv.some((a) => a.startsWith('--selftest'))) { // autoteste sem abrir janelas
    app.removeAllListeners('window-all-closed'); // as janelas ocultas do teste não podem encerrar o app
    return app.exit(await require('./selftest').run());
  }
  cfg = settings.load();
  engine = new Engine(() => cfg, emit, askPermission);
  changes.purge(30); // apaga cópias de segurança com mais de 30 dias
  const ultima = sessions.list()[0]; // retoma a última conversa se for recente (menos de 12 h)
  if (ultima && Date.now() - ultima.updatedAt < 12 * 3600e3) engine.loadSession(ultima.id);
  createPet(); createChat(); createTray();
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => require('./tools').pararServidores(true)); // nenhum servidor de teste fica órfão ao fechar o app
