// Relatório de USO do PC (somente leitura, offline): histórico dos navegadores, arquivos/pastas acessados, programas executados,
// downloads, sessões, USB, redes salvas (apenas nomes) e cache DNS. NÃO lê senhas e NÃO avalia problemas (isso é o diagnóstico).
// Use apenas em equipamento que você tem autorização para auditar.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runPS, arr, esc } = require('./reportkit');

const PS = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$days = [int]$env:LOOP_DAYS; if ($days -lt 1) { $days = 30 }
$since = (Get-Date).AddDays(-$days)
$o = [ordered]@{}
function D($d) { if ($d) { ([datetime]$d).ToString('yyyy-MM-dd HH:mm:ss') } else { '' } }
function Try-Do($name, [scriptblock]$sb) { try { $o[$name] = & $sb } catch { $o[$name] = $null; $o['_erro_' + $name] = $_.Exception.Message } }
function Rot13($s) { -join ($s.ToCharArray() | ForEach-Object { $c = [int]$_; if ($c -ge 65 -and $c -le 90) { [char](($c - 65 + 13) % 26 + 65) } elseif ($c -ge 97 -and $c -le 122) { [char](($c - 97 + 13) % 26 + 97) } else { $_ } }) }
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$o['meta'] = [ordered]@{ geradoEm = D (Get-Date); dias = $days; admin = $admin }

