export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({
      erro: "Método não permitido"
    });
  }

  try {

    const { prompt } = req.body;

    const resposta = await fetch(
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

    const json = await resposta.json();

    const texto =
      json.candidates?.[0]?.content?.parts?.[0]?.text ||
      "Não foi possível gerar o diagnóstico.";

    return res.status(200).json({
      texto
    });

  } catch (erro) {

    console.error(erro);

    return res.status(500).json({
      erro: erro.message
    });

  }

}
