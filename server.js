import express from "express";
import ffmpegPath from "ffmpeg-static";
import { execFile } from "child_process";
const app = express();

app.use(express.json({ limit: "12mb" }));
app.use(express.static("public"));

const esperar = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function chamarGemini(modelo, prompt) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": process.env.GEMINI_API_KEY
    },
    body: JSON.stringify({
      contents: [{
        parts: [{ text: prompt }]
      }]
    })
  });

  const data = await response.json();

  return {
    ok: response.ok,
    status: response.status,
    data
  };
}

app.post("/api/roteiro", async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        error: "GEMINI_API_KEY não configurada."
      });
    }

    const { produto, preco, publico, estilo } = req.body;

    if (!produto) {
      return res.status(400).json({
        error: "Informe o produto."
      });
    }

    const prompt = `
Crie um roteiro de vendas em português do Brasil
para um vídeo de aproximadamente 30 segundos no TikTok/Reels.

Produto: ${produto}
Preço: ${preco || "não informado"}
Público-alvo: ${publico || "geral"}
Estilo: ${estilo || "viral"}

Não invente características, descontos ou garantias
que não foram informados.

Responda neste formato:

GANCHO:
NARRAÇÃO:
CENAS:
LEGENDAS:
CTA:
`;

    // Primeiro tentamos um modelo rápido e econômico.
    const modelos = [
      "gemini-3.5-flash-lite",
      "gemini-3.5-flash",
      "gemini-3.6-flash"
    ];

    let ultimoErro = null;

    for (const modelo of modelos) {

      // Até 3 tentativas por modelo.
      for (let tentativa = 0; tentativa < 3; tentativa++) {

        const resultado = await chamarGemini(modelo, prompt);

        if (resultado.ok) {
          const roteiro =
            resultado.data?.candidates?.[0]?.content?.parts
              ?.map(p => p.text || "")
              .join("") || "";

          if (roteiro) {
            return res.json({
              roteiro,
              modelo
            });
          }
        }

        ultimoErro = resultado;

        // 429 ou erros temporários do servidor:
        // espera e tenta novamente.
        if (
          resultado.status === 429 ||
          resultado.status === 408 ||
          resultado.status >= 500
        ) {
          await esperar(1000 * Math.pow(2, tentativa));
          continue;
        }

        // Erro permanente: não adianta repetir.
        break;
      }
    }

    console.error("Erro Gemini:", ultimoErro?.data);

    return res.status(503).json({
      error:
        ultimoErro?.data?.error?.message ||
        "Gemini temporariamente indisponível. Tente novamente."
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Erro interno ao gerar o roteiro."
    });
  }
});
// GERAR NARRAÇÃO COM GEMINI
app.post("/api/narracao", async (req, res) => {
  try {
    const { texto } = req.body;

    if (!texto) {
      return res.status(400).json({
        error: "Texto da narração não informado."
      });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        error: "GEMINI_API_KEY não configurada."
      });
    }

    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-tts:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": process.env.GEMINI_API_KEY
        },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text:
               texto
            }]
          }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: "Kore"
                }
              }
            }
          }
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("Erro TTS Gemini:", data);

      return res.status(response.status).json({
        error:
          data?.error?.message ||
          "Erro ao gerar narração."
      });
    }

    const parteAudio =
      data?.candidates?.[0]?.content?.parts?.find(
        parte => parte.inlineData?.data
      );

    if (!parteAudio) {
      return res.status(500).json({
        error: "O Gemini não retornou áudio."
      });
    }

    res.json({
      audio: parteAudio.inlineData.data,
      mimeType:
        parteAudio.inlineData.mimeType ||
        "audio/L16;rate=24000"
    });

  } catch (error) {
    console.error("Erro na narração:", error);

    res.status(500).json({
      error: "Erro interno ao gerar narração."
    });
  }
});

app.post("/api/video", async (req, res) => {
  let caminhoImagem = null;
  let caminhoVideo = null;

  try {
    const { roteiro, imagem } = req.body;

    if (!roteiro) {
      return res.status(400).json({ error: "Roteiro não recebido." });
    }

    if (!imagem || typeof imagem !== "string") {
      return res.status(400).json({
        error: "Escolha uma foto do produto para gerar o vídeo."
      });
    }

    const correspondencia = imagem.match(
      /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/
    );

    if (!correspondencia) {
      return res.status(400).json({
        error: "Formato de imagem inválido. Use JPG, PNG ou WEBP."
      });
    }

    const mimeType = correspondencia[1];
    const base64 = correspondencia[2];
    const extensoes = {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp"
    };

    const id = Date.now();
    caminhoImagem = `/tmp/produto-${id}.${extensoes[mimeType]}`;
    caminhoVideo = `/tmp/video-${id}.mp4`;

    const { writeFile, unlink } = await import("fs");
    const bufferImagem = Buffer.from(base64, "base64");

    if (bufferImagem.length > 8 * 1024 * 1024) {
      return res.status(413).json({ error: "A foto deve ter no máximo 8 MB." });
    }

    await new Promise((resolve, reject) => {
      writeFile(caminhoImagem, bufferImagem, erro => {
        if (erro) reject(erro);
        else resolve();
      });
    });

    // Cria um MP4 vertical usando a foto real do produto.
    // O movimento suave (zoom) deixa o resultado mais próximo de um vídeo
    // e não depende do filtro drawtext que falhou no Render.
    const filtro = [
      "scale=900:1600:force_original_aspect_ratio=increase",
      "crop=900:1600",
      "zoompan=z='min(zoom+0.0008,1.10)':d=360:s=720x1280:fps=30",
      "format=yuv420p"
    ].join(",");

    const argumentos = [
      "-loop", "1",
      "-i", caminhoImagem,
      "-vf", filtro,
      "-t", "12",
      "-r", "30",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "25",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-an",
      "-y",
      caminhoVideo
    ];

    await new Promise((resolve, reject) => {
      execFile(ffmpegPath, argumentos, (error, stdout, stderr) => {
        if (error) {
          console.error("FFmpeg stderr:", stderr);
          reject(error);
          return;
        }
        resolve();
      });
    });

    res.download(caminhoVideo, "video-tiktok-produto.mp4", erroDownload => {
      unlink(caminhoImagem, () => {});
      unlink(caminhoVideo, () => {});

      if (erroDownload && !res.headersSent) {
        console.error("Erro no download do vídeo:", erroDownload);
        res.status(500).json({ error: "Erro ao enviar o vídeo." });
      }
    });

  } catch (error) {
    console.error("Erro ao gerar vídeo:", error);

    const { unlink } = await import("fs");
    if (caminhoImagem) unlink(caminhoImagem, () => {});
    if (caminhoVideo) unlink(caminhoVideo, () => {});

    res.status(500).json({
      error: "Erro ao montar o vídeo do produto."
    });
  }
});
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor ativo na porta ${PORT}`);
});
