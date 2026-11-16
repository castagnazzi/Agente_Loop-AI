// Diagnóstico do PC (embutido, somente leitura, offline): varre problemas, considera o problema informado pelo técnico,
// lista evidências, causas prováveis e como corrigir, e gera um HTML imprimível. NÃO lê histórico de navegação/uso
// (isso é o relatório de uso: uso.js).
const { runPS, arr, esc, list } = require('./reportkit');
const D = require('./dashkit');

const PS = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$days = [int]$env:LOOP_DAYS; if ($days -lt 1) { $days = 30 }
$forense = $env:LOOP_FORENSE -eq '1'
$since = (Get-Date).AddDays(-$days)
$o = [ordered]@{}
function D($d) { if ($d) { ([datetime]$d).ToString('yyyy-MM-dd HH:mm:ss') } else { '' } }
function First($m) { if ($m) { (([string]$m) -split '\r?\n')[0] } else { '' } }
function Try-Do($name, [scriptblock]$sb) { try { $o[$name] = & $sb } catch { $o[$name] = $null; $o['_erro_' + $name] = $_.Exception.Message } }
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$o['meta'] = [ordered]@{ geradoEm = D (Get-Date); dias = $days; forense = $forense; admin = $admin }

Try-Do 'sistema' {
  $cs = Get-CimInstance Win32_ComputerSystem; $os = Get-CimInstance Win32_OperatingSystem; $bios = Get-CimInstance Win32_BIOS
  $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1; $bb = Get-CimInstance Win32_BaseBoard
  [ordered]@{
    host = $env:COMPUTERNAME; usuario = $env:USERNAME; fabricante = $cs.Manufacturer; modelo = $cs.Model
    so = $os.Caption; versao = $os.Version; build = $os.BuildNumber; instalacao = D $os.InstallDate; ultimoBoot = D $os.LastBootUpTime
    uptimeDias = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalDays, 1)
    cpu = $cpu.Name; nucleos = $cpu.NumberOfCores; threads = $cpu.NumberOfLogicalProcessors; clockAtual = $cpu.CurrentClockSpeed; clockMax = $cpu.MaxClockSpeed
    ramGB = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1); ramLivreGB = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
    gpu = @(Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name + ' (drv ' + $_.DriverVersion + ' de ' + (D $_.DriverDate) + ')' })
    placaMae = ($bb.Manufacturer + ' ' + $bb.Product); bios = $bios.SMBIOSBIOSVersion; serial = $bios.SerialNumber
  }
}
Try-Do 'cargaCpu' { [math]::Round(((Get-Counter '\Processor(_Total)\% Processor Time' -SampleInterval 1 -MaxSamples 3).CounterSamples | Measure-Object CookedValue -Average).Average, 0) }
Try-Do 'volumes' { @(Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DriveType -in 2,3 } | ForEach-Object { [ordered]@{ letra = $_.DeviceID; nome = $_.VolumeName; fs = $_.FileSystem; tipo = $(if ($_.DriveType -eq 2) { 'removivel' } else { 'fixo' }); totalGB = [math]::Round($_.Size / 1GB, 1); livreGB = [math]::Round($_.FreeSpace / 1GB, 1) } }) }
Try-Do 'discos' { @(Get-PhysicalDisk | ForEach-Object { $r = $_ | Get-StorageReliabilityCounter; [ordered]@{ nome = $_.FriendlyName; midia = [string]$_.MediaType; saude = [string]$_.HealthStatus; sizeGB = [math]::Round($_.Size / 1GB, 0); tempC = $r.Temperature; desgaste = $r.Wear; errosLeitura = $r.ReadErrorsTotal; horas = $r.PowerOnHours } }) }
Try-Do 'discoSistema' { [string](Get-Partition -DriveLetter C | Get-Disk | Get-PhysicalDisk | Select-Object -First 1).MediaType }
Try-Do 'discoEventos' { @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'disk', 'Ntfs', 'Microsoft-Windows-Ntfs', 'volmgr', 'storahci', 'stornvme', 'storport', 'partmgr', 'iaStorA', 'iaStorAC'; Level = 1, 2, 3; Id = 7, 11, 51, 55, 129, 153; StartTime = $since } -MaxEvents 200 | Group-Object Id | ForEach-Object { [ordered]@{ id = [int]$_.Name; qtd = $_.Count; ultimo = D ($_.Group | Select-Object -First 1).TimeCreated; fonte = ($_.Group | Select-Object -First 1).ProviderName; exemplo = First ($_.Group | Select-Object -First 1).Message } }) }
Try-Do 'temperatura' { $t = Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature; if ($t) { @($t | ForEach-Object { [math]::Round(($_.CurrentTemperature / 10) - 273.15, 0) }) } else { $null } }
Try-Do 'bateria' {
  $f = Get-CimInstance -Namespace root/wmi -ClassName BatteryFullChargedCapacity; $s = Get-CimInstance -Namespace root/wmi -ClassName BatteryStaticData
  if ($f -and $s) { [ordered]@{ projetadaMWh = $s.DesignedCapacity; cheiaMWh = $f.FullChargedCapacity } } else { $null }
}
Try-Do 'energia' { [ordered]@{ plano = First (powercfg /getactivescheme); inicializacaoRapida = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power').HiberbootEnabled } }
Try-Do 'rede' {
  $gw = (Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1).NextHop
  $px = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
  $hosts = @(Get-Content "$env:SystemRoot\System32\drivers\etc\hosts" | Where-Object { $_ -notmatch '^\s*#' -and $_.Trim() -ne '' -and $_ -notmatch '^\s*(127\.0\.0\.1|::1)\s+localhost\s*$' })
  [ordered]@{
    adaptadores = @(Get-NetAdapter | ForEach-Object { [ordered]@{ nome = $_.Name; estado = [string]$_.Status; velocidade = $_.LinkSpeed } })
    ips = @(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | ForEach-Object { $_.InterfaceAlias + ': ' + $_.IPAddress })
    gateway = $gw
    dns = @(Get-DnsClientServerAddress -AddressFamily IPv4 | ForEach-Object { $_.ServerAddresses } | Sort-Object -Unique)
    pingGateway = $(if ($gw) { [bool](Test-Connection $gw -Count 1 -Quiet) } else { $false })
    pingInternet = [bool](Test-Connection 1.1.1.1 -Count 1 -Quiet)
    resolveDns = [bool](Resolve-DnsName 'www.microsoft.com' -Type A -QuickTimeout)
    proxyAtivo = [bool]$px.ProxyEnable; proxy = [string]$px.ProxyServer
    hostsPersonalizado = $hosts
  }
}
Try-Do 'seguranca' {
  $mp = Get-MpComputerStatus; $fw = Get-NetFirewallProfile
  [ordered]@{
    defender = if ($mp) { [ordered]@{ antivirus = $mp.AntivirusEnabled; tempoReal = $mp.RealTimeProtectionEnabled; assinaturaIdadeDias = $mp.AntivirusSignatureAge; ultimaVarreduraRapida = D $mp.QuickScanEndTime } } else { $null }
    firewall = @($fw | ForEach-Object { [ordered]@{ perfil = [string]$_.Name; ativo = [bool]$_.Enabled } })
    hotfixes = @(Get-HotFix | Sort-Object InstalledOn -Descending | Select-Object -First 8 | ForEach-Object { [ordered]@{ id = $_.HotFixID; data = (D $_.InstalledOn) } })
    usuariosLocais = @(Get-LocalUser | ForEach-Object { [ordered]@{ nome = $_.Name; ativo = $_.Enabled; ultimoLogon = D $_.LastLogon } })
    administradores = @(Get-LocalGroupMember -SID 'S-1-5-32-544' | ForEach-Object { $_.Name })
  }
}
Try-Do 'windowsUpdate' {
  [ordered]@{
    servico = [string](Get-Service wuauserv).StartType
    rebootPendente = [bool]((Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired') -or (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending'))
    falhas = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-WindowsUpdateClient'; Id = 20; StartTime = $since } -MaxEvents 20 | ForEach-Object { (D $_.TimeCreated) + ' ' + (First $_.Message) })
  }
}
Try-Do 'eventosSistema' {
  @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 41, 1074, 6005, 6006, 6008; StartTime = $since } -MaxEvents 300 | ForEach-Object {
    $t = switch ($_.Id) { 41 { 'Reinício inesperado (Kernel-Power)' } 1074 { 'Desligamento/reinício solicitado' } 6005 { 'Sistema iniciado' } 6006 { 'Sistema encerrado normalmente' } 6008 { 'Desligamento inesperado' } default { 'Evento ' + $_.Id } }
    [ordered]@{ quando = D $_.TimeCreated; id = $_.Id; descricao = $t }
  })
}
Try-Do 'bootTempo' { @(Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-Diagnostics-Performance/Operational'; Id = 100; StartTime = $since } -MaxEvents 15 | ForEach-Object { $x = [xml]$_.ToXml(); [int](($x.Event.EventData.Data | Where-Object { $_.Name -eq 'BootTime' }).'#text') } | Where-Object { $_ -gt 0 }) }
Try-Do 'errosCriticos' {
  $ev = Get-WinEvent -FilterHashtable @{ LogName = 'System', 'Application'; Level = 1, 2; StartTime = $since } -MaxEvents 1500
  [ordered]@{
    total = @($ev).Count
    porFonte = @($ev | Group-Object ProviderName | Sort-Object Count -Descending | Select-Object -First 12 | ForEach-Object { [ordered]@{ fonte = $_.Name; qtd = $_.Count; ultimo = D ($_.Group | Select-Object -First 1).TimeCreated; exemplo = First ($_.Group | Select-Object -First 1).Message } })
  }
}
Try-Do 'crashes' { [ordered]@{
  minidumps = @(Get-ChildItem 'C:\Windows\Minidump\*.dmp' | Sort-Object LastWriteTime -Descending | Select-Object -First 10 | ForEach-Object { (D $_.LastWriteTime) + ' ' + $_.Name })
  bugchecks = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-WER-SystemErrorReporting'; Id = 1001; StartTime = $since } -MaxEvents 15 | ForEach-Object { (D $_.TimeCreated) + ' ' + (First $_.Message) })
  appCrashes = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; Id = 1000; StartTime = $since } -MaxEvents 60 | ForEach-Object { (D $_.TimeCreated) + ' ' + (First $_.Message) })
} }
Try-Do 'programas' {
  $keys = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
  @(Get-ItemProperty $keys | Where-Object { $_.DisplayName } | Sort-Object DisplayName -Unique | ForEach-Object {
    $d = ''; if ($_.InstallDate -match '^\d{8}$') { $d = $_.InstallDate.Substring(0,4) + '-' + $_.InstallDate.Substring(4,2) + '-' + $_.InstallDate.Substring(6,2) }
    [ordered]@{ nome = $_.DisplayName; versao = $_.DisplayVersion; editor = $_.Publisher; instalado = $d }
  })
}
Try-Do 'inicializacao' {
  $run = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run', 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run'
  $items = @(); foreach ($k in $run) { $p = Get-ItemProperty $k; if ($p) { $p.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' -and $_.Name -ne '(default)' } | ForEach-Object { $items += [ordered]@{ origem = $k -replace 'HKLM:|HKCU:', ''; nome = $_.Name; comando = [string]$_.Value } } } }
  $items
}
Try-Do 'processos' { @(Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 12 | ForEach-Object { [ordered]@{ nome = $_.ProcessName; memMB = [math]::Round($_.WorkingSet64 / 1MB, 0); pid = $_.Id } }) }
Try-Do 'impressoras' { [ordered]@{
  spooler = [string](Get-Service Spooler).Status
  impressoras = @(Get-Printer | ForEach-Object { $j = @(Get-PrintJob -PrinterName $_.Name).Count; [ordered]@{ nome = $_.Name; estado = [string]$_.PrinterStatus; trabalhosNaFila = $j } })
} }
if ($forense) {
  Try-Do 'tarefasAgendadas' { @(Get-ScheduledTask | Where-Object { $_.TaskPath -notlike '\Microsoft\*' -and $_.State -ne 'Disabled' } | ForEach-Object { [ordered]@{ nome = $_.TaskName; caminho = $_.TaskPath; estado = [string]$_.State; acao = (($_.Actions | ForEach-Object { $_.Execute + ' ' + $_.Arguments }) -join ' | ') } }) }
  Try-Do 'servicosTerceiros' { @(Get-CimInstance Win32_Service | Where-Object { $_.StartMode -eq 'Auto' -and $_.PathName -notmatch 'Windows\\|system32|SysWOW64|Microsoft' } | Select-Object -First 80 | ForEach-Object { [ordered]@{ nome = $_.Name; estado = $_.State; caminho = $_.PathName } }) }
  Try-Do 'ameacasDefender' { @(Get-MpThreatDetection | Sort-Object InitialDetectionTime -Descending | Select-Object -First 20 | ForEach-Object { [ordered]@{ quando = D $_.InitialDetectionTime; ameacaId = $_.ThreatID; recursos = (($_.Resources) -join '; ') } }) }
}
$o | ConvertTo-Json -Depth 5 -Compress
`;

// ---------------------------------------------------------------- temas (problema informado)
const THEMES = [
  { id: 'lento', titulo: 'Lentidão / travamentos', re: /lent|trav[ae]|demor|devagar|pesad|congel|engasg/i,
    manual: ['Verificar temperatura e limpar poeira/ventoinha (não dá para medir em todos os PCs).', 'Testar se a lentidão ocorre também logo após reiniciar e em modo de segurança.', 'Checar se é só em um programa ou no navegador (extensões, cache).', 'Rodar varredura completa de antivírus/adware.'] },
  { id: 'bsod', titulo: 'Tela azul', re: /tela azul|bsod|blue ?screen|stop code|erro fatal/i,
    manual: ['Anotar o código de parada exibido (ex.: DRIVER_IRQL_NOT_LESS_OR_EQUAL).', 'Lembrar o que mudou antes do problema (driver, atualização, hardware novo).', 'Testar a RAM com mdsched.exe ou MemTest86.'] },
  { id: 'reinicia', titulo: 'Reinicia / desliga sozinho', re: /reinic|desliga|apaga|sozinho|queda de energia|desligou/i,
    manual: ['Testar com outra fonte/carregador e outra tomada.', 'Ouvir/olhar as ventoinhas e medir a temperatura sob carga.', 'Em notebook, testar sem a bateria (se removível).'] },
  { id: 'internet', titulo: 'Internet / rede', re: /internet|rede|wi-?fi|wifi|sem conex|dns|navegar|ethernet|roteador/i,
    manual: ['Testar em outro dispositivo na mesma rede para isolar PC x roteador.', 'Reiniciar modem/roteador e testar por cabo.', 'Conferir se há VPN, proxy ou firewall de terceiros interferindo.'] },
  { id: 'disco', titulo: 'Disco / espaço / arquivos', re: /disco|\bhd\b|ssd|espa[çc]o|corromp|arquivo.*(sumiu|sumiram|apag)|clique/i,
    manual: ['Ouvir ruídos (cliques) no HD.', 'Ver o SMART completo com a ferramenta do fabricante ou CrystalDiskInfo.', 'Se há dados importantes: parar de usar o disco e fazer imagem/backup antes de qualquer reparo.'] },
  { id: 'virus', titulo: 'Vírus / propagandas / comportamento estranho', re: /v[ií]rus|malware|propaganda|an[uú]ncio|pop-?up|hack|spam|redirecion|estranho/i,
    manual: ['Rodar varredura offline do Defender e uma segunda opinião (ex.: Malwarebytes).', 'Revisar extensões do navegador e a página inicial.', 'Trocar senhas importantes a partir de outro dispositivo se houver suspeita de roubo de dados.'] },
  { id: 'boot', titulo: 'Inicialização lenta / não liga', re: /boot|inicializ|liga(r)? (devagar|lent)|demora para ligar|n[aã]o liga|n[aã]o inicia/i,
    manual: ['Observar em que etapa para (logo do fabricante, logo do Windows, tela de login).', 'Verificar ordem de boot na BIOS e se o disco é reconhecido.'] },
  { id: 'impressora', titulo: 'Impressora', re: /impress/i,
    manual: ['Conferir cabo/rede e se a impressora está online, com papel e sem erro no painel.', 'Reinstalar o driver do fabricante.'] },
  { id: 'update', titulo: 'Atualizações do Windows', re: /atualiza|windows update|update/i,
    manual: ['Rodar a solução de problemas do Windows Update.', 'Verificar espaço livre e data/hora do sistema.'] },
  { id: 'bateria', titulo: 'Bateria / carregamento', re: /bateria|carreg/i,
    manual: ['Testar outro carregador original.', 'Gerar o relatório de bateria: powercfg /batteryreport.'] },
  { id: 'programa', titulo: 'Programa travando / não abre', re: /programa|aplicativo|\bapp\b|fecha sozinho|n[aã]o abre/i,
    manual: ['Reinstalar o programa e atualizar .NET/Visual C++ se for o caso.', 'Executar como administrador e verificar o antivírus bloqueando.'] },
];

// ---------------------------------------------------------------- regras de análise
const ERRO_NOTAS = [
  [/NetBT/i, 'Conflito/registro de nome NetBIOS na rede (comum e geralmente inofensivo).', ['Desativar "NetBIOS sobre TCP/IP" no adaptador (Propriedades IPv4 > Avançado > WINS) se não usar compartilhamento antigo.', 'Verificar se há outro PC com o mesmo nome na rede.']],
  [/DCOM|DistributedCOM/i, 'Erros de permissão DCOM (ex.: ID 10016) costumam ser inofensivos.', ['Ignorar se não houver sintoma; só investigar se coincidir com travamentos.']],
  [/disk|storahci|stornvme|iaStor/i, 'Erros do driver/dispositivo de disco: possível falha do disco ou cabo/controlador.', ['Fazer backup, checar SMART e rodar chkdsk.', 'Atualizar driver SATA/NVMe e BIOS.']],
  [/Ntfs|volsnap|volmgr/i, 'Problemas no sistema de arquivos/volume.', ['Rodar chkdsk /f na unidade e sfc /scannow.', 'Conferir saúde do disco.']],
  [/WHEA/i, 'Erros de hardware reportados pelo processador/barramento (WHEA).', ['Verificar temperatura, desativar overclock, atualizar BIOS e testar RAM.']],
  [/Display|nvlddmkm|amdkmdap|igfx/i, 'Falhas do driver de vídeo.', ['Atualizar ou reinstalar o driver de vídeo (DDU em modo de segurança, se persistir).', 'Checar temperatura da GPU.']],
  [/Service Control Manager/i, 'Serviços falhando ao iniciar ou encerrar.', ['Identificar o serviço no log (Visualizador de Eventos) e reinstalar/atualizar o programa dono.']],
  [/HAL/i, 'Erros do HAL/ACPI (energia/hardware).', ['Atualizar BIOS e drivers de chipset.']],
];

const RULES = [
  { id: 'espaco', titulo: 'Pouco espaço livre em disco', temas: ['lento', 'disco', 'update', 'boot'],
    causas: ['Temporários, cache e downloads acumulados', 'Arquivos grandes (vídeos, backups, máquinas virtuais)', 'Arquivos de atualizações antigas e hibernação/paginação'],
    acoes: ['Executar Limpeza de Disco (cleanmgr) com "Limpar arquivos de sistema".', 'Apagar ou mover downloads e arquivos grandes para outro disco.', 'Desativar hibernação se não for usada: powercfg /h off.', 'Considerar um disco maior.'],
    check(d) { const v = arr(d.volumes).filter((x) => x.tipo === 'fixo' && x.totalGB > 0); if (!v.length) return undefined;
      const bad = v.map((x) => ({ x, p: (x.livreGB / x.totalGB) * 100 })).filter((o) => o.p < 20);
      if (!bad.length) return null; const worst = Math.min(...bad.map((o) => o.p));
      return { sev: worst < 10 ? 'alta' : 'média', evid: bad.map((o) => `${o.x.letra} com ${o.x.livreGB} GB livres de ${o.x.totalGB} GB (${o.p.toFixed(0)}%)`).join('; ') }; } },
  { id: 'saudeDisco', titulo: 'Disco com sinais de falha', temas: ['disco', 'lento', 'bsod', 'reinicia', 'boot'], sev: 'alta',
    causas: ['Setores defeituosos ou falha iminente do HD/SSD', 'Cabo/conexão SATA ou controlador com problema', 'Desligamentos bruscos corrompendo o sistema de arquivos'],
    acoes: ['FAZER BACKUP dos dados importantes antes de qualquer outra ação.', 'Agendar chkdsk /f /r na unidade e rodar sfc /scannow.', 'Conferir o SMART com a ferramenta do fabricante ou CrystalDiskInfo.', 'Substituir o disco se houver setores realocados/pendentes ou saúde diferente de Healthy.'],
    check(d) { if (d.discos == null && d.discoEventos == null) return undefined; const e = [];
      for (const k of arr(d.discos)) { if (k.saude && k.saude !== 'Healthy') e.push(`"${k.nome}" com saúde "${k.saude}"`); if (k.errosLeitura > 0) e.push(`"${k.nome}" com ${k.errosLeitura} erro(s) de leitura`); if (k.desgaste != null && k.desgaste > 80) e.push(`"${k.nome}" com desgaste de ${k.desgaste}%`); }
      for (const x of arr(d.discoEventos)) e.push(`evento ${x.id} (${x.fonte}) ${x.qtd}x, último em ${x.ultimo}: ${x.exemplo}`);
      return e.length ? { evid: e.join('; ') } : null; } },
  { id: 'hdd', titulo: 'Windows instalado em HD mecânico', temas: ['lento', 'boot'], sev: 'média',
    causas: ['HD mecânico é muito mais lento que SSD para abrir programas e iniciar o Windows'],
    acoes: ['Migrar/clonar o Windows para um SSD (maior ganho de desempenho possível).', 'Enquanto isso: reduzir programas na inicialização e desativar indexação pesada.'],
    check(d) { if (!d.discoSistema) return undefined; return /HDD/i.test(d.discoSistema) ? { evid: 'A unidade C: está em um disco do tipo HDD.' } : null; } },
  { id: 'memoria', titulo: 'Pouca memória RAM disponível', temas: ['lento', 'programa'],
    causas: ['RAM insuficiente para o uso atual', 'Muitos programas/abas abertos', 'Processo com vazamento de memória'],
    acoes: ['Fechar programas pesados (veja a lista de maiores consumos).', 'Ampliar a RAM (conferir tipo e slots livres).', 'Reiniciar para liberar vazamentos e atualizar o programa que mais consome.'],
    check(d) { const s = d.sistema; if (!s?.ramGB) return undefined; const e = []; let sev = 'baixa';
      if (s.ramGB < 8) e.push(`${s.ramGB} GB instalados`); if (s.ramLivreGB / s.ramGB < 0.15) { e.push(`apenas ${s.ramLivreGB} GB livres agora`); sev = 'média'; }
      return e.length ? { sev, evid: e.join('; ') } : null; } },
  { id: 'cpu', titulo: 'Processador muito carregado ou reduzindo velocidade', temas: ['lento', 'reinicia'], sev: 'média',
    causas: ['Programa/processo consumindo CPU em segundo plano', 'Superaquecimento fazendo o processador reduzir o clock (thermal throttling)', 'Plano de energia em economia'],
    acoes: ['Identificar o processo no Gerenciador de Tarefas e tratar/remover.', 'Limpar poeira, trocar pasta térmica e conferir o cooler.', 'Usar o plano de energia "Equilibrado"/"Alto desempenho".'],
    check(d) { const e = []; if (d.cargaCpu > 85) e.push(`uso médio de CPU em ${d.cargaCpu}% durante a coleta`);
      const s = d.sistema; if (s?.clockMax && s.clockAtual && s.clockAtual < s.clockMax * 0.5 && d.cargaCpu > 50) e.push(`clock em ${s.clockAtual} MHz de ${s.clockMax} MHz com carga alta (possível throttling)`);
      if (d.cargaCpu == null && !s) return undefined; return e.length ? { evid: e.join('; ') } : null; } },
  { id: 'temperatura', titulo: 'Temperatura alta', temas: ['lento', 'reinicia', 'bsod'], sev: 'alta',
    causas: ['Poeira, ventoinha parada ou pasta térmica ressecada'], acoes: ['Limpeza interna, troca da pasta térmica e teste do cooler.', 'Monitorar a temperatura sob carga (HWiNFO).'],
    check(d) { if (!arr(d.temperatura).length) return undefined; const t = Math.max(...arr(d.temperatura)); return t >= 85 ? { evid: `sensor ACPI em ${t} °C` } : null; } },
  { id: 'inicializacao', titulo: 'Muitos programas iniciando com o Windows', temas: ['lento', 'boot'], sev: 'baixa',
    causas: ['Aplicativos que se registram para iniciar automaticamente'],
    acoes: ['Gerenciador de Tarefas > Inicializar: desativar o que não for essencial.'],
    check(d) { if (d.inicializacao == null) return undefined; const n = arr(d.inicializacao).length; return n > 12 ? { evid: `${n} itens na inicialização (Run)` } : null; } },
  { id: 'bootLento', titulo: 'Inicialização do Windows demorada', temas: ['boot', 'lento'], sev: 'média',
    causas: ['Muitos itens na inicialização', 'HD mecânico', 'Drivers/serviços lentos'], acoes: ['Reduzir itens da inicialização; avaliar SSD; atualizar drivers.'],
    check(d) { const b = arr(d.bootTempo); if (!b.length) return undefined; const m = b.reduce((a, c) => a + c, 0) / b.length / 1000; return m > 60 ? { evid: `tempo médio de boot de ${m.toFixed(0)} s em ${b.length} inicialização(ões)` } : null; } },
  { id: 'uptime', titulo: 'PC sem reiniciar há muito tempo', temas: ['lento'], sev: 'baixa',
    causas: ['Vazamentos de memória e atualizações pendentes acumulados'], acoes: ['Reiniciar o PC; considerar desativar a Inicialização Rápida se o sintoma persistir.'],
    check(d) { const u = d.sistema?.uptimeDias; if (u == null) return undefined; return u > 30 ? { evid: `ligado há ${u} dias` } : null; } },
  { id: 'desligamentos', titulo: 'Desligamentos/reinícios inesperados', temas: ['reinicia', 'bsod'],
    causas: ['Queda de energia ou fonte/bateria com defeito', 'Superaquecimento (poeira, pasta térmica, cooler)', 'Driver/firmware com falha', 'RAM ou disco com defeito', 'Inicialização Rápida conflitando com drivers'],
    acoes: ['Testar com outra fonte/tomada (notebook: outro carregador, sem bateria se possível).', 'Limpar poeira, conferir ventoinhas e monitorar temperatura.', 'Testar a memória (mdsched.exe) e checar o disco (SMART/chkdsk).', 'Atualizar BIOS e drivers (chipset, vídeo); desativar a Inicialização Rápida.', 'Analisar os dumps (BlueScreenView/WinDbg) se existirem.'],
    check(d) { if (d.eventosSistema == null) return undefined; const x = arr(d.eventosSistema).filter((e) => e.id === 41 || e.id === 6008);
      return x.length ? { sev: x.length >= 3 ? 'alta' : 'média', evid: `${x.length} ocorrência(s); mais recentes: ${x.slice(0, 4).map((e) => e.quando + ' (' + e.descricao + ')').join('; ')}` } : null; } },
  { id: 'bsod', titulo: 'Telas azuis registradas', temas: ['bsod', 'reinicia'], sev: 'alta',
    causas: ['Driver incompatível ou defeituoso (causa mais comum)', 'RAM ou disco com falha', 'Atualização recente problemática', 'Superaquecimento/overclock'],
    acoes: ['Anotar o código de parada (BugCheck) e identificar o driver associado.', 'Atualizar ou reverter o driver recente (vídeo, rede, chipset).', 'Rodar mdsched.exe, sfc /scannow e DISM /Online /Cleanup-Image /RestoreHealth.', 'Desinstalar a atualização recente se o problema começou depois dela.'],
    check(d) { if (!d.crashes) return undefined; const m = arr(d.crashes.minidumps), b = arr(d.crashes.bugchecks); if (!m.length && !b.length) return null;
      return { evid: `${m.length} dump(s) em C:\\Windows\\Minidump${m[0] ? ' (mais recente: ' + m[0] + ')' : ''}; ${b.length} BugCheck(s) no log${b[0] ? ': ' + b[0] : ''}` }; } },
  { id: 'defender', titulo: 'Proteção antivírus desativada ou desatualizada', temas: ['virus'],
    causas: ['Defender desativado manualmente, por outro antivírus ou por malware', 'Sem atualização de assinaturas'],
    acoes: ['Ativar a proteção em tempo real (ou confirmar que há outro antivírus ativo).', 'Atualizar as definições e rodar varredura completa.'],
    check(d) { const f = d.seguranca?.defender; if (!d.seguranca) return undefined; if (!f) return { sev: 'baixa', evid: 'Status do Defender indisponível (outro antivírus ou falta de permissão).' };
      const e = []; let sev = 'média'; if (f.antivirus === false || f.tempoReal === false) { e.push('proteção em tempo real desativada'); sev = 'alta'; } if (f.assinaturaIdadeDias > 7) e.push(`assinaturas com ${f.assinaturaIdadeDias} dias`);
      return e.length ? { sev, evid: e.join('; ') } : null; } },
  { id: 'firewall', titulo: 'Firewall do Windows desativado', temas: ['virus', 'internet'], sev: 'média',
    causas: ['Desativado manualmente ou por software de terceiros'], acoes: ['Reativar o firewall (ou confirmar firewall de terceiros ativo).'],
    check(d) { const f = arr(d.seguranca?.firewall); if (!f.length) return undefined; const off = f.filter((p) => p.ativo === false); return off.length ? { evid: `perfil(is) desativado(s): ${off.map((p) => p.perfil).join(', ')}` } : null; } },
  { id: 'ameacas', titulo: 'Ameaças detectadas pelo Defender', temas: ['virus'], sev: 'alta',
    causas: ['Malware/adware executado ou baixado'], acoes: ['Verificar no Defender se foram removidas; fazer varredura completa/offline; revisar origem (downloads, extensões).'],
    check(d) { if (d.ameacasDefender === undefined) return undefined; const a = arr(d.ameacasDefender); return a.length ? { evid: a.slice(0, 5).map((x) => `${x.quando}: ${String(x.recursos).slice(0, 100)}`).join('; ') } : null; } },
  { id: 'tarefasSuspeitas', titulo: 'Tarefas agendadas de terceiros executando interpretadores', temas: ['virus'], sev: 'média',
    causas: ['Persistência de malware/adware ou automações legítimas'], acoes: ['Conferir cada tarefa, o autor e o executável; desativar as desconhecidas.'],
    check(d) { if (d.tarefasAgendadas === undefined) return undefined; const t = arr(d.tarefasAgendadas).filter((x) => /powershell|cmd\.exe|wscript|mshta|rundll32/i.test(x.acao)); return t.length ? { evid: t.slice(0, 5).map((x) => `${x.nome} → ${String(x.acao).slice(0, 100)}`).join('; ') } : null; } },
  { id: 'proxyHosts', titulo: 'Proxy ativo ou arquivo hosts alterado', temas: ['virus', 'internet'], sev: 'média',
    causas: ['Malware/adware redirecionando tráfego', 'Proxy corporativo/VPN legítimo'], acoes: ['Desativar proxy em Configurações > Rede > Proxy se não for esperado.', 'Revisar e limpar entradas desconhecidas do arquivo hosts.'],
    check(d) { if (!d.rede) return undefined; const e = []; if (d.rede.proxyAtivo) e.push(`proxy ativo: ${d.rede.proxy}`); const h = arr(d.rede.hostsPersonalizado); if (h.length) e.push(`hosts com ${h.length} entrada(s): ${h.slice(0, 4).join(' | ')}`); return e.length ? { evid: e.join('; ') } : null; } },
  { id: 'rede', titulo: 'Falha de conectividade de rede', temas: ['internet'], sev: 'alta',
    causas: ['Cabo/Wi-Fi ou roteador com problema (sem resposta do gateway)', 'Provedor sem internet (gateway responde, internet não)', 'DNS com falha (internet responde por IP, mas não resolve nomes)', 'Adaptador desativado ou driver com problema'],
    acoes: ['Conferir cabo/sinal Wi-Fi e reiniciar modem/roteador.', 'Se só o DNS falha: ipconfig /flushdns e trocar DNS (ex.: 1.1.1.1 / 8.8.8.8).', 'Reiniciar o adaptador e atualizar/reinstalar o driver de rede; netsh winsock reset e netsh int ip reset.', 'Testar em outro dispositivo para isolar PC x rede.'],
    check(d) { const r = d.rede; if (!r) return undefined; const e = []; if (!arr(r.ips).length) e.push('nenhum IP IPv4 válido atribuído');
      else if (!r.pingGateway) e.push(`gateway ${r.gateway || '?'} não respondeu ao ping`); else if (!r.pingInternet) e.push('gateway responde, mas a internet (1.1.1.1) não'); else if (!r.resolveDns) e.push('internet responde por IP, mas o DNS não resolve nomes');
      const down = arr(r.adaptadores).filter((a) => a.estado && a.estado !== 'Up' && !/Bluetooth|Virtual|Loopback/i.test(a.nome)); if (down.length && e.length) e.push(`adaptador(es) fora de operação: ${down.map((a) => a.nome).join(', ')}`);
      return e.length ? { evid: e.join('; ') } : null; } },
  { id: 'windowsUpdate', titulo: 'Problemas com o Windows Update', temas: ['update', 'lento'], sev: 'média',
    causas: ['Reinício pendente', 'Falhas repetidas de instalação', 'Serviço de atualização desativado', 'Pouco espaço em disco'],
    acoes: ['Reiniciar o PC para concluir pendências.', 'Executar a solução de problemas do Windows Update; limpar C:\\Windows\\SoftwareDistribution com os serviços parados.', 'Verificar o serviço Windows Update (wuauserv) e o espaço livre.'],
    check(d) { const w = d.windowsUpdate; if (!w) return undefined; const e = []; if (w.rebootPendente) e.push('reinício pendente'); const f = arr(w.falhas); if (f.length >= 3) e.push(`${f.length} falha(s) de instalação no período (ex.: ${f[0]})`); if (/Disabled/i.test(w.servico)) e.push('serviço Windows Update desativado');
      const h = arr(d.seguranca?.hotfixes)[0]; if (h && Date.now() - new Date(h.data).getTime() > 90 * 864e5) e.push(`última atualização instalada em ${h.data}`); return e.length ? { evid: e.join('; ') } : null; } },
  { id: 'impressora', titulo: 'Problemas de impressão', temas: ['impressora'], sev: 'média',
    causas: ['Serviço Spooler parado', 'Fila travada', 'Impressora offline/driver incorreto'],
    acoes: ['Reiniciar o Spooler e limpar a fila (net stop spooler; apagar C:\\Windows\\System32\\spool\\PRINTERS\\*; net start spooler).', 'Reinstalar o driver do fabricante; conferir cabo/rede.'],
    check(d) { const p = d.impressoras; if (!p) return undefined; const e = []; if (p.spooler && p.spooler !== 'Running') e.push(`Spooler está "${p.spooler}"`); for (const i of arr(p.impressoras)) { if (i.trabalhosNaFila > 0) e.push(`${i.trabalhosNaFila} trabalho(s) na fila de "${i.nome}"`); if (i.estado && !/Normal/i.test(i.estado)) e.push(`"${i.nome}" em estado ${i.estado}`); } return e.length ? { evid: e.join('; ') } : null; } },
  { id: 'appCrashes', titulo: 'Programas travando repetidamente', temas: ['programa', 'lento'], sev: 'média',
    causas: ['Programa corrompido/desatualizado', 'Conflito com antivírus ou driver', 'Arquivos de sistema ou RAM com problema'],
    acoes: ['Atualizar ou reinstalar o programa (e .NET/Visual C++ se aplicável).', 'Rodar sfc /scannow e testar a memória.', 'Ver detalhes no Visualizador de Eventos > Aplicativo (ID 1000).'],
    check(d) { if (!d.crashes) return undefined; const c = {}; for (const l of arr(d.crashes.appCrashes)) { const m = l.match(/:\s*([^,]+?),/); if (m) c[m[1].trim()] = (c[m[1].trim()] || 0) + 1; }
      const t = Object.entries(c).filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]); return t.length ? { evid: t.slice(0, 5).map(([a, n]) => `${a}: ${n} falhas`).join('; ') } : null; } },
  { id: 'bateria', titulo: 'Bateria com desgaste elevado', temas: ['bateria', 'reinicia'], sev: 'média',
    causas: ['Desgaste natural dos ciclos de carga'], acoes: ['Substituir a bateria; usar apenas carregador original.'],
    check(d) { const b = d.bateria; if (!b?.projetadaMWh) return undefined; const w = 100 - (b.cheiaMWh / b.projetadaMWh) * 100; return w > 40 ? { evid: `capacidade atual ${b.cheiaMWh} mWh de ${b.projetadaMWh} mWh projetados (desgaste ≈ ${w.toFixed(0)}%)` } : null; } },
  { id: 'erros', titulo: 'Volume alto de erros nos logs', temas: [], sev: 'média',
    causas: ['Depende da fonte; veja a nota de cada uma'], acoes: ['Investigar a fonte principal no Visualizador de Eventos.'],
    check(d) { if (!d.errosCriticos) return undefined; const top = arr(d.errosCriticos.porFonte).filter((f) => f.qtd >= 20).slice(0, 3); if (!top.length) return null;
      return { evid: top.map((f) => `${f.fonte} (${f.qtd}x, último ${f.ultimo}): ${String(f.exemplo).slice(0, 140)}`).join(' || '),
        extraCausas: top.flatMap((f) => ERRO_NOTAS.filter((n) => n[0].test(f.fonte)).map((n) => `${f.fonte}: ${n[1]}`)),
        extraAcoes: top.flatMap((f) => ERRO_NOTAS.filter((n) => n[0].test(f.fonte)).flatMap((n) => n[2])) }; } },
  { id: 'admins', titulo: 'Muitas contas administradoras', temas: ['virus'], sev: 'baixa',
    causas: ['Contas criadas por usuários, instaladores ou terceiros'], acoes: ['Remover privilégio de administrador das contas desnecessárias.'],
    check(d) { const a = arr(d.seguranca?.administradores); if (!d.seguranca) return undefined; return a.length > 2 ? { evid: `${a.length} contas: ${a.join(', ')}` } : null; } },
];

/** Roda todas as regras. Retorna { achados[], porRegra{id->estado} } onde estado = 'achado' | 'ok' | 'indisponivel'. */
function analisar(d) {
  const achados = [], estado = {};
  for (const r of RULES) {
    let res; try { res = r.check(d); } catch { res = undefined; }
    if (res === undefined) { estado[r.id] = 'indisponivel'; continue; }
    if (res === null) { estado[r.id] = 'ok'; continue; }
    estado[r.id] = 'achado';
    achados.push({ id: r.id, sev: res.sev || r.sev || 'média', titulo: r.titulo, evid: res.evid, temas: r.temas,
      causas: [...r.causas, ...(res.extraCausas || [])], acoes: [...r.acoes, ...(res.extraAcoes || [])] });
  }
  const ordem = { alta: 0, média: 1, baixa: 2, info: 3 };
  achados.sort((a, b) => ordem[a.sev] - ordem[b.sev]);
  if (d.meta && !d.meta.admin) achados.push({ id: 'semAdmin', sev: 'info', titulo: 'Coleta sem privilégios de administrador', evid: 'Alguns dados (SMART detalhado, sensores, eventos de segurança) podem estar incompletos.', temas: [], causas: [], acoes: ['Executar o Loop-AI como Administrador (iniciar-admin.bat) e repetir o diagnóstico.'] });
  return { achados, estado };
}

function detectarTemas(problema) { return THEMES.filter((t) => t.re.test(problema || '')); }

function renderCard(a) {
  return `<div class="fd ${a.sev}"><h4><span class="sev">${esc(a.sev)}</span>${esc(a.titulo)}</h4>` +
    (a.evid ? `<div class="evid"><b class="t">Evidência</b> ${esc(a.evid)}</div>` : '') +
    (a.causas?.length ? `<b class="t">Causas possíveis</b>${list(a.causas)}` : '') +
    (a.acoes?.length ? `<b class="t">O que fazer</b><ol>${a.acoes.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>` : '') + '</div>';
}

const brData = (s) => { const m = /^(\d{4})-(\d\d)-(\d\d)(.*)$/.exec(s || ''); return m ? `${m[3]}/${m[2]}/${m[1]}${m[4]}` : s || ''; };
const kv = (pairs) => D.dtable([['k', 'Item'], ['v', 'Valor']], pairs.filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => ({ k, v })), { placeholder: 'Pesquisar…' });
const tb = (cols, rows, max = 1000) => D.dtable(cols, rows, { max });

function render(d, { problema = '', temas = [], analise }) {
  const s = d.sistema || {}, an = analise || analisar(d), hoje = brData(d.meta?.geradoEm);
  const vol = arr(d.volumes).find((v) => v.letra === 'C:') || {};
  const sevCount = (k) => an.achados.filter((a) => a.sev === k).length;
  const evs = arr(d.eventosSistema);
  const inesperados = evs.filter((e) => Number(e.id) === 41 || Number(e.id) === 6008).length;
  const energia = evs.filter((e) => [6005, 6006, 6008, 41].includes(Number(e.id))).slice(0, 40).map((e) => {
    const id = Number(e.id), ruim = id === 41 || id === 6008;
    return { cls: ruim ? 'tl-crash' : id === 6005 ? 'tl-on' : 'tl-off', ico: ruim ? '⚠️' : id === 6005 ? '🟢' : '🔴', rot: ruim ? 'Desligamento inesperado' : id === 6005 ? 'Ligado' : 'Desligado', quando: brData(e.quando) };
  });
  const fontes = arr(d.errosCriticos?.porFonte).slice(0, 10).map((f) => ({ l: f.fonte, v: f.qtd }));
  const discos = arr(d.volumes).map((v) => ({ letra: v.letra, nome: v.nome, totalGB: v.totalGB, livreGB: v.livreGB, usadoGB: Math.round((v.totalGB - v.livreGB) * 10) / 10 }));
  const sevItems = [['alta', 'Alta', '#ef476f'], ['média', 'Média', '#ffd166'], ['baixa', 'Baixa', '#4cc9f0']].map(([k, l, c]) => ({ l, v: sevCount(k), c })).filter((x) => x.v > 0);
  const nAlta = sevCount('alta');
  const veredito = nAlta ? `⚠️ ${nAlta} problema(s) de prioridade alta` : sevCount('média') ? 'Atenção: há pontos de prioridade média' : an.achados.length ? 'Sem problemas graves — apenas observações' : '✅ Nenhum problema evidente';

  const grupos = [];
  const resumo = { id: 'resumo', ico: '📊', title: 'Resumo do diagnóstico', sub: `Gerado em ${esc(hoje)} · últimos ${d.meta?.dias} dias · ${esc(veredito)}`, html:
    `<div class="grid g6">${D.kpi('🔴', nAlta, 'Achados: alta')}${D.kpi('🟠', sevCount('média'), 'Achados: média')}${D.kpi('🔵', sevCount('baixa'), 'Achados: baixa')}` +
    `${D.kpi('⚠️', inesperados, 'Desligamentos inesperados')}${D.kpi('🧾', d.errosCriticos?.total ?? '-', 'Erros críticos nos logs')}${D.kpi('💿', vol.totalGB ? `${Math.round(vol.livreGB)} GB` : '-', 'Livre em C:')}` +
    `${D.kpi('🧠', s.ramGB ? `${s.ramLivreGB} GB` : '-', `RAM livre (de ${s.ramGB} GB)`)}${D.kpi('⚙️', d.cargaCpu != null ? `${d.cargaCpu}%` : '-', 'Carga de CPU')}${D.kpi('⏳', s.uptimeDias != null ? `${s.uptimeDias} d` : '-', 'Ligado há')}</div>` +
    `<div class="alert info">🛠️ <b>Problema informado:</b> ${problema ? esc(problema) : 'nenhum — varredura geral'}</div>` +
    `<div class="grid g3">${D.card('🩺 Achados por prioridade', D.donut(sevItems, { label: 'achados' }))}${D.card('🧾 Erros críticos por fonte', D.hbars(fontes))}${D.card('⚡ Ligar / desligar', D.timeline(energia))}</div>` +
    `<div class="grid g2e">${D.card('💿 Espaço em disco', D.disks(discos))}${D.card('🖥️ Equipamento', D.info([['Computador', s.host], ['Modelo', `${s.fabricante || ''} ${s.modelo || ''}`.trim()], ['Sistema', `${s.so || ''} (build ${s.build || ''})`], ['Processador', s.cpu], ['Executado como', d.meta?.admin ? 'Administrador' : 'Usuário comum (dados parciais)'], ['Modo', d.meta?.forense ? 'Forense (inclui persistência)' : 'Padrão']]))}</div>` };

  const items = [resumo];
  if (problema) {
    const blocos = temas.map((t) => {
      const regras = RULES.filter((r) => r.temas.includes(t.id));
      const achados = an.achados.filter((a) => a.temas.includes(t.id));
      const ok = regras.filter((r) => an.estado[r.id] === 'ok').map((r) => r.titulo);
      const nv = regras.filter((r) => an.estado[r.id] === 'indisponivel').map((r) => r.titulo);
      return `<h3 class="h3">${esc(t.titulo)}</h3>` +
        (achados.length ? achados.map(renderCard).join('') : '<p class="vazio">Nenhuma evidência objetiva encontrada pelas verificações automáticas para este tipo de problema.</p>') +
        (ok.length ? `<p class="ok"><b>Verificado, sem indício:</b> ${esc(ok.join('; '))}.</p>` : '') +
        (nv.length ? `<p class="nao"><b>Não foi possível verificar:</b> ${esc(nv.join('; '))}.</p>` : '') +
        `<b class="t" style="display:block;font-size:.68rem;text-transform:uppercase;letter-spacing:1px;color:var(--text2);margin:10px 0 3px">Verificações manuais recomendadas</b>${list(t.manual)}`;
    });
    items.push({ id: 'problema', ico: '🛠️', title: 'Análise do problema informado', sub: esc(problema), html: temas.length ? blocos.join('') :
      '<p class="vazio">O texto informado não corresponde a uma categoria conhecida; veja os achados gerais e descreva o sintoma com mais detalhes (quando começou, o que mudou, mensagens exibidas).</p>' });
  }
  items.push({ id: 'achados', ico: '🩺', title: 'Achados e como corrigir', sub: `${an.achados.length} achado(s): evidência, causas possíveis e passos`, html:
    an.achados.length ? an.achados.map(renderCard).join('') : '<p class="vazio">Nenhum problema evidente encontrado pelas verificações automáticas.</p>' });
  grupos.push({ label: 'Visão geral', items });

  grupos.push({ label: 'Sistema', items: [
    { id: 'sistema', ico: '💻', title: 'Dados do PC', sub: 'Hardware, sistema e energia', html: kv([['Fabricante / modelo', `${s.fabricante || ''} ${s.modelo || ''}`], ['Placa-mãe', s.placaMae], ['BIOS / serial', `${s.bios || ''} / ${s.serial || ''}`], ['Usuário', s.usuario], ['Sistema', `${s.so || ''} (build ${s.build || ''})`], ['Processador', s.cpu], ['Núcleos/threads', `${s.nucleos}/${s.threads}`], ['Memória', `${s.ramGB} GB (${s.ramLivreGB} livres)`], ['Instalação do Windows', brData(s.instalacao)], ['Último boot', brData(s.ultimoBoot)], ['Tempo ligado', `${s.uptimeDias} dias`], ['GPU / driver', arr(s.gpu).join(' | ')], ['Plano de energia', d.energia?.plano], ['Inicialização rápida', d.energia?.inicializacaoRapida]]) },
    { id: 'discos', ico: '💿', title: 'Discos e volumes', sub: 'Capacidade e saúde física', html: tb([['letra', 'Unid.'], ['nome', 'Nome'], ['tipo', 'Tipo'], ['fs', 'Sistema'], ['totalGB', 'Total GB'], ['livreGB', 'Livre GB']], d.volumes) + '<h3 class="h3">Saúde física</h3>' + tb([['nome', 'Disco'], ['midia', 'Mídia'], ['saude', 'Saúde'], ['sizeGB', 'GB'], ['tempC', '°C'], ['desgaste', 'Desgaste %'], ['errosLeitura', 'Erros leitura'], ['horas', 'Horas ligado']], d.discos) },
    { id: 'rede', ico: '🔌', title: 'Rede', sub: 'Adaptadores, conectividade, DNS e proxy', html: kv([['Adaptadores', arr(d.rede?.adaptadores).map((a) => `${a.nome} (${a.estado})`).join('; ')], ['IPs', arr(d.rede?.ips).join('; ')], ['Gateway', d.rede?.gateway], ['DNS', arr(d.rede?.dns).join(', ')], ['Ping gateway', d.rede?.pingGateway], ['Ping internet (1.1.1.1)', d.rede?.pingInternet], ['Resolução DNS', d.rede?.resolveDns], ['Proxy', d.rede?.proxyAtivo ? d.rede.proxy : 'desativado']]) },
    { id: 'seguranca', ico: '🛡️', title: 'Segurança', sub: 'Defender, firewall, contas e atualizações', html: '<h3 class="h3">Defender</h3>' + (d.seguranca?.defender ? kv(Object.entries(d.seguranca.defender)) : '<p class="vazio">Indisponível.</p>') + '<h3 class="h3">Firewall</h3>' + tb([['perfil', 'Perfil'], ['ativo', 'Ativo']], d.seguranca?.firewall) + '<h3 class="h3">Contas locais</h3>' + tb([['nome', 'Conta'], ['ativo', 'Ativa'], ['ultimoLogon', 'Último logon']], d.seguranca?.usuariosLocais) + '<h3 class="h3">Administradores</h3>' + list(d.seguranca?.administradores) + '<h3 class="h3">Atualizações recentes</h3>' + tb([['id', 'KB'], ['data', 'Data']], d.seguranca?.hotfixes) },
    { id: 'programas', ico: '📦', title: 'Programas instalados', sub: `${arr(d.programas).length} programas`, html: tb([['nome', 'Programa'], ['versao', 'Versão'], ['editor', 'Editor'], ['instalado', 'Instalado em']], d.programas) },
    { id: 'inicializacao', ico: '🚀', title: 'Inicialização automática', sub: 'Programas que iniciam com o Windows (Run)', html: tb([['origem', 'Origem'], ['nome', 'Nome'], ['comando', 'Comando']], d.inicializacao) },
    { id: 'processos', ico: '🧠', title: 'Maiores consumos de memória', sub: 'Processos em execução', html: tb([['nome', 'Processo'], ['memMB', 'MB'], ['pid', 'PID']], d.processos) },
  ] });

  grupos.push({ label: 'Eventos e falhas', items: [
    { id: 'eventos', ico: '⚡', title: 'Inicializações e desligamentos', sub: `${evs.length} eventos`, html: tb([['q', 'Data/hora', (r) => esc(brData(r.quando))], ['id', 'ID'], ['descricao', 'Evento']], evs, 500) },
    { id: 'erros', ico: '🧾', title: 'Erros críticos nos logs', sub: `Total no período: ${d.errosCriticos?.total ?? '-'}`, html: tb([['fonte', 'Fonte'], ['qtd', 'Qtd'], ['ultimo', 'Último', (r) => esc(brData(r.ultimo))], ['exemplo', 'Exemplo', (r) => esc(String(r.exemplo || '').slice(0, 300))]], d.errosCriticos?.porFonte) },
    { id: 'crashes', ico: '💥', title: 'Travamentos', sub: 'Telas azuis e falhas de aplicativos', html: '<h3 class="h3">Dumps de tela azul</h3>' + list(d.crashes?.minidumps) + '<h3 class="h3">BugChecks</h3>' + list(d.crashes?.bugchecks) + '<h3 class="h3">Falhas de aplicativos</h3>' + list(d.crashes?.appCrashes) },
  ] });

  if (d.meta?.forense) {
    grupos.push({ label: 'Forense', items: [
      { id: 'tarefas', ico: '⏰', title: 'Tarefas agendadas de terceiros', sub: '', html: tb([['nome', 'Nome'], ['caminho', 'Caminho'], ['estado', 'Estado'], ['acao', 'Ação']], d.tarefasAgendadas) },
      { id: 'servicos', ico: '🧩', title: 'Serviços automáticos de terceiros', sub: '', html: tb([['nome', 'Serviço'], ['estado', 'Estado'], ['caminho', 'Executável']], d.servicosTerceiros) },
      { id: 'ameacas', ico: '🦠', title: 'Ameaças detectadas pelo Defender', sub: '', html: tb([['quando', 'Quando'], ['ameacaId', 'ID'], ['recursos', 'Recursos']], d.ameacasDefender) },
    ] });
  }

  const alerta = (d.meta?.admin ? '' : '<div class="alert">⚠️ <b>Privilégios limitados:</b> execute o Loop-AI como Administrador (iniciar-admin.bat) para SMART detalhado, sensores e eventos de segurança.</div>') +
    '<div class="alert info">ℹ️ Diagnóstico somente leitura: nada foi alterado no PC. Não inclui histórico de navegação nem senhas. Achados são indícios a confirmar, não conclusões definitivas.</div>';
  return D.page({
    title: `Diagnóstico do PC — ${s.host || ''}${s.usuario ? ` (${s.usuario})` : ''}`, brand: 'Loop-AI', tagline: 'Diagnóstico do PC',
    subtitle: `📅 Gerado: ${esc(hoje)} · ${d.meta?.admin ? 'administrador' : 'sem administrador (dados parciais)'} · ${esc(s.so || '')}`,
    meta: [`📅 ${hoje}`, `🖥️ ${s.host || ''}`, `👤 ${s.usuario || ''}`, d.meta?.admin ? '🔑 Administrador' : '🔑 Padrão ⚠️', problema ? `🛠️ ${problema.slice(0, 60)}` : '🛠️ Varredura geral'], alerta, groups: grupos,
  });
}

/** Resumo curto para o agente (sem ler o HTML). */
function summarize(d, { problema, temas, analise }) {
  const s = d.sistema || {}, an = analise;
  const L = [
    `PC: ${s.host} | ${s.fabricante} ${s.modelo} | ${s.so} build ${s.build} | CPU ${s.cpu} | RAM ${s.ramGB} GB | uptime ${s.uptimeDias} d | serial ${s.serial}`,
    `Data/hora: ${d.meta?.geradoEm} | período ${d.meta?.dias} d | ${d.meta?.admin ? 'admin' : 'SEM admin (parcial)'}`,
    `Problema informado: ${problema || '(nenhum)'} | categorias reconhecidas: ${temas.map((t) => t.titulo).join(', ') || '-'}`,
    '', 'ACHADOS (evidência → ver causas/ações no HTML):',
    ...an.achados.map((a) => `- [${a.sev}] ${a.titulo}: ${a.evid || ''}`),
  ];
  if (!an.achados.length) L.push('- nenhum problema evidente');
  const indisp = Object.entries(an.estado).filter(([, v]) => v === 'indisponivel').map(([k]) => k);
  if (indisp.length) L.push('', `Verificações indisponíveis: ${indisp.join(', ')}`);
  return L.join('\n').slice(0, 6000);
}

async function run({ days = 30, forense = false, problema = '' } = {}) {
  const dados = await runPS(PS, { LOOP_DAYS: String(days), LOOP_FORENSE: forense ? '1' : '0' });
  const temas = detectarTemas(problema);
  const analise = analisar(dados);
  return { dados, temas, analise, html: render(dados, { problema, temas, analise }), resumo: summarize(dados, { problema, temas, analise }) };
}

module.exports = { run, analisar, detectarTemas, render, summarize, THEMES, RULES };
