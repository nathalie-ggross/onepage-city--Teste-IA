export default async function handler(req, res) {
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

    const apiKey = process.env.GROQ_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
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
              content: `
Você é um consultor executivo de inteligência de mercado em saúde privada.

Responda em português do Brasil.
Gere exatamente 2 parágrafos.
Cada parágrafo deve ter no máximo 3 frases.
Não use tópicos.
Não use markdown.
Não invente dados.
Não recalcule indicadores.
Use apenas os dados enviados.
A análise deve ser objetiva, executiva e útil para decisão de priorização.
              `.trim()
            },
            {
              role: "user",
              content: prompt
            }
          ],
          temperature: 0.25,
          max_tokens: 380
        })
      }
    );

    const json = await resposta.json();

    if (!resposta.ok) {
      return res.status(resposta.status).json({
        erro: "Erro retornado pela Groq.",
        status: resposta.status,
        detalhe: json
      });
    }

    const texto =
      json?.choices?.[0]?.message?.content?.trim() || "";

    if (!texto) {
      return res.status(500).json({
        erro: "A Groq respondeu, mas não retornou texto utilizável.",
        detalhe: json
      });
    }

    return res.status(200).json({
      texto
    });

  } catch (erro) {
    return res.status(500).json({
      erro: "Erro interno ao gerar diagnóstico com Groq.",
      detalhe: erro.message
    });
  }
}
