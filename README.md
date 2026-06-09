# One Page — Pesquisa Estratégica de Cidades

Dossiê estratégico de qualquer município brasileiro em três abas: **Microrregião · Cidade · Infraestrutura**.

Agrega dados oficiais públicos em um _one-pager_ pronto para análise e impressão em A4.

## Fontes integradas

| Fonte | Uso |
|---|---|
| **IBGE** — Localidades, Censo 2022 (agregado 9514), Estimativas (6579), Área/Densidade (1301), PIB Municipal (5938), CEMPRE (1685), Classes de rendimento (10292), Malhas geográficas | Demografia, economia, mapas |
| **CNES / apidadosabertos.saude.gov.br** | Lista de estabelecimentos de saúde |
| **ElastiCNES / elasticnes.saude.gov.br** | Leitos por hospital, tipos de leito, serviços/especialidades |
| **ANS — Dados Abertos** (PDA 024) | Beneficiários de saúde suplementar, operadoras por município |
| **Wikimedia Commons + Wikipedia PT** | Fotos de hospitais (quando disponíveis) |

## Como rodar

### Desenvolvimento local (Ruby/WEBrick)

Requisitos: **Ruby 2.6+** (já incluso no macOS).

```bash
cd pesquisa-cidade
ruby server.rb
```

