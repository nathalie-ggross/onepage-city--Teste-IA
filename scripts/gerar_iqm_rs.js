/* =========================================================
 * Gera data/iqm_rs.json
 *
 * Uso:
 *   npm run gerar:iqm-rs
 * ou:
 *   node scripts/gerar_iqm_rs.js
 *
 * Fontes usadas:
 * - IBGE Localidades: municípios e microrregiões
 * - SIDRA 6579: população estimada mais recente
 * - SIDRA 5938: PIB municipal mais recente
 * - SIDRA 10292: proxy de renda A+B no Censo 2022
 * - data/ans_RS_YYYYMM.json: beneficiários ANS por município/operadora
 * - ElastiCNES: leitos e profissionais médicos
 * ========================================================= */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { elasticSearch, elasticLatestComp } from "../api/_lib/elastic.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const OUT_FILE = path.join(DATA_DIR, "iqm_rs.json");

const UF = "RS";
const UF_IBGE = "43";
const TODAY = new Date().toISOString().slice(0, 10);

const IBGE_LOC = "https://servicodados.ibge.gov.br/api/v1/localidades";
const IBGE_AGG = "https://servicodados.ibge.gov.br/api/v3/agregados";

const RENDA_CLASSES = [
  "99822", // até 1/4 SM
  "99823", // 1/4 a 1/2 SM
  "99824", // 1/2 a 1 SM
  "96179", // 1 a 2 SM
  "96180", // 2 a 3 SM
  "96181", // 3 a 5 SM
  "96182", // 5 a 10 SM
  "99825", // 10 a 15 SM
  "99828", // 15 a 20 SM
  "96184", // mais de 20 SM
  "96185", // sem rendimento
];

