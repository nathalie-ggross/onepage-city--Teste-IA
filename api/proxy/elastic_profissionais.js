import { medicosPorCidade } from "../_lib/elastic.js";

export default async function handler(req, res) {
  try {
    const ibge = String(req.query.ibge || "").replace(/\D/g, "");
    const comp = req.query.comp ? String(req.query.comp).replace(/\D/g, "") : undefined;

    if (!ibge) {
      return res.status(400).json({
        error: "Informe o parâmetro ibge.",
      });
    }

    const data = await medicosPorCidade(ibge, comp);

    res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=604800");
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({
      error: String(e?.message || e),
    });
  }
}
