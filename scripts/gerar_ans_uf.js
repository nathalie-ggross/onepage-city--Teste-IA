#!/usr/bin/env node
/* =========================================================
 * Gera arquivos ANS pré-processados por UF e competência
 *
 * Saída: data/ans_<UF>_<AAAAMM>.json
 * Fonte: ANS PDA 024 — informações consolidadas de beneficiários
 *
 * Exemplos:
 *   node scripts/gerar_ans_uf.js SC 202602
 *   node scripts/gerar_ans_uf.js SC 202312 202406 202412 202506 202511 202512 202601 202602
 *   node scripts/gerar_ans_uf.js SC --months-from RS
 *   node scripts/gerar_ans_uf.js SC PR --months-from RS
 *   node scripts/gerar_ans_uf.js SC --latest 6
 *
 * Observações:
 * - O script é genérico para qualquer UF.
 * - Ele cria a pasta data/ se ela não existir.
 * - Usa o comando `unzip` para ler o CSV dentro do ZIP da ANS.
 * ========================================================= */

import fs from "fs";
import path from "path";
import https from "https";
import http from "http";
import { spawn } from "child_process";
import readline from "readline";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const TMP_DIR = path.join(ROOT, ".cache", "ans_downloads");

const ANS_BASE = "https://dadosabertos.ans.gov.br/FTP/PDA/informacoes_consolidadas_de_beneficiarios-024";
const REQUIRED_COLS = [
  "CD_MUNICIPIO",
  "NM_RAZAO_SOCIAL",
  "MODALIDADE_OPERADORA",
  "COBERTURA_ASSIST_PLAN",
  "QT_BENEFICIARIO_ATIVO",
];

function usageAndExit(message = "") {
  if (message) console.error(`\nErro: ${message}\n`);
  console.error(`Uso:
  node scripts/gerar_ans_uf.js <UF...> <AAAAMM...>
  node scripts/gerar_ans_uf.js <UF...> --months-from <UF_BASE>
  node scripts/gerar_ans_uf.js <UF...> --latest <N>

Exemplos:
  node scripts/gerar_ans_uf.js SC 202602
  node scripts/gerar_ans_uf.js SC --months-from RS
  node scripts/gerar_ans_uf.js SC PR --months-from RS
  node scripts/gerar_ans_uf.js SC --latest 6
`);
  process.exit(1);
}

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

function normalizeUF(value) {
  const uf = String(value || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(uf)) return null;
  return uf;
}

function normalizeYm(value) {
  const ym = String(value || "").trim();
  if (!/^\d{6}$/.test(ym)) return null;
  const mm = Number(ym.slice(4, 6));
  if (mm < 1 || mm > 12) return null;
  return ym;
}

function ymToFileToken(ym) {
  return `${ym.slice(0, 4)}_${ym.slice(4, 6)}`;
}

function ansUrl(uf, ym) {
  return `${ANS_BASE}/${ym}/pda-024-icb-${uf}-${ymToFileToken(ym)}.zip`;
}

function outputJsonPath(uf, ym) {
  return path.join(DATA_DIR, `ans_${uf}_${ym}.json`);
}

function zipPath(uf, ym) {
  return path.join(TMP_DIR, `pda-024-icb-${uf}-${ymToFileToken(ym)}.zip`);
}

function monthsFromData(baseUf) {
  if (!fs.existsSync(DATA_DIR)) return [];
  const rx = new RegExp(`^ans_${baseUf}_(\\d{6})\\.json$`);
  return fs.readdirSync(DATA_DIR)
    .map(f => f.match(rx)?.[1])
    .filter(Boolean)
    .sort();
}

function recentMonths(count) {
  const n = Number(count);
  if (!Number.isInteger(n) || n <= 0 || n > 60) usageAndExit("--latest precisa ser um número entre 1 e 60.");

  const out = [];
  const now = new Date();
  // Começa no mês atual e volta. Se a ANS ainda não publicou o mês atual,
  // as tentativas inexistentes serão puladas com aviso.
  let y = now.getFullYear();
  let m = now.getMonth() + 1;

  for (let i = 0; i < n; i++) {
    out.push(`${y}${String(m).padStart(2, "0")}`);
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }

  return out.reverse();
}

