import express from "express";
import ffmpegPath from "ffmpeg-static";
import { execFile } from "child_process";
const app = express();

app.use(express.json({ limit: "24mb" }));
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
async function gerarAudioGemini(texto) {
  if (!process.env.GEMINI_API_KEY) {
    const erro = new Error("GEMINI_API_KEY não configurada.");
    erro.status = 500;
    throw erro;
  }

  const modelos = ["gemini-3.8-flash-lite-tts", "gemini-3.8-flash-tts"];
  let ultimoErro = null;

  for (const modelo of modelos) {
    for (let tentativa = 1; tentativa <= 2; tentativa++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 45000);

      try {
        console.log(`[TTS] Iniciando ${modelo} - tentativa ${tentativa}`);

        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": process.env.GEMINI_API_KEY
            },
            signal: controller.signal,
            body: JSON.stringify({
              contents: [{
                role: "user",
                parts: [{ text: texto }]
              }],
              generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: {
                  voiceConfig: { voice: "Kore" }
                }
              }
            })
          }
        );

        clearTimeout(timeout);
        const textoResposta = await response.text();
        let data = {};
        try { data = textoResposta ? JSON.parse(textoResposta) : {}; } catch {}

        if (!response.ok) {
          const mensagem = data?.error?.message || `Gemini TTS respondeu HTTP ${response.status}`;
          console.error(`[TTS] ${modelo} HTTP ${response.status}:`, mensagem);
          ultimoErro = Object.assign(new Error(mensagem), {
            status: response.status,
            detalhes: data
          });

          if (response.status === 408 || response.status === 429 || response.status >= 500) {
            await esperar(1000 * tentativa);
            continue;
          }
          throw ultimoErro;
        }

        const parteAudio = data?.candidates?.[0]?.content?.parts?.find(
          parte => parte.inlineData?.data || parte.inline_data?.data
        );
        const inline = parteAudio?.inlineData || parteAudio?.inline_data;

        if (!inline?.data) {
          console.error(`[TTS] ${modelo} respondeu sem áudio.`, JSON.stringify(data).slice(0, 1200));
          ultimoErro = Object.assign(new Error("O Gemini respondeu, mas não retornou áudio."), { status: 502 });
          continue;
        }

        console.log(`[TTS] Áudio recebido com sucesso de ${modelo}.`);
        return {
          audio: inline.data,
          mimeType: inline.mimeType || inline.mime_type || "audio/wav"
        };
      } catch (error) {
        clearTimeout(timeout);

        const causa = error?.cause || {};
        const detalhesRede = [
          `nome=${error?.name || "Erro"}`,
          `mensagem=${error?.message || "sem mensagem"}`,
          causa?.code ? `code=${causa.code}` : "",
          causa?.errno ? `errno=${causa.errno}` : "",
          causa?.address ? `address=${causa.address}` : ""
        ].filter(Boolean).join(" | ");

        console.error(`[TTS] Falha em ${modelo}, tentativa ${tentativa}: ${detalhesRede}`);
        ultimoErro = error;

        if (error?.name === "AbortError") {
          ultimoErro = Object.assign(new Error("A geração de voz demorou mais de 45 segundos."), { status: 504 });
        } else if (error?.message === "fetch failed") {
          ultimoErro = Object.assign(new Error("Falha de conexão entre o servidor e o Gemini TTS."), {
            status: 503,
            detalhesRede
          });
        }

        if (tentativa < 2) {
          await esperar(1500 * tentativa);
          continue;
        }
      }
    }
  }

  throw ultimoErro || Object.assign(new Error("Não foi possível gerar a narração."), { status: 503 });
}

// GERAR NARRAÇÃO COM GEMINI
app.post("/api/narracao", async (req, res) => {
  try {
    const { texto } = req.body;
    if (!texto) return res.status(400).json({ error: "Texto da narração não informado." });
    const resultado = await gerarAudioGemini(texto);
    res.json(resultado);
  } catch (error) {
    console.error("Erro na narração:", error.detalhes || error);
    res.status(error.status || 500).json({ error: error.message || "Erro interno ao gerar narração." });
  }
});