Try-Do 'sistema' {
  $cs = Get-CimInstance Win32_ComputerSystem; $os = Get-CimInstance Win32_OperatingSystem
  $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1; $bios = Get-CimInstance Win32_BIOS
  $nic = Get-CimInstance Win32_NetworkAdapterConfiguration | Where-Object { $_.IPEnabled -and $_.IPAddress } | Select-Object -First 1
  [ordered]@{ host = $env:COMPUTERNAME; usuario = $env:USERNAME; dominio = $cs.Domain; fabricante = $cs.Manufacturer; modelo = $cs.Model; so = $os.Caption; build = $os.BuildNumber; arquitetura = $os.OSArchitecture
    cpu = ([string]$cpu.Name).Trim(); ramGB = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1); serial = $bios.SerialNumber; bios = $bios.SMBIOSBIOSVersion
    ip = ($nic.IPAddress | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' } | Select-Object -First 1); mac = $nic.MACAddress
    instaladoEm = D $os.InstallDate; ultimoBoot = D $os.LastBootUpTime }
}
Try-Do 'discos' { @(Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DriveType -in 2, 3 -and $_.Size } | ForEach-Object { [ordered]@{ letra = $_.DeviceID; nome = $_.VolumeName; tipo = $(if ($_.DriveType -eq 2) { 'Removível' } else { 'Fixo' }); totalGB = [math]::Round($_.Size / 1GB, 1); livreGB = [math]::Round($_.FreeSpace / 1GB, 1); usadoGB = [math]::Round(($_.Size - $_.FreeSpace) / 1GB, 1) } }) }
Try-Do 'officeRecentes' {
  $r = @(); $apps = @{ 'Word' = 'Word'; 'Excel' = 'Excel'; 'PowerPoint' = 'PowerPoint' }
  foreach ($k in (Get-ChildItem 'HKCU:\Software\Microsoft\Office' -Recurse | Where-Object { $_.PSChildName -eq 'File MRU' })) {
    $app = ($k.Name -split '\\' | Where-Object { $apps.ContainsKey($_) } | Select-Object -First 1)
    foreach ($n in $k.GetValueNames()) {
      if ($n -notlike 'Item*') { continue }
      $v = [string]$k.GetValue($n); $m = [regex]::Match($v, '^\[F[0-9A-Fa-f]+\]\[T([0-9A-Fa-f]{16})\]\[O[0-9A-Fa-f]+\]\*(.+)$')
      if ($m.Success) { $dt = [DateTime]::FromFileTime([Convert]::ToInt64($m.Groups[1].Value, 16)); $r += [ordered]@{ quando = D $dt; app = $app; caminho = $m.Groups[2].Value } }
    }
  }
  @($r | Sort-Object { $_.quando } -Descending | Select-Object -First 300)
}
Try-Do 'urlsDigitadas' {
  $k = Get-Item 'HKCU:\Software\Microsoft\Internet Explorer\TypedURLs'; $kt = Get-Item 'HKCU:\Software\Microsoft\Internet Explorer\TypedURLsTime'; $r = @()
  if ($k) { foreach ($n in $k.GetValueNames()) { $t = ''; if ($kt) { $b = $kt.GetValue($n -replace 'url', 'url'); if ($b -is [byte[]] -and $b.Length -ge 8) { $t = D ([DateTime]::FromFileTime([BitConverter]::ToInt64($b, 0))) } }; $r += [ordered]@{ quando = $t; url = [string]$k.GetValue($n) } } }
  @($r | Sort-Object { $_.quando } -Descending | Select-Object -First 300)
}
Try-Do 'conexoes' { @(Get-NetTCPConnection -State Established | ForEach-Object { $p = (Get-Process -Id $_.OwningProcess).ProcessName; [ordered]@{ programa = $p; local = $_.LocalAddress + ':' + $_.LocalPort; remoto = $_.RemoteAddress + ':' + $_.RemotePort } } | Where-Object { $_.remoto -notmatch '^(127\.|::1)' } | Select-Object -First 300) }
Try-Do 'contas' { @(Get-LocalUser | ForEach-Object { [ordered]@{ nome = $_.Name; ativo = $_.Enabled; ultimoLogon = D $_.LastLogon } }) }
Try-Do 'arquivosRecentes' {
  $rp = Join-Path $env:APPDATA 'Microsoft\Windows\Recent'; $sh = New-Object -ComObject WScript.Shell
  @(Get-ChildItem $rp -Filter *.lnk | Where-Object { $_.LastWriteTime -gt $since } | Sort-Object LastWriteTime -Descending | Select-Object -First 1000 | ForEach-Object {
    [ordered]@{ quando = D $_.LastWriteTime; nome = $_.BaseName; caminho = [string]$sh.CreateShortcut($_.FullName).TargetPath }
  })
}
Try-Do 'pastasAcessadas' { $sh = New-Object -ComObject Shell.Application; @($sh.Namespace('shell:::{679f85cb-0220-4080-b29b-5540cc05aab6}').Items() | ForEach-Object { [string]$_.Path } | Where-Object { $_ }) }
Try-Do 'downloads' {
  $dp = Join-Path $env:USERPROFILE 'Downloads'
  @(Get-ChildItem $dp -File | Where-Object { $_.LastWriteTime -gt $since } | Sort-Object LastWriteTime -Descending | Select-Object -First 300 | ForEach-Object { [ordered]@{ quando = D $_.LastWriteTime; nome = $_.Name; mb = [math]::Round($_.Length / 1MB, 2) } })
}
Try-Do 'programasExecutados' {
  $ua = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\UserAssist'; $r = @()
  foreach ($g in Get-ChildItem $ua) {
    $k = Get-Item (Join-Path $g.PSPath 'Count'); if (-not $k) { continue }
    foreach ($n in $k.GetValueNames()) {
      $b = $k.GetValue($n)
      if ($b -is [byte[]] -and $b.Length -ge 68) {
        $ft = [BitConverter]::ToInt64($b, 60)
        if ($ft -gt 0) { $dt = [DateTime]::FromFileTime($ft); if ($dt -gt $since) { $r += [ordered]@{ quando = D $dt; vezes = [BitConverter]::ToUInt32($b, 4); programa = (Rot13 $n) } } }
      }
    }
  }
  @($r | Sort-Object { $_.quando } -Descending | Select-Object -First 250)
}
Try-Do 'prefetch' { @(Get-ChildItem 'C:\Windows\Prefetch\*.pf' | Where-Object { $_.LastWriteTime -gt $since } | Sort-Object LastWriteTime -Descending | Select-Object -First 200 | ForEach-Object { [ordered]@{ quando = D $_.LastWriteTime; programa = $_.Name -replace '-[0-9A-F]{8}\.pf$', '' } }) }
Try-Do 'sessoes' {
  $ev = @()
  $ev += @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 6005, 6006, 6008, 1074; StartTime = $since } -MaxEvents 300 | ForEach-Object { $t = switch ($_.Id) { 6005 { 'Sistema iniciado' } 6006 { 'Sistema encerrado normalmente' } 6008 { 'Desligamento inesperado' } 1074 { 'Desligamento/reinício solicitado' } }; [ordered]@{ quando = D $_.TimeCreated; evento = $t } })
  $ev += @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-Kernel-Power'; Id = 42; StartTime = $since } -MaxEvents 100 | ForEach-Object { [ordered]@{ quando = D $_.TimeCreated; evento = 'Suspensão (sleep)' } })
  $ev += @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-Power-Troubleshooter'; Id = 1; StartTime = $since } -MaxEvents 100 | ForEach-Object { [ordered]@{ quando = D $_.TimeCreated; evento = 'Retomada (saiu da suspensão)' } })
  if ($admin) {
    $ev += @(Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4800, 4801, 4647; StartTime = $since } -MaxEvents 300 | ForEach-Object { $t = switch ($_.Id) { 4800 { 'Sessão bloqueada' } 4801 { 'Sessão desbloqueada' } 4647 { 'Logoff' } }; [ordered]@{ quando = D $_.TimeCreated; evento = $t } })
    $ev += @(Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4624; StartTime = $since } -MaxEvents 400 | Where-Object { $_.Properties[8].Value -in 2, 7, 10, 11 } | ForEach-Object { [ordered]@{ quando = D $_.TimeCreated; evento = 'Logon (usuário ' + $_.Properties[5].Value + ')' } })
  }
  @($ev | Sort-Object { $_.quando } -Descending | Select-Object -First 400)
}
Try-Do 'usb' { @(Get-ChildItem 'HKLM:\SYSTEM\CurrentControlSet\Enum\USBSTOR' | ForEach-Object { Get-ChildItem $_.PSPath | ForEach-Object { $p = Get-ItemProperty $_.PSPath; if ($p.FriendlyName) { $p.FriendlyName } } } | Sort-Object -Unique) }
Try-Do 'wifi' { @(netsh wlan show profiles | Select-String 'Perfil de Todos os Usu|All User Profile' | ForEach-Object { ($_ -split ':', 2)[1].Trim() }) }
Try-Do 'dns' { @(Get-DnsClientCache | Where-Object { $_.Type -in 1, 5 } | Select-Object -ExpandProperty Entry -Unique | Select-Object -First 400) }
Try-Do 'programasInstalados' {
  $keys = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
  $seen = @{}; $r = @()
  foreach ($p in (Get-ItemProperty $keys | Where-Object { $_.DisplayName })) {
    $k = ([string]$p.DisplayName + '|' + [string]$p.DisplayVersion).ToLower(); if ($seen.ContainsKey($k)) { continue }; $seen[$k] = 1
    $d = ''; if ($p.InstallDate -match '^\d{8}$') { $d = $p.InstallDate.Substring(0,4) + '-' + $p.InstallDate.Substring(4,2) + '-' + $p.InstallDate.Substring(6,2) }
    $r += [ordered]@{ nome = [string]$p.DisplayName; versao = [string]$p.DisplayVersion; editora = [string]$p.Publisher; instalado = $d }
  }
  @($r)
}
Try-Do 'janelasAbertas' { @(Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { [ordered]@{ programa = $_.ProcessName; titulo = $_.MainWindowTitle } }) }
$o | ConvertTo-Json -Depth 5 -Compress
`;

// ---------------------------------------------------------------- navegadores (SQLite via sql.js)
const LOCAL = process.env.LOCALAPPDATA || '', ROAM = process.env.APPDATA || '';
const CHROMIUM = [
  ['Chrome', path.join(LOCAL, 'Google', 'Chrome', 'User Data')],
  ['Edge', path.join(LOCAL, 'Microsoft', 'Edge', 'User Data')],
  ['Brave', path.join(LOCAL, 'BraveSoftware', 'Brave-Browser', 'User Data')],
  ['Vivaldi', path.join(LOCAL, 'Vivaldi', 'User Data')],
  ['Chromium', path.join(LOCAL, 'Chromium', 'User Data')],
  ['Opera', path.join(ROAM, 'Opera Software', 'Opera Stable')],
  ['Opera GX', path.join(ROAM, 'Opera Software', 'Opera GX Stable')],
];
const EPOCH_1601_MS = 11644473600000;
const fmt = (ms) => { const d = new Date(ms), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };

let SQLP = null;
async function sql() {
  if (!SQLP) {
    const initSqlJs = require('sql.js');
    const dist = path.dirname(require.resolve('sql.js/dist/sql-wasm.js'));
    SQLP = initSqlJs({ locateFile: (f) => path.join(dist, f) });
  }
  return SQLP;
}

/** Copia o banco (o navegador pode estar aberto) e abre em memória. */
async function openDb(file) {
  const SQL = await sql();
  const tmp = path.join(os.tmpdir(), `loopai_${process.pid}_${Math.random().toString(36).slice(2)}.db`);
  try {
    fs.copyFileSync(file, tmp);
    return new SQL.Database(fs.readFileSync(tmp));
  } finally { fs.rm(tmp, { force: true }, () => {}); }
}
const rows = (db, q) => { const r = db.exec(q)[0]; return r ? r.values : []; };

function profilesChromium(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  if (fs.existsSync(path.join(root, 'History'))) out.push(['', root]); // Opera
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (e.isDirectory() && (e.name === 'Default' || /^Profile \d+$/.test(e.name)) && fs.existsSync(path.join(root, e.name, 'History'))) out.push([e.name, path.join(root, e.name)]);
  }
  return out;
}

const lerJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

function flattenBookmarks(node, pasta, out, rotulo) {
  if (!node) return;
  if (node.type === 'url') out.push({ navegador: rotulo, nome: node.name || '', url: node.url || '', pasta, ms: node.date_added ? Number(node.date_added) / 1000 - EPOCH_1601_MS : 0 });
  for (const c of node.children || []) flattenBookmarks(c, node.type === 'folder' ? (pasta ? `${pasta} / ${node.name}` : node.name) : pasta, out, rotulo);
}

async function lerNavegadores(days, maxVisitas = 20000) {
  const res = { visitas: [], downloads: [], buscas: [], navegadores: [], avisos: [], digitadas: [], favoritos: [], contas: [] };
  const desde = Date.now() - days * 864e5;
  const cutChromium = (desde + EPOCH_1601_MS) * 1000;
  const addConta = (navegador, email, nome) => { if (email && !res.contas.some((c) => c.email === email && c.navegador === navegador)) res.contas.push({ navegador, email, nome: nome || '' }); };

  for (const [nome, root] of CHROMIUM) {
    for (const [perfil, dir] of profilesChromium(root)) {
      const rotulo = perfil ? `${nome} (${perfil})` : nome;
      try {
        const db = await openDb(path.join(dir, 'History'));
        let v;
        try { v = rows(db, `SELECT u.url, u.title, v.visit_time, vs.source FROM visits v JOIN urls u ON u.id = v.url LEFT JOIN visit_source vs ON vs.id = v.id WHERE v.visit_time >= ${cutChromium} ORDER BY v.visit_time DESC LIMIT ${maxVisitas}`); }
        catch { v = rows(db, `SELECT u.url, u.title, v.visit_time, 1 FROM visits v JOIN urls u ON u.id = v.url WHERE v.visit_time >= ${cutChromium} ORDER BY v.visit_time DESC LIMIT ${maxVisitas}`); }
        for (const [url, title, t, src] of v) res.visitas.push({ ms: t / 1000 - EPOCH_1601_MS, navegador: rotulo, titulo: title || '', url, sync: src === 0 });
        for (const [p, tab, t, bytes] of rows(db, `SELECT target_path, tab_url, start_time, total_bytes FROM downloads WHERE start_time >= ${cutChromium} ORDER BY start_time DESC LIMIT 500`)) {
          res.downloads.push({ ms: t / 1000 - EPOCH_1601_MS, navegador: rotulo, arquivo: p, origem: tab || '', mb: Math.round((bytes / 1048576) * 100) / 100 });
        }
        try {
          for (const [term, t] of rows(db, `SELECT t.term, u.last_visit_time FROM keyword_search_terms t JOIN urls u ON u.id = t.url_id WHERE u.last_visit_time >= ${cutChromium} ORDER BY u.last_visit_time DESC LIMIT 500`)) res.buscas.push({ ms: t / 1000 - EPOCH_1601_MS, navegador: rotulo, termo: term });
        } catch { /* tabela ausente */ }
        try {
          for (const [url, title, cnt, t] of rows(db, `SELECT url, title, typed_count, last_visit_time FROM urls WHERE typed_count > 0 AND last_visit_time >= ${cutChromium} ORDER BY last_visit_time DESC LIMIT 400`)) res.digitadas.push({ ms: t / 1000 - EPOCH_1601_MS, navegador: rotulo, url, titulo: title || '', vezes: cnt });
        } catch { /* coluna ausente */ }
        db.close();
        res.navegadores.push({ nome: rotulo, visitas: v.length, sincronizadas: v.filter((r) => r[3] === 0).length });
      } catch (e) { res.avisos.push(`${rotulo}: não foi possível ler (${e.message.split('\n')[0]}). Se o navegador estiver aberto, feche-o e repita.`); }
      // favoritos e contas (arquivos JSON; sem senhas)
      const bm = lerJson(path.join(dir, 'Bookmarks'));
      if (bm?.roots) for (const r of Object.values(bm.roots)) if (r && typeof r === 'object') flattenBookmarks(r, '', res.favoritos, rotulo);
      const prefs = lerJson(path.join(dir, 'Preferences'));
      for (const a of prefs?.account_info || []) addConta(rotulo, a.email, a.full_name);
    }
  }

  // Firefox
  const ffRoot = path.join(ROAM, 'Mozilla', 'Firefox', 'Profiles');
  if (fs.existsSync(ffRoot)) {
    for (const e of fs.readdirSync(ffRoot, { withFileTypes: true })) {
      const f = path.join(ffRoot, e.name, 'places.sqlite');
      if (!e.isDirectory() || !fs.existsSync(f)) continue;
      const rotulo = `Firefox (${e.name.replace(/^[^.]+\./, '')})`;
      try {
        const db = await openDb(f);
        const v = rows(db, `SELECT p.url, p.title, h.visit_date FROM moz_historyvisits h JOIN moz_places p ON p.id = h.place_id WHERE h.visit_date >= ${desde * 1000} ORDER BY h.visit_date DESC LIMIT ${maxVisitas}`);
        for (const [url, title, t] of v) res.visitas.push({ ms: t / 1000, navegador: rotulo, titulo: title || '', url, sync: false });
        try {
          for (const [title, url, t] of rows(db, `SELECT b.title, p.url, b.dateAdded FROM moz_bookmarks b JOIN moz_places p ON p.id = b.fk WHERE b.type = 1 AND p.url LIKE 'http%' LIMIT 3000`)) res.favoritos.push({ navegador: rotulo, nome: title || '', url, pasta: '', ms: t / 1000 });
        } catch { /* sem favoritos */ }
        db.close();
        res.navegadores.push({ nome: rotulo, visitas: v.length, sincronizadas: 0 });
      } catch (err) { res.avisos.push(`${rotulo}: não foi possível ler (${err.message.split('\n')[0]}). Se o Firefox estiver aberto, feche-o e repita.`); }
      const su = lerJson(path.join(ffRoot, e.name, 'signedInUser.json'));
      addConta(rotulo, su?.accountData?.email, '');
    }
  }

  // buscas deduzidas das URLs (cobre Firefox e navegadores sem keyword_search_terms)
  const seen = new Set(res.buscas.map((b) => b.termo.toLowerCase()));
  for (const v of res.visitas) {
    try {
      const u = new URL(v.url);
      const q = /google\.|bing\.|duckduckgo\.|yahoo\.|ecosia\./i.test(u.hostname) ? u.searchParams.get('q') : /youtube\./i.test(u.hostname) ? u.searchParams.get('search_query') : null;
      if (q && !seen.has(q.toLowerCase())) { seen.add(q.toLowerCase()); res.buscas.push({ ms: v.ms, navegador: v.navegador, termo: q }); }
    } catch { /* url inválida */ }
  }
  res.visitas.sort((a, b) => b.ms - a.ms);
  res.buscas.sort((a, b) => b.ms - a.ms);
  res.downloads.sort((a, b) => b.ms - a.ms);
  res.digitadas.sort((a, b) => b.ms - a.ms);
  return res;
}

/** Timeline de atividades do Windows (ActivitiesCache.db): apps/arquivos/URLs abertos, fora do histórico do navegador. */
async function lerTimelineWindows(days) {
  const out = [], root = path.join(LOCAL, 'ConnectedDevicesPlatform');
  if (!fs.existsSync(root)) return out;
  const cut = Math.floor((Date.now() - days * 864e5) / 1000);
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const f = path.join(root, e.name, 'ActivitiesCache.db');
    if (!e.isDirectory() || !fs.existsSync(f)) continue;
    try {
      const db = await openDb(f);
      for (const [appId, payload, start, mod] of rows(db, `SELECT AppId, CAST(Payload AS TEXT), StartTime, LastModifiedTime FROM Activity WHERE LastModifiedTime >= ${cut} ORDER BY LastModifiedTime DESC LIMIT 1500`)) {
        let app = '', p = {};
        try { const a = JSON.parse(appId); app = (a.find((x) => x.platform === 'windows_win32') || a[0] || {}).application || ''; } catch { /* sem app */ }
        try { p = JSON.parse(payload || '{}'); } catch { /* sem payload */ }
        out.push({ ms: (start || mod) * 1000, app: app.split('\\').pop(), titulo: p.displayText || p.appDisplayName || '', detalhe: p.description || p.contentUri || p.activationUri || '' });
      }
      db.close();
    } catch { /* banco bloqueado/ausente */ }
  }
  return out.sort((a, b) => b.ms - a.ms);
}

function dominios(visitas) {
  const c = new Map();
  for (const v of visitas) { try { const h = new URL(v.url).hostname.replace(/^www\./, ''); if (h) c.set(h, (c.get(h) || 0) + 1); } catch { /* ignora */ } }
  return [...c.entries()].sort((a, b) => b[1] - a[1]).map(([dominio, visitas]) => ({ dominio, visitas }));
}

// ---------------------------------------------------------------- relatório (dashboard)
const br = (s) => { const m = /^(\d{4})-(\d\d)-(\d\d)(.*)$/.exec(s || ''); return m ? `${m[3]}/${m[2]}/${m[1]}${m[4]}` : s || ''; };
const brMs = (ms) => (ms ? br(fmt(ms)) : '');
const EXT_ICO = { pdf: '📕', doc: '📘', docx: '📘', xls: '📗', xlsx: '📗', csv: '📗', ppt: '📙', pptx: '📙', zip: '🗜️', rar: '🗜️', '7z': '🗜️', iso: '💿', png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', html: '🌐', htm: '🌐', exe: '⚙️', msi: '⚙️', txt: '📝', ps1: '📜', bat: '📜', mp4: '🎞️', mp3: '🎵' };
const extOf = (p) => { const m = /\.([A-Za-z0-9]{1,5})$/.exec(String(p || '')); return m ? m[1].toLowerCase() : ''; };
const fileIco = (p) => EXT_ICO[extOf(p)] || (extOf(p) ? '📄' : '📁');
const evCls = (t) => (/inesperado/i.test(t) ? 'ev-warn' : /iniciado|retomada|logon|desbloq/i.test(t) ? 'ev-on' : /encerrado|logoff|solicitado/i.test(t) ? 'ev-off' : /suspens|bloquead/i.test(t) ? 'ev-lock' : 'ev-other');
const urlCell = (r) => `<span class="mono" title="${esc(r.url)}">${esc(String(r.url || '').slice(0, 140))}</span>`;
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

/** Horas ligadas por dia, estimadas pelos eventos de energia (ligar/retomar → desligar/suspender). */
function usoPorDia(sessoes, dias) {
  const ev = arr(sessoes).map((e) => ({ t: new Date(e.quando.replace(' ', 'T')).getTime(), e: e.evento })).filter((e) => e.t).sort((a, b) => a.t - b.t);
  const horas = new Map(), add = (a, b) => {
    for (let t = a; t < b;) {
      const d = new Date(t), fim = Math.min(b, new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime());
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      horas.set(k, (horas.get(k) || 0) + (fim - t) / 36e5); t = fim;
    }
  };
  let ini = null;
  for (const x of ev) {
    if (/iniciado|retomada/i.test(x.e)) { if (ini === null) ini = x.t; }
    else if (/encerrado normalmente|suspens|inesperado/i.test(x.e)) { if (ini !== null && x.t > ini) add(ini, x.t); ini = null; }
  }
  if (ini !== null) add(ini, Date.now());
  const corte = Date.now() - dias * 864e5;
  return [...horas.entries()].filter(([k]) => new Date(k).getTime() >= corte - 864e5).sort().map(([k, h]) => ({ dia: `${k.slice(8)}/${k.slice(5, 7)}`, horas: Math.round(h * 10) / 10 }));
}

function render(d, nav, tl) {
  const D = require('./dashkit');
  const s = d.sistema || {}, dom = dominios(nav.visitas), dias = d.meta?.dias, hoje = br(d.meta?.geradoEm);
  const local = nav.visitas.filter((v) => !v.sync), sync = nav.visitas.filter((v) => v.sync);
  const rec = arr(d.arquivosRecentes), inst = arr(d.programasInstalados).slice().sort((a, b) => (b.instalado || '').localeCompare(a.instalado || '') || a.nome.localeCompare(b.nome)), sess = arr(d.sessoes);
  const dlTodos = nav.downloads.length + arr(d.downloads).length;
  const dtCol = [['quando', 'Data/hora']];

  // gráficos
  const porDia = new Map(), porHora = Array(24).fill(0);
  for (const v of nav.visitas) { const dt = new Date(v.ms), k = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`; porDia.set(k, (porDia.get(k) || 0) + 1); porHora[dt.getHours()]++; }
  const dias_ = [...porDia.entries()].sort();
  const exts = new Map();
  for (const r of rec) { const e = extOf(r.caminho || r.nome); if (e) exts.set(`.${e}`, (exts.get(`.${e}`) || 0) + 1); }
  const topExt = [...exts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([l, v]) => ({ l, v }));
  const energia = sess.filter((e) => /iniciado|encerrado normalmente|inesperado/i.test(e.evento)).slice(0, 60)
    .map((e) => ({ cls: /inesperado/i.test(e.evento) ? 'tl-crash' : /iniciado/i.test(e.evento) ? 'tl-on' : 'tl-off', ico: /inesperado/i.test(e.evento) ? '⚠️' : /iniciado/i.test(e.evento) ? '🟢' : '🔴', rot: /iniciado/i.test(e.evento) ? 'Ligado' : /inesperado/i.test(e.evento) ? 'Desligamento inesperado' : 'Desligado', quando: br(e.quando) }));
  const horasDia = usoPorDia(sess, dias);
  const boots = sess.filter((e) => /iniciado/i.test(e.evento)).length;

  const grupos = [];
  grupos.push({ label: 'Visão geral', items: [
    { id: 'dashboard', ico: '📊', title: 'Dashboard de uso', sub: `Período: últimos ${dias} dias · gerado em ${esc(hoje)}`, html:
      `<div class="grid g6">${D.kpi('🌐', nav.visitas.length, 'Visitas na web')}${D.kpi('🔗', dom.length, 'Sites únicos')}${D.kpi('🔎', nav.buscas.length, 'Pesquisas')}` +
      `${D.kpi('🟢', boots, 'Inicializações')}${D.kpi('📄', rec.length, 'Arquivos recentes')}${D.kpi('⬇️', dlTodos, 'Downloads')}${D.kpi('💾', arr(d.usb).length, 'Dispositivos USB')}${D.kpi('📦', inst.length, 'Programas instalados')}</div>` +
      `<div class="grid g2">${D.card('📈 Atividade de navegação por dia', D.line(dias_.map(([k]) => `${k.slice(8)}/${k.slice(5, 7)}`), dias_.map(([, v]) => v)))}` +
      `${D.card('🌐 Uso por navegador', D.donut(nav.navegadores.filter((x) => x.visitas > 0).map((x) => ({ l: x.nome, v: x.visitas }))))}</div>` +
      `<div class="grid g2e">${D.card('🏆 Top 15 sites mais visitados', D.hbars(dom.slice(0, 15).map((x) => ({ l: x.dominio, v: x.visitas }))))}` +
      `${D.card('🕐 Atividade por hora do dia', D.columns(porHora.map((_, h) => `${String(h).padStart(2, '0')}h`), porHora))}</div>` +
      `<div class="grid g3">${D.card('📄 Tipos de arquivo acessados', D.hbars(topExt))}${D.card('💿 Uso de disco', D.disks(arr(d.discos)))}${D.card('⚡ Linha do tempo de energia', D.timeline(energia))}</div>` +
      D.card('⏱️ Tempo de uso estimado por dia (horas com o PC ligado)', horasDia.length ? D.columns(horasDia.map((x) => x.dia), horasDia.map((x) => x.horas), { h: 150, every: Math.ceil(horasDia.length / 12) }) : '<p class="no-data">Sem eventos de ligar/desligar no período.</p>') },
    { id: 'sistema', ico: '💻', title: 'Informações do sistema', sub: 'Hardware, sistema operacional e rede', html:
      D.info([['Computador', s.host], ['Usuário', s.usuario], ['Domínio / grupo', s.dominio], ['Fabricante', s.fabricante], ['Modelo', s.modelo], ['Nº de série', s.serial], ['BIOS', s.bios], ['Processador', s.cpu], ['Memória', s.ramGB ? `${s.ramGB} GB` : ''],
        ['Sistema', `${s.so || ''} ${s.arquitetura || ''}`.trim()], ['Build', s.build], ['Instalado em', br(s.instaladoEm)], ['Último boot', br(s.ultimoBoot)], ['IP', s.ip], ['MAC', s.mac], ['Executado como', d.meta?.admin ? 'Administrador' : 'Usuário comum']]) +
      '<h3 class="h3">Discos</h3>' + D.disks(arr(d.discos)) },
  ] });

  grupos.push({ label: 'Atividade', items: [
    { id: 'navegadores', ico: '🌐', title: 'Navegadores (geral)', nav: 'Navegadores', sub: `${D.n(nav.visitas.length)} URLs · ${D.n(dom.length)} sites únicos · local + sincronizado`, html:
      D.dtable([['nome', 'Navegador/perfil'], ['visitas', 'Visitas'], ['locais', 'Neste PC', (r) => D.n(r.visitas - r.sincronizadas)], ['sincronizadas', 'Sincronizadas']], nav.navegadores, { placeholder: 'Pesquisar navegador…' }) +
      '<h3 class="h3">Sites visitados</h3>' + D.dtable([['dominio', 'Site', (r) => `<span class="badge">${esc(r.dominio)}</span>`], ['visitas', 'Visitas']], dom, { max: 500, placeholder: 'Pesquisar site…' }) +
      (nav.avisos.length ? '<div class="alert">' + nav.avisos.map(esc).join('<br>') + '</div>' : '') },
    { id: 'nav-local', ico: '🖥️', title: 'Histórico local', sub: `${D.n(local.length)} URLs com visita registrada neste computador`, html:
      D.dtable([['q', 'Data/hora', (r) => esc(brMs(r.ms))], ['navegador', 'Navegador'], ['titulo', 'Título', (r) => esc((r.titulo || '').slice(0, 100))], ['url', 'Endereço', urlCell]], local, { max: 3000, placeholder: 'Pesquisar no histórico local…' }) },
    { id: 'nav-sync', ico: '📱', title: 'Histórico sincronizado', sub: `${D.n(sync.length)} URLs visitadas em outros dispositivos (celular, tablet, outro PC) e trazidas pela sincronização`, html:
      D.dtable([['q', 'Data/hora', (r) => esc(brMs(r.ms))], ['navegador', 'Navegador'], ['titulo', 'Título', (r) => esc((r.titulo || '').slice(0, 100))], ['url', 'Endereço', urlCell]], sync, { max: 2000, placeholder: 'Pesquisar no histórico sincronizado…' }) },
    { id: 'buscas', ico: '🔎', title: 'Pesquisas realizadas', sub: `${D.n(nav.buscas.length)} termos pesquisados`, html:
      D.dtable([['q', 'Data/hora', (r) => esc(brMs(r.ms))], ['navegador', 'Navegador'], ['termo', 'Pesquisa']], nav.buscas, { max: 1500, placeholder: 'Pesquisar termo…' }) },
    { id: 'contas-browser', ico: '👤', title: 'Contas dos navegadores', sub: `${nav.contas.length} conta(s) conectada(s) (e-mail/nome, sem senhas)`, html:
      D.dtable([['navegador', 'Navegador'], ['email', 'Conta (e-mail)'], ['nome', 'Nome']], nav.contas) },
    { id: 'bookmarks', ico: '⭐', title: 'Favoritos', sub: `${D.n(nav.favoritos.length)} favoritos`, html:
      D.dtable([['nome', 'Nome', (r) => esc((r.nome || '').slice(0, 90))], ['url', 'Endereço', urlCell], ['pasta', 'Pasta'], ['navegador', 'Navegador'], ['q', 'Adicionado', (r) => esc(brMs(r.ms))]], nav.favoritos, { max: 1500, placeholder: 'Pesquisar favorito…' }) },
    { id: 'eventos', ico: '⚡', title: 'Eventos do sistema', sub: 'Ligar/desligar, suspensão, bloqueio, logon e logoff', html:
      (d.meta?.admin ? '' : '<div class="alert">Sem administrador: bloqueio/desbloqueio e logons não foram coletados. Use iniciar-admin.bat.</div>') +
      D.dtable([['q', 'Data/hora', (r) => esc(br(r.quando))], ['evento', 'Evento', (r) => `<span class="ev ${evCls(r.evento)}">${esc(r.evento)}</span>`]], sess, { max: 1000, placeholder: 'Pesquisar evento…' }) },
    { id: 'arquivos', ico: '📄', title: 'Arquivos recentemente acessados', nav: 'Arquivos recentes', sub: `${D.n(rec.length)} arquivos (com caminho completo)`, html:
      D.dtable([['q', 'Data/hora', (r) => esc(br(r.quando))], ['nome', 'Arquivo', (r) => `${fileIco(r.caminho || r.nome)} ${esc(r.nome)}`], ['caminho', 'Caminho completo', (r) => `<span class="mono">${esc(r.caminho)}</span>`]], rec, { max: 1000, placeholder: 'Pesquisar arquivo ou caminho…' }) },
    { id: 'pastas', ico: '📁', title: 'Pastas acessadas', sub: 'Acesso rápido (pastas frequentes e recentes)', html:
      D.dtable([['p', 'Pasta', (r) => `<span class="mono">📁 ${esc(r)}</span>`]], arr(d.pastasAcessadas), { placeholder: 'Pesquisar pasta…' }) },
    { id: 'downloads', ico: '⬇️', title: 'Downloads (pasta)', sub: `${D.n(arr(d.downloads).length)} itens na pasta Downloads no período`, html:
      D.dtable([['q', 'Modificado', (r) => esc(br(r.quando))], ['nome', 'Nome', (r) => `${fileIco(r.nome)} ${esc(r.nome)}`], ['mb', 'MB']], arr(d.downloads), { placeholder: 'Pesquisar download…' }) },
  ] });

  const pdfs = rec.filter((r) => extOf(r.caminho || r.nome) === 'pdf');
  const offExt = /^(docx?|xlsx?|pptx?|csv|odt|ods|odp)$/;
  const seenOf = new Set(), office = [];
  for (const r of [...arr(d.officeRecentes).map((x) => ({ quando: x.quando, app: x.app, caminho: x.caminho })), ...rec.filter((r) => offExt.test(extOf(r.caminho || r.nome))).map((r) => ({ quando: r.quando, app: '', caminho: r.caminho || r.nome }))]) {
    const k = String(r.caminho).toLowerCase(); if (seenOf.has(k)) continue; seenOf.add(k); office.push(r);
  }
  office.sort((a, b) => (b.quando || '').localeCompare(a.quando || ''));
  grupos.push({ label: 'Forense (sobrevive ao modo anônimo)', items: [
    { id: 'dns', ico: '🧭', title: 'Cache DNS', sub: `${arr(d.dns).length} domínios resolvidos — inclui sites visitados em modo anônimo até o próximo reinício`, html:
      D.dtable([['x', 'Domínio', (r) => `<span class="mono">${esc(r)}</span>`]], arr(d.dns), { max: 1000, placeholder: 'Pesquisar domínio…' }) },
    { id: 'pdf-recent', ico: '📕', title: 'PDFs recentes', sub: `${pdfs.length} PDFs abertos recentemente`, html:
      D.dtable([['q', 'Data/hora', (r) => esc(br(r.quando))], ['nome', 'Arquivo'], ['caminho', 'Caminho', (r) => `<span class="mono">${esc(r.caminho)}</span>`]], pdfs, { placeholder: 'Pesquisar PDF…' }) },
    { id: 'office-recent', ico: '📘', title: 'Word / Excel / PowerPoint', sub: `${office.length} documentos (lista do Office + arquivos recentes do Windows)`, html:
      D.dtable([['q', 'Data/hora', (r) => esc(br(r.quando))], ['app', 'Aplicativo', (r) => esc(r.app || ({ doc: 'Word', docx: 'Word', xls: 'Excel', xlsx: 'Excel', csv: 'Excel', ppt: 'PowerPoint', pptx: 'PowerPoint' }[extOf(r.caminho)] || ''))], ['caminho', 'Caminho', (r) => `${fileIco(r.caminho)} <span class="mono">${esc(r.caminho)}</span>`]], office, { placeholder: 'Pesquisar documento…' }) },
    { id: 'programas', ico: '📦', title: 'Programas instalados', sub: `${inst.length} programas`, html:
      D.dtable([['nome', 'Programa'], ['versao', 'Versão'], ['editora', 'Editora'], ['q', 'Instalado em', (r) => esc(br(r.instalado))]], inst, { placeholder: 'Pesquisar programa…' }) },
    { id: 'timeline', ico: '⏱️', title: 'Timeline do Windows', sub: `${D.n(tl.length)} atividades (apps, arquivos e páginas registrados pelo sistema, fora do histórico do navegador)`, html:
      D.dtable([['q', 'Data/hora', (r) => esc(brMs(r.ms))], ['app', 'Aplicativo', (r) => `<span class="mono">${esc(r.app)}</span>`], ['titulo', 'Atividade', (r) => esc((r.titulo || '').slice(0, 120))], ['detalhe', 'Detalhe', (r) => `<span class="mono">${esc(String(r.detalhe || '').slice(0, 140))}</span>`]], tl, { max: 1500, placeholder: 'Pesquisar atividade…' }) },
  ] });

  grupos.push({ label: 'Atividade avançada', items: [
    { id: 'browser-downloads', ico: '📥', title: 'Downloads pelos navegadores', nav: 'Downloads (navegador)', sub: `${nav.downloads.length} registros`, html:
      D.dtable([['q', 'Data/hora', (r) => esc(brMs(r.ms))], ['navegador', 'Navegador'], ['arquivo', 'Salvo em', (r) => `${fileIco(r.arquivo)} <span class="mono">${esc(r.arquivo)}</span>`], ['origem', 'Página de origem', (r) => `<span class="mono">${esc((r.origem || '').slice(0, 110))}</span>`], ['mb', 'MB']], nav.downloads, { placeholder: 'Pesquisar download…' }) },
    { id: 'executados', ico: '🚀', title: 'Aplicativos executados', sub: 'UserAssist do Windows' + (arr(d.prefetch).length ? ' + Prefetch (administrador)' : ''), html:
      D.dtable([['q', 'Última execução', (r) => esc(br(r.quando))], ['vezes', 'Vezes'], ['programa', 'Programa', (r) => `<span class="mono">${esc(r.programa)}</span>`]], arr(d.programasExecutados), { placeholder: 'Pesquisar programa…' }) +
      (arr(d.prefetch).length ? '<h3 class="h3">Prefetch</h3>' + D.dtable([['q', 'Última execução', (r) => esc(br(r.quando))], ['programa', 'Programa']], arr(d.prefetch), { placeholder: 'Pesquisar…' }) : '') },
    { id: 'typed-urls', ico: '⌨️', title: 'URLs digitadas', sub: 'Endereços digitados manualmente na barra (navegadores e registro do Windows)', html:
      D.dtable([['q', 'Data/hora', (r) => esc(r.ms ? brMs(r.ms) : br(r.quando))], ['navegador', 'Origem', (r) => esc(r.navegador || 'Registro (IE/Edge)')], ['url', 'Endereço', urlCell], ['vezes', 'Vezes']],
        [...nav.digitadas, ...arr(d.urlsDigitadas).map((x) => ({ quando: x.quando, url: x.url }))], { max: 1000, placeholder: 'Pesquisar URL…' }) },
    { id: 'usuarios', ico: '👥', title: 'Contas de usuário', sub: `${arr(d.contas).length} contas locais`, html:
      D.dtable([['nome', 'Conta'], ['ativo', 'Ativa', (r) => (r.ativo ? 'Sim' : 'Não')], ['q', 'Último logon', (r) => esc(br(r.ultimoLogon))]], arr(d.contas)) },
  ] });

  grupos.push({ label: 'Hardware e rede', items: [
    { id: 'usb', ico: '💾', title: 'Dispositivos USB', sub: `${arr(d.usb).length} dispositivos de armazenamento já conectados`, html: D.dtable([['x', 'Dispositivo']], arr(d.usb)) },
    { id: 'wifi', ico: '📶', title: 'Redes Wi-Fi salvas', sub: `${arr(d.wifi).length} redes (somente os nomes; senhas não são lidas)`, html: D.dtable([['x', 'Rede']], arr(d.wifi)) },
    { id: 'rede', ico: '🔌', title: 'Conexões de rede ativas', sub: `${arr(d.conexoes).length} conexões estabelecidas agora`, html:
      D.dtable([['programa', 'Programa'], ['local', 'Local'], ['remoto', 'Remoto']], arr(d.conexoes), { placeholder: 'Pesquisar conexão…' }) },
    { id: 'janelas', ico: '🪟', title: 'Janelas abertas agora', sub: 'Programas com janela no momento da coleta', html: D.dtable([['programa', 'Programa'], ['titulo', 'Título da janela']], arr(d.janelasAbertas)) },
  ] });

  const alerta = (d.meta?.admin ? '' : '<div class="alert">⚠️ <b>Privilégios limitados:</b> execute o Loop-AI como Administrador (iniciar-admin.bat) para incluir logons/bloqueios (Segurança) e Prefetch.</div>') +
    '<div class="alert info">ℹ️ Relatório de uso/atividade. Não avalia problemas do PC (use o diagnóstico) e não lê senhas. Utilize apenas em equipamento que você está autorizado a auditar.</div>';
  return D.page({
    title: `Relatório de uso — ${s.host || ''}${s.usuario ? ` (${s.usuario})` : ''}`, brand: 'Loop-AI',
    subtitle: `📅 Últimos ${dias} dias · Gerado: ${esc(hoje)} · ${esc(s.so || '')}`,
    meta: [`📅 ${hoje}`, `🖥️ ${s.host || ''}`, `👤 ${s.usuario || ''}`, d.meta?.admin ? '🔑 Administrador' : '🔑 Padrão ⚠️'], alerta, groups: grupos,
  });
}

