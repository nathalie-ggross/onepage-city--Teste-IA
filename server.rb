#!/usr/bin/env ruby
# Servidor local: serve arquivos estáticos + proxies para CNES e ANS (que não liberam CORS).
require "webrick"
require "net/http"
require "uri"
require "json"
require "csv"
require "fileutils"
require "shellwords"
require "date"

ROOT  = File.expand_path(File.dirname(__FILE__))
CACHE = File.join(ROOT, ".cache")
FileUtils.mkdir_p(CACHE)
PORT = (ENV["PORT"] || 8765).to_i

# ==========================================================
# ANS helpers — baixa ZIP da UF, extrai CSV, agrega por cidade.
# Cacheia o JSON agregado por UF+mês.
# ==========================================================

ANS_BASE = "https://dadosabertos.ans.gov.br/FTP/PDA/informacoes_consolidadas_de_beneficiarios-024"

def http_get(url, timeout: 90)
  uri = URI(url)
  http = Net::HTTP.new(uri.host, uri.port)
  http.use_ssl = uri.scheme == "https"
  http.open_timeout = 15
  http.read_timeout = timeout
  http.get(uri.request_uri, { "User-Agent" => "pesquisa-cidade/1.0" })
end

def ans_latest_month
  # Tenta mês atual e vai voltando. Retorna "AAAAMM" quando acha.
  today = Date.today
  6.times.map { |i| (today << i).strftime("%Y%m") }
end

def ans_process_month(uf, ym)
  cache_json = File.join(CACHE, "ans_#{uf}_#{ym}.json")
  return JSON.parse(File.read(cache_json)) if File.exist?(cache_json)
  yyyy = ym[0,4]; mm = ym[4,2]
  url = "#{ANS_BASE}/#{ym}/pda-024-icb-#{uf}-#{yyyy}_#{mm}.zip"
  zip_path = File.join(CACHE, "ans_#{uf}_#{ym}.zip")
  unless File.exist?(zip_path)
    puts "[ANS] baixando #{url}"
    res = http_get(url, timeout: 180)
    return nil if res.code.to_i != 200
    File.binwrite(zip_path, res.body)
  end
  csv_path = File.join(CACHE, "ans_#{uf}_#{ym}.csv")
  unless File.exist?(csv_path)
    system("cd #{Shellwords.escape(CACHE)} && unzip -o #{Shellwords.escape(File.basename(zip_path))} >/dev/null")
    found = Dir[File.join(CACHE, "pda-024-icb-#{uf}-*.csv")].first
    FileUtils.mv(found, csv_path) if found
  end
  return nil unless File.exist?(csv_path)
  json = ans_aggregate(csv_path, uf, ym)
  File.write(cache_json, JSON.generate(json))
  File.delete(csv_path) if File.exist?(csv_path)
  json
end

def ans_fetch_uf(uf)
  uf = uf.upcase
  months = ans_latest_month
  for ym in months
    data = ans_process_month(uf, ym)
    return data if data
  end
  raise "ANS: não foi possível obter dados para UF #{uf}"
end