// Proxy operacional para A+B. Não é Critério Brasil.
// Mantém coerência com o app.js atual: classes >= 10 salários mínimos.
const RENDA_AB_KEYS = new Set(["99825", "99828", "96184"]);
const ODONTO_RX = /ODONTO|DENTAL|DENT[ÁA]RIO/i;

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function cod6(value) {
  const d = onlyDigits(value);
  return d.length >= 6 ? d.slice(0, 6) : d;
}

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  let s = String(value).trim();
  if (!s || s === "-" || s === "..." || /^x$/i.test(s)) return null;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function round(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  const f = 10 ** digits;
  return Math.round(Number(value) * f) / f;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function getJSON(url) {
  const r = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "onepage-city-iqm-generator/1.0",
    },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status} — ${url} — ${body.slice(0, 200)}`);
  }
  return r.json();
}

async function getMunicipiosRS() {
  const url = `${IBGE_LOC}/estados/${UF_IBGE}/municipios?orderBy=nome`;
  const data = await getJSON(url);
  return data.map((m) => ({
    codigo_ibge: String(m.id),
    codigo_6: String(m.id).slice(0, 6),
    municipio: m.nome,
    microrregiao: m.microrregiao?.nome || null,
    microrregiao_id: m.microrregiao?.id ? String(m.microrregiao.id) : null,
    mesorregiao: m.microrregiao?.mesorregiao?.nome || null,
    uf: m.microrregiao?.mesorregiao?.UF?.sigla || UF,
  }));
}

function extractSeriesValue(serieObj) {
  if (!serieObj) return { ano: null, valor: null };
  const anos = Object.keys(serieObj).sort();
  const ano = anos[anos.length - 1] || null;
  return { ano, valor: ano ? num(serieObj[ano]) : null };
}

async function fetchSidraMap({ tabela, variaveis, ids, extra = "", chunkSize = 80 }) {
  const map = {};
  for (const idsChunk of chunk(ids, chunkSize)) {
    const url = `${IBGE_AGG}/${tabela}/periodos/-1/variaveis/${variaveis}?localidades=N6[${idsChunk.join(",")}]${extra}`;
    const data = await getJSON(url);
    for (const variavel of data || []) {
      const varId = String(variavel.id);
      for (const resultado of variavel.resultados || []) {
        for (const serie of resultado.series || []) {
          const id = String(serie.localidade?.id || "");
          if (!id) continue;
          if (!map[id]) map[id] = {};
          map[id][varId] = extractSeriesValue(serie.serie || {});
        }
      }
    }
  }
  return map;
}

async function fetchRendaABMap(ids) {
  const map = {};
  const classIds = RENDA_CLASSES.join(",");

  for (const idsChunk of chunk(ids, 45)) {
    const url = `${IBGE_AGG}/10292/periodos/2022/variaveis/4090?localidades=N6[${idsChunk.join(",")}]&classificacao=11915[${classIds}]|2[6794]`;
    const data = await getJSON(url);

    const byCity = {};

    for (const resultado of data?.[0]?.resultados || []) {
      const cat = resultado.classificacoes?.find((c) => String(c.id) === "11915")?.categoria || {};
      const key = Object.keys(cat)[0];
      if (!key) continue;

      for (const serie of resultado.series || []) {
        const id = String(serie.localidade?.id || "");
        if (!id) continue;
        const valor = num(Object.values(serie.serie || {})[0]);
        if (valor === null) continue;
        if (!byCity[id]) byCity[id] = { total: 0, ab: 0 };
        byCity[id].total += valor;
        if (RENDA_AB_KEYS.has(key)) byCity[id].ab += valor;
      }
    }

    for (const [id, v] of Object.entries(byCity)) {
      map[id] = v.total > 0 ? (v.ab / v.total) * 100 : null;
    }
  }

  return map;
}

function loadLatestAnsRS() {
  const files = fs.readdirSync(DATA_DIR)
    .map((f) => f.match(/^ans_RS_(\d{6})\.json$/)?.[1])
    .filter(Boolean)
    .sort();

  const latest = files[files.length - 1];
  if (!latest) throw new Error("Nenhum arquivo data/ans_RS_YYYYMM.json encontrado.");

  const file = path.join(DATA_DIR, `ans_RS_${latest}.json`);
  const data = JSON.parse(fs.readFileSync(file, "utf-8"));
  return { competencia: latest, data };
}

function ansMunicipio(ansData, codigo6, populacao) {
  const c = ansData.byCity?.[codigo6] || { mh: 0, operadoras: {} };
  const mh = Number(c.mh || 0);

  const ops = Object.entries(c.operadoras || {})
    .map(([razao, v]) => ({
      razao,
      modalidade: v.modalidade || "",
      mh: Number(v.mh || 0),
      beneficiarios: Number(v.beneficiarios || 0),
    }))
    .filter((o) => o.mh > 0 && !ODONTO_RX.test(o.modalidade))
    .sort((a, b) => b.mh - a.mh);

  const lider = ops[0] || null;

  return {
    beneficiarios_mh: mh,
    cobertura_pct: populacao ? (mh / populacao) * 100 : null,
    operadora_lider: lider?.razao || null,
    beneficiarios_lider_mh: lider?.mh || null,
    concentracao_lider_pct: mh > 0 && lider ? (lider.mh / mh) * 100 : null,
    qtd_operadoras_mh: ops.length,
  };
}

async function fetchLeitosPorMunicipio(codigos6) {
  const map = {};
  let comp = null;

  try {
    comp = await elasticLatestComp("cnes-leitosh", 18);
    if (!comp) throw new Error("sem competência de leitos");

    const body = {
      size: 0,
      query: {
        bool: {
          filter: [
            { terms: { "CÓDIGO DO MUNICÍPIO.keyword": codigos6 } },
            { term: { "STATUS DO ESTABELECIMENTO.keyword": "ATIVO" } },
          ],
        },
      },
      aggs: {
        por_municipio: {
          terms: {
            field: "CÓDIGO DO MUNICÍPIO.keyword",
            size: 1000,
          },
          aggs: {
            existentes: { sum: { field: "LEITOS EXISTENTES" } },
            sus: { sum: { field: "LEITOS SUS" } },
            hospitais: { cardinality: { field: "CNES.keyword" } },
          },
        },
      },
    };

    const r = await elasticSearch(`cnes-leitosh-${comp}`, body);
    const buckets = r?.rawResponse?.aggregations?.por_municipio?.buckets || [];

    for (const b of buckets) {
      const total = Number(b.existentes?.value || 0);
      const sus = Number(b.sus?.value || 0);
      map[String(b.key)] = {
        comp,
        leitos_total: Math.round(total),
        leitos_sus: Math.round(sus),
        leitos_privados: Math.max(Math.round(total - sus), 0),
        hospitais_cnes: Math.round(Number(b.hospitais?.value || 0)),
      };
    }
  } catch (e) {
    console.warn(`Aviso: falha em leitos ElastiCNES: ${e.message || e}`);
  }

  return { comp, map };
}

async function fetchMedicosPorMunicipio(municipios) {
  const map = {};
  let comp = null;

  const codigos = [...new Set(municipios.flatMap((m) => [m.codigo_ibge, m.codigo_6]))];

  try {
    comp = await elasticLatestComp("cnes-profissionais", 18);
    if (!comp) throw new Error("sem competência de profissionais");

    const body = {
      size: 0,
      query: {
        bool: {
          filter: [
            { terms: { "ibge.keyword": codigos } },
            { wildcard: { "profissional_cbo.keyword": "225*" } },
          ],
        },
      },
      aggs: {
        por_municipio: {
          terms: {
            field: "ibge.keyword",
            size: 2000,
          },
          aggs: {
            medicos_unicos: {
              cardinality: {
                field: "profissional_cns.keyword",
                precision_threshold: 40000,
              },
            },
          },
        },
      },
    };

    const r = await elasticSearch(`cnes-profissionais-${comp}`, body);
    const buckets = r?.rawResponse?.aggregations?.por_municipio?.buckets || [];

    for (const b of buckets) {
      const key = cod6(b.key);
      if (!key) continue;
      map[key] = (map[key] || 0) + Math.round(Number(b.medicos_unicos?.value || 0));
    }
  } catch (e) {
    console.warn(`Aviso: falha em médicos ElastiCNES: ${e.message || e}`);
  }

  return { comp, map };
}

function validar(row) {
  const status = [];
  if (!row.populacao) status.push("sem_populacao");
  if (!row.pib_rs) status.push("sem_pib");
  if (row.cobertura_ans_pct == null) status.push("sem_cobertura_ans");
  if (row.renda_ab_pct == null) status.push("sem_renda_ab_proxy");
  if (row.medicos == null) status.push("sem_medicos");
  if (row.leitos_privados == null) status.push("sem_leitos_privados");
  if (row.concentracao_operadora_lider_pct == null) status.push("sem_concentracao_operadora");
  return status;
}

async function main() {
  console.log("Carregando municípios do RS...");
  const municipios = await getMunicipiosRS();
  const ids = municipios.map((m) => m.codigo_ibge);
  const codigos6 = municipios.map((m) => m.codigo_6);
  console.log(`Municípios: ${municipios.length}`);

  console.log("Carregando população SIDRA 6579...");
  const popMap = await fetchSidraMap({ tabela: 6579, variaveis: "9324", ids });

  console.log("Carregando PIB SIDRA 5938...");
  const pibMap = await fetchSidraMap({ tabela: 5938, variaveis: "37", ids });

  console.log("Carregando renda proxy A+B SIDRA 10292...");
  const rendaMap = await fetchRendaABMap(ids);

  console.log("Carregando ANS local...");
  const { competencia: competenciaAns, data: ansData } = loadLatestAnsRS();

  console.log("Carregando leitos ElastiCNES agregados...");
  const { comp: compLeitos, map: leitosMap } = await fetchLeitosPorMunicipio(codigos6);

  console.log("Carregando médicos ElastiCNES agregados...");
  const { comp: compMedicos, map: medicosMap } = await fetchMedicosPorMunicipio(municipios);

  console.log("Montando JSON final...");

  const rows = municipios.map((m) => {
    const popObj = popMap[m.codigo_ibge]?.["9324"] || {};
    const populacao = popObj.valor;
    const anoPop = popObj.ano ? Number(popObj.ano) : null;

    const pibObj = pibMap[m.codigo_ibge]?.["37"] || {};
    const pibMilReais = pibObj.valor;
    const pibRs = pibMilReais != null ? pibMilReais * 1000 : null;
    const anoPib = pibObj.ano ? Number(pibObj.ano) : null;

    const ans = ansMunicipio(ansData, m.codigo_6, populacao);
    const leitos = leitosMap[m.codigo_6] || null;
    const medicos = medicosMap[m.codigo_6] ?? null;

    const row = {
      codigo_ibge: m.codigo_ibge,
      codigo_6: m.codigo_6,
      municipio: m.municipio,
      microrregiao: m.microrregiao,
      microrregiao_id: m.microrregiao_id,
      mesorregiao: m.mesorregiao,
      uf: m.uf,

      populacao,
      ano_populacao: anoPop,

      pib_rs: pibRs,
      ano_pib: anoPib,

      cobertura_ans_pct: round(ans.cobertura_pct, 2),
      competencia_ans: competenciaAns,
      beneficiarios_ans_total: ans.beneficiarios_mh,

      renda_ab_pct: round(rendaMap[m.codigo_ibge], 2),
      ano_renda_ab: 2022,
      fonte_renda_ab: "Proxy IBGE/SIDRA 10292: pessoas em domicílios com rendimento domiciliar per capita >= 10 salários mínimos. Não é Critério Brasil A+B.",

      medicos,
      competencia_medicos: compMedicos,
      densidade_medica_10k: populacao && medicos != null ? round((medicos / populacao) * 10000, 2) : null,

      leitos_privados: leitos?.leitos_privados ?? null,
      leitos_total: leitos?.leitos_total ?? null,
      leitos_sus: leitos?.leitos_sus ?? null,
      hospitais_cnes: leitos?.hospitais_cnes ?? null,
      competencia_leitos: compLeitos,
      densidade_leito_privado_10k: populacao && leitos?.leitos_privados != null ? round((leitos.leitos_privados / populacao) * 10000, 2) : null,

      operadora_lider: ans.operadora_lider,
      beneficiarios_operadora_lider_mh: ans.beneficiarios_lider_mh,
      concentracao_operadora_lider_pct: round(ans.concentracao_lider_pct, 2),
      qtd_operadoras_mh: ans.qtd_operadoras_mh,

      fonte: "Base consolidada One Page: IBGE/SIDRA + ANS pré-processada + ElastiCNES",
      data_atualizacao: TODAY,
    };

    row.status_validacao = validar(row).join("; ");
    return row;
  });

  fs.writeFileSync(OUT_FILE, JSON.stringify(rows, null, 2) + "\n", "utf-8");

  const semCritico = rows.filter((r) => !r.status_validacao).length;
  console.log(`Arquivo gerado: ${path.relative(ROOT, OUT_FILE)}`);
  console.log(`Linhas: ${rows.length}`);
  console.log(`Linhas sem pendência: ${semCritico}`);
  console.log(`Competência ANS: ${competenciaAns}`);
  console.log(`Competência leitos: ${compLeitos || "N/D"}`);
  console.log(`Competência médicos: ${compMedicos || "N/D"}`);
}

main().catch((e) => {
  console.error("Falha ao gerar IQM RS:", e);
  process.exit(1);
});