app.post("/api/video", async (req, res) => {
  let caminhoImagem = null;
  let caminhoAudio = null;
  let caminhoVideo = null;
  let caminhosLegendas = [];

  try {
    let { roteiro, imagem, audio, audioMimeType, textoNarracao, legendas = [] } = req.body;

    if (!roteiro) return res.status(400).json({ error: "Roteiro não recebido." });
    if (!imagem || typeof imagem !== "string") {
      return res.status(400).json({ error: "Escolha uma foto do produto para gerar o vídeo." });
    }
    if (!audio || typeof audio !== "string") {
      // O servidor não depende mais do navegador enviar textoNarracao.
      // Se ele não vier, extraímos a seção NARRAÇÃO diretamente do roteiro.
      let textoParaVoz = String(textoNarracao || "").trim();

      if (!textoParaVoz) {
        const roteiroTexto = String(roteiro || "");
        const marcadorNarracao = "NARRAÇÃO:";
        const marcadorCenas = "CENAS:";
        const inicioNarracao = roteiroTexto.indexOf(marcadorNarracao);
        const inicioCenas = roteiroTexto.indexOf(marcadorCenas);

        if (inicioNarracao !== -1) {
          const inicio = inicioNarracao + marcadorNarracao.length;
          textoParaVoz = (inicioCenas !== -1 && inicioCenas > inicioNarracao
            ? roteiroTexto.substring(inicio, inicioCenas)
            : roteiroTexto.substring(inicio)).trim();
        }
      }

      // Último fallback: usa o próprio roteiro para nunca falhar por campo ausente.
      if (!textoParaVoz) textoParaVoz = String(roteiro || "").trim();

      const voz = await gerarAudioGemini(textoParaVoz);
      audio = voz.audio;
      audioMimeType = voz.mimeType;
    }

    const correspondencia = imagem.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
    if (!correspondencia) {
      return res.status(400).json({ error: "Formato de imagem inválido. Use JPG, PNG ou WEBP." });
    }

    const mimeType = correspondencia[1];
    const extensoes = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
    const id = Date.now();
    caminhoImagem = `/tmp/produto-${id}.${extensoes[mimeType]}`;
    caminhoVideo = `/tmp/video-${id}.mp4`;

    const tipoAudio = String(audioMimeType || "audio/L16;rate=24000").toLowerCase();
    const audioEhPCM = tipoAudio.includes("l16") || tipoAudio.includes("pcm");
    const extensaoAudio = tipoAudio.includes("wav") ? "wav" : tipoAudio.includes("mpeg") || tipoAudio.includes("mp3") ? "mp3" : "pcm";
    caminhoAudio = `/tmp/narracao-${id}.${extensaoAudio}`;

    const { writeFile, unlink } = await import("fs");
    const bufferImagem = Buffer.from(correspondencia[2], "base64");
    const bufferAudio = Buffer.from(audio, "base64");

    if (bufferImagem.length > 8 * 1024 * 1024) {
      return res.status(413).json({ error: "A foto deve ter no máximo 8 MB." });
    }
    if (bufferAudio.length > 10 * 1024 * 1024) {
      return res.status(413).json({ error: "A narração ficou grande demais." });
    }

    const legendasValidas = Array.isArray(legendas)
      ? legendas.slice(0, 24).filter(item =>
          item &&
          typeof item.imagem === "string" &&
          /^data:image\/png;base64,/.test(item.imagem) &&
          Number.isFinite(Number(item.inicio)) &&
          Number.isFinite(Number(item.fim)) &&
          Number(item.fim) > Number(item.inicio)
        )
      : [];

    caminhosLegendas = legendasValidas.map((_, indice) => `/tmp/legenda-${id}-${indice}.png`);

    const gravacoes = [
      new Promise((resolve, reject) => writeFile(caminhoImagem, bufferImagem, e => e ? reject(e) : resolve())),
      new Promise((resolve, reject) => writeFile(caminhoAudio, bufferAudio, e => e ? reject(e) : resolve()))
    ];

    legendasValidas.forEach((item, indice) => {
      const base64 = item.imagem.replace(/^data:image\/png;base64,/, "");
      gravacoes.push(
        new Promise((resolve, reject) =>
          writeFile(caminhosLegendas[indice], Buffer.from(base64, "base64"), e => e ? reject(e) : resolve())
        )
      );
    });

    await Promise.all(gravacoes);

    const argumentos = ["-loop", "1", "-i", caminhoImagem];
    if (audioEhPCM) {
      argumentos.push("-f", "s16le", "-ar", "24000", "-ac", "1", "-i", caminhoAudio);
    } else {
      argumentos.push("-i", caminhoAudio);
    }

    // Cada legenda já chega como uma imagem PNG transparente pronta.
    // Isso evita drawtext/subtitles e preserva a montagem que já funcionava.
    caminhosLegendas.forEach(caminho => {
      argumentos.push("-loop", "1", "-i", caminho);
    });

    const filtros = [
      "[0:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,zoompan=z='min(zoom+0.0008,1.10)':d=720:s=720x1280:fps=24,format=yuv420p[base]"
    ];

    let anterior = "base";
    legendasValidas.forEach((item, indice) => {
      const saida = indice === legendasValidas.length - 1 ? "vout" : `v${indice}`;
      const inicio = Math.max(0, Number(item.inicio)).toFixed(2);
      const fim = Math.max(Number(item.inicio), Number(item.fim)).toFixed(2);
      filtros.push(
        `[${indice + 2}:v]format=rgba[ov${indice}];` +
        `[${anterior}][ov${indice}]overlay=0:0:enable='between(t,${inicio},${fim})'[${saida}]`
      );
      anterior = saida;
    });

    if (!legendasValidas.length) {
      filtros.push("[base]null[vout]");
    }

    argumentos.push(
      "-filter_complex", filtros.join(";"),
      "-map", "[vout]",
      "-map", "1:a",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "28",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "96k",
      "-shortest",
      "-movflags", "+faststart",
      "-y", caminhoVideo
    );

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

    res.download(caminhoVideo, "video-tiktok-completo.mp4", erroDownload => {
      unlink(caminhoImagem, () => {});
      unlink(caminhoAudio, () => {});
      caminhosLegendas.forEach(caminho => unlink(caminho, () => {}));
      unlink(caminhoVideo, () => {});
      if (erroDownload && !res.headersSent) {
        res.status(500).json({ error: "Erro ao enviar o vídeo." });
      }
    });
  } catch (error) {
    console.error("Erro ao gerar vídeo completo:", error);
    const { unlink } = await import("fs");
    if (caminhoImagem) unlink(caminhoImagem, () => {});
    if (caminhoAudio) unlink(caminhoAudio, () => {});
    caminhosLegendas.forEach(caminho => unlink(caminho, () => {}));
    if (caminhoVideo) unlink(caminhoVideo, () => {});
    if (!res.headersSent) {
      const status = error.status || 500;
      res.status(status).json({
        error: error.message || "Erro ao montar o vídeo completo."
      });
    }
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor ativo na porta ${PORT}`);
});
