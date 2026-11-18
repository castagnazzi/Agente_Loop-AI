# Loop-AI

![Loop-AI em ação: escolhendo o modelo local, pedindo um jogo da velha e acompanhando o raciocínio até a entrega](media/demo.gif)

<sub>Gravação real do app usando um modelo local na rede (Qwen 27B). A etapa em que o modelo trabalha foi acelerada.</sub>

Assistente de desktop para Windows: um **boneco flutuante** que abre um chat com um **agente de IA** (com multi-agente, skills e plugins). Feito para uso portátil (pendrive) em assistência técnica, desenvolvimento e análise.

> Como instalar: [`INSTALL.md`](INSTALL.md) · Histórico e motivação do projeto: [`HISTORIA.md`](HISTORIA.md)

## Começar
1. `iniciar.bat` (duplo clique). No primeiro uso em um PC novo ele chama `instalar.bat` sozinho (internet; instala Node.js via winget se faltar). Se a pasta `node_modules` veio junto, abre direto, sem Node.js.
2. `iniciar-admin.bat` abre como Administrador (necessário para eventos de segurança, SMART etc.).
3. Clique direito no boneco → **Configurações → Modelos**: cadastre o provedor (URL + chave), clique **Buscar modelos**, marque os que quer e escolha o padrão.

## Precisa de internet?
| Recurso | Internet |
|---|---|
| Conversar com modelo **local** (llama.cpp, Ollama, LM Studio na mesma máquina/rede) | **Não** |
| Conversar com modelo de **nuvem** (NVIDIA, OpenAI, OpenRouter…) ou via túnel ngrok | **Sim** |
| `diagnostico_pc`, `relatorio_uso`, leitura/escrita de arquivos, comandos, skills já instaladas, exportar HTML | **Não** |
| Ferramenta `webfetch`, adicionar skills/plugins pelo GitHub, instalar (`instalar.bat`) | **Sim** |

O status do chat mostra **🔒 local** ou **☁ nuvem** para o modelo em uso. Com dados de cliente, prefira modelo local.

## Interface
- **Boneco:** arraste para mover · clique abre/fecha o chat · **role o mouse** sobre ele para mudar o tamanho · clique direito = menu (chat, **Agente**, nova conversa, configurações, tamanho, sempre no topo).
- **Chat:** respostas em streaming; painel *Raciocínio* mostra o que cada agente/ferramenta está fazendo; linha de status mostra **modelo, 🔒/☁ e tokens**; 📎 anexa (ou arraste arquivos); 🧹 **zera conversa e contexto**; 💾 exporta a conversa em HTML (Ctrl+P → PDF); ⏹ (vermelho) interrompe.
- **Permissões:** criar e editar arquivos **dentro da pasta de trabalho** é direto, sem perguntar (fora dela aparece o cartão com o aviso "Fora da pasta de trabalho"). Comandos **de consulta** (`Get-*`, `dir`, `ipconfig`, `ping`, `netstat`…) também rodam direto; comandos que alteram o sistema (apagar, instalar, mudar registro, parar serviços) e o acesso à web mostram o cartão **Permitir / Sempre (sessão) / Negar**. "Sempre (sessão)" vale para aquele tipo de ação (escrever, executar, web) até você clicar na vassoura 🧹. Ajustável em *Configurações → Geral → Permissões padrão* (e por agente).
- **Conversas salvas:** toda conversa é salva sozinha em `data/sessions`. 🕘 lista as conversas (abrir ou apagar); 🧹 inicia uma nova **sem perder** a anterior; ao abrir o app, a última conversa (menos de 12 h) é retomada com o histórico na tela.
- **Conversa longa:** quando o contexto passa do **limite** (*Configurações → Geral*, padrão 48 000 tokens; 0 desliga), o app primeiro reduz as saídas antigas de ferramentas e, se ainda não couber, **resume o começo da conversa** com o próprio modelo, mantendo os dois últimos pedidos. Se o provedor recusar por tamanho, ele compacta e tenta de novo. O chat avisa quando isso acontece.
- **Desfazer (↩):** antes de criar/editar um arquivo (`write`, `edit`, documentos), o app guarda uma cópia em `data/backups` (30 dias). O botão ↩ lista as alterações da conversa e **restaura** o arquivo anterior ou **remove** o que foi criado. Comandos de terminal não são rastreados.
- **Registro de atividades (📋):** gera `registro-atividades.html` (na pasta do trabalho) com tudo o que o agente fez no PC — comandos, arquivos criados/alterados, relatórios, acessos à web, com data/hora e como cada ação foi autorizada — para **anexar ao laudo do cliente**. Também dá para pedir ao `loop` ("gere o registro do que foi feito").
- **Imagens:** cole um print com **Ctrl+V** (ou anexe/arraste). Com *Enviar imagens ao modelo* ligado (só modelos com visão), a imagem vai junto da mensagem; desligado, o agente lê o texto da imagem por OCR.
- **Pesquisa na internet:** a ferramenta `websearch` (DuckDuckGo, com Bing de reserva; sem chave de API) devolve título, endereço e resumo; `webfetch` lê o texto principal da página (com limite de tempo). Por pedido o agente faz no máximo 3 buscas e ~8 consultas; depois as ferramentas de web são desativadas e ele precisa **escrever o resultado** (documento na pasta do projeto) e responder. O terminal é PowerShell 5.1: o agente é avisado de que não existem `head`, `grep` nem `curl` do Linux.
- **Não para no meio:** se o modelo terminar o turno só anunciando o que vai fazer ("Vou criar o documento…") sem usar ferramenta, o app manda continuar (até 2 vezes). Uma resposta vazia depois de usar ferramentas também é tratada assim. No último passo permitido o agente responde sem ferramentas, para sempre haver uma resposta.
- **Aparência:** transparência separada do boneco e do chat, cores de pergunta/resposta/raciocínio, tamanho do boneco (px ou scroll).

