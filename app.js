/* =========================================================
 * One Page — Pesquisa de Cidades
 * 3 abas: Microrregião · Cidade · Infra
 * Fontes: IBGE · CNES · ANS (via backend)
 * ========================================================= */

const IBGE_LOC = "https://servicodados.ibge.gov.br/api/v1/localidades";
const IBGE_AGG = "https://servicodados.ibge.gov.br/api/v3/agregados";
const CNES = "/proxy/cnes";
const ANS = "/proxy/ans";
const LEITOS = "/proxy/elastic/leitos";       // ElastiCNES (mais detalhado)
const SERVICOS = "/proxy/elastic/servicos";   // especialidades por CNES
const MEDICOS = "/proxy/elastic/profissionais"; // profissionais médicos por CBO/CNS

// Porto Alegre — referência para comparação
const POA_IBGE = "4314902";
const POA_CNES = "431490";
const CAXIAS_IBGE = "4305108";

const COLORS = {
  ink: "#0b1220",
  brand: "#1a3566",
  brand2: "#274a8a",
  gray1: "#2a3246",
  gray2: "#8a93a3",
  male: "#1a3566",
  female: "#8a93a3",
};

const AGE_GROUPS = [
  { id: "93070", label: "0–4" },
  { id: "93084", label: "5–9" },
  { id: "93085", label: "10–14" },
  { id: "93086", label: "15–19" },
  { id: "93087", label: "20–24" },
  { id: "93088", label: "25–29" },
  { id: "93089", label: "30–34" },
  { id: "93090", label: "35–39" },
  { id: "93091", label: "40–44" },
  { id: "93092", label: "45–49" },
  { id: "93093", label: "50–54" },
  { id: "93094", label: "55–59" },
  { id: "93095", label: "60–64" },
  { id: "93096", label: "65–69" },
  { id: "93097", label: "70–74" },
  { id: "93098", label: "75–79" },
  { id: "49108", label: "80–84" },
  { id: "49109", label: "85–89" },
  { id: "60040", label: "90–94" },
  { id: "60041", label: "95–99" },
  { id: "6653",  label: "100+"  },
];
const AGE_60_PLUS = new Set(["93095","93096","93097","93098","49108","49109","60040","60041","6653"]);

const TIPO_UNIDADE_MAP = {
  1: "Posto de Saúde", 2: "Centro de Saúde/UBS", 4: "Policlínica",
  5: "Hospital Geral", 7: "Hospital Especializado",
  15: "Unidade Mista", 20: "Pronto Socorro Geral", 21: "Pronto Socorro Especializado",
  22: "Consultório Isolado", 32: "Unidade Móvel Fluvial",
  36: "Clínica / Centro de Especialidade", 39: "Unidade de Apoio Diagnose/Terapia (SADT)",
  40: "Unidade Móvel Terrestre", 42: "Unidade Móvel Pré-Hospitalar (Urgência)",
  43: "Farmácia", 45: "Unidade de Saúde da Família", 50: "Unidade de Vigilância",
  60: "Cooperativa", 61: "Centro de Parto Normal (Isolado)", 62: "Hospital/Dia (Isolado)",
  69: "Centro de Atenção Hemoterápica/Hematológica", 70: "Centro de Atenção Psicossocial (CAPS)",
  71: "Centro de Apoio à Saúde da Família", 72: "Unidade de Atenção à Saúde Indígena",
  73: "Pronto Atendimento", 74: "Polo Academia da Saúde",
  75: "Telessaúde", 76: "Central de Regulação do Acesso",
  77: "Serviço de Atenção Domiciliar (SAD)", 78: "Unidade de Atenção em Regime Residencial",
  79: "Oficina Ortopédica", 80: "Laboratório Central de Saúde Pública (LACEN)",
  81: "Central de Regulação de Serviços de Saúde", 82: "Central de Regulação Médica das Urgências (SAMU)",
  83: "Polo de Prevenção de Doenças e Agravos", 84: "Central de Notificação/Captação/Distribuição de Órgãos",
  85: "Centro de Imunização",
};

/* ===== State ===== */
const state = {
  city: null,
  micro: { id: null, nome: null, municipios: [] },
  establishments: [],
  estabsPOA: [],
  estabsMicro: [],
  charts: {},
  maps: {},
};

/* ===== Utils ===== */
const $  = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) n.append(k?.nodeType ? k : document.createTextNode(k));
  return n;
};
const fmt = n => (n == null || Number.isNaN(n)) ? "—" : Number(n).toLocaleString("pt-BR");
const fmt1 = n => (n == null || Number.isNaN(n)) ? "—" : Number(n).toLocaleString("pt-BR", { maximumFractionDigits: 1 });
const pct = (v, total) => total ? ((v / total) * 100).toFixed(1) + "%" : "—";
// Filtra ANS para MÉDICO-HOSPITALAR somente (exclui odontológicos).
// Retorna um objeto no mesmo formato, com total = mh e só operadoras com mh > 0.
// Defesa em profundidade: rejeita explicitamente modalidades odonto mesmo que mh > 0
// (impossível em teoria, mas blinda contra dados sujos do backend).
const ODONTO_RX = /ODONTO|DENTAL|DENT[ÁA]RIO/i;
function ansMHOnly(raw) {
  if (!raw) return null;
  const ops = (raw.operadoras || [])
    .filter(o => (o.mh || 0) > 0 && !ODONTO_RX.test(o.modalidade || ""))
    .map(o => ({ ...o, beneficiarios: o.mh }))
    .sort((a, b) => b.beneficiarios - a.beneficiarios);
  return {
    month: raw.month,
    total: raw.mh || 0,
    operadoras: ops,
  };
}
// Coleciona top N operadoras + uma linha "Outras" com soma do restante.
function topOpsWithOutras(ops, n = 5) {
  if (!ops || ops.length <= n) return ops || [];
  const top = ops.slice(0, n);
  const rest = ops.slice(n);
  const outrasCount = rest.length;
  const outrasSum = rest.reduce((a, b) => a + (b.beneficiarios || 0), 0);
  return [...top, {
    razao: `Outras (${outrasCount})`,
    modalidade: "—",
    beneficiarios: outrasSum,
    isOutras: true,
  }];
}

const monthLabel = ym => {
  if (!ym || ym.length < 6) return ym || "";
  const MESES = ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];
  return `${MESES[Number(ym.slice(4,6)) - 1]}/${ym.slice(0,4)}`;
};

function showLoader(msg) { $("#loader-msg").textContent = msg || "Carregando dados…"; $("#loader").hidden = false; }
function hideLoader() { $("#loader").hidden = true; }
function showError(msg) { const e = $("#error"); e.textContent = msg; e.hidden = false; setTimeout(() => (e.hidden = true), 8000); }

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res.json();
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/* ===== Search autocomplete ===== */
let _allMun;
const loadMun = async () => (_allMun ||= await getJSON(`${IBGE_LOC}/municipios`));
const norm = s => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

const onType = debounce(async () => {
  const q = norm($("#search").value.trim());
  const box = $("#suggestions");
  if (q.length < 2) { box.hidden = true; box.innerHTML = ""; return; }
  const list = await loadMun();
  const matches = list.filter(m => norm(m.nome).includes(q)).slice(0, 10);
  box.innerHTML = "";
  if (!matches.length) { box.hidden = true; return; }
  for (const m of matches) {
    const uf = m.microrregiao?.mesorregiao?.UF?.sigla ?? "";
    box.append(el("li", { onclick: () => selectCity(m.id, m.nome, uf) },
      el("span", {}, m.nome), el("span", { class: "uf" }, uf)));
  }
  box.hidden = false;
}, 200);

$("#search").addEventListener("input", onType);
$("#search").addEventListener("blur", () => setTimeout(() => ($("#suggestions").hidden = true), 200));
$("#search").addEventListener("focus", onType);
$("#search").addEventListener("keydown", e => { if (e.key === "Enter") { const f = $("#suggestions li"); if (f) f.click(); } });
for (const btn of $$(".example")) btn.addEventListener("click", () => selectCity(btn.dataset.id, btn.dataset.name, btn.dataset.uf));
// ---------- Impressão: snapshot SÍNCRONO antes do window.print() ----------
// O canvas do Chart.js costuma "sumir" quando o navegador aplica @media print
// porque o re-render é assíncrono. Solução: congelamos como PNG antes de imprimir.

// Plugin Chart.js que, quando ativado (chart.options.plugins.printValues.show),
// desenha os valores em cima de cada ponto/barra/segmento. Usado só na impressão.
// Internamente envelopado em try/catch — qualquer falha aqui NÃO pode quebrar
// o fluxo de impressão.
const printValuesPlugin = {
  id: "printValues",
  afterDatasetsDraw(chart, _args, opts) {
    if (!opts || !opts.show) return;
    try {
      const ctx = chart.ctx;
      if (!ctx) return;
      const fmtN = v => {
        if (v == null || Number.isNaN(v)) return "";
        const a = Math.abs(v);
        return a >= 1000
          ? Number(v).toLocaleString("pt-BR", { maximumFractionDigits: 0 })
          : Number(v).toLocaleString("pt-BR", { maximumFractionDigits: 1 });
      };
      ctx.save();
      ctx.font = "700 10px -apple-system, 'Inter', Helvetica, Arial, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const chartType = chart?.config?.type || "";
      (chart.data?.datasets || []).forEach((ds, di) => {
        const meta = chart.getDatasetMeta(di);
        if (!meta || meta.hidden) return;
        const type = meta.type || chartType;
        // Bubble já tem labels próprias — não duplicar
        if (type === "bubble") return;
        (meta.data || []).forEach((elem, i) => {
          if (!elem) return;
          const raw = ds.data[i];
          if (raw == null) return;
          let val = (typeof raw === "object")
            ? (raw.y != null ? raw.y : raw.r != null ? raw.r : raw.v)
            : raw;
          if (val == null) return;
          const label = fmtN(Math.abs(val));
          if (!label) return;
          const pos = (typeof elem.tooltipPosition === "function")
            ? elem.tooltipPosition()
            : { x: elem.x, y: elem.y };
          if (pos.x == null || pos.y == null) return;
          let x = pos.x, y = pos.y;
          const padX = 3, padY = 1.5;
          const w = ctx.measureText(label).width + padX * 2;
          const h = 12;
          if (type === "bar") {
            if (chart.options.indexAxis === "y") {
              x = elem.x + (val < 0 ? -10 : 10);
            } else {
              y = elem.y - 8;
            }
          } else if (type !== "doughnut" && type !== "pie") {
            y = elem.y - 8;
          }
          ctx.fillStyle = "rgba(255,255,255,0.92)";
          ctx.fillRect(x - w / 2, y - h / 2 - padY, w, h + padY * 2);
          ctx.fillStyle = "#0b1220";
          ctx.fillText(label, x, y);
        });
      });
      ctx.restore();
    } catch (err) {
      console.warn("printValues plugin error (silencioso):", err);
    }
  },
};
if (typeof Chart !== "undefined") {
  try { Chart.register(printValuesPlugin); } catch (e) { console.warn("printValues register falhou:", e); }
}

function togglePrintValues(on) {
  for (const key in state.charts) {
    const chart = state.charts[key];
    if (!chart) continue;
    try {
      chart.options.plugins = chart.options.plugins || {};
      chart.options.plugins.printValues = { show: !!on };
      // update("none") força um render síncrono sem animação. Isto é suficiente
      // para o próximo toBase64Image capturar a versão correta. NÃO chamamos
      // chart.draw() porque não é parte da API pública do Chart.js 4 e pode
      // jogar exceção em algumas versões.
      chart.update("none");
    } catch (e) {
      console.warn(`togglePrintValues falhou para ${key}:`, e);
    }
  }
}

function snapshotAllCharts() {
  togglePrintValues(true);
  for (const key in state.charts) {
    const chart = state.charts[key];
    if (!chart || !chart.canvas) continue;
    const canvas = chart.canvas;
    if (canvas.dataset.printReplaced === "1") continue;
    try {
      const dataUrl = (typeof chart.toBase64Image === "function")
        ? chart.toBase64Image("image/png", 1.0)
        : canvas.toDataURL("image/png");
      const parent = canvas.parentElement;
      if (!parent) continue;
      const img = new Image();
      img.src = dataUrl;
      img.className = "print-snapshot";
      img.alt = "gráfico";
      parent.appendChild(img);
      canvas.dataset.printReplaced = "1";
      canvas.style.visibility = "hidden";
    } catch (e) {
      console.warn("snapshot falhou:", key, e);
    }
  }
}

