export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método não permitido" });
  }

  try {
    const { dados } = req.body;

    const prompt = `
Você é um consultor especialista em mercado hospitalar privado.

Analise os dados abaixo e escreva uma conclusão executiva em até 200 palavras.

Dados:
${dados}
`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
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
          ]
        })
      }
    );

    const json = await response.json();

    const texto =
      json.candidates?.[0]?.content?.parts?.[0]?.text ||
      "Não foi possível gerar o diagnóstico.";

    res.status(200).json({
      diagnostico: texto
    });

  } catch (erro) {
    console.error(erro);

    res.status(500).json({
      error: erro.message
    });
  }
}