function parseArgs(argv) {
  if (!argv.length) usageAndExit();

  const ufs = [];
  const months = [];
  let monthsFrom = null;
  let latest = null;
  let overwrite = false;
  let keepZip = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (a === "--months-from") {
      const uf = normalizeUF(argv[++i]);
      if (!uf) usageAndExit("Informe uma UF válida depois de --months-from.");
      monthsFrom = uf;
      continue;
    }

    if (a === "--latest") {
      const n = argv[++i];
      if (!n) usageAndExit("Informe a quantidade de meses depois de --latest.");
      latest = n;
      continue;
    }

    if (a === "--overwrite") {
      overwrite = true;
      continue;
    }

    if (a === "--keep-zip") {
      keepZip = true;
      continue;
    }

    const uf = normalizeUF(a);
    const ym = normalizeYm(a);

    if (ym) months.push(ym);
    else if (uf) ufs.push(uf);
    else usageAndExit(`Argumento inválido: ${a}`);
  }

  if (!ufs.length) usageAndExit("Informe pelo menos uma UF, por exemplo SC.");

  let finalMonths = [...months];
  if (monthsFrom) finalMonths.push(...monthsFromData(monthsFrom));
  if (latest) finalMonths.push(...recentMonths(latest));

  finalMonths = [...new Set(finalMonths)].sort();
  if (!finalMonths.length) usageAndExit("Informe pelo menos uma competência AAAAMM, --months-from UF ou --latest N.");

  return { ufs: [...new Set(ufs)], months: finalMonths, overwrite, keepZip };
}

function requestWithRedirect(url, dest, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https:") ? https : http;
    const req = client.get(url, {
      headers: {
        "User-Agent": "onepage-city-ans-generator/1.0",
        "Accept": "application/zip,application/octet-stream,*/*",
      },
      timeout: 180000,
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
        const nextUrl = new URL(res.headers.location, url).toString();
        res.resume();
        requestWithRedirect(nextUrl, dest, redirectsLeft - 1).then(resolve, reject);
        return;
      }

      if (res.statusCode !== 200) {
        const chunks = [];
        res.on("data", d => chunks.push(d));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8").slice(0, 300);
          reject(new Error(`HTTP ${res.statusCode} ao baixar ${url}. Resposta: ${body}`));
        });
        return;
      }

      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
      file.on("error", reject);
    });

    req.on("timeout", () => {
      req.destroy(new Error(`Timeout ao baixar ${url}`));
    });
    req.on("error", reject);
  });
}

async function downloadZip(uf, ym) {
  const url = ansUrl(uf, ym);
  const out = zipPath(uf, ym);

  if (fs.existsSync(out) && fs.statSync(out).size > 0) {
    console.log(`  ZIP já existe: ${path.relative(ROOT, out)}`);
    return out;
  }

  console.log(`  Baixando: ${url}`);
  await requestWithRedirect(url, out);
  const size = fs.statSync(out).size;
  if (size <= 0) throw new Error(`Download vazio: ${out}`);
  console.log(`  ZIP baixado: ${(size / 1024 / 1024).toFixed(1)} MB`);
  return out;
}

function cleanHeader(value) {
  return String(value || "").replace(/^\uFEFF/, "").trim();
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        quoted = !quoted;
      }
      continue;
    }

    if (ch === ";" && !quoted) {
      out.push(cur);
      cur = "";
      continue;
    }

    cur += ch;
  }

  out.push(cur);
  return out;
}