function restoreAllCharts() {
  try {
    document.querySelectorAll("img.print-snapshot").forEach(img => img.remove());
    document.querySelectorAll("canvas[data-print-replaced='1']").forEach(c => {
      c.style.visibility = "";
      c.dataset.printReplaced = "0";
    });
    togglePrintValues(false);
  } catch (e) {
    console.warn("restoreAllCharts falhou:", e);
  }
}

function runPrint() {
  try {
    for (const k in state.maps) {
      try { state.maps[k].invalidateSize(); } catch {}
    }
    // Pequeno delay para o DOM se estabilizar (mapas, etc.)
    setTimeout(() => {
      try {
        snapshotAllCharts();
      } catch (e) {
        console.warn("snapshotAllCharts falhou — imprimindo mesmo assim:", e);
      }
      requestAnimationFrame(() => {
        try {
          window.print();
        } catch (e) {
          console.error("window.print() falhou:", e);
          alert("Não foi possível abrir a janela de impressão. Use Ctrl/Cmd+P como alternativa.");
        }
        setTimeout(restoreAllCharts, 600);
      });
    }, 80);
  } catch (e) {
    console.error("runPrint falhou:", e);
    alert("Erro ao preparar impressão: " + (e.message || e));
  }
}

const printBtn = document.getElementById("print-btn");
if (printBtn) printBtn.addEventListener("click", runPrint);

// Fallback: se o usuário apertar Ctrl/Cmd+P direto (não passou pelo botão),
// cai de volta pro caminho via evento.
window.addEventListener("beforeprint", () => {
  if (!document.querySelector("img.print-snapshot")) snapshotAllCharts();
  for (const k in state.maps) try { state.maps[k].invalidateSize(); } catch {}
});
window.addEventListener("afterprint", restoreAllCharts);

/* ===== Tab switcher ===== */
$$(".tab").forEach(t => t.addEventListener("click", () => {
  $$(".tab").forEach(x => x.classList.toggle("active", x === t));
  const tab = t.dataset.tab;
  $$(".tab-panel").forEach(p => p.classList.toggle("active", p.dataset.panel === tab));
  // invalida mapas quando trocar para aba com mapa
  setTimeout(() => { for (const k in state.maps) state.maps[k]?.invalidateSize?.(); }, 120);
}));

/* ===== Referência POA (cache de sessão) =====
 * Carrega 1x os dados de POA cidade + microrregião de POA usados como
 * comparativo nos cards de hab/leito e benef/leito.
 */
let _poaRefCache = null;
async function loadPOAReference() {
  if (_poaRefCache) return _poaRefCache;
  try {
    const loc = await getJSON(`${IBGE_LOC}/municipios/${POA_IBGE}`);
    const microId = loc.microrregiao.id;
    const ufSigla = loc.microrregiao.mesorregiao.UF.sigla;
    const microMun = await getJSON(`${IBGE_LOC}/microrregioes/${microId}/municipios`);
    const microIds = microMun.map(m => String(m.id));
    const microCods6 = microIds.map(i => i.slice(0, 6)).join(",");

    const [popPOA, popMicro, ansCityRaw, ansMicroRaw, leitosCity, leitosMicro] = await Promise.all([
      fetchPopByMunicipios([POA_IBGE]).catch(() => ({})),
      fetchPopByMunicipios(microIds).catch(() => ({})),
      getJSON(`${ANS}?uf=${ufSigla}&cod=${POA_CNES}`).catch(() => null),
      getJSON(`${ANS}/multi?uf=${ufSigla}&cods=${microCods6}`).catch(() => null),
      getJSON(`${LEITOS}?cod=${POA_CNES}`).catch(() => null),
      getJSON(`${LEITOS}/multi?cods=${microCods6}`).catch(() => null),
    ]);

    const ansCity = ansMHOnly(ansCityRaw);
    const ansMicro = ansMHOnly(ansMicroRaw);
    const cityPop = popPOA[POA_IBGE] || 0;
    const microPop = Object.values(popMicro).reduce((a, b) => a + (b || 0), 0);

    _poaRefCache = {
      city: {
        pop: cityPop,
        ansTotal: ansCity?.total || 0,
        leitosTotais: leitosCity?.totais || null,
      },
      micro: {
        microId,
        pop: microPop,
        ansTotal: ansMicro?.total || 0,
        leitosTotais: leitosMicro?.totais || null,
      },
    };
  } catch (e) {
    console.warn("loadPOAReference falhou:", e);
    _poaRefCache = { city: null, micro: null };
  }
  return _poaRefCache;
}

function renderPOAReferences(ref) {
  const setRef = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  const ratio = (a, b) => (a && b) ? fmt(Math.round(a / b)) : "—";

  // Cidade, referência POA
  const c = ref?.city;
  if (c?.leitosTotais) {
    const t = c.leitosTotais;
    setRef("ref-city-habxleito-tot", ratio(c.pop, t.existentes));
    setRef("ref-city-habxleito-sus", ratio(c.pop, t.sus));
    setRef("ref-city-benefxleito-priv", ratio(c.ansTotal, t.privados));
  }

  // Microrregião, referência POA
  const m = ref?.micro;
  if (m?.leitosTotais) {
    const t = m.leitosTotais;
    setRef("ref-micro-habxleito-tot", ratio(m.pop, t.existentes));
    setRef("ref-micro-habxleito-sus", ratio(m.pop, t.sus));
    setRef("ref-micro-benefxleito-priv", ratio(m.ansTotal, t.privados));
  }
}

function renderMedicosBeneficiariosKPI({ cidade, poa, ansCidade, ansPoaTotal }) {
  const set = (id, value) => {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  };

  const ratio = (medicos, beneficiarios) => {
    medicos = Number(medicos) || 0;
    beneficiarios = Number(beneficiarios) || 0;
    return beneficiarios ? (medicos / beneficiarios) * 10000 : null;
  };

  const cityVal = ratio(cidade?.total, ansCidade?.total);
  const poaVal = ratio(poa?.total, ansPoaTotal);

  set("city-medxbenef", fmt1(cityVal));
  set("ref-city-medxbenef", fmt1(poaVal));
}

/* ===== Orchestrator ===== */
async function selectCity(ibgeId, name, uf) {
  $("#suggestions").hidden = true;
  $("#search").value = `${name} — ${uf}`;
  $("#landing").hidden = true;
  $("#dashboard").hidden = false;
  window.scrollTo({ top: 0, behavior: "smooth" });

  showLoader(`Carregando ${name}…`);

  try {
    // 1) Localidade detalhada (para pegar microrregião)
    const loc = await getJSON(`${IBGE_LOC}/municipios/${ibgeId}`);
    const microId = loc.microrregiao.id;
    const microNome = loc.microrregiao.nome;
    const ufSigla = loc.microrregiao.mesorregiao.UF.sigla;
    const ufNome = loc.microrregiao.mesorregiao.UF.nome;
    const mesor = loc.microrregiao.mesorregiao.nome;

    state.city = { id: String(ibgeId), name: loc.nome, uf: ufSigla, ufNome, mesor, microNome, microId };
    state.micro.id = microId;
    state.micro.nome = microNome;

    $("#city-title").textContent = `${loc.nome} — ${ufSigla}`;
    $("#city-sub").textContent = `Microrregião de ${microNome} · Mesorregião ${mesor} · ${ufNome}`;
    $$(".c-name").forEach(x => x.textContent = loc.nome);
    $("#micro-title").textContent = `Microrregião de ${microNome}`;

    // 2) Lista de municípios da microrregião
    showLoader("Listando municípios da microrregião…");
    const microMun = await getJSON(`${IBGE_LOC}/microrregioes/${microId}/municipios`);
    state.micro.municipios = microMun.map(m => ({ id: String(m.id), nome: m.nome }));
    const microIds = state.micro.municipios.map(m => m.id);

    // 3) Disparar em paralelo tudo que dá
    showLoader("Carregando dados demográficos (IBGE)…");
    const [
      popByCity,
      pyramidCity,
      pyramidMicro,
      evolutionCity,
      evolutionMicro,
      area2010,
      densityCity,
      censo2010,
      pib,
      cempre,
      rendimento,
    ] = await Promise.all([
      fetchPopByMunicipios(microIds),
      fetchPyramid([String(ibgeId)]),
      fetchPyramid(microIds),
      fetchEvolution([String(ibgeId)]),
      fetchEvolution(microIds),
      fetchArea(String(ibgeId)),
      fetchDensity(String(ibgeId)),
      fetchCenso2010(String(ibgeId)),
      fetchPIB(String(ibgeId)),
      fetchCEMPRE(String(ibgeId)),
      fetchRendimento(String(ibgeId)),
    ]);

    // 4) CNES — paralelo: cidade, POA (comparação), e também micro (só se não for absurdo grande)
    showLoader("Carregando rede de saúde (CNES)… pode levar alguns segundos.");
    const estabsCity = await fetchEstablishmentsByCity(String(ibgeId).slice(0, 6));
    state.establishments = estabsCity;
    // POA em paralelo com a microrregião agregada
    const [estabsPOA, estabsMicro] = await Promise.all([
      String(ibgeId) === POA_IBGE ? Promise.resolve(estabsCity) : fetchEstablishmentsByCity(POA_CNES),
      fetchEstablishmentsByMicro(microIds.map(i => i.slice(0, 6))),
    ]);
    state.estabsPOA = estabsPOA;
    state.estabsMicro = estabsMicro;

    // 5) ANS — só médico-hospitalar
    showLoader("Carregando saúde suplementar (ANS)…");
    const cityCod6 = String(ibgeId).slice(0,6);
    const microCods6 = microIds.map(i => i.slice(0,6)).join(",");
    const [ansCityRaw, ansMicroRaw, ansHistCityRaw, ansHistMicroRaw] = await Promise.all([
      getJSON(`${ANS}?uf=${ufSigla}&cod=${cityCod6}`).catch(() => null),
      getJSON(`${ANS}/multi?uf=${ufSigla}&cods=${microCods6}`).catch(() => null),
      getJSON(`${ANS}/history?uf=${ufSigla}&cods=${cityCod6}`).catch(() => ({ series: [] })),
      getJSON(`${ANS}/history?uf=${ufSigla}&cods=${microCods6}`).catch(() => ({ series: [] })),
    ]);
    const ansCity = ansMHOnly(ansCityRaw);
    const ansMicro = ansMHOnly(ansMicroRaw);
    // Para o histórico, usamos só mh (já vem quebrado)
    const ansHistCity = { series: (ansHistCityRaw?.series || []).map(s => ({ month: s.month, total: s.mh })) };
    const ansHistMicro = { series: (ansHistMicroRaw?.series || []).map(s => ({ month: s.month, total: s.mh })) };

    // 6) Leitos via ElastiCNES (+ serviços dos 3 maiores) + histórico anual + referência POA
    showLoader("Carregando leitos (ElastiCNES)… pode levar alguns segundos.");
    const [leitosCity, leitosMicro, leitosHistCity, leitosHistMicro, poaRef] = await Promise.all([
      getJSON(`${LEITOS}?cod=${cityCod6}`).catch(() => null),
      getJSON(`${LEITOS}/multi?cods=${microCods6}`).catch(() => null),
      getJSON(`${LEITOS}/history?cod=${cityCod6}`).catch(() => ({ series: [] })),
      getJSON(`${LEITOS}/history?cods=${microCods6}`).catch(() => ({ series: [] })),
      loadPOAReference(),
    ]);
    // Top 3 hospitais da cidade + seus serviços
    const top3 = (leitosCity?.hospitais || []).slice(0, 3);
    const top3Servicos = await Promise.all(top3.map(h =>
      getJSON(`${SERVICOS}?cod=${cityCod6}&cnes=${h.cnes}`).catch(() => ({ servicos: [] }))
    ));

    // 7) Densidade médica via ElastiCNES — cidade selecionada + referências
    showLoader("Carregando densidade médica (ElastiCNES)…");
    const [refPopByCity, medicosCity, medicosCaxias, medicosPOA] = await Promise.all([
      fetchPopByMunicipios([CAXIAS_IBGE, POA_IBGE]).catch(() => ({})),
      getJSON(`${MEDICOS}?ibge=${String(ibgeId)}`).catch(() => null),
      getJSON(`${MEDICOS}?ibge=${CAXIAS_IBGE}`).catch(() => null),
      getJSON(`${MEDICOS}?ibge=${POA_IBGE}`).catch(() => null),
    ]);

    // ======= RENDER =======
    // Micro tab
    renderMicroList();
    renderMicroPopTable(popByCity);
    renderMicroMap(microMun);
    renderMicroKPIs(popByCity, pyramidMicro, ansMicro);
    renderGenderPie("micro", pyramidMicro);
    renderPyramid("micro", pyramidMicro);
    renderEvolution("micro", evolutionMicro, pyramidMicro);
    renderAnsEvolution("micro", ansHistMicro?.series || []);
    renderOpsTable("micro", ansMicro);
    renderTypesTable("micro", estabsMicro, estabsPOA);
    renderServicesTable("micro", estabsMicro, estabsPOA);

// City tab
const cityPop = popByCity[String(ibgeId)] ?? null;
renderCityKPIs(cityPop, area2010, densityCity, pyramidCity, censo2010);
renderGenderPie("city", pyramidCity);
renderPyramid("city", pyramidCity);
renderEvolution("city", evolutionCity, pyramidCity);
renderAnsEvolution("city", ansHistCity?.series || []);
renderAnsKPIs("city", ansCity, cityPop);
renderAnsKPIs("micro", ansMicro, Object.values(popByCity).reduce((a,b) => a + (b||0), 0));
renderOpsTable("city", ansCity);

renderMedicalDensityTable({
  cidade: medicosCity,
  caxias: medicosCaxias,
  poa: medicosPOA,
  popCidade: cityPop,
  popCaxias: refPopByCity[CAXIAS_IBGE] || null,
  popPoa: refPopByCity[POA_IBGE] || null,
});

renderMedicosBeneficiariosKPI({
  cidade: medicosCity,
  poa: medicosPOA,
  ansCidade: ansCity,
  ansPoaTotal: poaRef?.city?.ansTotal || null,
});

renderTypesTable("city", estabsCity, estabsPOA);
renderServicesTable("city", estabsCity, estabsPOA);
renderProfile({ loc, pop: cityPop, area: area2010, pyramid: pyramidCity, censo2010, ans: ansCity, pib, cempre });
renderRendimentoChart(rendimento);

// Leitos — cidade & microrregião
renderLeitosCity(leitosCity, cityPop, ansCity?.total || 0);
renderLeitosMicro(leitosMicro, Object.values(popByCity).reduce((a,b)=>a+b,0), ansMicro?.total || 0);
renderLeitosPrivEvolution("city", leitosHistCity?.series || []);
renderLeitosPrivEvolution("micro", leitosHistMicro?.series || []);
renderPOAReferences(poaRef);

    // IQM e bubble chart (assíncrono — não bloqueia o resto)
    renderIQMandBubble({
      cityIbge: String(ibgeId),
      cityName: loc.nome,
      cityUF: ufSigla,
      cityPop, censo2010,
      cityLeitos: leitosCity,
      cityAns: ansCity,
      cityAnsHist: ansHistCity?.series || [],
      cityRendimento: rendimento,
      estabsCity,
      popByCity,
      poaRef,
    });

    // Infra tab
    renderInfraMap(estabsCity);
    renderTop3Hospitals(top3, top3Servicos, estabsCity);
    enrichHospitalPhotos(top3, state.city.name, state.city.uf); // async

  } catch (err) {
    console.error(err);
    showError(`Falha ao carregar: ${err.message}`);
  } finally {
    hideLoader();
  }
}

