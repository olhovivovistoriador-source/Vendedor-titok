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


function extrairSecaoRoteiro(roteiro, titulo, proximoTitulo) {
  const texto = String(roteiro || "");
  const inicio = texto.indexOf(titulo);
  if (inicio === -1) return "";
  const de = inicio + titulo.length;
  const fim = proximoTitulo ? texto.indexOf(proximoTitulo, de) : -1;
  return (fim !== -1 ? texto.substring(de, fim) : texto.substring(de)).trim();
}

function tempoASS(segundos) {
  const s = Math.max(0, Number(segundos) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const cs = Math.floor((s - Math.floor(s)) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function limparTextoLegenda(texto) {
  return String(texto || "")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[{}]/g, "")
    .trim();
}

function estimarDuracaoAudio(buffer, tipoAudio, textoNarracao) {
  const tipo = String(tipoAudio || "").toLowerCase();

  // PCM/L16 do Gemini: 24 kHz, mono, 16 bits.
  if (tipo.includes("l16") || tipo.includes("pcm")) {
    return Math.max(1, buffer.length / (24000 * 2));
  }

  // WAV: tenta ler byteRate e o tamanho do chunk data.
  if (tipo.includes("wav") && buffer.length > 44) {
    try {
      const fmt = buffer.indexOf(Buffer.from("fmt "));
      const data = buffer.indexOf(Buffer.from("data"));
      if (fmt >= 0 && data >= 0 && data + 8 <= buffer.length) {
        const byteRate = buffer.readUInt32LE(fmt + 12);
        const dataSize = buffer.readUInt32LE(data + 4);
        if (byteRate > 0 && dataSize > 0) return Math.max(1, dataSize / byteRate);
      }
    } catch (_) {}
  }

  // Fallback para formatos comprimidos.
  const palavras = limparTextoLegenda(textoNarracao).split(/\s+/).filter(Boolean).length;
  return Math.max(6, Math.min(35, palavras * 0.38));
}

function criarLegendasTikTok(textoNarracao, roteiro, duracao) {
  const texto = limparTextoLegenda(textoNarracao);
  const palavras = texto.split(/\s+/).filter(Boolean);
  const linhas = [];

  const cabecalho = `[Script Info]
ScriptType: v4.00+
PlayResX: 720
PlayResY: 1280
ScaledBorderAndShadow: yes
WrapStyle: 2

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: TikTok,Arial,58,&H00FFFFFF,&H0000FFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,5,1,2,55,55,185,1
Style: Destaque,Arial,64,&H0000FFFF,&H0000FFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,6,1,8,45,45,95,1
Style: CTA,Arial,54,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,6,1,8,45,45,95,1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text`;

  if (palavras.length) {
    const tempoPorPalavra = Math.max(0.16, duracao / palavras.length);
    const grupo = 5;
    for (let i = 0; i < palavras.length; i += grupo) {
      const bloco = palavras.slice(i, i + grupo);
      const inicio = i * tempoPorPalavra;
      const fim = Math.min(duracao, (i + bloco.length) * tempoPorPalavra);
      const centis = Math.max(1, Math.round(tempoPorPalavra * 100));
      const karaoke = bloco.map(p => `{\\k${centis}}${p.toUpperCase()}`).join(" ");
      linhas.push(`Dialogue: 0,${tempoASS(inicio)},${tempoASS(fim)},TikTok,,0,0,0,,${karaoke}`);
    }
  }

  const preco = String(roteiro || "").match(/R\$\s*\d+(?:[.,]\d{1,2})?/i)?.[0];
  if (preco && duracao > 4) {
    const inicioPreco = Math.max(0, duracao - 5);
    const fimPreco = Math.max(inicioPreco + 1, duracao - 2.4);
    linhas.push(`Dialogue: 1,${tempoASS(inicioPreco)},${tempoASS(fimPreco)},Destaque,,0,0,0,,${preco.toUpperCase()}`);
  }

  if (duracao > 2.5) {
    const inicioCTA = Math.max(0, duracao - 2.4);
    linhas.push(`Dialogue: 2,${tempoASS(inicioCTA)},${tempoASS(duracao)},CTA,,0,0,0,,COMPRE AGORA - LINK NA BIO`);
  }

  return cabecalho + "\n" + linhas.join("\n") + "\n";
}

app.post("/api/video", async (req, res) => {
  let caminhoImagem = null;
  let caminhoAudio = null;
  let caminhoVideo = null;
  let caminhoLegenda = null;

  try {
    let { roteiro, imagem, audio, audioMimeType, textoNarracao } = req.body;

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
    caminhoLegenda = `/tmp/legendas-${id}.ass`;

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

    const textoLegenda = extrairSecaoRoteiro(roteiro, "NARRAÇÃO:", "CENAS:") || String(roteiro || "");
    const duracaoLegenda = estimarDuracaoAudio(bufferAudio, tipoAudio, textoLegenda);
    const arquivoASS = criarLegendasTikTok(textoLegenda, roteiro, duracaoLegenda);

    await Promise.all([
      new Promise((resolve, reject) => writeFile(caminhoImagem, bufferImagem, e => e ? reject(e) : resolve())),
      new Promise((resolve, reject) => writeFile(caminhoAudio, bufferAudio, e => e ? reject(e) : resolve())),
      new Promise((resolve, reject) => writeFile(caminhoLegenda, arquivoASS, "utf8", e => e ? reject(e) : resolve()))
    ]);

    // Configuração leve para evitar timeout no Render Free.
    const filtro = [
      "scale=720:1280:force_original_aspect_ratio=increase",
      "crop=720:1280",
      "zoompan=z='min(zoom+0.0008,1.10)':d=720:s=720x1280:fps=24",
      `subtitles=${caminhoLegenda}:force_style='FontName=Arial'`,
      "format=yuv420p"
    ].join(",");

    const argumentos = ["-loop", "1", "-i", caminhoImagem];
    if (audioEhPCM) {
      argumentos.push("-f", "s16le", "-ar", "24000", "-ac", "1", "-i", caminhoAudio);
    } else {
      argumentos.push("-i", caminhoAudio);
    }

    argumentos.push(
      "-vf", filtro,
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
      unlink(caminhoLegenda, () => {});
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
    if (caminhoLegenda) unlink(caminhoLegenda, () => {});
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
