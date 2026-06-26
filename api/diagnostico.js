export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      rota: "/api/diagnostico",
      gemini_key_configurada: Boolean(process.env.GEMINI_API_KEY),
      gemini_key_prefixo: process.env.GEMINI_API_KEY
        ? process.env.GEMINI_API_KEY.slice(0, 4)
        : null
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      erro: "Método não permitido. Use POST."
    });
  }

  try {
    const { prompt } = req.body || {};

    if (!prompt) {
      return res.status(400).json({
        erro: "Prompt não enviado."
      });
    }

    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        erro: "GEMINI_API_KEY não configurada na Vercel."
      });
    }

    const resposta = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: prompt
                }
              ]
            }
          ],
          generationConfig: {
            temperature: 0.25,
            maxOutputTokens: 450
          }
        })
      }
    );

    const json = await resposta.json();

    if (!resposta.ok) {
      return res.status(resposta.status).json({
        erro: "Erro retornado pelo Gemini.",
        status: resposta.status,
        detalhe: json
      });
    }

    const texto = json?.candidates?.[0]?.content?.parts
      ?.map((parte) => parte.text || "")
      ?.join("")
      ?.trim();

    if (!texto) {
      return res.status(500).json({
        erro: "O Gemini respondeu, mas não retornou texto utilizável.",
        detalhe: json
      });
    }

    return res.status(200).json({
      texto
    });

  } catch (erro) {
    return res.status(500).json({
      erro: "Erro interno na API de diagnóstico.",
      detalhe: erro.message
    });
  }
}
