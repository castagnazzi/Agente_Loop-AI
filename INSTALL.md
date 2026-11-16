# Instalação

## Opção 1 — Uso direto (recomendado para quem só quer usar)
1. Baixe/copie a pasta do Loop-AI para o PC (ou pendrive).
2. Dê dois cliques em **`iniciar.bat`**.
   - Se faltar o Node.js, o próprio `iniciar.bat` chama o `instalar.bat`, que instala o Node.js via `winget` (precisa de internet nessa primeira vez) e prepara as dependências.
   - Se a pasta já veio com `node_modules`, ele abre direto, sem precisar de internet nem instalar nada.
3. Use **`iniciar-admin.bat`** quando precisar que o Loop-AI rode como Administrador (necessário para ler eventos de segurança do Windows, SMART do disco etc.).
4. No primeiro uso, clique com o botão direito no "boneco" flutuante → **Configurações → Modelos**:
   - cadastre um provedor de IA (URL da API + chave, se precisar) — local (Ollama, LM Studio, llama.cpp) ou em nuvem (NVIDIA, OpenAI, OpenRouter, Groq…);
   - clique em **Buscar modelos**, marque os que quiser usar e escolha o modelo padrão.

Pronto — o chat já funciona. Os detalhes de uso (ferramentas, permissões, diagnóstico, relatório de uso etc.) estão no [`README.md`](README.md).

## Opção 2 — A partir do código-fonte (para desenvolver/contribuir)
Pré-requisitos: Windows 10/11 e [Node.js](https://nodejs.org/) (LTS).

```bash
git clone <endereço-do-repositório>
cd loop-ai
npm install
npm start
```

Outros comandos úteis:
- `npm run selftest` — roda o autoteste sem abrir janelas (bibliotecas, Word/Excel/PowerPoint/PDF, OCR, SQLite, PowerShell).
- `npm run pack` — gera `dist/win-unpacked` (executável solto + dependências).
- `npm run dist` — gera o instalador/`.exe` portátil único.

## Levar em um pendrive
Copie a pasta inteira **com `node_modules`** para o pendrive — assim o app abre em qualquer PC sem precisar reinstalar nada. Veja a seção **Portátil (pendrive)** e **Segurança** no [`README.md`](README.md) antes de levar o app para o PC de um cliente ou entregar para outra pessoa: a pasta `data/` guarda suas chaves de API e conversas, e `saidas/` pode conter resultados/dados gerados — nenhuma das duas deve ser copiada/compartilhada sem necessidade.

## Problemas na instalação
Abra uma *issue* no repositório descrevendo: versão do Windows, se tem Node.js instalado (`node -v`), e a mensagem de erro (se o `iniciar.bat`/`instalar.bat` mostrar alguma).