/* ===== IBGE fetchers ===== */
async function fetchPopByMunicipios(ids) {
  // uma única requisição com lista de localidades
  const url = `${IBGE_AGG}/9514/periodos/2022/variaveis/93?localidades=N6[${ids.join(",")}]`;
  const data = await getJSON(url);
  const res = {};
  for (const s of data?.[0]?.resultados?.[0]?.series ?? []) {
    res[String(s.localidade.id)] = Number(Object.values(s.serie)[0]);
  }
  return res;
}

async function fetchPyramid(ids) {
  const ages = AGE_GROUPS.map(a => a.id).join(",");
  const url = `${IBGE_AGG}/9514/periodos/2022/variaveis/93?localidades=N6[${ids.join(",")}]&classificacao=2[4,5]|287[${ages}]`;
  const data = await getJSON(url);
  const grid = { men: {}, women: {} };
  for (const r of data?.[0]?.resultados ?? []) {
    const sex = r.classificacoes.find(c => c.id === "2")?.categoria;
    const age = r.classificacoes.find(c => c.id === "287")?.categoria;
    const sexKey = sex?.[4] ? "men" : sex?.[5] ? "women" : null;
    const ageId = age ? Object.keys(age)[0] : null;
    if (!sexKey || !ageId) continue;
    let sum = 0;
    for (const s of r.series ?? []) {
      const v = Number(Object.values(s.serie)[0]);
      if (!Number.isNaN(v)) sum += v;
    }
    grid[sexKey][ageId] = (grid[sexKey][ageId] || 0) + sum;
  }
  return grid;
}

async function fetchEvolution(ids) {
  const periods = "2010|2015|2020|2021|2022|2024";
  const url = `${IBGE_AGG}/6579/periodos/${encodeURIComponent(periods)}/variaveis/9324?localidades=N6[${ids.join(",")}]`;
  const data = await getJSON(url);
  const totals = {};
  for (const s of data?.[0]?.resultados?.[0]?.series ?? []) {
    for (const [y, v] of Object.entries(s.serie)) {
      const n = Number(v);
      if (!Number.isNaN(n)) totals[y] = (totals[y] || 0) + n;
    }
  }
  // Adiciona 2022 do censo se não estiver
  try {
    const url2 = `${IBGE_AGG}/9514/periodos/2022/variaveis/93?localidades=N6[${ids.join(",")}]`;
    const d2 = await getJSON(url2);
    let sum22 = 0;
    for (const s of d2?.[0]?.resultados?.[0]?.series ?? []) sum22 += Number(Object.values(s.serie)[0]) || 0;
    if (sum22) totals["2022"] = sum22;
  } catch {}
  return Object.entries(totals).map(([y, v]) => [Number(y), v]).sort((a, b) => a[0] - b[0]);
}

async function fetchArea(id) {
  try {
    const url = `${IBGE_AGG}/1301/periodos/2010/variaveis/615?localidades=N6[${id}]`;
    const d = await getJSON(url);
    const serie = d?.[0]?.resultados?.[0]?.series?.[0]?.serie;
    return serie ? Number(Object.values(serie)[0]) : null;
  } catch { return null; }
}
async function fetchDensity(id) {
  try {
    const url = `${IBGE_AGG}/1301/periodos/2010/variaveis/616?localidades=N6[${id}]`;
    const d = await getJSON(url);
    const serie = d?.[0]?.resultados?.[0]?.series?.[0]?.serie;
    return serie ? Number(Object.values(serie)[0]) : null;
  } catch { return null; }
}
async function fetchCenso2010(id) {
  try {
    const url = `${IBGE_AGG}/608/periodos/2010/variaveis/93?localidades=N6[${id}]`;
    const d = await getJSON(url);
    const serie = d?.[0]?.resultados?.[0]?.series?.[0]?.serie;
    return serie ? Number(Object.values(serie)[0]) : null;
  } catch { return null; }
}

/* PIB Municipal (agregado 5938) */
async function fetchPIB(id) {
  try {
    const url = `${IBGE_AGG}/5938/periodos/-1/variaveis/37|513|517|6564|525?localidades=N6[${id}]`;
    const d = await getJSON(url);
    const out = { year: null, pib: null, agro: null, industria: null, servicos: null, admin: null };
    for (const v of d) {
      const s = v.resultados?.[0]?.series?.[0]?.serie ?? {};
      const year = Object.keys(s).sort().pop();
      const val = year ? Number(s[year]) : null;
      out.year = year;
      if (v.id === "37") out.pib = val;
      if (v.id === "513") out.agro = val;
      if (v.id === "517") out.industria = val;
      if (v.id === "6564") out.servicos = val;
      if (v.id === "525") out.admin = val;
    }
    return out;
  } catch { return null; }
}

/* Classes de rendimento Censo 2022 (agregado 10292) — salário mínimo de 2022 = R$ 1.212 */
async function fetchRendimento(id) {
  try {
    // fmtR$ helper local
    const r = v => "R$ " + v.toLocaleString("pt-BR", { maximumFractionDigits: 0 });
    const SM = 1212;
    const classes = [
      ["99822", `Até ${r(SM * 0.25)}`],                           // 303
      ["99823", `${r(SM * 0.25)} a ${r(SM * 0.5)}`],              // 303–606
      ["99824", `${r(SM * 0.5)} a ${r(SM)}`],                     // 606–1.212
      ["96179", `${r(SM)} a ${r(SM * 2)}`],                       // 1.212–2.424
      ["96180", `${r(SM * 2)} a ${r(SM * 3)}`],                   // 2.424–3.636
      ["96181", `${r(SM * 3)} a ${r(SM * 5)}`],                   // 3.636–6.060
      ["96182", `${r(SM * 5)} a ${r(SM * 10)}`],                  // 6.060–12.120
      ["99825", `${r(SM * 10)} a ${r(SM * 15)}`],                 // 12.120–18.180
      ["99828", `${r(SM * 15)} a ${r(SM * 20)}`],                 // 18.180–24.240
      ["96184", `Mais de ${r(SM * 20)}`],                         // >24.240
      ["96185", "Sem rendimento"],
    ];
    const classIds = classes.map(c => c[0]).join(",");
    const url = `${IBGE_AGG}/10292/periodos/2022/variaveis/4090?localidades=N6[${id}]&classificacao=11915[${classIds}]|2[6794]`;
    const data = await getJSON(url);
    const out = [];
    for (const r of data?.[0]?.resultados ?? []) {
      const cls = r.classificacoes.find(c => c.id === "11915")?.categoria;
      const k = cls ? Object.keys(cls)[0] : null;
      const label = classes.find(c => c[0] === k)?.[1] || cls?.[k] || "?";
      const v = Number(Object.values(r.series?.[0]?.serie || {})[0]);
      if (!Number.isNaN(v)) out.push({ key: k, label, value: v });
    }
    return out;
  } catch { return []; }
}

/* CEMPRE — reativa o antigo */
async function fetchCEMPRE(id) {
  try {
    const url = `${IBGE_AGG}/1685/periodos/-1/variaveis/367|707|708|662|10143?localidades=N6[${id}]`;
    const d = await getJSON(url);
    const out = { year: null, empresas: null, pessoalTotal: null, pessoalAssal: null, salarios: null, salarioMed: null };
    for (const v of d) {
      const s = v.resultados?.[0]?.series?.[0]?.serie ?? {};
      const year = Object.keys(s).sort().pop();
      const val = year ? Number(s[year]) : null;
      out.year = year;
      if (v.id === "367") out.empresas = val;
      if (v.id === "707") out.pessoalTotal = val;
      if (v.id === "708") out.pessoalAssal = val;
      if (v.id === "662") out.salarios = val;
      if (v.id === "10143") out.salarioMed = val;
    }
    return out;
  } catch { return null; }
}

function normalizeTxt(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// Extrai palavras-chave distintivas do nome do hospital (remove termos genéricos).
function hospitalKeywords(name) {
  const stop = new Set(["hospital","clinica","clinicas","santa","casa","maternidade","de","da","do","dos","das","e","ltda","sa","eireli","cooperativa","associacao","fundacao","irmandade","medico","medica","geral","especializado","municipal","estadual","federal"]);
  return normalizeTxt(name)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= 3 && !stop.has(w));
}

