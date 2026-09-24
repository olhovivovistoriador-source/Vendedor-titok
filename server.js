import express from "express";

const app = express();

app.use(express.json());
app.use(express.static("public"));

app.post("/api/roteiro", async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        error: "GEMINI_API_KEY não configurada no servidor."
      });
    }

    const {
      produto,
      preco,
      publico,
      estilo
    } = req.body;

    if (!produto) {
      return res.status(400).json({
        error: "Informe o produto."
      });
    }

    const prompt = `
Crie em português do Brasil um roteiro de aproximadamente 30 segundos
para um vídeo de vendas no TikTok/Reels.

Produto: ${produto}
Preço: ${preco || "não informado"}
Público-alvo: ${publico || "geral"}
Estilo: ${estilo || "viral"}

Não invente características, descontos, garantias ou benefícios
que não foram informados.

Organize a resposta exatamente nestas partes:

GANCHO:
NARRAÇÃO:
CENAS:
LEGENDAS:
CTA:
`;

    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": process.env.GEMINI_API_KEY
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: prompt }]
            }
          ]
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("Erro Gemini:", data);

      return res.status(response.status).json({
        error:
          data?.error?.message ||
          "Erro ao gerar roteiro com Gemini."
      });
    }

    const roteiro =
      data?.candidates?.[0]?.content?.parts
        ?.map(part => part.text || "")
        .join("") || "";

    if (!roteiro) {
      return res.status(500).json({
        error: "O Gemini não retornou um roteiro."
      });
    }

    res.json({ roteiro });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: error.message || "Erro ao gerar roteiro."
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor ativo na porta ${PORT}`);
});