# Retorna série temporal: [{month, total, mh, odonto}] para um código de município (ou soma de códigos)
# Varre TODOS os JSONs cacheados para o UF — permite séries longas quando o operador pre-popula meses.
def ans_history(uf, cods)
  uf = uf.upcase
  files = Dir[File.join(CACHE, "ans_#{uf}_*.json")]
  series = []
  files.each do |f|
    ym = File.basename(f).scan(/ans_#{uf}_(\d{6})\.json/).flatten.first
    next unless ym
    data = JSON.parse(File.read(f)) rescue next
    tot = 0; mh = 0; od = 0
    cods.each do |cod|
      c = data["byCity"][cod]; next unless c
      tot += c["total"]; mh += c["mh"]; od += c["odonto"]
    end
    series << { "month" => ym, "total" => tot, "mh" => mh, "odonto" => od }
  end
  series.sort_by { |s| s["month"] }
end

# Retorna hash: { month, byCity: { codMun => { total, mh, odonto, operadoras: {razao => {modalidade, beneficiarios, mh}} } } }
def ans_aggregate(csv_path, uf, ym)
  result = { "month" => ym, "uf" => uf, "byCity" => {} }
  File.open(csv_path, "r:UTF-8") do |f|
    header = nil
    idx = {}
    f.each_line do |line|
      row = CSV.parse_line(line, col_sep: ";", quote_char: '"') rescue nil
      next unless row
      if header.nil?
        header = row
        header.each_with_index { |h, i| idx[h.to_s.strip] = i }
        next
      end
      cod = row[idx["CD_MUNICIPIO"]]
      next unless cod
      razao = row[idx["NM_RAZAO_SOCIAL"]].to_s.strip
      modalidade = row[idx["MODALIDADE_OPERADORA"]].to_s.strip
      cobertura = row[idx["COBERTURA_ASSIST_PLAN"]].to_s.strip.downcase
      ativos = row[idx["QT_BENEFICIARIO_ATIVO"]].to_i
      next if ativos <= 0

      is_odonto = cobertura.start_with?("odont")
      city = result["byCity"][cod] ||= { "total" => 0, "mh" => 0, "odonto" => 0, "operadoras" => {} }
      city["total"] += ativos
      is_odonto ? city["odonto"] += ativos : city["mh"] += ativos
      op = city["operadoras"][razao] ||= { "modalidade" => modalidade, "beneficiarios" => 0, "mh" => 0, "odonto" => 0 }
      op["beneficiarios"] += ativos
      is_odonto ? op["odonto"] += ativos : op["mh"] += ativos
    end
  end
  result
end

# ==========================================================
# LEITOS (CNES) — OpenDataSUS / CKAN
# Download 1x do CSV anual, cache em JSON indexado por código IBGE.
# ==========================================================

LEITOS_URL_TEMPLATE = "https://s3.sa-east-1.amazonaws.com/ckan.saude.gov.br/Leitos_SUS/Leitos_csv_%d.zip"

def leitos_load(year = nil)
  year ||= Date.today.year
  json_cache = File.join(CACHE, "leitos_#{year}.json")
  return JSON.parse(File.read(json_cache)) if File.exist?(json_cache)

  zip_path = File.join(CACHE, "leitos_#{year}.zip")
  unless File.exist?(zip_path)
    url = LEITOS_URL_TEMPLATE % year
    puts "[LEITOS] baixando #{url}"
    res = http_get(url, timeout: 120)
    if res.code.to_i != 200
      # fallback: ano anterior
      return leitos_load(year - 1) if year > 2022
      raise "LEITOS: não foi possível baixar CSV (HTTP #{res.code})"
    end
    File.binwrite(zip_path, res.body)
  end

  csv_path = File.join(CACHE, "leitos_#{year}_final.csv")
  unless File.exist?(csv_path)
    system("cd #{Shellwords.escape(CACHE)} && unzip -o #{Shellwords.escape(File.basename(zip_path))} >/dev/null")
    found = Dir[File.join(CACHE, "Leitos_*#{year}.csv")].first
    FileUtils.mv(found, csv_path) if found
  end
  raise "LEITOS: CSV não extraído" unless File.exist?(csv_path)

  # Indexa: { cod_ibge6 => [ {cnes, nome, razao, tipo, natureza, bairro, leitos_existentes, leitos_sus, leitos_priv, uti_total, uti_sus, uti_adulto, uti_ped, uti_neo, comp} ] }
  # Mantém apenas a competência MAIS RECENTE por CNES.
  byCnes = {} # cnes => row
  File.open(csv_path, "r:ISO-8859-1") do |f|
    header = nil; idx = {}
    f.each_line do |raw|
      line = raw.encode("UTF-8", invalid: :replace, undef: :replace)
      row = CSV.parse_line(line, col_sep: ";", quote_char: '"') rescue nil
      next unless row
      if header.nil?
        header = row
        header.each_with_index { |h, i| idx[h.to_s.strip] = i }
        next
      end
      comp = row[idx["COMP"]].to_s
      cnes = row[idx["CNES"]].to_s.strip
      next if cnes.empty?
      cur = byCnes[cnes]
      next if cur && cur["comp"] >= comp  # só a mais recente
      co_ibge = row[idx["CO_IBGE"]].to_s.strip
      le = row[idx["LEITOS_EXISTENTES"]].to_i
      ls = row[idx["LEITOS_SUS"]].to_i
      byCnes[cnes] = {
        "comp" => comp,
        "cnes" => cnes,
        "cod_ibge" => co_ibge,
        "nome" => row[idx["NOME_ESTABELECIMENTO"]].to_s.strip,
        "razao" => row[idx["RAZAO_SOCIAL"]].to_s.strip,
        "tipo" => row[idx["DS_TIPO_UNIDADE"]].to_s.strip,
        "natureza" => row[idx["DESC_NATUREZA_JURIDICA"]].to_s.strip,
        "bairro" => row[idx["NO_BAIRRO"]].to_s.strip,
        "endereco" => row[idx["NO_LOGRADOURO"]].to_s.strip,
        "numero" => row[idx["NU_ENDERECO"]].to_s.strip,
        "leitos_existentes" => le,
        "leitos_sus" => ls,
        "leitos_privados" => [le - ls, 0].max,
        "uti_total" => row[idx["UTI_TOTAL_EXIST"]].to_i,
        "uti_sus" => row[idx["UTI_TOTAL_SUS"]].to_i,
        "uti_adulto" => row[idx["UTI_ADULTO_EXIST"]].to_i,
        "uti_ped" => row[idx["UTI_PEDIATRICO_EXIST"]].to_i,
        "uti_neo" => row[idx["UTI_NEONATAL_EXIST"]].to_i,
        "uti_cor" => row[idx["UTI_CORONARIANA_EXIST"]].to_i,
        "uti_queimado" => row[idx["UTI_QUEIMADO_EXIST"]].to_i,
      }
    end
  end

  # Agrupa por município
  byCity = {}
  byCnes.each_value do |r|
    (byCity[r["cod_ibge"]] ||= []) << r
  end

  data = { "year" => year, "comp_max" => byCnes.values.map { |r| r["comp"] }.max, "byCity" => byCity }
  File.write(json_cache, JSON.generate(data))
  File.delete(csv_path) if File.exist?(csv_path)
  data
end

# ==========================================================
# ELASTICNES — consulta Elasticsearch pública via proxy Kibana.
# https://elasticnes.saude.gov.br/leitos
# ==========================================================

ELASTIC_BASE = "https://elasticnes.saude.gov.br/kibana/internal/search/es"

def normalize_text(s)
  s.to_s.unicode_normalize(:nfd).gsub(/[^\w\s]/, "").downcase.strip.gsub(/\s+/, " ")
rescue
  s.to_s.downcase.strip
end


def elastic_search(index, body)
  uri = URI(ELASTIC_BASE)
  http = Net::HTTP.new(uri.host, uri.port)
  http.use_ssl = true
  http.open_timeout = 10
  http.read_timeout = 60
  req = Net::HTTP::Post.new(uri.request_uri, {
    "Content-Type" => "application/json",
    "kbn-xsrf" => "true",
    "User-Agent" => "pesquisa-cidade/1.0",
  })
  req.body = JSON.generate({ "params" => { "index" => index, "body" => body } })
  res = http.request(req)
  raise "elastic #{res.code}" unless res.code.to_i == 200
  JSON.parse(res.body)
end

def elastic_latest_comp(prefix = "cnes-leitosh")
  # Testa 6 últimos meses — retorna o primeiro índice que responde com docs.
  today = Date.today
  6.times.each do |i|
    ym = (today << i).strftime("%Y%m")
    begin
      r = elastic_search("#{prefix}-#{ym}", { "size" => 0 })
      tot = r.dig("rawResponse", "hits", "total")
      tot = tot.is_a?(Hash) ? tot["value"] : tot
      return ym if tot && tot > 0
    rescue
    end
  end
  nil
end

def elastic_leitos_city(cod6, comp = nil)
  comp ||= @elastic_comp ||= elastic_latest_comp("cnes-leitosh")
  raise "elastic: sem competência disponível" unless comp
  cache_file = File.join(CACHE, "elastic_leitos_#{cod6}_#{comp}.json")
  return JSON.parse(File.read(cache_file)) if File.exist?(cache_file)

  # pega todos os leitos do município — apenas estabelecimentos ATIVOS
  body = {
    "size" => 2000,
    "query" => { "bool" => { "filter" => [
      { "term" => { "CÓDIGO DO MUNICÍPIO.keyword" => cod6 } },
      { "term" => { "STATUS DO ESTABELECIMENTO.keyword" => "ATIVO" } },
    ]}},
    "_source" => [
      "CNES","NOME FANTASIA","RAZÃO SOCIAL","TIPO DO ESTABELECIMENTO","TIPO NOVO DO ESTABELECIMENTO",
      "NATUREZA JURÍDICA CATEGORIA","CATEGORIA NATUREZA JURÍDICA",
      "BAIRRO","LOGRADOURO","TELEFONE","E-MAIL","location",
      "LEITO","TIPO DO LEITO","LEITOS EXISTENTES","LEITOS SUS",
      "LEITOS EXISTENTES (TOTAL)","LEITOS SUS (TOTAL)",
      "STATUS DO ESTABELECIMENTO","COMPETÊNCIA"
    ],
  }
  r = elastic_search("cnes-leitosh-#{comp}", body)
  hits = r.dig("rawResponse", "hits", "hits") || []

  # Agrupa por CNES
  byCnes = {}
  hits.each do |h|
    s = h["_source"]
    cnes = s["CNES"].to_s
    next if cnes.empty?
    hosp = byCnes[cnes] ||= {
      "cnes" => cnes,
      "nome" => s["NOME FANTASIA"].to_s.strip,
      "razao" => s["RAZÃO SOCIAL"].to_s.strip,
      "tipo" => s["TIPO DO ESTABELECIMENTO"].to_s.strip,
      "tipo_novo" => s["TIPO NOVO DO ESTABELECIMENTO"].to_s.strip,
      "natureza" => s["NATUREZA JURÍDICA CATEGORIA"].to_s.strip,
      "natureza_cat" => s["CATEGORIA NATUREZA JURÍDICA"].to_s.strip,
      "bairro" => s["BAIRRO"].to_s.strip,
      "endereco" => s["LOGRADOURO"].to_s.strip,
      "telefone" => s["TELEFONE"].to_s.strip,
      "email" => s["E-MAIL"].to_s.strip,
      "location" => s["location"],
      "leitos_total" => s["LEITOS EXISTENTES (TOTAL)"].to_i,
      "leitos_sus_total" => s["LEITOS SUS (TOTAL)"].to_i,
      "status" => s["STATUS DO ESTABELECIMENTO"].to_s,
      "comp" => s["COMPETÊNCIA"].to_s,
      "leitos" => [],
    }
    hosp["leitos"] << {
      "tipo" => s["LEITO"].to_s,
      "categoria" => s["TIPO DO LEITO"].to_s,
      "existentes" => s["LEITOS EXISTENTES"].to_i,
      "sus" => s["LEITOS SUS"].to_i,
    }
  end

  # Normaliza: privados = total - sus + agrupa leitos por tipo
  byCnes.each do |_, h|
    h["leitos_privados_total"] = [h["leitos_total"] - h["leitos_sus_total"], 0].max
    agg = {}
    h["leitos"].each do |lt|
      key = lt["tipo"]
      cur = agg[key] ||= { "tipo" => key, "categoria" => lt["categoria"], "existentes" => 0, "sus" => 0 }
      cur["existentes"] += lt["existentes"]
      cur["sus"] += lt["sus"]
    end
    agg.each_value { |v| v["privados"] = [v["existentes"] - v["sus"], 0].max }
    h["leitos"] = agg.values.sort_by { |v| -v["existentes"] }
  end

  # Consolida cadastros CNES do MESMO complexo hospitalar (mesmo nome + mesma razão social).
  # Casos típicos: hospital principal + ala privativa + maternidade com cadastros separados.
  # Mantém o CNES com MAIS leitos como "principal" (pra buscar serviços) e lista os outros em "unidades".
  consolidated = {}
  byCnes.each_value do |h|
    key = [normalize_text(h["nome"]), normalize_text(h["razao"])].join("|")
    cur = consolidated[key]
    if cur.nil?
      consolidated[key] = h.merge(
        "cnes_unidades" => [h["cnes"]],
        "num_unidades" => 1,
        "__primary_leitos" => h["leitos_total"], # inicializa para comparação posterior
      )
    else
      # Merge totais
      cur["leitos_total"] += h["leitos_total"]
      cur["leitos_sus_total"] += h["leitos_sus_total"]
      cur["leitos_privados_total"] += h["leitos_privados_total"]
      # Merge lista de leitos por tipo
      map = {}
      (cur["leitos"] + h["leitos"]).each do |lt|
        k = lt["tipo"]
        m = map[k] ||= { "tipo" => k, "categoria" => lt["categoria"], "existentes" => 0, "sus" => 0, "privados" => 0 }
        m["existentes"] += lt["existentes"]; m["sus"] += lt["sus"]; m["privados"] += lt["privados"]
      end
      cur["leitos"] = map.values.sort_by { |v| -v["existentes"] }
      cur["cnes_unidades"] << h["cnes"]
      cur["num_unidades"] += 1
      # Se a nova unidade tem mais leitos, vira a principal (endereço/coordenadas/cnes de referência)
      if h["leitos_total"] > (cur["__primary_leitos"] || 0)
        %w[cnes bairro endereco telefone email location tipo tipo_novo natureza natureza_cat].each { |k| cur[k] = h[k] }
        cur["__primary_leitos"] = h["leitos_total"]
      end
    end
  end

  hospitais = consolidated.values.each { |h| h.delete("__primary_leitos") }.sort_by { |h| -h["leitos_total"] }
  totais = {
    "existentes" => hospitais.sum { |h| h["leitos_total"] },
    "sus" => hospitais.sum { |h| h["leitos_sus_total"] },
    "privados" => hospitais.sum { |h| h["leitos_privados_total"] },
  }
  out = { "comp" => comp, "hospitais" => hospitais, "totais" => totais }
  File.write(cache_file, JSON.generate(out))
  out
end

def elastic_servicos_hospital(cod6, cnes, comp = nil)
  comp ||= @elastic_comp ||= elastic_latest_comp("cnes-leitosh")
  cache_file = File.join(CACHE, "elastic_servicos_#{cod6}_#{cnes}_#{comp}.json")
  return JSON.parse(File.read(cache_file)) if File.exist?(cache_file)
  body = {
    "size" => 500,
    "query" => { "bool" => { "filter" => [
      { "term" => { "CNES.keyword" => cnes } },
    ]}},
    "_source" => [
      "SERVIÇO - DESCRIÇÃO", "SERVIÇO CLASSIFICAÇÃO - DESCRIÇÃO",
      "SERVIÇO - AMBULATORIAL SUS", "SERVIÇO - AMBULATORIAL NÃO SUS",
      "SERVIÇO - HOSPITALAR SUS", "SERVIÇO - HOSPITALAR NÃO SUS",
    ],
  }
  begin
    r = elastic_search("cnes-servicos-#{comp}", body)
    hits = r.dig("rawResponse", "hits", "hits") || []
    grouped = {}
    hits.each do |h|
      s = h["_source"]
      key = s["SERVIÇO - DESCRIÇÃO"].to_s
      next if key.empty?
      g = grouped[key] ||= { "servico" => key, "classificacoes" => [], "sus" => false, "nao_sus" => false }
      cls = s["SERVIÇO CLASSIFICAÇÃO - DESCRIÇÃO"].to_s
      g["classificacoes"] << cls if !cls.empty? && !g["classificacoes"].include?(cls)
      g["sus"] = true if s["SERVIÇO - AMBULATORIAL SUS"] == "Sim" || s["SERVIÇO - HOSPITALAR SUS"] == "Sim"
      g["nao_sus"] = true if s["SERVIÇO - AMBULATORIAL NÃO SUS"] == "Sim" || s["SERVIÇO - HOSPITALAR NÃO SUS"] == "Sim"
    end
    out = { "comp" => comp, "servicos" => grouped.values.sort_by { |s| s["servico"] } }
    File.write(cache_file, JSON.generate(out))
    out
  rescue => e
    { "comp" => comp, "servicos" => [], "error" => e.message }
  end
end

# ==========================================================
# WEBrick server
# ==========================================================

server = WEBrick::HTTPServer.new(Port: PORT, BindAddress: "127.0.0.1", DocumentRoot: ROOT)

# Proxy CNES
server.mount_proc "/proxy/cnes" do |req, res|
  qs = req.query_string.to_s
  target = URI("https://apidadosabertos.saude.gov.br/cnes/estabelecimentos?#{qs}")
  begin
    http = Net::HTTP.new(target.host, target.port)
    http.use_ssl = true
    http.open_timeout = 10
    http.read_timeout = 30
    r = http.get(target.request_uri, { "User-Agent" => "pesquisa-cidade/1.0", "Accept" => "application/json" })
    res.status = r.code.to_i
    res["Content-Type"] = r["Content-Type"] || "application/json"
    res["Access-Control-Allow-Origin"] = "*"
    res.body = r.body
  rescue => e
    res.status = 502
    res["Content-Type"] = "application/json"
    res["Access-Control-Allow-Origin"] = "*"
    res.body = %Q({"error":"proxy_error","message":#{e.message.inspect}})
  end
end

# ANS por município: /proxy/ans?uf=RS&cod=431410
# Retorna: { month, total, mh, odonto, operadoras: [...] }
server.mount_proc "/proxy/ans" do |req, res|
  res["Access-Control-Allow-Origin"] = "*"
  res["Content-Type"] = "application/json"
  uf = req.query["uf"].to_s.upcase
  cod = req.query["cod"].to_s
  if uf.empty? || cod.empty?
    res.status = 400; res.body = '{"error":"params uf e cod são obrigatórios"}'; next
  end
  begin
    data = ans_fetch_uf(uf)
    city = data["byCity"][cod] || { "total" => 0, "mh" => 0, "odonto" => 0, "operadoras" => {} }
    ops = city["operadoras"].map { |razao, v|
      { "razao" => razao, "modalidade" => v["modalidade"], "beneficiarios" => v["beneficiarios"], "mh" => v["mh"], "odonto" => v["odonto"] }
    }.sort_by { |o| -o["beneficiarios"] }
    res.body = JSON.generate({ "month" => data["month"], "total" => city["total"], "mh" => city["mh"], "odonto" => city["odonto"], "operadoras" => ops })
  rescue => e
    res.status = 500; res.body = JSON.generate({ "error" => e.message })
  end
end

# ANS histórico: /proxy/ans/history?uf=RS&cods=431410,430060
server.mount_proc "/proxy/ans/history" do |req, res|
  res["Access-Control-Allow-Origin"] = "*"
  res["Content-Type"] = "application/json"
  uf = req.query["uf"].to_s.upcase
  cods = (req.query["cods"] || "").split(",").map(&:strip)
  if uf.empty? || cods.empty?
    res.status = 400; res.body = '{"error":"params uf e cods são obrigatórios"}'; next
  end
  begin
    ans_fetch_uf(uf) # garante que pelo menos o mais recente está cached
    series = ans_history(uf, cods)
    res.body = JSON.generate({ "series" => series })
  rescue => e
    res.status = 500; res.body = JSON.generate({ "error" => e.message })
  end
end

# ANS por lista de municípios (microrregião): /proxy/ans/multi?uf=RS&cods=431410,430060,...
server.mount_proc "/proxy/ans/multi" do |req, res|
  res["Access-Control-Allow-Origin"] = "*"
  res["Content-Type"] = "application/json"
  uf = req.query["uf"].to_s.upcase
  cods = (req.query["cods"] || "").split(",").map(&:strip)
  if uf.empty? || cods.empty?
    res.status = 400; res.body = '{"error":"params uf e cods são obrigatórios"}'; next
  end
  begin
    data = ans_fetch_uf(uf)
    agg_total = 0; agg_mh = 0; agg_odonto = 0
    ops_map = {}
    cities = {}
    cods.each do |cod|
      c = data["byCity"][cod] || { "total" => 0, "mh" => 0, "odonto" => 0, "operadoras" => {} }
      cities[cod] = { "total" => c["total"], "mh" => c["mh"], "odonto" => c["odonto"] }
      agg_total += c["total"]; agg_mh += c["mh"]; agg_odonto += c["odonto"]
      c["operadoras"].each do |razao, v|
        o = ops_map[razao] ||= { "razao" => razao, "modalidade" => v["modalidade"], "beneficiarios" => 0, "mh" => 0, "odonto" => 0 }
        o["beneficiarios"] += v["beneficiarios"]; o["mh"] += v["mh"]; o["odonto"] += v["odonto"]
      end
    end
    ops = ops_map.values.sort_by { |o| -o["beneficiarios"] }
    res.body = JSON.generate({
      "month" => data["month"], "total" => agg_total, "mh" => agg_mh, "odonto" => agg_odonto,
      "operadoras" => ops, "cities" => cities
    })
  rescue => e
    res.status = 500; res.body = JSON.generate({ "error" => e.message })
  end
end

# Leitos por município: /proxy/leitos?cod=431410
server.mount_proc "/proxy/leitos" do |req, res|
  res["Access-Control-Allow-Origin"] = "*"
  res["Content-Type"] = "application/json"
  cod = req.query["cod"].to_s
  if cod.empty?
    res.status = 400; res.body = '{"error":"param cod é obrigatório"}'; next
  end
  begin
    data = leitos_load
    hospitais = (data["byCity"][cod] || []).sort_by { |h| -h["leitos_existentes"] }
    tot_exist = hospitais.sum { |h| h["leitos_existentes"] }
    tot_sus   = hospitais.sum { |h| h["leitos_sus"] }
    tot_priv  = hospitais.sum { |h| h["leitos_privados"] }
    tot_uti   = hospitais.sum { |h| h["uti_total"] }
    tot_uti_sus = hospitais.sum { |h| h["uti_sus"] }
    res.body = JSON.generate({
      "comp" => data["comp_max"], "hospitais" => hospitais,
      "totais" => { "existentes" => tot_exist, "sus" => tot_sus, "privados" => tot_priv, "uti_total" => tot_uti, "uti_sus" => tot_uti_sus }
    })
  rescue => e
    res.status = 500; res.body = JSON.generate({ "error" => e.message })
  end
end

# Leitos agregados por microrregião: /proxy/leitos/multi?cods=431410,430060
server.mount_proc "/proxy/leitos/multi" do |req, res|
  res["Access-Control-Allow-Origin"] = "*"
  res["Content-Type"] = "application/json"
  cods = (req.query["cods"] || "").split(",").map(&:strip).reject(&:empty?)
  if cods.empty?
    res.status = 400; res.body = '{"error":"param cods obrigatório"}'; next
  end
  begin
    data = leitos_load
    hospitais = []
    cods.each { |c| (data["byCity"][c] || []).each { |h| hospitais << h } }
    hospitais.sort_by! { |h| -h["leitos_existentes"] }
    tot_exist = hospitais.sum { |h| h["leitos_existentes"] }
    tot_sus   = hospitais.sum { |h| h["leitos_sus"] }
    tot_priv  = hospitais.sum { |h| h["leitos_privados"] }
    tot_uti   = hospitais.sum { |h| h["uti_total"] }
    tot_uti_sus = hospitais.sum { |h| h["uti_sus"] }
    res.body = JSON.generate({
      "comp" => data["comp_max"], "hospitais" => hospitais,
      "totais" => { "existentes" => tot_exist, "sus" => tot_sus, "privados" => tot_priv, "uti_total" => tot_uti, "uti_sus" => tot_uti_sus }
    })
  rescue => e
    res.status = 500; res.body = JSON.generate({ "error" => e.message })
  end
end

# Elasticnes: leitos por cidade
server.mount_proc "/proxy/elastic/leitos" do |req, res|
  res["Access-Control-Allow-Origin"] = "*"
  res["Content-Type"] = "application/json"
  cod = req.query["cod"].to_s
  if cod.empty?
    res.status = 400; res.body = '{"error":"cod obrigatório"}'; next
  end
  begin
    data = elastic_leitos_city(cod)
    res.body = JSON.generate(data)
  rescue => e
    res.status = 500; res.body = JSON.generate({ "error" => e.message })
  end
end

# Elasticnes: leitos microrregião
server.mount_proc "/proxy/elastic/leitos/multi" do |req, res|
  res["Access-Control-Allow-Origin"] = "*"
  res["Content-Type"] = "application/json"
  cods = (req.query["cods"] || "").split(",").map(&:strip).reject(&:empty?)
  if cods.empty?
    res.status = 400; res.body = '{"error":"cods obrigatório"}'; next
  end
  begin
    hospitais = []
    comp = nil
    cods.each do |c|
      d = elastic_leitos_city(c) rescue nil
      next unless d
      comp ||= d["comp"]
      d["hospitais"].each { |h| hospitais << h.merge("cod_ibge" => c) }
    end
    hospitais.sort_by! { |h| -h["leitos_total"] }
    totais = {
      "existentes" => hospitais.sum { |h| h["leitos_total"] },
      "sus" => hospitais.sum { |h| h["leitos_sus_total"] },
      "privados" => hospitais.sum { |h| h["leitos_privados_total"] },
    }
    res.body = JSON.generate({ "comp" => comp, "hospitais" => hospitais, "totais" => totais })
  rescue => e
    res.status = 500; res.body = JSON.generate({ "error" => e.message })
  end
end

# Elasticnes: serviços/especialidades do hospital
server.mount_proc "/proxy/elastic/servicos" do |req, res|
  res["Access-Control-Allow-Origin"] = "*"
  res["Content-Type"] = "application/json"
  cod = req.query["cod"].to_s
  cnes = req.query["cnes"].to_s
  if cod.empty? || cnes.empty?
    res.status = 400; res.body = '{"error":"cod e cnes obrigatórios"}'; next
  end
  begin
    data = elastic_servicos_hospital(cod, cnes)
    res.body = JSON.generate(data)
  rescue => e
    res.status = 500; res.body = JSON.generate({ "error" => e.message })
  end
end

trap("INT") { server.shutdown }
puts "Servindo em http://127.0.0.1:#{PORT}/"
server.start