/* Tenta Wikimedia Commons primeiro (busca em fotos direto), depois Wikipedia. */
async function fetchHospitalPhoto(name, city, uf) {
  if (!name) return null;
  const cityN = normalizeTxt(city);
  const keywords = hospitalKeywords(name);
  // primeiro keyword (provavelmente o nome próprio/distintivo)
  const distinctive = keywords[0] || "";

  const clean = name
    .replace(/\bLTDA\b\.?/gi, "")
    .replace(/\bS\/?A\b\.?/gi, "")
    .replace(/\bEIRELI\b\.?/gi, "")
    .replace(/\b(COOPERATIVA|ASSOCIACAO|FUNDACAO|IRMANDADE)\b/gi, "")
    .replace(/\s+/g, " ").trim();

  // 1) Wikimedia Commons — busca fotos direto (mais amplo que só páginas)
  const commonsQueries = [
    `${clean} ${city}`,
    `${clean} ${uf}`,
    `${clean}`,
  ];
  for (const q of commonsQueries) {
    try {
      const url =
        "https://commons.wikimedia.org/w/api.php?action=query" +
        "&generator=search&gsrnamespace=6&gsrlimit=6" +
        "&gsrsearch=" + encodeURIComponent(q) +
        "&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=600" +
        "&format=json&origin=*";
      const r = await fetch(url);
      if (!r.ok) continue;
      const d = await r.json();
      const pages = d?.query?.pages;
      if (!pages) continue;
      const cands = Object.values(pages).sort((a, b) => (a.index || 99) - (b.index || 99));
      for (const p of cands) {
        const info = p.imageinfo?.[0];
        if (!info) continue;
        const fileName = normalizeTxt((p.title || "").replace(/^file:/i, ""));
        const desc = normalizeTxt(info.extmetadata?.ImageDescription?.value || "");
        const hay = `${fileName} ${desc}`;
        const isHospital = /\bhospital\b|\bsanta\s*casa\b|\bmaternidade\b|\bclinica\b/.test(hay);
        const mentionsCity = cityN ? hay.includes(cityN) : false;
        const mentionsKey = distinctive ? hay.includes(distinctive) : false;
        // precisa ser foto de hospital E (bater cidade OU o nome distintivo do hospital)
        if (isHospital && (mentionsCity || mentionsKey)) {
          const thumb = info.thumburl || info.url;
          if (thumb) return thumb;
        }
      }
    } catch {}
  }

  // 2) Wikipedia PT — página do hospital
  const wikiQueries = [
    `${clean} ${city} ${uf}`,
    `${clean} ${city}`,
    `${clean}`,
  ];
  for (const q of wikiQueries) {
    try {
      const url =
        "https://pt.wikipedia.org/w/api.php?action=query" +
        "&generator=search&gsrlimit=4" +
        "&gsrsearch=" + encodeURIComponent(q) +
        "&prop=pageimages|extracts" +
        "&pithumbsize=600&pilicense=any" +
        "&exintro=1&explaintext=1&exsentences=3" +
        "&format=json&origin=*";
      const r = await fetch(url);
      if (!r.ok) continue;
      const d = await r.json();
      const pages = d?.query?.pages;
      if (!pages) continue;
      const cands = Object.values(pages).sort((a, b) => (a.index || 99) - (b.index || 99));
      for (const p of cands) {
        const thumb = p.thumbnail?.source;
        if (!thumb) continue;
        const title = normalizeTxt(p.title || "");
        const extract = normalizeTxt(p.extract || "");
        const hay = `${title} ${extract}`;
        const isHospital = /\bhospital\b|\bsanta\s*casa\b|\bmaternidade\b|\bclinica\b/.test(hay);
        const mentionsCity = hay.includes(cityN);
        const mentionsKey = distinctive ? hay.includes(distinctive) : false;
        if (isHospital && (mentionsCity || mentionsKey)) {
          // evita biografias
          if (/\bnasceu\b|\bfalecid|\bpolitico\b|\bator\b|\batriz\b|\bcantor\b|\bescritor\b/.test(extract)) continue;
          return thumb;
        }
      }
    } catch {}
  }
  return null;
}

/* ===== CNES fetcher =====
 * A API apidadosabertos.saude.gov.br/cnes/estabelecimentos:
 *  - limita 20 por página (parâmetro `limit` é ignorado);
 *  - retorna ATIVOS e DESATIVADOS misturados — filtramos por
 *    `codigo_motivo_desabilitacao_estabelecimento` (nulo/vazio/"00" = ativo);
 *  - cidades grandes têm ~8-9 mil estabelecimentos (POA), por isso
 *    MAX_PAGES precisa ser alto (~600 para POA com folga).
 * Detecção de fim: só paramos quando uma página inteira (offset sequencial)
 * vier vazia. Páginas paralelas que retornam < 20 não disparam parada
 * porque podem ser internamente paralelas com outras que ainda têm dados.
 */
function isActiveEstablishment(e) {
  const m = e?.codigo_motivo_desabilitacao_estabelecimento;
  if (m == null) return true;
  const s = String(m).trim();
  return s === "" || s === "00" || s === "0";
}

async function fetchEstablishmentsByCity(cnesCode6) {
  const limit = 20;
  const MAX_PAGES = 600;     // suporta até ~12.000 estabs (POA tem ~8.500)
  const BATCH = 10;
  const all = [];
  let page = 0, consecutiveEmpty = 0;
  while (page < MAX_PAGES) {
    const tasks = [];
    for (let i = 0; i < BATCH && page + i < MAX_PAGES; i++) {
      const offset = (page + i) * limit;
      tasks.push(
        getJSON(`${CNES}?codigo_municipio=${cnesCode6}&limit=${limit}&offset=${offset}`)
          .catch(() => ({ estabelecimentos: [] }))
      );
    }
    const results = await Promise.all(tasks);
    let batchHadData = false;
    for (const r of results) {
      const list = r?.estabelecimentos ?? [];
      if (list.length > 0) { batchHadData = true; consecutiveEmpty = 0; }
      all.push(...list);
    }
    if (!batchHadData) {
      consecutiveEmpty++;
      // Dois batches inteiros vazios em sequência = chegamos ao fim.
      if (consecutiveEmpty >= 2) break;
    }
    page += BATCH;
  }
  // Dedup por CNES
  const seen = new Set(), unique = [];
  for (const e of all) {
    const k = e.codigo_cnes;
    if (!k || seen.has(k)) continue;
    seen.add(k); unique.push(e);
  }
  // Filtra apenas ATIVOS — alinha com a busca padrão do site CNES manual
  return unique.filter(isActiveEstablishment);
}

async function fetchEstablishmentsByMicro(codes6) {
  // paraleliza 3 cidades por vez para não sufocar o proxy
  const out = [];
  const chunkSize = 3;
  for (let i = 0; i < codes6.length; i += chunkSize) {
    const chunk = codes6.slice(i, i + chunkSize);
    const results = await Promise.all(chunk.map(c => fetchEstablishmentsByCity(c).catch(() => [])));
    for (const r of results) out.push(...r);
  }
  return out;
}

/* ===== Renderers ========================================= */
const destroyChart = key => { if (state.charts[key]) { state.charts[key].destroy(); delete state.charts[key]; } };

/* -- Microrregião -- */

function renderMicroList() {
  const { municipios } = state.micro;
  $("#micro-count").textContent = `${municipios.length} municípios na microrregião. Cidade pesquisada em destaque.`;
  const box = $("#micro-list");
  box.innerHTML = "";
  for (const m of municipios) {
    box.append(el("span", { class: "chip" + (m.id === state.city.id ? " current" : "") }, m.nome));
  }
}

function renderMicroPopTable(popByCity) {
  const tbody = $("#micro-pop-table tbody");
  const tfoot = $("#micro-pop-table tfoot");
  tbody.innerHTML = ""; tfoot.innerHTML = "";
  const rows = state.micro.municipios
    .map(m => ({ ...m, pop: popByCity[m.id] || 0 }))
    .sort((a, b) => b.pop - a.pop);
  const total = rows.reduce((a, b) => a + b.pop, 0);
  for (const r of rows) {
    const tr = el("tr", r.id === state.city.id ? { class: "current" } : {},
      el("td", {}, r.nome),
      el("td", { class: "num" }, fmt(r.pop)),
      el("td", { class: "num" }, pct(r.pop, total)),
    );
    if (r.id === state.city.id) tr.style.background = "rgba(26,53,102,0.08)";
    tbody.append(tr);
  }
  tfoot.append(el("tr", {},
    el("td", {}, "TOTAL MICRORREGIÃO"),
    el("td", { class: "num" }, fmt(total)),
    el("td", { class: "num" }, "100%"),
  ));
}

function renderMicroMap(microMun) {
  const mapEl = $("#micro-map");
  if (!state.maps.micro) {
    state.maps.micro = L.map(mapEl).setView([-14.2, -51.9], 4);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap", maxZoom: 18 }).addTo(state.maps.micro);
  }
  const map = state.maps.micro;
  // remove layers antigas
  if (state.microLayer) map.removeLayer(state.microLayer);
  const group = L.featureGroup();
  // desenhar apenas marcador central de cada cidade
  // (para polígono exato, precisaria do geojson da malha; overhead grande)
  const cityId = state.city.id;
  for (const m of microMun) {
    const coord = cityBaseCoord(m.nome, m.microrregiao);
  }
  // fallback: usar o geojson de malha IBGE em baixa resolução para a microrregião
  fetchMicroGeoJson(state.micro.id).then(geo => {
    if (!geo) return;
    if (state.microLayer) map.removeLayer(state.microLayer);
    state.microLayer = L.geoJSON(geo, {
      style: f => ({
        color: COLORS.brand, weight: 1,
        fillColor: String(f.properties?.codarea) === cityId ? COLORS.brand : "#c5cbd6",
        fillOpacity: String(f.properties?.codarea) === cityId ? 0.7 : 0.4,
      }),
      onEachFeature: (f, l) => {
        const nome = f.properties?.nome || "";
        if (nome) l.bindTooltip(nome, { sticky: true });
      },
    }).addTo(map);
    map.fitBounds(state.microLayer.getBounds(), { padding: [10, 10] });
  });
  setTimeout(() => map.invalidateSize(), 100);
}

async function fetchMicroGeoJson(microId) {
  try {
    const url = `https://servicodados.ibge.gov.br/api/v3/malhas/microrregioes/${microId}?formato=application/vnd.geo+json&qualidade=minima&intrarregiao=municipio`;
    return await getJSON(url);
  } catch { return null; }
}
function cityBaseCoord() { return null; }

function renderMicroKPIs(popByCity, pyramidMicro, ansMicro) {
  const total = Object.values(popByCity).reduce((a, b) => a + b, 0);
  $("#micro-total-pop").textContent = fmt(total);
  $("#micro-total-mun").textContent = state.micro.municipios.length;

  let pop60 = 0;
  for (const g of ["men","women"]) {
    for (const [aid, v] of Object.entries(pyramidMicro[g])) if (AGE_60_PLUS.has(aid)) pop60 += v;
  }
  $("#micro-60").textContent = `${fmt(pop60)} (${pct(pop60, total)})`;
}

function renderAnsKPIs(scope, ansData, totalPop) {
  const prefix = scope === "city" ? "city" : "micro";
  const total = ansData?.total ?? 0;
  $(`#${prefix}-ans-total`).textContent = fmt(total);
  $(`#${prefix}-ans-pct`).textContent = totalPop ? ((total / totalPop) * 100).toFixed(1) + "%" : "—";
  $(`#${prefix}-ops-count`).textContent = fmt((ansData?.operadoras ?? []).length);
  $(`#${prefix}-ans-month`).textContent = monthLabel(ansData?.month);
}

function renderGenderPie(scope, pyramid) {
  const key = `${scope}-gender`;
  destroyChart(key);
  const men = Object.values(pyramid.men).reduce((a,b) => a+b, 0);
  const women = Object.values(pyramid.women).reduce((a,b) => a+b, 0);
  const total = men + women;
  state.charts[key] = new Chart($(`#${key}`), {
    type: "doughnut",
    data: { labels: ["Homens", "Mulheres"], datasets: [{ data: [men, women], backgroundColor: [COLORS.male, COLORS.female], borderWidth: 0 }] },
    options: {
      maintainAspectRatio: false, cutout: "65%",
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => `${c.label}: ${fmt(c.parsed)} (${pct(c.parsed, total)})` } } },
    },
  });
  $(`#${key}-legend`).innerHTML =
    `<span><i class="dot" style="background:${COLORS.male}"></i>Homens ${fmt(men)} · ${pct(men, total)}</span>` +
    `<span><i class="dot" style="background:${COLORS.female}"></i>Mulheres ${fmt(women)} · ${pct(women, total)}</span>`;
}

