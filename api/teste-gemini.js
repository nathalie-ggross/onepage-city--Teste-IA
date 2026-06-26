export default async function handler(req, res) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        ok: false,
        erro: "GEMINI_API_KEY não configurada."
      });
    }

    const resposta = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: "Responda apenas: teste ok"
                }
              ]
            }
          ],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 20
          }
        })
      }
    );

    const json = await resposta.json();

    if (!resposta.ok) {
      return res.status(resposta.status).json({
        ok: false,
        status: resposta.status,
        erro: "Erro retornado pelo Gemini.",
        detalhe: json
      });
    }

    const texto = json?.candidates?.[0]?.content?.parts
      ?.map((parte) => parte.text || "")
      ?.join("")
      ?.trim();

    return res.status(200).json({
      ok: true,
      texto,
      key_prefixo: apiKey.slice(0, 4),
      key_final: apiKey.slice(-4),
      key_tamanho: apiKey.length
    });

  } catch (erro) {
    return res.status(500).json({
      ok: false,
      erro: "Erro interno.",
      detalhe: erro.message
    });
  }
}
