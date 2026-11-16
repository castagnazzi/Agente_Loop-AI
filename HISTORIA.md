# Histórico do Loop-AI

## Motivação
O Loop-AI nasceu de uma necessidade prática: um técnico de assistência e manutenção de PCs precisava de um assistente de IA que pudesse ser levado de computador em computador (inclusive por pendrive), capaz de ler/gerar documentos, rodar comandos, investigar problemas no Windows e registrar tudo de forma auditável — sem depender de instalação pesada, de conta em nuvem ou de enviar dados de cliente para fora da rede.

A ideia central desde o início: um "boneco" flutuante, sempre à mão, que abre um chat com um agente de IA capaz de agir de verdade no PC (não só responder texto).

## Como o projeto evoluiu
- **Base**: janela Electron transparente e *always-on-top* (o "boneco"), chat em streaming acoplado a ela, configurações por formulário.
- **Agente e ferramentas**: um motor próprio de conversa com modelos de IA (qualquer API compatível com OpenAI — local ou em nuvem), com ferramentas para ler/criar/editar arquivos, rodar comandos PowerShell, pesquisar na web e ler documentos (Word, Excel, PowerPoint, PDF, com OCR offline).
- **Multi-agente**: além do agente principal, agentes "ajudantes" especializados (pesquisa, programação, revisão), que podem receber tarefas delegadas e rodar em paralelo.
- **Diagnóstico e relatório de uso**: ferramentas embutidas, offline e somente leitura, pensadas para o dia a dia de assistência técnica — varredura de problemas comuns (lentidão, tela azul, disco, rede, impressora etc.) e levantamento de atividade do PC para laudos, sem ler senhas.
- **Extensões**: suporte a *skills* (instruções especializadas) e *plugins* (novas ferramentas), inclusive importáveis diretamente de um repositório do GitHub.
- **Portabilidade e segurança**: tudo roda localmente, os dados sensíveis (`data/`, com as chaves de API, e `saidas/`, com os resultados gerados) ficam isolados do código-fonte e nunca são versionados.

## Estado atual
O projeto está em uso ativo no dia a dia do autor, sendo testado com diferentes modelos de IA locais e na nuvem, e evoluindo conforme bugs e limitações aparecem no uso real.

## Por que abrir no GitHub
A ideia de publicar o código é simples: já é útil para quem presta assistência técnica ou quer um assistente de desktop portátil, e pode ficar ainda melhor com outras pessoas testando, reportando problemas e sugerindo ideias. Issues, sugestões e pull requests são bem-vindos — veja o [`README.md`](README.md) para entender a arquitetura e os recursos atuais, e [`INSTALL.md`](INSTALL.md) para rodar o projeto.