Acesse [http://127.0.0.1:8765/](http://127.0.0.1:8765/).

O `server.rb` faz proxy para APIs que não liberam CORS (CNES, ANS, ElastiCNES) e cacheia downloads pesados (ZIPs ANS por UF, CSV de leitos) em `.cache/` — regenerável, ignorado pelo git.

### Produção (Vercel)

Cada arquivo em `api/proxy/*.js` vira um endpoint serverless. O `vercel.json` reescreve `/proxy/cnes` → `/api/proxy/cnes`, etc. Os JSONs em `data/` são empacotados no deploy e ficam disponíveis no FS read-only do runtime.

```bash
vercel --prod
```

## Estrutura

```
pesquisa-cidade/
├── index.html         # UI: landing + 3 abas (Microrregião · Cidade · Infra)
├── style.css          # Paleta branco/preto/cinza/azul-escuro + @media print
├── app.js             # Orquestração, fetchers, charts (Chart.js), mapas (Leaflet)
│
├── server.rb          # Dev local (WEBrick): estáticos + proxies + CSV parser
├── api/               # Produção (Vercel serverless, Node.js)
│   ├── proxy/         #   um arquivo por endpoint /proxy/...
│   └── _lib/          #   helpers (ans.js, elastic.js)
├── data/              # ✱ Snapshots ANS pré-processados (commitados)
│   └── ans_RS_202602.json …
│
├── .cache/            # (gitignored) downloads ZIP/CSV temporários do server.rb
├── package.json
└── vercel.json        # rewrites /proxy/* → /api/proxy/*
```

---

## Como o site funciona — guia passo a passo

### A pergunta direta: onde guardamos os dados?

**Em quase nenhum lugar.** Não há banco, não há planilha, não há datalake. O sistema é
um _BFF (backend-for-frontend)_ stateless que consulta APIs públicas a cada
pesquisa. A única exceção é a ANS, explicada mais abaixo.

| Fonte | Como é obtida | Onde mora |
|---|---|---|
| **IBGE** (demografia, censo, malhas) | API REST pública com CORS aberto | Browser bate direto em `servicodados.ibge.gov.br` |
| **CNES** (estabelecimentos) | API REST pública sem CORS | Backend faz proxy → resposta passa pelo servidor sem ser persistida |
| **ElastiCNES** (leitos, serviços) | Kibana público da DEMAS | Backend faz POST em `elasticnes.saude.gov.br` e devolve resumo |
| **ANS** (saúde suplementar) | ZIPs mensais (~22 MB cada) no FTP de Dados Abertos | **Pré-processados em JSON e commitados em `data/`** |
| **Wikimedia / Wikipedia** (foto de hospital) | API pública com CORS aberto | Browser bate direto |

Ou seja: cada vez que você busca "Caxias do Sul", o app dispara ~15 requisições
em paralelo para essas fontes e monta o dossiê do zero — _não há leitura de
"banco do projeto"_, exceto a ANS.

### Por que a ANS é diferente?

A ANS publica beneficiários de saúde suplementar como **CSVs gigantes mensais
por UF, dentro de ZIPs**. Não há API consultável. Para Porto Alegre, o CSV bruto
do RS tem ~80 MB descomprimido, com milhões de linhas (um beneficiário por
linha, agregando por município/operadora/modalidade).

Fazer isso ao vivo no browser ou num cold start serverless é inviável. Então
construímos uma pipeline simples:

1. **Baixar** o ZIP do mês (`pda-024-icb-RS-2026_02.zip`) do FTP da ANS.
2. **Descompactar** o CSV.
3. **Agregar** em uma estrutura aninhada `{ uf, month, byCity: { codMun: { total, mh, odonto, operadoras: {...} } } }`.
4. **Salvar** o JSON agregado em `data/ans_RS_202602.json` (~500 KB).
5. **Apagar** o ZIP/CSV — só fica o JSON, que é o que vai pro git.

Essa pipeline está em `server.rb` (`ans_process_month`). Em produção (Vercel),
os endpoints em `api/_lib/ans.js` apenas **leem** os JSONs já commitados —
nunca baixam nem geram nada.

> **Atualizar a base ANS** = rodar localmente `ruby server.rb`, abrir uma
> cidade da UF desejada (ex: SP), o `server.rb` baixa/processa/salva em
> `data/ans_SP_AAAAMM.json`, fazer `git add data/ && git commit && git push`.
> Pronto — produção passa a servir aquela UF.

### Fluxo completo de uma pesquisa

Quando você clica em "Caxias do Sul":

```
[Browser]                                    [APIs externas / Vercel]
   |
   |-- GET /api/v1/localidades/municipios/4305108 -------> IBGE (direto)
   |-- GET /api/v3/agregados/9514/.../localidades=N6[…] -> IBGE Censo 2022
   |-- GET /api/v3/agregados/6579/.../localidades=N6[…] -> IBGE estimativas
   |-- GET /api/v3/agregados/5938/.../localidades=N6[…] -> IBGE PIB
   |-- GET /api/v3/agregados/1685/.../localidades=N6[…] -> IBGE CEMPRE
   |-- GET /api/v3/agregados/10292/.../localidades=N6[…] > IBGE rendimentos
   |
   |-- GET /proxy/cnes?codigo_municipio=430510 -----> Vercel ──► apidadosabertos.saude.gov.br
   |          (paginação, ~150 páginas em batches de 8)
   |
   |-- GET /proxy/elastic/leitos?cod=430510 --------> Vercel ──► ElastiCNES (Kibana)
   |-- GET /proxy/elastic/leitos/history?cod=…  ---> Vercel ──► ElastiCNES (snapshots anuais)
   |-- GET /proxy/elastic/servicos?cnes=NNNN -------> Vercel ──► ElastiCNES (top 3 hosp)
   |
   |-- GET /proxy/ans?uf=RS&cod=430510 -------------> Vercel ──► lê data/ans_RS_*.json (FS)
   |-- GET /proxy/ans/multi?uf=RS&cods=A,B,C  ─────> Vercel ──► soma várias cidades
   |-- GET /proxy/ans/history?uf=RS&cods=…    ─────> Vercel ──► varre todos os meses em data/
   |
   |-- GET /api/v3/malhas/microrregioes/43017  ----> IBGE (direto, geojson da microrregião)
   |
   |-- (top 3 hospitais) -- GET commons.wikimedia.org… -> Wikimedia (direto)
   |
   v
[app.js orquestra todas as respostas e renderiza]
```

Tudo é **disparado em paralelo** (`Promise.all`) — a latência total é a do
endpoint mais lento, não a soma. O loader exibe o passo atual; quando termina,
o dashboard aparece preenchido.

### Cache: existe, mas é "in-flight" e descartável

Há três níveis de cache, todos voláteis:

1. **Prompt cache do browser** — Chrome/Firefox cacheiam respostas das APIs IBGE
   pelo tempo que o `Cache-Control` do servidor delas mandar. O nosso código
   não controla isso.
2. **Cache em memória do serverless** (`api/_lib/ans.js` mantém um `Map` por
   instância de função) — vive enquanto a função Lambda fica "quente" no Vercel
   (~minutos). Some no próximo cold start.
3. **`.cache/` local** (`server.rb`) — só roda em desenvolvimento. Guarda os
   ZIPs originais da ANS para não baixar de novo, e o output de `/proxy/elastic`
   para iterar mais rápido. **Está no `.gitignore`, nunca vai pra produção.**

Nada disso é "dado do projeto" — é só economia de tempo. Apaguei o `.cache/`
inteiro? Ele se reconstrói na próxima pesquisa.

### O que isso significa na prática

- **Não há "banco" pra administrar.** Não há schema, migration, backup.
- **Os dados estão sempre frescos** (exceto ANS, congelada nos meses commitados em `data/`).
- **Para adicionar uma nova fonte**, basta criar um endpoint em `api/proxy/` que faz fetch e devolve JSON, e consumir em `app.js`.
- **Para suportar uma nova UF na ANS**, processe localmente o ZIP daquela UF e commite o JSON em `data/`.
- **Custo zero de armazenamento** em produção (Vercel free tier; só pesa o git).

### Quando isso seria insuficiente?

Se quisermos:

- Histórico de **todas** as cidades de **todos** os estados → o `data/` cresceria pra centenas de MB e o git ficaria pesado. Aí compensaria mover para Vercel Blob, S3 ou um KV.
- **Joins** ou **filtros analíticos** entre métricas de cidades diferentes → faria sentido um warehouse (BigQuery / DuckDB sobre Parquet). Hoje cada cidade é renderizada isolada; o bubble chart e o IQM são os primeiros lugares onde fazemos comparação cruzada e ainda assim por demanda, não em batch.
- **Atualização automática** dos snapshots ANS → cron job (GitHub Actions) que roda a pipeline mensalmente e abre PR com os JSONs novos.

Por enquanto, o modelo "site estático + serverless + JSON commitado" entrega tudo que precisamos com a menor complexidade possível.

## Funcionalidades

### Aba Microrregião
- Lista dos municípios + mapa colorido (malha IBGE)
- Tabela de populações em ordem decrescente com % da microrregião
- Pirâmide etária, distribuição por gênero, evolução populacional (2010–2024)
- KPIs de beneficiários de saúde suplementar + evolução
- Top 5 operadoras (+ linha "Outras" consolidada)
- Leitos por hospital da microrregião (SUS/Privado/Total/UTI)
- KPI de habitantes/leito SUS e beneficiários/leito, com comparação Porto Alegre
- Tipos de estabelecimento e serviços vs. Porto Alegre (linhas zeradas ocultas)

### Aba Cidade
- Mesmos indicadores da microrregião, focados na cidade pesquisada
- Crescimento populacional desde Censo 2010 (+CAGR)
- Perfil econômico: PIB, composição setorial, empresas CEMPRE, massa salarial
- Composição de renda por classe econômica (Censo 2022 — em R$ convertidos do salário mínimo de 2022)

### Aba Infraestrutura
- 3 maiores hospitais da cidade (foto quando disponível na Wikimedia Commons)
- Número de leitos detalhado (SUS, privados, total, UTI)
- Especialidades dos leitos (CLINICA GERAL, UTI Neonatal, etc.)
- Especialidades do hospital (serviços CNES)
- Consolidação automática de CNES redundantes (múltiplas unidades do mesmo complexo)
- Mapa com todos os estabelecimentos

### Impressão
- Botão "Imprimir" no topo gera A4 com as 3 abas em sequência
- Gráficos são convertidos para PNG antes da impressão (evita bugs de canvas)
- Tabelas, cards e gráficos com `page-break-inside: avoid`

## Regras de negócio

- **Apenas médico-hospitalar** — planos odontológicos são ignorados em todos os indicadores de saúde suplementar
- **Apenas estabelecimentos ATIVOS** — cadastros CNES desativados são filtrados
- **Consolidação por complexo hospitalar** — múltiplos CNES com mesmo nome + razão social são mesclados (soma leitos, lista unidades)

## Limitações conhecidas

- Fotos de hospitais dependem de cobertura na Wikimedia Commons (bom para capitais e hospitais famosos; interior não costuma ter foto)
- Série histórica da ANS depende de quantos meses estão em cache — o backend baixa sob demanda por UF (~22 MB/mês)
- Não há integração com Caravela (SaaS pago sem API pública)

## Tecnologias

- Frontend puro: **HTML + CSS + JS** (sem build step, sem framework, sem bundler)
- **Chart.js 4** via CDN (gráficos: pirâmide, linha, doughnut, bubble)
- **Leaflet 1.9** via CDN (mapa da microrregião + mapa de estabelecimentos)
- Backend dev: **Ruby / WEBrick** (`server.rb` — estáticos + proxy + parser de CSV)
- Backend prod: **Node.js serverless / Vercel** (`api/proxy/*.js`)
- Persistência: **arquivos JSON commitados em `data/`** (snapshots ANS por UF/mês)