function intValue(value) {
  const s = String(value ?? "").trim();
  if (!s) return 0;
  const n = Number(s.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function findColumn(idx, name) {
  const exact = idx[name];
  if (exact != null) return exact;

  const normalizedTarget = name.toUpperCase().replace(/[^A-Z0-9]/g, "");
  for (const [col, i] of Object.entries(idx)) {
    const normalizedCol = col.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (normalizedCol === normalizedTarget) return i;
  }

  return null;
}

function aggregateRow(result, row, idx) {
  const codIdx = findColumn(idx, "CD_MUNICIPIO");
  const razaoIdx = findColumn(idx, "NM_RAZAO_SOCIAL");
  const modalidadeIdx = findColumn(idx, "MODALIDADE_OPERADORA");
  const coberturaIdx = findColumn(idx, "COBERTURA_ASSIST_PLAN");
  const ativosIdx = findColumn(idx, "QT_BENEFICIARIO_ATIVO");

  const cod = String(row[codIdx] || "").trim();
  if (!cod) return;

  const ativos = intValue(row[ativosIdx]);
  if (ativos <= 0) return;

  const razao = String(row[razaoIdx] || "SEM RAZÃO SOCIAL").trim() || "SEM RAZÃO SOCIAL";
  const modalidade = String(row[modalidadeIdx] || "").trim();
  const cobertura = String(row[coberturaIdx] || "").trim().toLowerCase();
  const isOdonto = cobertura.startsWith("odont");

  const city = result.byCity[cod] ||= {
    total: 0,
    mh: 0,
    odonto: 0,
    operadoras: {},
  };

  city.total += ativos;
  if (isOdonto) city.odonto += ativos;
  else city.mh += ativos;

  const op = city.operadoras[razao] ||= {
    modalidade,
    beneficiarios: 0,
    mh: 0,
    odonto: 0,
  };

  op.beneficiarios += ativos;
  if (isOdonto) op.odonto += ativos;
  else op.mh += ativos;
}

async function aggregateZip(uf, ym, zipFile) {
  return new Promise((resolve, reject) => {
    const result = { month: ym, uf, byCity: {} };
    const unzip = spawn("unzip", ["-p", zipFile]);

    let header = null;
    let idx = null;
    let rows = 0;
    let usedRows = 0;
    let stderr = "";

    unzip.stderr.on("data", d => { stderr += d.toString(); });
    unzip.on("error", err => {
      if (err.code === "ENOENT") {
        reject(new Error("Comando `unzip` não encontrado. No Codespaces/Linux instale com: sudo apt-get update && sudo apt-get install -y unzip"));
      } else {
        reject(err);
      }
    });

    const rl = readline.createInterface({ input: unzip.stdout, crlfDelay: Infinity });

    rl.on("line", (line) => {
      if (!line.trim()) return;
      const row = parseCsvLine(line);

      if (!header) {
        header = row.map(cleanHeader);
        idx = Object.fromEntries(header.map((h, i) => [h, i]));

        const missing = REQUIRED_COLS.filter(c => findColumn(idx, c) == null);
        if (missing.length) {
          rl.close();
          unzip.kill();
          reject(new Error(`CSV sem colunas obrigatórias: ${missing.join(", ")}. Cabeçalho encontrado: ${header.join(" | ")}`));
        }
        return;
      }

      rows++;
      const beforeCities = Object.keys(result.byCity).length;
      aggregateRow(result, row, idx);
      if (Object.keys(result.byCity).length > beforeCities) usedRows++;
      else {
        // também conta linhas que atualizaram cidade já existente
        const ativosIdx = findColumn(idx, "QT_BENEFICIARIO_ATIVO");
        if (intValue(row[ativosIdx]) > 0) usedRows++;
      }

      if (rows % 500000 === 0) console.log(`    processadas ${rows.toLocaleString("pt-BR")} linhas...`);
    });

    rl.on("close", () => {
      unzip.on("close", (code) => {
        if (code !== 0 && !header) {
          reject(new Error(`Falha ao ler ZIP com unzip. Código ${code}. ${stderr}`));
          return;
        }
        const cities = Object.keys(result.byCity).length;
        console.log(`  Agregado: ${cities} municípios; ${rows.toLocaleString("pt-BR")} linhas lidas.`);
        resolve(result);
      });
    });

    rl.on("error", reject);
  });
}

function writeJson(uf, ym, data) {
  const out = outputJsonPath(uf, ym);
  const tmp = `${out}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, out);
  console.log(`  JSON salvo: ${path.relative(ROOT, out)} (${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} MB)`);
}

async function processOne(uf, ym, options) {
  const out = outputJsonPath(uf, ym);
  if (fs.existsSync(out) && !options.overwrite) {
    console.log(`\n[${uf} ${ym}] já existe em data/. Pulando. Use --overwrite para regerar.`);
    return { uf, ym, status: "exists" };
  }

  console.log(`\n[${uf} ${ym}]`);
  const z = await downloadZip(uf, ym);
  const data = await aggregateZip(uf, ym, z);
  writeJson(uf, ym, data);

  if (!options.keepZip) {
    try { fs.unlinkSync(z); } catch {}
  }

  return { uf, ym, status: "ok" };
}

async function main() {
  ensureDirs();
  const opts = parseArgs(process.argv.slice(2));

  console.log(`Destino: ${DATA_DIR}`);
  console.log(`UFs: ${opts.ufs.join(", ")}`);
  console.log(`Competências: ${opts.months.join(", ")}`);

  const results = [];

  for (const uf of opts.ufs) {
    for (const ym of opts.months) {
      try {
        results.push(await processOne(uf, ym, opts));
      } catch (e) {
        console.error(`  ERRO em ${uf} ${ym}: ${e.message}`);
        results.push({ uf, ym, status: "error", message: e.message });
      }
    }
  }

  const ok = results.filter(r => r.status === "ok").length;
  const exists = results.filter(r => r.status === "exists").length;
  const errors = results.filter(r => r.status === "error");

  console.log(`\nConcluído. Gerados: ${ok}; já existentes: ${exists}; erros: ${errors.length}.`);

  if (errors.length) {
    console.log("\nErros:");
    for (const e of errors) console.log(`- ${e.uf} ${e.ym}: ${e.message}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