function renderPyramid(scope, pyramid) {
  const key = `${scope}-pyramid`;
  destroyChart(key);
  // Ordem invertida (do mais velho no topo) p/ aparência clássica de pirâmide
  const groupsRev = [...AGE_GROUPS].reverse();
  const labels = groupsRev.map(a => a.label);
  const men = groupsRev.map(a => -(pyramid.men[a.id] || 0));
  const women = groupsRev.map(a => pyramid.women[a.id] || 0);
  const maxAbs = Math.max(...men.map(Math.abs), ...women) || 1;
  const canvas = $(`#${key}`);
  // altura maior para caber todas as faixas sem pular
  if (canvas.parentElement) canvas.parentElement.style.height = "520px";
  state.charts[key] = new Chart(canvas, {
    type: "bar",
    data: { labels, datasets: [
      { label: "Homens", data: men, backgroundColor: COLORS.male },
      { label: "Mulheres", data: women, backgroundColor: COLORS.female },
    ]},
    options: {
      indexAxis: "y", maintainAspectRatio: false,
      scales: {
        x: { min: -maxAbs, max: maxAbs, ticks: { callback: v => fmt(Math.abs(v)) } },
        y: { stacked: true, ticks: { autoSkip: false, font: { size: 10.5 } } },
      },
      plugins: {
        legend: { position: "bottom" },
        tooltip: { callbacks: { label: c => `${c.dataset.label}: ${fmt(Math.abs(c.parsed.x))}` } },
      },
    },
  });
}

function renderEvolution(scope, series, pyramid) {
  const key = `${scope}-evolution`;
  destroyChart(key);
  const men2022 = Object.values(pyramid?.men || {}).reduce((a,b)=>a+b, 0);
  const women2022 = Object.values(pyramid?.women || {}).reduce((a,b)=>a+b, 0);
  const total2022 = men2022 + women2022;
  // Razão de gênero (Censo 2022) aplicada a cada ano p/ estimar evolução por sexo
  const ratioM = total2022 ? men2022 / total2022 : 0.49;
  const ratioF = total2022 ? women2022 / total2022 : 0.51;
  const years = series.map(([y]) => y);
  const totals = series.map(([, v]) => v);
  state.charts[key] = new Chart($(`#${key}`), {
    type: "line",
    data: {
      labels: years,
      datasets: [
        {
          label: "Total",
          data: totals,
          borderColor: COLORS.brand, backgroundColor: "rgba(26,53,102,0.12)",
          tension: 0.3, fill: true, pointRadius: 4, pointBackgroundColor: COLORS.brand, borderWidth: 2.5,
        },
        {
          label: "Homens",
          data: totals.map(v => Math.round(v * ratioM)),
          borderColor: COLORS.male, backgroundColor: "transparent",
          tension: 0.3, fill: false, pointRadius: 3, borderWidth: 2, borderDash: [4, 4],
        },
        {
          label: "Mulheres",
          data: totals.map(v => Math.round(v * ratioF)),
          borderColor: COLORS.female, backgroundColor: "transparent",
          tension: 0.3, fill: false, pointRadius: 3, borderWidth: 2, borderDash: [4, 4],
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom" },
        tooltip: { callbacks: { label: c => `${c.dataset.label}: ${fmt(c.parsed.y)}` } },
      },
      scales: { y: { ticks: { callback: v => fmt(v) } } },
    },
  });
}

function renderAnsEvolution(scope, series) {
  const key = `${scope}-ans-evol`;
  destroyChart(key);
  if (!series || series.length < 2) {
    $(`#${key}`).parentElement.innerHTML =
      `<p class="muted">Histórico insuficiente — servidor ainda processando meses adicionais. Aguarde alguns minutos e recarregue.</p>`;
    return;
  }
  state.charts[key] = new Chart($(`#${key}`), {
    type: "line",
    data: {
      labels: series.map(s => monthLabel(s.month)),
      datasets: [
        {
          label: "Beneficiários médico-hospitalar",
          data: series.map(s => s.total),
          borderColor: COLORS.brand,
          backgroundColor: "rgba(26,53,102,0.15)",
          tension: 0.3, fill: true, pointRadius: 4, pointBackgroundColor: COLORS.brand, borderWidth: 2.5,
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => fmt(c.parsed.y) } },
      },
      scales: { y: { ticks: { callback: v => fmt(v) } } },
    },
  });
}

function renderOpsTable(scope, ansData) {
  const tbody = $(`#${scope}-ops-table tbody`);
  tbody.innerHTML = "";
  if (!ansData) { tbody.append(el("tr", {}, el("td", { colspan: "4" }, "Sem dados ANS"))); return; }
  const total = ansData.total || 1;
  const rows = topOpsWithOutras(ansData.operadoras || [], 5);
  for (const o of rows) {
    const tr = el("tr", o.isOutras ? { style: "font-style: italic" } : {},
      el("td", {}, o.razao),
      el("td", {}, o.modalidade),
      el("td", { class: "num" }, fmt(o.beneficiarios)),
      el("td", { class: "num" }, pct(o.beneficiarios, total)),
    );
    tbody.append(tr);
  }
}

