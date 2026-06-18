/* =========================================================
 * Gera data/iqm_rs.json
 *
 * Uso:
 *   npm.cmd run gerar:iqm-rs
 * ou:
 *   node scripts/gerar_iqm_rs.js
 *
 * Fontes usadas:
 * - IBGE Localidades: municípios e microrregiões
 * - SIDRA 6579: população estimada mais recente
 * - SIDRA 5938: PIB municipal mais recente
 * - SIDRA 10292: proxy de renda A+B no Censo 2022
 * - SIDRA 9514: população por faixa etária, para % 60+
 * - data/ans_RS_YYYYMM.json: beneficiários ANS por município/operadora
 * - ElastiCNES: leitos e profissionais médicos
 *
 * Observação metodológica:
 * - população e PIB total NÃO entram no IQM_qualidade.
 * - tamanho de mercado entra como porte/segmentação, não como qualidade.
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
  "99822", "99823", "99824", "96179", "96180", "96181", "96182",
  "99825", "99828", "96184", "96185",
];

// Proxy operacional para A+B. Não é Critério Brasil.
// Mantém coerência com o app.js atual: classes >= 10 salários mínimos.
const RENDA_AB_KEYS = new Set(["99825", "99828", "96184"]);

const AGE_GROUPS = [
  "93070", "93084", "93085", "93086", "93087", "93088", "93089", "93090", "93091",
  "93092", "93093", "93094", "93095", "93096", "93097", "93098", "49108", "49109",
  "60040", "60041", "6653",
];
const AGE_60_PLUS = new Set(["93095", "93096", "93097", "93098", "49108", "49109", "60040", "60041", "6653"]);

const ODONTO_RX = /ODONTO|DENTAL|DENT[ÁA]RIO/i;

// Aproximação por nome/CBO para médicos geradores de procedimento.
// É melhor que médico total para expansão hospitalar, mas ainda não substitui validação por linha de serviço.
const PROCEDURE_DOCTOR_RX = /CIRURG|ANESTES|ORTOPED|TRAUMATO|OFTALMO|OTORRINO|GINECO|OBSTET|UROLOG|COLOPROCT|VASCULAR|ANGIOLOG|ENDOSCOP|GASTRO|RADIOLOG|DIAGNOST|CARDIO|ONCO|CANCERO|MASTOLOG|NEUROCIR|PATOLOG|HEMOTER|RADIOTER|MEDICINA NUCLEAR/i;

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

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function scoreRobusto(v, p5, p95) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return null;
  if (!Number.isFinite(p5) || !Number.isFinite(p95) || p95 <= p5) return null;
  return clamp(((Number(v) - p5) / (p95 - p5)) * 100, 0, 100);
}

function quantile(values, q) {
  const xs = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return null;
  const pos = (xs.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return xs[lo];
  return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function ymIndex(ym) {
  const y = Number(String(ym).slice(0, 4));
  const m = Number(String(ym).slice(4, 6));
  return y * 12 + (m - 1);
}

function addMonthsYm(ym, delta) {
  const idx = ymIndex(ym) + delta;
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  return `${y}${String(m).padStart(2, "0")}`;
}

function pctChange(current, base) {
  if (!Number.isFinite(current) || !Number.isFinite(base) || base <= 0) return null;
  return ((current / base) - 1) * 100;
}

function cagrPct(current, base, months) {
  if (!Number.isFinite(current) || !Number.isFinite(base) || base <= 0 || months <= 0) return null;
  const years = months / 12;
  return (Math.pow(current / base, 1 / years) - 1) * 100;
}

async function getJSON(url) {
  const r = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "onepage-city-iqm-generator/1.0",
    },
  });

  const contentType = r.headers.get("content-type") || "";
  const text = await r.text();

  if (!r.ok) throw new Error(`HTTP ${r.status} — ${url} — ${text.slice(0, 200)}`);
  if (text.trim().startsWith("<")) {
    throw new Error(`Resposta HTML onde era esperado JSON — ${url} — ${text.slice(0, 200)}`);
  }

  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`JSON inválido — ${url} — content-type=${contentType} — ${text.slice(0, 200)}`);
  }
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

async function fetchAge60Map(ids) {
  const map = {};
  const classIds = AGE_GROUPS.join(",");

  for (const idsChunk of chunk(ids, 45)) {
    const url = `${IBGE_AGG}/9514/periodos/2022/variaveis/93?localidades=N6[${idsChunk.join(",")}]&classificacao=287[${classIds}]`;
    const data = await getJSON(url);
    const byCity = {};

    for (const resultado of data?.[0]?.resultados || []) {
      const cat = resultado.classificacoes?.find((c) => String(c.id) === "287")?.categoria || {};
      const ageKey = Object.keys(cat)[0];
      if (!ageKey) continue;

      for (const serie of resultado.series || []) {
        const id = String(serie.localidade?.id || "");
        if (!id) continue;
        const valor = num(Object.values(serie.serie || {})[0]);
        if (valor === null) continue;
        if (!byCity[id]) byCity[id] = { total: 0, pop60: 0 };
        byCity[id].total += valor;
        if (AGE_60_PLUS.has(ageKey)) byCity[id].pop60 += valor;
      }
    }

    for (const [id, v] of Object.entries(byCity)) {
      map[id] = {
        populacao_2022_faixas: v.total,
        populacao_60_mais: v.pop60,
        pct_populacao_60_mais: v.total > 0 ? (v.pop60 / v.total) * 100 : null,
      };
    }
  }

  return map;
}

function listAnsMonthsRS() {
  return fs.readdirSync(DATA_DIR)
    .map((f) => f.match(/^ans_RS_(\d{6})\.json$/)?.[1])
    .filter(Boolean)
    .sort();
}

function loadAnsRSMonth(ym) {
  const file = path.join(DATA_DIR, `ans_RS_${ym}.json`);
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function loadAnsRSAll() {
  const months = listAnsMonthsRS();
  if (!months.length) throw new Error("Nenhum arquivo data/ans_RS_YYYYMM.json encontrado.");
  const byMonth = {};
  for (const ym of months) byMonth[ym] = loadAnsRSMonth(ym);
  return { months, byMonth, latest: months[months.length - 1] };
}

function ansCityMh(ansData, codigo6) {
  return Number(ansData.byCity?.[codigo6]?.mh || 0);
}

function ansGrowth(allAns, codigo6) {
  const latest = allAns.latest;
  const current = ansCityMh(allAns.byMonth[latest], codigo6);

  const target12 = addMonthsYm(latest, -12);
  const base12 = [...allAns.months].filter((m) => m <= target12).pop() || allAns.months[0];
  const value12 = ansCityMh(allAns.byMonth[base12], codigo6);

  const target24 = addMonthsYm(latest, -24);
  const base24 = allAns.months.find((m) => m >= target24) || allAns.months[0];
  const value24 = ansCityMh(allAns.byMonth[base24], codigo6);
  const months24 = ymIndex(latest) - ymIndex(base24);

  return {
    variacao_ans_mh_12m_pct: round(pctChange(current, value12), 2),
    mes_base_variacao_ans_mh_12m: base12,
    cagr_ans_mh_periodo_pct: round(cagrPct(current, value24, months24), 2),
    mes_base_cagr_ans_mh: base24,
  };
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
  const hhi = mh > 0
    ? ops.reduce((sum, o) => {
        const share = (o.mh / mh) * 100;
        return sum + share * share;
      }, 0)
    : null;

  return {
    beneficiarios_mh: mh,
    cobertura_pct: populacao ? (mh / populacao) * 100 : null,
    operadora_lider: lider?.razao || null,
    beneficiarios_lider_mh: lider?.mh || null,
    concentracao_lider_pct: mh > 0 && lider ? (lider.mh / mh) * 100 : null,
    qtd_operadoras_mh: ops.length,
    hhi_operadoras_mh: hhi,
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
          terms: { field: "CÓDIGO DO MUNICÍPIO.keyword", size: 1000 },
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

function isProcedureDoctorCbo(cboKey) {
  return PROCEDURE_DOCTOR_RX.test(String(cboKey || ""));
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
          terms: { field: "ibge.keyword", size: 2000 },
          aggs: {
            medicos_unicos: {
              cardinality: { field: "profissional_cns.keyword", precision_threshold: 40000 },
            },
            por_cbo: {
              terms: { field: "profissional_cbo.keyword", size: 300 },
              aggs: {
                medicos_unicos: {
                  cardinality: { field: "profissional_cns.keyword", precision_threshold: 40000 },
                },
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

      const total = Math.round(Number(b.medicos_unicos?.value || 0));
      let procedimentoAprox = 0;

      for (const cboBucket of b.por_cbo?.buckets || []) {
        if (isProcedureDoctorCbo(cboBucket.key)) {
          procedimentoAprox += Math.round(Number(cboBucket.medicos_unicos?.value || 0));
        }
      }

      if (!map[key]) map[key] = { medicos: 0, medicos_procedimento_aprox: 0 };
      map[key].medicos += total;
      map[key].medicos_procedimento_aprox += procedimentoAprox;
    }
  } catch (e) {
    console.warn(`Aviso: falha em médicos ElastiCNES: ${e.message || e}`);
  }

  return { comp, map };
}

function porteMercadoAns(beneficiarios) {
  const n = Number(beneficiarios || 0);
  if (n < 1000) return "Micro";
  if (n < 5000) return "Pequeno";
  if (n < 20000) return "Médio";
  if (n < 80000) return "Grande";
  return "Muito grande";
}

function classeIQM(iqm) {
  if (iqm == null) return null;
  if (iqm >= 70) return "A - Excelente";
  if (iqm >= 55) return "B - Alto potencial";
  if (iqm >= 40) return "C - Seletivo";
  if (iqm >= 25) return "D - Baixo";
  return "E - Frágil";
}

function prioridadeExpansao(iqm, porte) {
  if (iqm == null || !porte) return null;
  const grande = porte === "Grande" || porte === "Muito grande";
  if (iqm >= 70 && grande) return "Prioridade 1";
  if (iqm >= 55 && grande) return "Prioridade 2";
  if (iqm >= 70 && porte === "Médio") return "Prioridade 2";
  if (iqm >= 55 && porte === "Médio") return "Investigar";
  if (iqm >= 70) return "Nicho";
  if (iqm >= 40 && grande) return "Mercado grande, seletivo/difícil";
  return "Baixa prioridade";
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
  if (row.pct_populacao_60_mais == null) status.push("sem_populacao_60_mais");
  if (row.variacao_ans_mh_12m_pct == null) status.push("sem_variacao_ans");
  return status;
}

function buildMicroAgg(rows) {
  const micro = {};

  for (const r of rows) {
    const id = r.microrregiao_id || r.microrregiao || "SEM_MICRO";
    if (!micro[id]) {
      micro[id] = {
        populacao: 0,
        beneficiarios_ans_total: 0,
        leitos_privados: 0,
        medicos: 0,
        medicos_procedimento_aprox: 0,
        municipios: 0,
      };
    }
    const m = micro[id];
    m.populacao += Number(r.populacao || 0);
    m.beneficiarios_ans_total += Number(r.beneficiarios_ans_total || 0);
    m.leitos_privados += Number(r.leitos_privados || 0);
    m.medicos += Number(r.medicos || 0);
    m.medicos_procedimento_aprox += Number(r.medicos_procedimento_aprox || 0);
    m.municipios += 1;
  }

  for (const m of Object.values(micro)) {
    m.cobertura_ans_pct = m.populacao ? (m.beneficiarios_ans_total / m.populacao) * 100 : null;
    m.densidade_leito_privado_10k = m.populacao ? (m.leitos_privados / m.populacao) * 10000 : null;
    m.densidade_medica_10k = m.populacao ? (m.medicos / m.populacao) * 10000 : null;
    m.densidade_medicos_procedimento_10k = m.populacao ? (m.medicos_procedimento_aprox / m.populacao) * 10000 : null;
    m.beneficiarios_ans_por_leito_privado = m.leitos_privados > 0 ? m.beneficiarios_ans_total / m.leitos_privados : null;
    m.beneficiarios_ans_por_leito_privado_ajustado = m.beneficiarios_ans_total / (m.leitos_privados + 5);
  }

  return micro;
}

function addScores(rows) {
  const ranges = {
    cobertura: [quantile(rows.map((r) => r.cobertura_ans_pct), 0.05), quantile(rows.map((r) => r.cobertura_ans_pct), 0.95)],
    pressao: [quantile(rows.map((r) => r.beneficiarios_ans_por_leito_privado_ajustado), 0.05), quantile(rows.map((r) => r.beneficiarios_ans_por_leito_privado_ajustado), 0.95)],
    medProc: [quantile(rows.map((r) => r.densidade_medicos_procedimento_10k), 0.05), quantile(rows.map((r) => r.densidade_medicos_procedimento_10k), 0.95)],
    leitos: [quantile(rows.map((r) => r.densidade_leito_privado_10k), 0.05), quantile(rows.map((r) => r.densidade_leito_privado_10k), 0.95)],
    renda: [quantile(rows.map((r) => r.renda_ab_pct), 0.05), quantile(rows.map((r) => r.renda_ab_pct), 0.95)],
    crescimentoAns: [quantile(rows.map((r) => r.variacao_ans_mh_12m_pct), 0.05), quantile(rows.map((r) => r.variacao_ans_mh_12m_pct), 0.95)],
    centralidade: [quantile(rows.map((r) => r.participacao_pop_microrregiao_pct), 0.05), quantile(rows.map((r) => r.participacao_pop_microrregiao_pct), 0.95)],
  };

  for (const r of rows) {
    const scoreCob = scoreRobusto(r.cobertura_ans_pct, ...ranges.cobertura);
    const scorePressao = scoreRobusto(r.beneficiarios_ans_por_leito_privado_ajustado, ...ranges.pressao);
    const scoreMedProc = scoreRobusto(r.densidade_medicos_procedimento_10k, ...ranges.medProc);
    const scoreLeitos = scoreRobusto(r.densidade_leito_privado_10k, ...ranges.leitos);
    const scoreRenda = scoreRobusto(r.renda_ab_pct, ...ranges.renda);
    const scoreCrescAns = scoreRobusto(r.variacao_ans_mh_12m_pct, ...ranges.crescimentoAns);
    const scoreCentralidade = scoreRobusto(r.participacao_pop_microrregiao_pct, ...ranges.centralidade);

    r.score_cobertura_ans = round(scoreCob, 2);
    r.score_pressao_demanda_ans_leito = round(scorePressao, 2);
    r.score_medicos_procedimento = round(scoreMedProc, 2);
    r.score_leitos_privados = round(scoreLeitos, 2);
    r.score_renda_ab_proxy = round(scoreRenda, 2);
    r.score_crescimento_ans = round(scoreCrescAns, 2);
    r.score_centralidade_microrregional = round(scoreCentralidade, 2);

    const safe = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;

    const iqmBase =
      0.25 * safe(scoreCob) +
      0.20 * safe(scorePressao) +
      0.15 * safe(scoreMedProc) +
      0.10 * safe(scoreLeitos) +
      0.10 * safe(scoreRenda) +
      0.10 * safe(scoreCrescAns) +
      0.10 * safe(scoreCentralidade);

    // Detrator principal por HHI. Fallback pela concentração da líder.
    let detrator = null;
    if (r.hhi_operadoras_mh != null) {
      detrator = clamp(((r.hhi_operadoras_mh - 2500) / (7000 - 2500)) * 10, 0, 10);
    } else if (r.concentracao_operadora_lider_pct != null) {
      detrator = clamp(((r.concentracao_operadora_lider_pct - 40) / (85 - 40)) * 10, 0, 10);
    }

    r.detrator_concentracao_operadora_pontos = round(detrator, 2);
    r.iqm_qualidade_base = round(iqmBase, 2);
    r.iqm_qualidade_final = round(clamp(iqmBase - safe(detrator), 0, 100), 2);
    r.classe_iqm_qualidade = classeIQM(r.iqm_qualidade_final);
    r.prioridade_expansao = prioridadeExpansao(r.iqm_qualidade_final, r.porte_mercado_ans);
  }

  return { rows, ranges };
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

  console.log("Carregando população 60+ SIDRA 9514...");
  const age60Map = await fetchAge60Map(ids);

  console.log("Carregando ANS local e histórico...");
  const ansAll = loadAnsRSAll();
  const ansDataLatest = ansAll.byMonth[ansAll.latest];

  console.log("Carregando leitos ElastiCNES agregados...");
  const { comp: compLeitos, map: leitosMap } = await fetchLeitosPorMunicipio(codigos6);

  console.log("Carregando médicos ElastiCNES agregados...");
  const { comp: compMedicos, map: medicosMap } = await fetchMedicosPorMunicipio(municipios);

  console.log("Montando JSON final...");

  let rows = municipios.map((m) => {
    const popObj = popMap[m.codigo_ibge]?.["9324"] || {};
    const populacao = popObj.valor;
    const anoPop = popObj.ano ? Number(popObj.ano) : null;

    const pibObj = pibMap[m.codigo_ibge]?.["37"] || {};
    const pibMilReais = pibObj.valor;
    const pibRs = pibMilReais != null ? pibMilReais * 1000 : null;
    const anoPib = pibObj.ano ? Number(pibObj.ano) : null;

    const ans = ansMunicipio(ansDataLatest, m.codigo_6, populacao);
    const growth = ansGrowth(ansAll, m.codigo_6);

    const leitos = leitosMap[m.codigo_6] || null;
    const leitosPrivados = compLeitos ? (leitos?.leitos_privados ?? 0) : null;
    const leitosTotal = compLeitos ? (leitos?.leitos_total ?? 0) : null;
    const leitosSus = compLeitos ? (leitos?.leitos_sus ?? 0) : null;
    const hospitaisCnes = compLeitos ? (leitos?.hospitais_cnes ?? 0) : null;

    const med = medicosMap[m.codigo_6] || null;
    const medicos = compMedicos ? (med?.medicos ?? 0) : null;
    const medicosProcedimento = compMedicos ? (med?.medicos_procedimento_aprox ?? 0) : null;

    const benef = ans.beneficiarios_mh || 0;
    const benefPorLeitoRaw = leitosPrivados && leitosPrivados > 0 ? benef / leitosPrivados : null;
    const benefPorLeitoAdj = leitosPrivados != null ? benef / (leitosPrivados + 5) : null;

    const age = age60Map[m.codigo_ibge] || {};

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
      pib_per_capita_rs: populacao && pibRs ? round(pibRs / populacao, 2) : null,

      cobertura_ans_pct: round(ans.cobertura_pct, 2),
      competencia_ans: ansAll.latest,
      beneficiarios_ans_total: ans.beneficiarios_mh,
      porte_mercado_ans: porteMercadoAns(ans.beneficiarios_mh),

      beneficiarios_ans_por_leito_privado: round(benefPorLeitoRaw, 2),
      beneficiarios_ans_por_leito_privado_ajustado: round(benefPorLeitoAdj, 2),

      variacao_ans_mh_12m_pct: growth.variacao_ans_mh_12m_pct,
      mes_base_variacao_ans_mh_12m: growth.mes_base_variacao_ans_mh_12m,
      cagr_ans_mh_periodo_pct: growth.cagr_ans_mh_periodo_pct,
      mes_base_cagr_ans_mh: growth.mes_base_cagr_ans_mh,

      renda_ab_pct: round(rendaMap[m.codigo_ibge], 2),
      ano_renda_ab: 2022,
      fonte_renda_ab: "Proxy IBGE/SIDRA 10292: pessoas em domicílios com rendimento domiciliar per capita >= 10 salários mínimos. Não é Critério Brasil A+B.",

      populacao_60_mais: age.populacao_60_mais ?? null,
      pct_populacao_60_mais: round(age.pct_populacao_60_mais, 2),
      ano_populacao_60_mais: 2022,

      medicos,
      competencia_medicos: compMedicos,
      densidade_medica_10k: populacao && medicos != null ? round((medicos / populacao) * 10000, 2) : null,
      medicos_procedimento_aprox: medicosProcedimento,
      densidade_medicos_procedimento_10k: populacao && medicosProcedimento != null ? round((medicosProcedimento / populacao) * 10000, 2) : null,
      fonte_medicos_procedimento: "Aproximação por CBO/nome da especialidade médica no ElastiCNES; pode contar médico em mais de uma especialidade.",

      leitos_privados: leitosPrivados,
      leitos_total: leitosTotal,
      leitos_sus: leitosSus,
      hospitais_cnes: hospitaisCnes,
      competencia_leitos: compLeitos,
      densidade_leito_privado_10k: populacao && leitosPrivados != null ? round((leitosPrivados / populacao) * 10000, 2) : null,

      operadora_lider: ans.operadora_lider,
      beneficiarios_operadora_lider_mh: ans.beneficiarios_lider_mh,
      concentracao_operadora_lider_pct: round(ans.concentracao_lider_pct, 2),
      qtd_operadoras_mh: ans.qtd_operadoras_mh,
      hhi_operadoras_mh: round(ans.hhi_operadoras_mh, 0),

      fonte: "Base consolidada One Page: IBGE/SIDRA + ANS pré-processada + ElastiCNES",
      data_atualizacao: TODAY,
    };

    return row;
  });

  const micro = buildMicroAgg(rows);

  rows = rows.map((r) => {
    const m = micro[r.microrregiao_id || r.microrregiao || "SEM_MICRO"] || {};
    r.populacao_microrregiao = m.populacao || null;
    r.participacao_pop_microrregiao_pct = m.populacao ? round((Number(r.populacao || 0) / m.populacao) * 100, 2) : null;
    r.beneficiarios_ans_microrregiao_total = m.beneficiarios_ans_total || 0;
    r.cobertura_ans_microrregiao_pct = round(m.cobertura_ans_pct, 2);
    r.leitos_privados_microrregiao = m.leitos_privados || 0;
    r.densidade_leito_privado_microrregiao_10k = round(m.densidade_leito_privado_10k, 2);
    r.beneficiarios_ans_por_leito_privado_microrregiao = round(m.beneficiarios_ans_por_leito_privado, 2);
    r.beneficiarios_ans_por_leito_privado_microrregiao_ajustado = round(m.beneficiarios_ans_por_leito_privado_ajustado, 2);
    r.medicos_microrregiao = m.medicos || 0;
    r.densidade_medica_microrregiao_10k = round(m.densidade_medica_10k, 2);
    r.medicos_procedimento_microrregiao_aprox = m.medicos_procedimento_aprox || 0;
    r.densidade_medicos_procedimento_microrregiao_10k = round(m.densidade_medicos_procedimento_10k, 2);
    r.status_validacao = validar(r).join("; ");
    return r;
  });

  const scoring = addScores(rows);
  rows = scoring.rows;

  fs.writeFileSync(OUT_FILE, JSON.stringify(rows, null, 2) + "\n", "utf-8");

  const semCritico = rows.filter((r) => !r.status_validacao).length;
  console.log(`Arquivo gerado: ${path.relative(ROOT, OUT_FILE)}`);
  console.log(`Linhas: ${rows.length}`);
  console.log(`Linhas sem pendência: ${semCritico}`);
  console.log(`Competência ANS: ${ansAll.latest}`);
  console.log(`Competência leitos: ${compLeitos || "N/D"}`);
  console.log(`Competência médicos: ${compMedicos || "N/D"}`);
  console.log("Novas variáveis incluídas: pressão demanda ANS/leito, crescimento ANS, 60+, centralidade, HHI, PIB per capita, microrregião e IQM_qualidade.");
}

main().catch((e) => {
  console.error("Falha ao gerar IQM RS:", e);
  process.exit(1);
});
