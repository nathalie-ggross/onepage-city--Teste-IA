export default async function handler(req, res) {
  try {
    const apiKey = process.env.GROQ_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        ok: false,
        erro: "GROQ_API_KEY não configurada na Vercel."
      });
    }

    const resposta = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: "llama-3.1-8b-instant",
          messages: [
            {
              role: "system",
              content: "Você é um assistente objetivo. Responda apenas ao que foi pedido."
            },
            {
              role: "user",
              content: "Responda apenas: teste ok"
            }
          ],
          temperature: 0,
          max_tokens: 20
        })
      }
    );

    const json = await resposta.json();

    if (!resposta.ok) {
      return res.status(resposta.status).json({
        ok: false,
        status: resposta.status,
        erro: "Erro retornado pela Groq.",
        detalhe: json
      });
    }

    const texto =
      json?.choices?.[0]?.message?.content?.trim() || "";

    return res.status(200).json({
      ok: true,
      texto,
      key_configurada: true,
      key_prefixo: apiKey.slice(0, 4),
      key_final: apiKey.slice(-4),
      key_tamanho: apiKey.length
    });

  } catch (erro) {
    return res.status(500).json({
      ok: false,
      erro: "Erro interno na rota de teste Groq.",
      detalhe: erro.message
    });
  }
}