function summarize(d, nav, tl = []) {
  const s = d.sistema || {}, dom = dominios(nav.visitas);
  const L = [
    `PC: ${s.host} | usuário ${s.usuario} | ${s.so} | gerado em ${d.meta?.geradoEm} | período ${d.meta?.dias} d | ${d.meta?.admin ? 'admin' : 'sem admin'}`,
    `Navegadores: ${nav.navegadores.map((n) => `${n.nome} (${n.visitas})`).join('; ') || 'nenhum lido'} | visitas ${nav.visitas.length} | sites distintos ${dom.length}`,
    `Top sites: ${dom.slice(0, 15).map((x) => `${x.dominio} (${x.visitas})`).join(', ')}`,
    `Pesquisas recentes: ${nav.buscas.slice(0, 15).map((b) => `"${b.termo}"`).join(', ') || '-'}`,
    `Arquivos acessados: ${arr(d.arquivosRecentes).length}; exemplos: ${arr(d.arquivosRecentes).slice(0, 8).map((a) => a.caminho || a.nome).join(' | ')}`,
    `Downloads: navegadores ${nav.downloads.length}, pasta Downloads ${arr(d.downloads).length}`,
    `Programas executados (UserAssist): ${arr(d.programasExecutados).length}; recentes: ${arr(d.programasExecutados).slice(0, 12).map((p) => p.programa.split('\\').pop()).join(', ')}`,
    `Sessões registradas: ${arr(d.sessoes).length}; USB já conectados: ${arr(d.usb).join(', ') || '-'}`,
    `Favoritos: ${nav.favoritos.length}; contas dos navegadores: ${nav.contas.map((c) => c.email).join(', ') || '-'}; histórico sincronizado: ${nav.visitas.filter((v) => v.sync).length}; URLs digitadas: ${nav.digitadas.length}; Timeline do Windows: ${tl.length}`,
    `Instalados no período: ${arr(d.programasInstalados).filter((p) => p.instalado >= new Date(Date.now() - (d.meta?.dias || 30) * 864e5).toISOString().slice(0, 10)).map((p) => p.nome).slice(0, 10).join('; ') || '-'}`,
    ...(nav.avisos.length ? ['', 'AVISOS: ' + nav.avisos.join(' | ')] : []),
  ];
  return L.join('\n').slice(0, 6000);
}

async function run({ days = 30 } = {}) {
  const [dados, nav, tl] = await Promise.all([runPS(PS, { LOOP_DAYS: String(days) }), lerNavegadores(days), lerTimelineWindows(days).catch(() => [])]);
  const dadosJson = {
    ...dados,
    navegadores: {
      resumo: nav.navegadores, avisos: nav.avisos, contas: nav.contas, topSites: dominios(nav.visitas).slice(0, 100), buscas: nav.buscas.slice(0, 500), downloads: nav.downloads,
      favoritos: nav.favoritos, digitadas: nav.digitadas, visitas: nav.visitas.slice(0, 5000).map((v) => ({ ...v, quando: fmt(v.ms) })),
    },
    timelineWindows: tl.slice(0, 1500).map((t) => ({ ...t, quando: fmt(t.ms) })),
  };
  return { dados: dadosJson, html: render(dados, nav, tl), resumo: summarize(dados, nav, tl) };
}

module.exports = { run, lerNavegadores, dominios };