## Onde ficam os resultados
Pedidos de criar/desenvolver algo, analisar, gerar relatório etc. criam automaticamente uma pasta
`saidas\<nome-descritivo>\` (só o nome, sem data; se já existir, acrescenta `-2`, `-3`…) com tudo dentro (projeto, código, documento, relatório). O chat mostra o caminho e um botão **Abrir pasta**. O local é a **Pasta de trabalho** (*Configurações → Geral*); se você preencher *Pasta de saídas*, ela tem prioridade; se as duas estiverem vazias, usa `saidas\` do Loop-AI. Exportações do chat vão em `saidas\conversas\`.

## Agentes (multi-agente)
Editados em *Configurações → Agentes* por **formulário** (nome, função, instruções, modelo, ferramentas e skills por caixinhas, permissões, passos e cor), com validação: nome único e sem espaços, ao menos uma ferramenta quando limitada, ao menos um agente principal; o `loop` não pode ser removido. *Restaurar padrões* volta os agentes originais sem apagar os seus. Mesmo que o `settings.json` seja editado à mão, o app repara a lista ao abrir e ao salvar. `primary` conversa com você; `subagent` recebe tarefas delegadas. Troque o agente pelo menu do boneco.

| Agente | Papel |
|---|---|
| `loop` | principal: planeja e **delega em paralelo** a subagentes |
| `pesquisador` | subagente, somente leitura + web |
| `programador` | subagente: cria/edita arquivos e roda comandos |
| `revisor` | subagente, revisão somente leitura |

**Você não precisa escolher o agente.** No `loop` (padrão), "faça um diagnóstico neste PC, procure falhas" já roda `diagnostico_pc`, e "relatório de uso / o que foi acessado" roda `relatorio_uso`. Não há agentes separados para isso. Diagnóstico e relatório de uso rodam direto, sem confirmação (só leem o PC).

**Simplificar:** o multiagente é opcional. Se preferir um único agente fazendo tudo sozinho (sem delegar, sem o custo extra de contexto que a ferramenta `delegate` adiciona ao prompt), remova os subagentes em *Configurações → Agentes* e desmarque "Pode passar tarefas a ajudantes" no `loop` — útil em modelos locais menores ou com pouca VRAM.

Campos: `name, mode, description, system, model ("provedor/modelo"), tools (vazio = todas), skills (limita o catálogo), permissions {read,write,exec,net: allow|ask|deny}, canDelegate, steps`.

## Ferramentas embutidas
`read`, `ler_documento`, `criar_documento`, `write`, `edit`, `glob`, `grep`, `bash` (PowerShell), `webfetch`, `todowrite`, `delegate` (subagentes), `skill`, `criar_projeto`, **`diagnostico_pc`**, **`relatorio_uso`**, `registro_atividades`, **`websearch`** (pesquisa na internet) e `webfetch` (lê páginas).

### Documentos (`ler_documento` e `criar_documento`)
- **Ler:** PDF, Word `.docx`, Excel `.xlsx`/`.csv` (todas as abas) e PowerPoint `.pptx` (slides e notas). Textos longos vêm paginados. **OCR offline** (português + inglês): PDF digitalizado e imagens (`.png`, `.jpg`, `.bmp`, `.webp`, `.tif`) são lidos automaticamente por OCR, ~2–4 s por página; PDFs longos leem 15 páginas por vez (use `paginas="16-30"`), e `ocr=true` força o OCR em PDF com texto ilegível. Os dados de idioma ficam na pasta `ocr/` (copie junto com o app; se faltarem, são baixados na primeira vez, com internet). OCR de PDF só funciona dentro do app; o de imagem funciona em qualquer contexto. Qualidade depende do scan: fotos tortas, manuscrito e fundos ruidosos erram mais; confira números importantes. Formatos antigos (`.doc`, `.xls`, `.ppt`) não são lidos: salve como docx/xlsx/pptx ou PDF.
- **Criar:** `docx` e `pdf` a partir de Markdown (títulos, listas, tabelas, negrito, código); `xlsx` a partir de abas/colunas/linhas (fórmulas com `=`, cabeçalho formatado, filtros); `pptx` a partir de slides (capa, tópicos, tabela, notas). Tudo salvo na pasta do projeto. Usa bibliotecas embutidas: não precisa de Word/Excel/LibreOffice nem de internet. O PDF é gerado pelo Chromium do Electron (só dentro do app).
- Pedir ao `loop` "faça um laudo em Word" ou "monte uma planilha com…" já aciona a ferramenta; a escrita segue a permissão de escrever (pergunta por padrão).

### Diagnóstico do PC (`diagnostico_pc`)
Varredura de **problemas**, embutida, offline e somente leitura. Você informa o problema com as palavras do cliente (ex.: "lento e reinicia sozinho"); o app reconhece a categoria (lentidão, tela azul, reinício, internet, disco, vírus, boot, impressora, atualização, bateria, programa) e prioriza as verificações. Cobre: disco e SMART, eventos de disco/NTFS, desligamentos inesperados, dumps e BugChecks, erros de log por fonte, RAM/CPU/clock/temperatura, boot lento, rede (gateway, internet, DNS, proxy, hosts), Defender/firewall, Windows Update, impressora, programas travando, inicialização, bateria (modo **forense** acrescenta tarefas agendadas, serviços de terceiros e ameaças do Defender).
Gera `diagnostico.html`, um **dashboard offline** no mesmo estilo do relatório de uso (menu lateral, indicadores, gráficos de achados/erros/energia/disco, tabelas com busca, ✕ para remover seções, Imprimir/PDF), com **data/hora**, dados do PC, achados por severidade, **evidência, causas possíveis e como corrigir**, análise do problema informado com o que foi verificado e o que precisa de checagem manual) e `dados.json`. **Não lê histórico de navegação.**

### Relatório de uso (`relatorio_uso`)
Relatório de **atividade**, sem avaliar defeitos e sem senhas: histórico dos navegadores (Chrome, Edge, Brave, Opera, Vivaldi, Firefox; lê também com o navegador aberto), sites mais visitados, pesquisas, downloads, **arquivos e pastas acessados com caminho completo**, programas executados (UserAssist; Prefetch com admin), sessões (ligar/desligar/suspender; bloqueio e logon com admin), USB já conectados, cache DNS (inclui navegação anônima), janelas abertas. Gera `relatorio-uso.html` + `dados.json`. O HTML é um **dashboard offline** (sem CDN): menu lateral por grupos, KPIs, gráficos (navegação por dia/hora, top sites, navegadores, tipos de arquivo, disco, energia, horas de uso por dia), tabelas com **busca e ordenação**, histórico local × sincronizado, contas dos navegadores (e-mail, sem senhas), favoritos, URLs digitadas, PDFs e Office recentes, Timeline do Windows, programas instalados, conexões de rede, botão ✕ para remover seções, *Baixar limpo* e *Imprimir/PDF* (tema claro). Use só em equipamento que você está autorizado a auditar.

## Skills e plugins
Em *Configurações → Extensões*:
- **Skills** (`SKILL.md`): o agente vê o catálogo e carrega a skill quando a tarefa combina. Para **forçar**, escreva `/nome-da-skill` ou "use a skill nome-da-skill" no pedido.
- **Plugins** (`index.js`): adicionam ferramentas. Rodam código no PC: só de fonte confiável.
- **Adicionar por endereço:** cole o link do GitHub → *Analisar* → marque skills/plugins/agentes → *Adicionar selecionados* (baixa só o necessário; junta cópias duplicadas).
- Também é possível adicionar de uma pasta/arquivo do computador. Pastas: `skills/` e `plugins/` ao lado do app.
- **Nenhuma skill ou plugin vem junto deste repositório** (as pastas `skills/` e `plugins/` ficam de fora). Cada pessoa instala as que quiser, em *Configurações → Extensões*, por endereço do GitHub ou por pasta local.

## Modelos / provedores
Qualquer API compatível com OpenAI (`/chat/completions` + `/models`): NVIDIA, OpenAI, OpenRouter, Groq, Ollama, LM Studio, llama.cpp. Atalhos de URL prontos; "Buscar modelos" lista os disponíveis; importa provedores de um `opencode.jsonc`. Cada agente pode usar um modelo diferente. Modelos de nuvem listados podem estar desativados (erro 404/410): troque por outro. Para ferramentas/delegação, use modelos com *tool calling*.

**Modelo local com prompt grande:** sem cache, o servidor pode levar vários minutos para ler um contexto de ~90k tokens. O Loop-AI não impõe o limite de 300 s do `fetch` do Node (usa `undici` com `headersTimeout`/`bodyTimeout` desligados); só desiste após **10 min sem nenhum dado** do servidor. Compactar o começo da conversa invalida o cache do servidor (llama.cpp) e força essa releitura.

**Janela de Configurações:** o tamanho do texto/layout se ajusta com **A− / A+** na barra lateral, **Ctrl +/−/0** ou **Ctrl + roda do mouse** (60–160 %, padrão 90 %, lembrado entre aberturas). O conteúdo acompanha a largura da janela.

## Portátil (pendrive)
Copie a pasta inteira (com `node_modules`). Tudo fica no app:

| Pasta | Conteúdo |
|---|---|
| `data/` | `settings.json` (**com suas chaves de API**) e cache |
| `skills/`, `plugins/` | extensões |
| `saidas/` (ou a sua pasta de trabalho) | resultados gerados (podem conter dados de clientes) |

## Segurança
- `data/settings.json` guarda chaves em **texto simples**; `data/` e `saidas/` estão no `.gitignore`. Não envie ao GitHub nem compartilhe.
- Quem tiver acesso ao pendrive vê as chaves e os resultados.
- Ao entregar/copiar o aplicativo para outra pessoa ou para o PC de um cliente, **não leve a pasta `data/`** (suas chaves e conversas) nem `saidas/`. O `.exe`/pasta de `dist` gerados pelo empacotamento não trazem esses dados; se você rodar o autoteste dentro de `dist`, apague `dist/data` depois.
- O bloqueio de escrita do agente vale para as ferramentas do app; um comando PowerShell aprovado ainda pode alterar o sistema.
- Plugins executam código com acesso total; skills/agentes baixados do GitHub podem conter instruções indesejadas: revise antes de usar.

## Desenvolvimento e empacotamento
- `npm install` · `npm start` · `npm run selftest` (autoteste sem janelas).
- `npm run pack` gera a pasta `dist/win-unpacked` (executável **Loop-AI.exe** + `resources/ocr`); `npm run dist` gera o `.exe` único portátil. A lista de arquivos de produção é calculada por `builder.config.js` a partir da árvore real de `node_modules` (o coletor automático do electron-builder 25 deixava módulos de fora e quebrava o Excel).
- **Autoteste:** `Loop-AI.exe --selftest` (ou `--selftest=full`, que inclui relatório de uso e diagnóstico) verifica bibliotecas, Word/Excel/PowerPoint/PDF, OCR, SQLite e PowerShell **neste PC**, grava `selftest.txt` ao lado do app e sai com código 0 se tudo estiver certo. Use em um PC novo antes de atender — ou dê dois cliques em `autoteste.bat`, que roda tudo e mostra o resultado.
- No pacote, os dados ficam ao lado do `.exe` (`data/`, `skills/`, `plugins/`, `saidas/`); os dados de idioma do OCR vêm em `resources/ocr`.

## Contribuindo
O projeto está em uso real e em evolução — issues, sugestões e pull requests são bem-vindos. Antes de abrir um PR grande, abra uma issue descrevendo o que pretende mudar. Ao reportar um problema, inclua: o que você pediu ao agente, o que esperava, o que aconteceu (texto do painel *Raciocínio*/erro ajuda muito) e o modelo de IA usado. Veja [`HISTORIA.md`](HISTORIA.md) para o contexto do projeto.

## Correções recentes
- Loop de verificação sem fim quando o agente espera algo externo (ex.: escanear QR Code) agora é detectado e avisado.
- Ao atingir o limite de passos do agente, o chat sempre mostra um aviso (antes podia parar calado se o modelo chamasse uma ferramenta no último passo).

## Licença
[MIT](LICENSE) © 2026 castagnazzi