function titleCaseMedical(label) {
  const s = String(label || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  if (!s) return "—";

  return s
    .replace(/\b\w/g, c => c.toUpperCase())
    .replace(/\bDe\b/g, "de")
    .replace(/\bDa\b/g, "da")
    .replace(/\bDo\b/g, "do")
    .replace(/\bDos\b/g, "dos")
    .replace(/\bDas\b/g, "das")
    .replace(/\bE\b/g, "e");
}

function medDensity(medicos, pop) {
  medicos = Number(medicos) || 0;
  pop = Number(pop) || 0;
  return pop ? (medicos / pop) * 10000 : null;
}

function medMapByCbo(data) {
  const map = {};
  for (const r of data?.especialidades || []) {
    if (!r.cbo) continue;
    map[r.cbo] = r;
  }
  return map;
}

function medicalCareLine(label) {
  const s = String(label || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();

  if (
    /CLINICO|FAMILIA|COMUNIDADE|ESTRATEGIA DE SAUDE DA FAMILIA|GERIATRA|MEDICINA DO TRABALHO/.test(s)
  ) {
    return "Clínica e atenção básica";
  }

  if (
    /PEDIATRA|GINECOLOGISTA|OBSTETRA|MASTOLOGISTA/.test(s)
  ) {
    return "Materno-infantil e saúde da mulher";
  }

  if (
    /CIRURGIAO|CIRURGIA|COLOPROCTOLOGISTA|UROLOGISTA|ANGIOLOGISTA|VASCULAR|ORTOPEDISTA|TRAUMATOLOGISTA/.test(s)
  ) {
    return "Cirúrgicas e procedimento";
  }

  if (
    /RADIOLOGIA|DIAGNOSTICO|ANESTESIOLOGISTA|PATOLOGISTA|CITOPATOLOGISTA|ANATOMOPATOLOGISTA|ENDOSCOPIA|MEDICINA NUCLEAR|RADIOTERAPEUTA|HEMOTERAPEUTA/.test(s)
  ) {
    return "Diagnóstico, suporte e terapia";
  }

  if (
    /CARDIOLOGISTA|ONCOLOGISTA|CANCEROLOGISTA|NEUROLOGISTA|NEUROCIRURGIAO|NEFROLOGISTA|HEMATOLOGISTA|ENDOCRINOLOGISTA|REUMATOLOGISTA|INFECTOLOGISTA|INTENSIVA|PNEUMOLOGISTA/.test(s)
  ) {
    return "Alta complexidade e doenças crônicas";
  }

  if (
    /DERMATOLOGISTA|OFTALMOLOGISTA|OTORRINOLARINGOLOGISTA|GASTROENTEROLOGISTA|ALERGISTA|NUTROLOGISTA|ACUPUNTURISTA|HOMEOPATA|FISIATRA/.test(s)
  ) {
    return "Ambulatoriais especializadas";
  }

  return "Outras especialidades médicas";
}

function renderMedicalDensityTable({ cidade, caxias, poa, popCidade, popCaxias, popPoa }) {
  const tbody = $("#city-med-density-table tbody");
  if (!tbody) return;

  tbody.innerHTML = "";

  const compEl = $("#city-med-density-comp");
  if (compEl) compEl.textContent = cidade?.comp || caxias?.comp || poa?.comp || "—";

  if (!cidade || !Array.isArray(cidade.especialidades)) {
    tbody.append(el("tr", {},
      el("td", { colspan: "5", class: "muted" }, "Dados de médicos não disponíveis para esta cidade.")
    ));
    return;
  }

  const caxiasByCbo = medMapByCbo(caxias);
  const poaByCbo = medMapByCbo(poa);

  const appendRow = ({ label, medCidade, medCaxias, medPoa, bold = false }) => {
    const tr = el("tr", bold ? { class: "total-row" } : {});

    tr.append(
      el("td", {}, bold ? label : titleCaseMedical(label)),
      el("td", { class: "num" }, fmt(medCidade)),
      el("td", { class: "num" }, fmt1(medDensity(medCidade, popCidade))),
      el("td", { class: "num" }, fmt1(medDensity(medCaxias, popCaxias))),
      el("td", { class: "num" }, fmt1(medDensity(medPoa, popPoa)))
    );

    tbody.append(tr);
  };

  const appendGroup = (label) => {
    tbody.append(el("tr", {
      style: "background:rgba(26,53,102,0.07);font-weight:800;color:#1a3566;"
    },
      el("td", { colspan: "5" }, label)
    ));
  };

  appendRow({
    label: "TOTAL DE MÉDICOS",
    medCidade: cidade.total || 0,
    medCaxias: caxias?.total || 0,
    medPoa: poa?.total || 0,
    bold: true
  });

  const groupOrder = [
    "Clínica e atenção básica",
    "Materno-infantil e saúde da mulher",
    "Cirúrgicas e procedimento",
    "Diagnóstico, suporte e terapia",
    "Alta complexidade e doenças crônicas",
    "Ambulatoriais especializadas",
    "Outras especialidades médicas"
  ];

  const grouped = {};

  for (const r of cidade.especialidades || []) {
    const group = medicalCareLine(r.especialidade || r.cbo);

    if (!grouped[group]) grouped[group] = [];
    grouped[group].push(r);
  }

  for (const group of groupOrder) {
    const rows = grouped[group] || [];
    if (!rows.length) continue;

    rows.sort((a, b) => (b.medicos || 0) - (a.medicos || 0));

    appendGroup(group);

    for (const r of rows) {
      const cx = caxiasByCbo[r.cbo];
      const pr = poaByCbo[r.cbo];

      appendRow({
        label: r.especialidade || r.cbo,
        medCidade: r.medicos || 0,
        medCaxias: cx?.medicos || 0,
        medPoa: pr?.medicos || 0
      });
    }
  }
}

function renderTypesTable(scope, estabsTarget, estabsPOA) {
  const tbody = $(`#${scope}-types-table tbody`);
  tbody.innerHTML = "";
  const countBy = list => {
    const c = {};
    for (const e of list) { const t = TIPO_UNIDADE_MAP[e.codigo_tipo_unidade] || `Tipo ${e.codigo_tipo_unidade ?? "N/I"}`; c[t] = (c[t] || 0) + 1; }
    return c;
  };
  const cT = countBy(estabsTarget), cP = countBy(estabsPOA);
  // Mostra apenas onde a cidade alvo tem pelo menos 1 (ignora zerados)
  const rows = Array.from(new Set([...Object.keys(cT), ...Object.keys(cP)]))
    .filter(name => (cT[name] || 0) > 0);
  rows.sort((a, b) => (cT[b]||0) - (cT[a]||0));
  for (const name of rows) {
    const t = cT[name] || 0, p = cP[name] || 0;
    tbody.append(el("tr", {},
      el("td", {}, name),
      el("td", { class: "num" }, fmt(t)),
      el("td", { class: "num" }, fmt(p)),
      el("td", { class: "num" + diffClass(t, p) }, diffPct(t, p)),
    ));
  }
}

/* Δ% formatter — diferença relativa de v vs ref (Porto Alegre).
 * (v - ref) / ref. Mostra "—" quando ref ausente; "+∞" se v>0 e ref=0; "0%" se ambos = 0.
 */
function diffPct(v, ref) {
  v = Number(v) || 0; ref = Number(ref) || 0;
  if (!ref && !v) return "0%";
  if (!ref) return v > 0 ? "+∞" : "—";
  const d = ((v - ref) / ref) * 100;
  const sign = d > 0 ? "+" : "";
  return `${sign}${d.toFixed(1)}%`;
}
function diffClass(v, ref) {
  v = Number(v) || 0; ref = Number(ref) || 0;
  if (!ref) return v > 0 ? " diff-pos" : "";
  const d = v - ref;
  return d > 0 ? " diff-pos" : d < 0 ? " diff-neg" : "";
}

function renderServicesTable(scope, estabsTarget, estabsPOA) {
  const tbody = $(`#${scope}-services-table tbody`);
  tbody.innerHTML = "";
  // Filtros de "Não SUS": estabelecimentos privados que NÃO atendem SUS
  // (combinação de esfera privada + flag de atendimento ambulatorial = "NAO" ou ausente).
  const isNaoSus = e =>
    e.descricao_esfera_administrativa === "PRIVADA" &&
    e.estabelecimento_faz_atendimento_ambulatorial_sus !== "SIM";
  const isSusActive = e =>
    e.estabelecimento_faz_atendimento_ambulatorial_sus === "SIM";

  const flags = [
    ["Atendimento hospitalar", e => e.estabelecimento_possui_atendimento_hospitalar === 1],
    ["Hospitalar — não SUS", e => e.estabelecimento_possui_atendimento_hospitalar === 1 && isNaoSus(e)],
    ["Centro cirúrgico", e => e.estabelecimento_possui_centro_cirurgico === 1],
    ["Centro cirúrgico — não SUS", e => e.estabelecimento_possui_centro_cirurgico === 1 && isNaoSus(e)],
    ["Centro obstétrico", e => e.estabelecimento_possui_centro_obstetrico === 1],
    ["Centro obstétrico — não SUS", e => e.estabelecimento_possui_centro_obstetrico === 1 && isNaoSus(e)],
    ["Centro neonatal", e => e.estabelecimento_possui_centro_neonatal === 1],
    ["Serviço de apoio diagnóstico/terapia (SADT)", e => e.estabelecimento_possui_servico_apoio === 1],
    ["SADT — não SUS", e => e.estabelecimento_possui_servico_apoio === 1 && isNaoSus(e)],
    ["Atendimento ambulatorial", e => e.estabelecimento_possui_atendimento_ambulatorial === 1],
    ["Ambulatorial SUS (ativo)", isSusActive],
    ["Ambulatorial não SUS (privado)", isNaoSus],
    ["Esfera privada", e => e.descricao_esfera_administrativa === "PRIVADA"],
    ["Esfera municipal", e => e.descricao_esfera_administrativa === "MUNICIPAL"],
    ["Esfera estadual", e => e.descricao_esfera_administrativa === "ESTADUAL"],
    ["Esfera federal", e => e.descricao_esfera_administrativa === "FEDERAL"],
  ];
  for (const [label, fn] of flags) {
    const nT = estabsTarget.filter(fn).length;
    const nP = estabsPOA.filter(fn).length;
    if (nT === 0 && nP === 0) continue;
    tbody.append(el("tr", {},
      el("td", {}, label),
      el("td", { class: "num" }, fmt(nT)),
      el("td", { class: "num" }, fmt(nP)),
      el("td", { class: "num" + diffClass(nT, nP) }, diffPct(nT, nP)),
    ));
  }
}

/* -- Cidade -- */

function renderCityKPIs(pop, area, density, pyramid, censo2010) {
  $("#city-pop").textContent = fmt(pop);
  $("#city-area").textContent = area ? fmt1(area) : "—";
  $("#city-dens").textContent = pop && area ? fmt1(pop / area) : (density ? fmt1(density) : "—");

  let pop60 = 0;
  for (const g of ["men","women"]) for (const [a, v] of Object.entries(pyramid[g])) if (AGE_60_PLUS.has(a)) pop60 += v;
  $("#city-60").textContent = pop ? `${fmt(pop60)} · ${pct(pop60, pop)}` : fmt(pop60);

  if (censo2010 && pop) {
    const g = ((pop / censo2010 - 1) * 100).toFixed(1);
    $("#city-growth").textContent = `${g >= 0 ? "+" : ""}${g}%`;
  } else {
    $("#city-growth").textContent = "—";
  }
}

function renderProfile({ loc, pop, area, pyramid, censo2010, ans, pib, cempre }) {
  const box = $("#city-profile");
  box.innerHTML = "";
  const line = html => box.append(el("div", { class: "line", html }));
  let pop60 = 0;
  for (const g of ["men","women"]) for (const [a, v] of Object.entries(pyramid[g])) if (AGE_60_PLUS.has(a)) pop60 += v;
  const growth = (censo2010 && pop) ? ((pop / censo2010 - 1) * 100).toFixed(1) : null;

  // DEMOGRAFIA
  line(`<strong>${loc.nome}</strong> — ${loc.microrregiao.mesorregiao.UF.nome}. Microrregião de <strong>${loc.microrregiao.nome}</strong>, mesorregião ${loc.microrregiao.mesorregiao.nome}.`);
  line(`População (Censo 2022): <strong>${fmt(pop)}</strong> habitantes.${area ? ` Área de <strong>${fmt1(area)} km²</strong>, densidade de <strong>${fmt1(pop / area)} hab/km²</strong>.` : ""}`);
  if (growth != null) {
    const sinal = growth >= 0 ? "+" : "";
    const cagr = ((Math.pow(pop/censo2010, 1/12) - 1) * 100).toFixed(2);
    line(`Crescimento populacional: <strong>${sinal}${growth}%</strong> de 2010 (${fmt(censo2010)}) a 2022 (${fmt(pop)}) — CAGR de ${cagr}% a.a.`);
  }
  line(`População 60+: <strong>${fmt(pop60)}</strong> (<strong>${pct(pop60, pop)}</strong>) — perfil ${pop60/pop > 0.20 ? "envelhecido" : pop60/pop > 0.15 ? "em transição demográfica" : "relativamente jovem"}.`);

  // ECONOMIA
  if (pib?.pib) {
    const pibPC = pop ? (pib.pib * 1000) / pop : null;
    const compAgro = pib.agro || 0, compInd = pib.industria || 0, compSv = pib.servicos || 0, compAdm = pib.admin || 0;
    const soma = compAgro + compInd + compSv + compAdm;
    line(`<strong>PIB ${pib.year}:</strong> R$ ${fmt1(pib.pib / 1000)} milhões · per capita ${pibPC ? "R$ " + fmt1(pibPC) : "—"}.`);
    if (soma > 0) {
      line(`Composição do Valor Adicionado: Serviços <strong>${pct(compSv, soma)}</strong> · Indústria <strong>${pct(compInd, soma)}</strong> · Adm. pública <strong>${pct(compAdm, soma)}</strong> · Agropecuária <strong>${pct(compAgro, soma)}</strong>.`);
    }
  }
  if (cempre?.empresas) {
    const ppe = cempre.pessoalTotal ? (cempre.pessoalTotal / cempre.empresas).toFixed(1) : "—";
    line(`<strong>Empresas ativas (${cempre.year}):</strong> ${fmt(cempre.empresas)} · pessoal ocupado ${fmt(cempre.pessoalTotal)} (${ppe} por empresa).`);
    if (cempre.salarios) line(`Massa salarial formal: <strong>R$ ${fmt1(cempre.salarios / 1000)} milhões/ano</strong>${cempre.salarioMed ? ` · salário médio mensal R$ ${fmt1(cempre.salarioMed)}` : ""}.`);
  }

  // SAÚDE
  if (ans && ans.total) {
    const top = (ans.operadoras||[])[0];
    line(`<strong>Saúde suplementar:</strong> ${fmt(ans.total)} beneficiários médico-hospitalares (${pop ? ((ans.total/pop)*100).toFixed(1) + "% da pop." : "—"}) em ${(ans.operadoras||[]).length} operadoras — mês ${monthLabel(ans.month)}.${top ? ` Líder: <strong>${top.razao}</strong> (${pct(top.beneficiarios, ans.total)}).` : ""}`);
  }
  const estabsHosp = state.establishments.filter(e => e.estabelecimento_possui_atendimento_hospitalar === 1);
  const priv = state.establishments.filter(e => e.descricao_esfera_administrativa === "PRIVADA").length;
  line(`<strong>Rede CNES:</strong> ${fmt(state.establishments.length)} estabelecimentos (${fmt(estabsHosp.length)} com atendimento hospitalar), ${pct(priv, state.establishments.length)} privados.`);
}

/* Renderiza pizza de composição de renda (Censo 2022) */
function renderRendimentoChart(classes) {
  const key = "city-renda";
  destroyChart(key);
  const canvas = $(`#${key}`);
  if (!canvas || !classes || !classes.length) return;
  const total = classes.reduce((a, b) => a + (b.value || 0), 0);
  if (!total) return;
  const palette = ["#0b1d58","#1a3566","#274a8a","#3e6bb0","#6690d0","#8ea9d4","#b2c3de","#cfd6e4","#d9dce4","#6b7380","#2a3246"];
  state.charts[key] = new Chart(canvas, {
    type: "doughnut",
    data: {
      labels: classes.map(c => c.label),
      datasets: [{ data: classes.map(c => c.value), backgroundColor: palette, borderWidth: 0 }],
    },
    options: {
      maintainAspectRatio: false,
      cutout: "55%",
      plugins: {
        legend: { position: "right", labels: { font: { size: 11 }, boxWidth: 12 } },
        tooltip: { callbacks: { label: c => `${c.label}: ${fmt(c.parsed)} (${pct(c.parsed, total)})` } },
      },
    },
  });
}

/* Busca foto do hospital na Wikipedia e insere no card correspondente */
async function enrichHospitalPhotos(top3, cityName, uf) {
  if (!top3 || !top3.length) return;
  for (let i = 0; i < top3.length; i++) {
    const h = top3[i];
    const name = h.nome || h.razao;
    if (!name) continue;
    const photoUrl = await fetchHospitalPhoto(name, cityName, uf);
    if (!photoUrl) continue;
    const cards = document.querySelectorAll(".top3-hospital");
    const card = cards[i];
    if (!card) continue;
    const photo = card.querySelector(".top3-photo");
    if (!photo) continue;
    // Pré-carrega pra garantir que a URL é válida
    const img = new Image();
    img.onload = () => {
      photo.style.backgroundImage = `url("${photoUrl}")`;
      photo.style.backgroundSize = "cover";
      photo.style.backgroundPosition = "center";
      const icon = photo.querySelector(".icon");
      if (icon) icon.remove();
      // atribuição sutil
      if (!photo.querySelector(".photo-attr")) {
        photo.append(el("span", { class: "photo-attr" }, "Foto: Wikipedia"));
      }
    };
    img.src = photoUrl;
  }
}

/* -- Leitos -- */

function renderLeitosMicro(leitos, totalPop, beneficiariosMH) {
  if (!leitos || !leitos.hospitais) return;
  const t = leitos.totais;
  $("#micro-leitos-tot").textContent = fmt(t.existentes);
  $("#micro-leitos-sus").textContent = `${fmt(t.sus)} · ${pct(t.sus, t.existentes)}`;
  $("#micro-leitos-priv").textContent = `${fmt(t.privados)} · ${pct(t.privados, t.existentes)}`;
  const utiTot = leitos.hospitais.reduce((sum, h) =>
    sum + (h.leitos || []).filter(l => /UTI|INTENSIV|UNIDADE INT/i.test(l.tipo)).reduce((a, b) => a + b.existentes, 0), 0);
  $("#micro-uti-tot").textContent = fmt(utiTot);
  $("#micro-hosp-count").textContent = fmt(leitos.hospitais.length);
  $("#micro-habxleito-tot").textContent = (totalPop && t.existentes) ? fmt(Math.round(totalPop / t.existentes)) : "—";
  $("#micro-habxleito-sus").textContent = (totalPop && t.sus) ? fmt(Math.round(totalPop / t.sus)) : "—";
  $("#micro-benefxleito-priv").textContent = (beneficiariosMH && t.privados) ? fmt(Math.round(beneficiariosMH / t.privados)) : "—";

  const muniMap = {};
  for (const m of state.micro.municipios) muniMap[m.id.slice(0, 6)] = m.nome;

  const tbody = $("#micro-leitos-table tbody");
  const tfoot = $("#micro-leitos-table tfoot");
  tbody.innerHTML = ""; tfoot.innerHTML = "";
  for (const h of leitos.hospitais) {
    const muniNome = muniMap[h.cod_ibge] || "—";
    const utiH = (h.leitos || []).filter(l => /UTI|INTENSIV|UNIDADE INT/i.test(l.tipo)).reduce((a, b) => a + b.existentes, 0);
    tbody.append(el("tr", {},
      el("td", {}, h.nome),
      el("td", {}, muniNome),
      el("td", {}, h.tipo),
      el("td", { class: "num" }, fmt(h.leitos_sus_total)),
      el("td", { class: "num" }, fmt(h.leitos_privados_total)),
      el("td", { class: "num" }, fmt(h.leitos_total)),
      el("td", { class: "num" }, fmt(utiH)),
    ));
  }
  tfoot.append(el("tr", {},
    el("td", { colspan: "3" }, "TOTAL"),
    el("td", { class: "num" }, fmt(t.sus)),
    el("td", { class: "num" }, fmt(t.privados)),
    el("td", { class: "num" }, fmt(t.existentes)),
    el("td", { class: "num" }, fmt(utiTot)),
  ));
}

function renderLeitosCity(leitos, pop, beneficiariosMH) {
  if (!leitos || !leitos.hospitais) return;
  const t = leitos.totais;
  $("#city-leitos-tot").textContent = fmt(t.existentes);
  $("#city-leitos-sus").textContent = `${fmt(t.sus)} · ${pct(t.sus, t.existentes)}`;
  $("#city-leitos-priv").textContent = `${fmt(t.privados)} · ${pct(t.privados, t.existentes)}`;
  const utiTot = leitos.hospitais.reduce((sum, h) =>
    sum + (h.leitos || []).filter(l => /UTI|INTENSIV|UNIDADE INT/i.test(l.tipo)).reduce((a, b) => a + b.existentes, 0), 0);
  $("#city-uti-tot").textContent = fmt(utiTot);
  $("#city-hosp-count").textContent = fmt(leitos.hospitais.length);

  $("#city-habxleito-tot").textContent = (pop && t.existentes) ? fmt(Math.round(pop / t.existentes)) : "—";
  $("#city-habxleito-sus").textContent = (pop && t.sus) ? fmt(Math.round(pop / t.sus)) : "—";
  $("#city-benefxleito-priv").textContent = (beneficiariosMH && t.privados) ? fmt(Math.round(beneficiariosMH / t.privados)) : "—";

  const tbody = $("#city-leitos-table tbody");
  const tfoot = $("#city-leitos-table tfoot");
  tbody.innerHTML = ""; tfoot.innerHTML = "";
  let utiSusTot = 0;
  for (const h of leitos.hospitais) {
    const utiH = (h.leitos || []).filter(l => /UTI|INTENSIV|UNIDADE INT/i.test(l.tipo));
    const utiExist = utiH.reduce((a, b) => a + b.existentes, 0);
    const utiSus = utiH.reduce((a, b) => a + b.sus, 0);
    utiSusTot += utiSus;
    tbody.append(el("tr", {},
      el("td", {}, h.nome),
      el("td", {}, (h.natureza || h.natureza_cat || "—").replace(/_/g, " ")),
      el("td", { class: "num" }, fmt(h.leitos_sus_total)),
      el("td", { class: "num" }, fmt(h.leitos_privados_total)),
      el("td", { class: "num" }, fmt(h.leitos_total)),
      el("td", { class: "num" }, fmt(utiExist)),
      el("td", { class: "num" }, fmt(utiSus)),
    ));
  }
  tfoot.append(el("tr", {},
    el("td", { colspan: "2" }, "TOTAL"),
    el("td", { class: "num" }, fmt(t.sus)),
    el("td", { class: "num" }, fmt(t.privados)),
    el("td", { class: "num" }, fmt(t.existentes)),
    el("td", { class: "num" }, fmt(utiTot)),
    el("td", { class: "num" }, fmt(utiSusTot)),
  ));
}

function renderLeitosPrivEvolution(scope, series) {
  const key = `${scope}-leitos-priv-evol`;
  destroyChart(key);
  const canvas = $(`#${key}`);
  if (!canvas) return;
  if (!series || series.length < 2) {
    canvas.parentElement.innerHTML =
      `<p class="muted">Histórico anual indisponível para esta competência.</p>`;
    return;
  }
  state.charts[key] = new Chart(canvas, {
    type: "line",
    data: {
      labels: series.map(s => String(s.year)),
      datasets: [
        {
          label: "Leitos privados",
          data: series.map(s => s.privados),
          borderColor: COLORS.brand,
          backgroundColor: "rgba(26,53,102,0.15)",
          tension: 0.3, fill: true, pointRadius: 4,
          pointBackgroundColor: COLORS.brand, borderWidth: 2.5,
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => `${fmt(c.parsed.y)} leitos privados` } },
      },
      scales: {
        x: { title: { display: true, text: "Ano" } },
        y: { title: { display: true, text: "Leitos privados" }, ticks: { callback: v => fmt(v) } },
      },
    },
  });
}

/* -- Infra -- */

function renderInfraMap(estabs) {
  const mapEl = $("#infra-map");
  if (!state.maps.infra) {
    state.maps.infra = L.map(mapEl).setView([-14.2, -51.9], 4);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap", maxZoom: 18 }).addTo(state.maps.infra);
  }
  const map = state.maps.infra;
  if (state.infraLayer) map.removeLayer(state.infraLayer);
  const markers = [];
  for (const e of estabs) {
    const lat = e.latitude_estabelecimento_decimo_grau, lon = e.longitude_estabelecimento_decimo_grau;
    if (!lat || !lon) continue;
    const tipo = TIPO_UNIDADE_MAP[e.codigo_tipo_unidade] || "—";
    const isHosp = e.estabelecimento_possui_atendimento_hospitalar === 1;
    const icon = L.divIcon({
      html: `<div style="background:${isHosp ? COLORS.brand : COLORS.gray2};width:${isHosp ? 14 : 8}px;height:${isHosp ? 14 : 8}px;border-radius:50%;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.3)"></div>`,
      className: "", iconSize: [16, 16],
    });
    const html = `<strong>${e.nome_fantasia || e.nome_razao_social || "—"}</strong><br>${tipo}<br>${e.endereco_estabelecimento || ""} ${e.numero_estabelecimento || ""}<br>${e.bairro_estabelecimento || ""}`;
    markers.push(L.marker([lat, lon], { icon }).bindPopup(html));
  }
  state.infraLayer = L.layerGroup(markers).addTo(map);
  if (markers.length) map.fitBounds(L.featureGroup(markers).getBounds().pad(0.12));
  setTimeout(() => map.invalidateSize(), 120);
}

function renderTop3Hospitals(top3, servicosArr, estabs) {
  const box = $("#top3-hospitals");
  box.innerHTML = "";
  if (!top3 || !top3.length) {
    box.append(el("p", { class: "muted" }, "Nenhum hospital com leitos encontrado no ElastiCNES."));
    return;
  }
  // Index CNES básico por cnes para pegar endereço
  const estabByCnes = {};
  for (const e of estabs) estabByCnes[String(e.codigo_cnes)] = e;

  top3.forEach((h, i) => {
    try {
    const estab = estabByCnes[h.cnes] || {};
    const name = h.nome || h.razao || "—";
    const natureza = (h.natureza || h.natureza_cat || "").replace(/_/g, " ");
    const tipo = h.tipo || "—";
    const initial = (name.match(/[A-Za-zÀ-ú]/) || ["H"])[0].toUpperCase();
    const endereco = [h.endereco, estab.numero_estabelecimento].filter(Boolean).join(", ") || estab.endereco_estabelecimento || "";
    const bairro = h.bairro || estab.bairro_estabelecimento || "";

    const uti = (h.leitos || []).filter(l => /UTI|INTENSIV|UNIDADE INT/i.test(l.tipo));
    const utiTot = uti.reduce((a, b) => a + b.existentes, 0);
    const utiSus = uti.reduce((a, b) => a + b.sus, 0);

    const photo = el("div", { class: "top3-photo" },
      el("span", { class: "rank" }, `${i + 1}º`),
      el("div", { class: "icon", html: hospitalIconSVG() }),
      el("div", { class: "name-strip" }, name),
    );

    const body = el("div", { class: "top3-body" });
    body.append(el("h4", {}, name));
    body.append(el("p", { class: "sub-info" }, `${tipo} · ${natureza}${bairro ? " · " + bairro : ""}`));
    if (h.num_unidades > 1) {
      body.append(el("p", { class: "sub-info unit-note" },
        `⊙ ${h.num_unidades} unidades cadastradas no CNES (valores consolidados)`));
    }

    // Stats: Total, SUS, Privado, UTI
    body.append(el("div", { class: "top3-stats" },
      el("div", { class: "top3-stat" }, el("span", { class: "label" }, "Total"), el("span", { class: "value" }, fmt(h.leitos_total))),
      el("div", { class: "top3-stat sus" }, el("span", { class: "label" }, "SUS"), el("span", { class: "value" }, fmt(h.leitos_sus_total))),
      el("div", { class: "top3-stat" }, el("span", { class: "label" }, "Privados"), el("span", { class: "value" }, fmt(h.leitos_privados_total))),
      el("div", { class: "top3-stat" }, el("span", { class: "label" }, "UTI"), el("span", { class: "value" }, fmt(utiTot))),
    ));

    // Especialidades dos leitos (bed types)
    if (h.leitos && h.leitos.length) {
      body.append(el("div", { class: "top3-section" },
        el("h5", {}, "Especialidades dos leitos"),
        el("div", { class: "leito-type-list" },
          ...h.leitos.slice(0, 30).map(l => el("span", { class: "leito-type" },
            el("strong", {}, String(l.existentes)), ` ${l.tipo}`,
          )),
        ),
      ));
    }

    // Especialidades do hospital (serviços)
    const servicos = (servicosArr[i]?.servicos) || [];
    if (servicos.length) {
      body.append(el("div", { class: "top3-section" },
        el("h5", {}, `Especialidades do hospital (${servicos.length})`),
        el("div", { class: "spec-list" },
          ...servicos.slice(0, 40).map(s => el("span", { class: "spec-tag", title: s.classificacoes?.join(", ") || "" },
            shortSpecLabel(s.servico),
          )),
        ),
      ));
    }

    box.append(el("div", { class: "top3-hospital" }, photo, body));
    } catch (err) {
      console.error(`Erro ao renderizar hospital #${i + 1}:`, err, "hospital:", h);
      box.append(el("div", { class: "top3-hospital", style: "padding:14px;color:#b03a1e" },
        `Erro ao renderizar ${h.nome || "hospital"}: ${err.message}`));
    }
  });
}

function shortSpecLabel(s) {
  return (s || "")
    .replace(/^SERVI[CÇ]O DE ATEN[CÇ]AO?\s+(EM|A|AO|AS|À|ÀS)?\s*/i, "")
    .replace(/^SERVI[CÇ]O\s+(DE|EM|A|AO)?\s*/i, "")
    .trim();
}

function hospitalIconSVG() {
  return `<svg width="110" height="110" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M3 21V8l9-5 9 5v13"/><path d="M10 21v-6h4v6"/>
    <path d="M12 8v4"/><path d="M10 10h4"/>
  </svg>`;
}

/* =========================================================
 * IQM (Índice de Qualidade de Mercado) + Bubble chart
 * ========================================================= */

// Soma das classes de rendimento ≥ 10 SM (proxy para classe A+B)
const RENDA_AB_KEYS = new Set(["99825", "99828", "96184"]);

function rendaABShare(rendimentoArr) {
  if (!rendimentoArr || !rendimentoArr.length) return 0;
  const total = rendimentoArr.reduce((a, c) => a + (c.value || 0), 0);
  if (!total) return 0;
  const ab = rendimentoArr.filter(c => RENDA_AB_KEYS.has(c.key)).reduce((a, c) => a + (c.value || 0), 0);
  return ab / total;
}

// CAGR a partir da série de beneficiários (mensal, mh)
function cagrFromAnsSeries(series) {
  if (!series || series.length < 2) return null;
  const valid = series.filter(s => s.total > 0);
  if (valid.length < 2) return null;
  const first = valid[0], last = valid[valid.length - 1];
  // Diferença em meses
  const ymToDate = ym => {
    const y = Number(String(ym).slice(0, 4));
    const m = Number(String(ym).slice(4, 6)) - 1;
    return new Date(y, m, 1);
  };
  const months = (ymToDate(last.month) - ymToDate(first.month)) / (1000 * 60 * 60 * 24 * 30);
  if (months <= 0) return null;
  const years = months / 12;
  const ratio = last.total / first.total;
  if (ratio <= 0) return null;
  return (Math.pow(ratio, 1 / years) - 1) * 100; // % a.a.
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function scoreLinear(v, min, max) {
  if (v == null || Number.isNaN(v)) return 0;
  return clamp(((v - min) / (max - min)) * 100, 0, 100);
}

// Calcula IQM 0-100 a partir de métricas brutas
function computeIQM(metrics) {
  // metrics: { coberturaPct (0-1), rendaAB (0-1), cagrPop (% a.a.), hospPer100k, benefPerLeitoPriv }
  const sCob = scoreLinear(metrics.coberturaPct * 100, 0, 50);   // 0–50% → 0–100
  const sRenda = scoreLinear(metrics.rendaAB * 100, 0, 25);      // 0–25% → 0–100
  const sCresc = scoreLinear(metrics.cagrPop, -1, 3);            // -1% a 3% a.a.
  const sRede = scoreLinear(metrics.hospPer100k, 0, 5);          // 0–5 hosp / 100k
  // benef por leito priv: menor é melhor. Inversão: 50 = score 100, 1000+ = score 0
  let sLeitos = 0;
  if (metrics.benefPerLeitoPriv && metrics.benefPerLeitoPriv > 0) {
    sLeitos = scoreLinear(1000 - metrics.benefPerLeitoPriv, 0, 950);
  }
  const score =
    sCob * 0.30 +
    sRenda * 0.25 +
    sCresc * 0.15 +
    sRede * 0.15 +
    sLeitos * 0.15;
  return {
    total: Math.round(score),
    parts: {
      cobertura: Math.round(sCob),
      renda: Math.round(sRenda),
      crescimento: Math.round(sCresc),
      rede: Math.round(sRede),
      leitos: Math.round(sLeitos),
    },
  };
}

function tierIQM(score) {
  if (score >= 75) return "premium";
  if (score >= 60) return "alto";
  if (score >= 45) return "médio";
  if (score >= 30) return "baixo";
  return "incipiente";
}

async function renderIQMandBubble(ctx) {
  const {
    cityIbge, cityName, cityUF, cityPop, censo2010,
    cityLeitos, cityAns, cityAnsHist, cityRendimento,
    estabsCity, popByCity, poaRef,
  } = ctx;

  // 1) Métricas para cidade-alvo (já temos tudo)
  const cityHospHospitalar = (estabsCity || []).filter(e =>
    e.estabelecimento_possui_atendimento_hospitalar === 1
  ).length;
  const cityMetrics = {
    coberturaPct: cityPop ? (cityAns?.total || 0) / cityPop : 0,
    rendaAB: rendaABShare(cityRendimento),
    cagrPop: (cityPop && censo2010) ? (Math.pow(cityPop / censo2010, 1 / 12) - 1) * 100 : 0,
    hospPer100k: cityPop ? (cityHospHospitalar / cityPop) * 100000 : 0,
    benefPerLeitoPriv: (cityLeitos?.totais?.privados && cityAns?.total)
      ? cityAns.total / cityLeitos.totais.privados : null,
  };
  const cityIQM = computeIQM(cityMetrics);

  // 2) Métricas para POA — usamos referências já cacheadas + um fetch leve para renda + estabs (POA hospital count)
  let poaIQM = null, poaMetrics = null;
  try {
    const poaRendimento = await fetchRendimento(POA_IBGE).catch(() => []);
    const poaEstabsHosp = state.estabsPOA.filter(e =>
      e.estabelecimento_possui_atendimento_hospitalar === 1
    ).length;
    const poaPop = poaRef?.city?.pop || 0;
    const poaAnsHistRaw = await getJSON(`${ANS}/history?uf=RS&cods=${POA_CNES}`).catch(() => ({ series: [] }));
    const poaCagr = cagrFromAnsSeries((poaAnsHistRaw?.series || []).map(s => ({ month: s.month, total: s.mh })));
    poaMetrics = {
      coberturaPct: poaPop ? (poaRef?.city?.ansTotal || 0) / poaPop : 0,
      rendaAB: rendaABShare(poaRendimento),
      cagrPop: 1.5,
      hospPer100k: poaPop ? (poaEstabsHosp / poaPop) * 100000 : 0,
      benefPerLeitoPriv: (poaRef?.city?.leitosTotais?.privados && poaRef?.city?.ansTotal)
        ? poaRef.city.ansTotal / poaRef.city.leitosTotais.privados : null,
    };
    poaIQM = computeIQM(poaMetrics);
    poaMetrics._cagrAns = poaCagr;
    poaMetrics._pop = poaPop;
    poaMetrics._privados = poaRef?.city?.leitosTotais?.privados;
    poaMetrics._ansTotal = poaRef?.city?.ansTotal;
  } catch (e) {
    console.warn("Falha ao calcular IQM POA:", e);
  }

  // 3) Render IQM
  $("#city-iqm-value").textContent = String(cityIQM.total);
  $("#city-iqm-tier").textContent = tierIQM(cityIQM.total);
  const bars = $("#city-iqm-bars");
  bars.innerHTML = "";
  const fmtPct1 = v => (v == null || Number.isNaN(v)) ? "—" : `${(v * 100).toFixed(1)}%`;
  const fmtPctAA = v => (v == null || Number.isNaN(v)) ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}% a.a.`;
  const fmtPer100k = v => (v == null || Number.isNaN(v)) ? "—" : v.toFixed(1);
  const rows = [
    ["Cobertura ANS", cityIQM.parts.cobertura, poaIQM?.parts?.cobertura, fmtPct1(cityMetrics.coberturaPct), fmtPct1(poaMetrics?.coberturaPct)],
    ["Renda classe A+B", cityIQM.parts.renda, poaIQM?.parts?.renda, fmtPct1(cityMetrics.rendaAB), fmtPct1(poaMetrics?.rendaAB)],
    ["Crescimento populacional (CAGR 2010–2022)", cityIQM.parts.crescimento, poaIQM?.parts?.crescimento, fmtPctAA(cityMetrics.cagrPop), fmtPctAA(poaMetrics?.cagrPop)],
    ["Hospitais / 100k hab.", cityIQM.parts.rede, poaIQM?.parts?.rede, fmtPer100k(cityMetrics.hospPer100k), fmtPer100k(poaMetrics?.hospPer100k)],
    ["Leitos privados (1 / benef.)", cityIQM.parts.leitos, poaIQM?.parts?.leitos,
      cityMetrics.benefPerLeitoPriv ? `1 / ${fmt(Math.round(cityMetrics.benefPerLeitoPriv))}` : "—",
      poaMetrics?.benefPerLeitoPriv ? `1 / ${fmt(Math.round(poaMetrics.benefPerLeitoPriv))}` : "—"],
  ];
  for (const [label, score, refScore, valStr, refStr] of rows) {
    const row = el("div", { class: "iqm-bar-row" });
    row.append(el("div", { class: "label" }, label));
    const track = el("div", { class: "track" });
    if (refScore != null) {
      track.append(el("div", { class: "fill poa", style: `width:${refScore}%` }));
    }
    track.append(el("div", { class: "fill", style: `width:${score}%` }));
    row.append(track);
    row.append(el("div", { class: "val" }, valStr));
    row.append(el("div", { class: "ref" }, `POA: ${refStr}`));
    bars.append(row);
  }

  // 4) Bubble chart — APENAS cidade pesquisada + Porto Alegre como referência.
  //    (Antes mostrávamos peers da microrregião, mas isso poluía a visualização.)
  const points = [];
  if (cityMetrics.benefPerLeitoPriv) {
    points.push({
      label: cityName,
      x: cityMetrics.benefPerLeitoPriv,
      y: cagrFromAnsSeries(cityAnsHist) ?? 0,
      r: Math.max(10, cityMetrics.rendaAB * 100),
      kind: "current",
    });
  }
  // POA como referência (se não for a própria cidade pesquisada)
  if (cityIbge !== POA_IBGE && poaMetrics?.benefPerLeitoPriv && poaMetrics?._cagrAns != null) {
    points.push({
      label: "Porto Alegre (referência)",
      x: poaMetrics.benefPerLeitoPriv,
      y: poaMetrics._cagrAns,
      r: Math.max(10, poaMetrics.rendaAB * 100),
      kind: "poa",
    });
  }

  renderBubbleChart(points);
}

function renderBubbleChart(points) {
  const key = "city-bubble";
  destroyChart(key);
  const canvas = $(`#${key}`);
  if (!canvas) return;
  if (!points || !points.length) {
    canvas.parentElement.innerHTML =
      `<p class="muted">Dados insuficientes para o gráfico de posicionamento (precisa de beneficiários ANS, leitos privados e renda — disponível primariamente para municípios do RS).</p>`;
    return;
  }
  const colorFor = k => k === "current" ? "#1a3566" : k === "poa" ? "#d94a4a" : "#8a93a3";
  const ds = {
    label: "Municípios",
    data: points.map(p => ({ x: p.x, y: p.y, r: p.r, label: p.label, kind: p.kind })),
    backgroundColor: points.map(p => colorFor(p.kind) + "cc"),
    borderColor: points.map(p => colorFor(p.kind)),
    borderWidth: 2,
  };
  state.charts[key] = new Chart(canvas, {
    type: "bubble",
    data: { datasets: [ds] },
    options: {
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: c => {
              const p = c.raw;
              return [
                `${p.label}`,
                `Benef. por leito privado: ${fmt(Math.round(p.x))}`,
                `CAGR benef.: ${p.y >= 0 ? "+" : ""}${p.y.toFixed(1)}% a.a.`,
                `Tamanho ∝ % renda A+B`,
              ];
            },
          },
        },
        // Plugin custom para anotar cada bolha com o nome
        bubbleLabels: { show: true },
      },
      scales: {
        x: {
          title: { display: true, text: "Beneficiários médico-hospitalares por leito privado (menor = mais leitos disponíveis)" },
          ticks: { callback: v => fmt(v) },
        },
        y: {
          title: { display: true, text: "CAGR de beneficiários (% a.a.)" },
          ticks: { callback: v => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%` },
        },
      },
    },
    plugins: [{
      id: "bubbleLabels",
      afterDatasetsDraw(chart, _args, opts) {
        if (!opts || !opts.show) return;
        const { ctx } = chart;
        ctx.save();
        ctx.font = "600 10.5px -apple-system, 'Inter', Helvetica, Arial, sans-serif";
        ctx.fillStyle = "#0b1220";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        const meta = chart.getDatasetMeta(0);
        meta.data.forEach((elem, i) => {
          const p = chart.data.datasets[0].data[i];
          if (!p) return;
          const pos = elem.tooltipPosition ? elem.tooltipPosition() : { x: elem.x, y: elem.y };
          ctx.fillText(p.label, pos.x, pos.y + (p.r || 6) + 2);
        });
        ctx.restore();
      },
    }],
  });
}

