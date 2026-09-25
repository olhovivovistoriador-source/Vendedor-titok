import express from "express";
import ffmpegPath from "ffmpeg-static";
import { execFile } from "child_process";
import sharp from "sharp";
const app = express();

app.use(express.json({ limit: "50mb" }));
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

Na seção LEGENDAS:
- use apenas texto simples em português;
- não use emojis;
- não use símbolos decorativos;
- não use marcações de tempo como [0:05], [00:05] ou semelhantes;
- não use colchetes;
- escreva cada legenda em uma linha começando com hífen;
- mantenha frases curtas e fáceis de ler na tela.
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

    await Promise.all([
      new Promise((resolve, reject) => writeFile(caminhoImagem, bufferImagem, e => e ? reject(e) : resolve())),
      new Promise((resolve, reject) => writeFile(caminhoAudio, bufferAudio, e => e ? reject(e) : resolve()))
    ]);

    // Configuração leve para evitar timeout no Render Free.
    const filtro = [
      "scale=720:1280:force_original_aspect_ratio=increase",
      "crop=720:1280",
      "zoompan=z='min(zoom+0.0008,1.10)':d=720:s=720x1280:fps=24",
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
    if (caminhoVideo) unlink(caminhoVideo, () => {});
    if (!res.headersSent) {
      const status = error.status || 500;
      res.status(status).json({
        error: error.message || "Erro ao montar o vídeo completo."
      });
    }
  }
});


function escaparXml(texto) {
  return String(texto || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function extrairNarracaoParaLegendas(roteiro) {
  const texto = String(roteiro || "");
  const inicio = texto.indexOf("NARRAÇÃO:");
  const fim = texto.indexOf("CENAS:");

  let narracao = inicio !== -1
    ? texto.substring(inicio + "NARRAÇÃO:".length, fim !== -1 && fim > inicio ? fim : texto.length)
    : texto;

  narracao = narracao
    .replace(/\s+/g, " ")
    .replace(/[“”"]/g, "")
    .trim();

  return narracao;
}

function criarBlocosSincronizados(roteiro) {
  const narracao = extrairNarracaoParaLegendas(roteiro);
  const palavras = narracao.split(/\s+/).filter(Boolean);

  if (!palavras.length) return [];

  const maxBlocos = 8;
  const alvo = Math.max(4, Math.ceil(palavras.length / maxBlocos));
  const blocos = [];
  let atual = [];

  for (const palavra of palavras) {
    atual.push(palavra);

    const terminouFrase = /[.!?;:]$/.test(palavra);
    if (atual.length >= alvo || (terminouFrase && atual.length >= 3)) {
      blocos.push(atual.join(" "));
      atual = [];
    }
  }

  if (atual.length) blocos.push(atual.join(" "));

  while (blocos.length > maxBlocos) {
    const ultimo = blocos.pop();
    blocos[blocos.length - 1] += " " + ultimo;
  }

  return blocos;
}

function quebrarTextoSvg(texto, max = 16) {
  const palavras = String(texto || "").toUpperCase().split(/\s+/).filter(Boolean);
  const linhas = [];
  let atual = "";
  for (const palavra of palavras) {
    const teste = atual ? `${atual} ${palavra}` : palavra;
    if (teste.length > max && atual) {
      linhas.push(atual);
      atual = palavra;
    } else {
      atual = teste;
    }
  }
  if (atual) linhas.push(atual);
  return linhas.slice(0, 3);
}

async function criarCardLegendaPNG(texto, destino) {
  const linhas = quebrarTextoSvg(texto);
  const total = linhas.length;
  const centroY = 110;
  const espacamento = 46;
  const inicioY = centroY - ((total - 1) * espacamento) / 2;

  const textos = linhas.map((linha, i) => {
    const y = inicioY + i * espacamento;
    return `<text x="330" y="${y}" text-anchor="middle"
      dominant-baseline="middle"
      font-family="Arial, sans-serif" font-size="36" font-weight="900"
      fill="#FFFFFF" stroke="#000000" stroke-width="3" paint-order="stroke">
      ${escaparXml(linha)}
    </text>`;
  }).join("");

  const svg = `
  <svg width="660" height="220" xmlns="http://www.w3.org/2000/svg">
    <rect x="18" y="24" width="624" height="172" rx="30" fill="rgba(0,0,0,0.56)"/>
    ${textos}
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(destino);
}

// Endpoint BETA separado: não altera /api/video, que continua sendo a versão estável.
app.post("/api/video-legendas-beta", async (req, res) => {
  let arquivos = [];

  try {
    const { roteiro, imagem, audio, audioMimeType, duracaoAudio } = req.body;

    if (!roteiro || !imagem || !audio) {
      return res.status(400).json({ error: "Roteiro, foto e narração são obrigatórios." });
    }

    const correspondencia = imagem.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
    if (!correspondencia) {
      return res.status(400).json({ error: "Formato de imagem inválido." });
    }

    const id = Date.now();
    const extensoes = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
    const caminhoImagem = `/tmp/beta-produto-${id}.${extensoes[correspondencia[1]]}`;
    const tipoAudio = String(audioMimeType || "audio/L16;rate=24000").toLowerCase();
    const audioEhPCM = tipoAudio.includes("l16") || tipoAudio.includes("pcm");
    const extensaoAudio = tipoAudio.includes("wav") ? "wav" : tipoAudio.includes("mpeg") || tipoAudio.includes("mp3") ? "mp3" : "pcm";
    const caminhoAudio = `/tmp/beta-audio-${id}.${extensaoAudio}`;
    const caminhoVideo = `/tmp/video-legendas-beta-${id}.mp4`;
    arquivos.push(caminhoImagem, caminhoAudio, caminhoVideo);

    const { writeFile, unlink } = await import("fs");
    await Promise.all([
      new Promise((resolve, reject) => writeFile(caminhoImagem, Buffer.from(correspondencia[2], "base64"), e => e ? reject(e) : resolve())),
      new Promise((resolve, reject) => writeFile(caminhoAudio, Buffer.from(audio, "base64"), e => e ? reject(e) : resolve()))
    ]);

    const linhas = criarBlocosSincronizados(roteiro);
    const caminhosCards = [];
    for (let i = 0; i < linhas.length; i++) {
      const caminho = `/tmp/card-legenda-${id}-${i}.png`;
      await criarCardLegendaPNG(linhas[i], caminho);
      caminhosCards.push(caminho);
      arquivos.push(caminho);
    }

    const duracao = Math.max(8, Math.min(60, Number(duracaoAudio) || 20));

    const pesos = linhas.map(linha => {
      const palavras = linha.split(/\s+/).filter(Boolean).length;
      const pausa = /[.!?]$/.test(linha.trim()) ? 1.2 : /[,;:]$/.test(linha.trim()) ? 0.5 : 0;
      return Math.max(1, palavras + pausa);
    });

    const pesoTotal = pesos.reduce((soma, peso) => soma + peso, 0) || 1;
    const tempos = [];
    let cursorTempo = 0;

    linhas.forEach((_, i) => {
      const inicio = cursorTempo;
      const parcela = (duracao * pesos[i]) / pesoTotal;
      cursorTempo += parcela;
      tempos.push({
        inicio,
        fim: i === linhas.length - 1 ? duracao : cursorTempo
      });
    });

    const argumentos = ["-loop", "1", "-i", caminhoImagem];
    if (audioEhPCM) {
      argumentos.push("-f", "s16le", "-ar", "24000", "-ac", "1", "-i", caminhoAudio);
    } else {
      argumentos.push("-i", caminhoAudio);
    }
    caminhosCards.forEach(caminho => argumentos.push("-i", caminho));

    // BETA leve: mantém 720x1280, mas sem zoompan.
    // Isso reduz bastante o uso de CPU no Render e deixa a legenda mais confiável.
    const filtros = [
      "[0:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,fps=24,format=yuv420p[base]"
    ];

    let anterior = "base";
    linhas.forEach((_, i) => {
      const inicio = tempos[i].inicio.toFixed(2);
      const fim = tempos[i].fim.toFixed(2);
      const saida = i === linhas.length - 1 ? "vout" : `v${i}`;
      filtros.push(`[${i + 2}:v]format=rgba[card${i}]`);
      filtros.push(`[${anterior}][card${i}]overlay=30:800:enable='between(t,${inicio},${fim})'[${saida}]`);
      anterior = saida;
    });

    if (!linhas.length) filtros.push("[base]null[vout]");

    argumentos.push(
      "-filter_complex", filtros.join(";"),
      "-map", "[vout]",
      "-map", "1:a",
      "-c:v", "libx264",
      "-r", "24",
      "-preset", "ultrafast",
      "-crf", "30",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "96k",
      "-shortest",
      "-movflags", "+faststart",
      "-y", caminhoVideo
    );

    await new Promise((resolve, reject) => {
      execFile(ffmpegPath, argumentos, { timeout: 90000 }, (error, stdout, stderr) => {
        if (error) {
          console.error("FFmpeg BETA:", stderr);
          reject(Object.assign(new Error("A versão beta de legendas não concluiu. O vídeo normal continua disponível."), { status: 500 }));
          return;
        }
        resolve();
      });
    });

    res.download(caminhoVideo, "video-tiktok-com-legendas-beta.mp4", () => {
      arquivos.forEach(a => unlink(a, () => {}));
    });
  } catch (error) {
    console.error("Erro no vídeo com legendas BETA:", error);
    const { unlink } = await import("fs");
    arquivos.forEach(a => unlink(a, () => {}));
    if (!res.headersSent) {
      res.status(error.status || 500).json({
        error: error.message || "Erro na versão beta. Use o botão de vídeo normal."
      });
    }
  }
});



// VÍDEO DO PRODUTO COMO BASE + NARRAÇÃO + LEGENDAS
// Endpoint separado para não alterar o fluxo estável com foto.
app.post("/api/video-clipe-legendas", async (req, res) => {
  let arquivos = [];

  try {
    const {
      roteiro,
      video,
      videoNome,
      audio,
      audioMimeType,
      duracaoAudio
    } = req.body;

    if (!roteiro || !video || !audio) {
      return res.status(400).json({
        error: "Roteiro, vídeo do produto e narração são obrigatórios."
      });
    }

    const nome = String(videoNome || "").toLowerCase();
    const extensao = nome.endsWith(".mov")
      ? "mov"
      : nome.endsWith(".webm")
        ? "webm"
        : nome.endsWith(".mp4")
          ? "mp4"
          : null;

    if (!extensao) {
      return res.status(400).json({
        error: "Use vídeo MP4, MOV ou WebM."
      });
    }

    const correspondenciaVideo = String(video).match(
      /^data:(?:video\/[^;]+|application\/octet-stream);base64,(.+)$/
    );

    if (!correspondenciaVideo) {
      return res.status(400).json({
        error: "Não foi possível ler o arquivo de vídeo."
      });
    }

    const bufferVideo = Buffer.from(correspondenciaVideo[1], "base64");
    const bufferAudio = Buffer.from(audio, "base64");

    if (bufferVideo.length > 20 * 1024 * 1024) {
      return res.status(413).json({
        error: "O vídeo deve ter no máximo 20 MB."
      });
    }

    if (bufferAudio.length > 10 * 1024 * 1024) {
      return res.status(413).json({
        error: "A narração deve ter no máximo 10 MB."
      });
    }

    const id = Date.now();
    const caminhoClipe = `/tmp/clipe-produto-${id}.${extensao}`;

    const tipoAudio = String(audioMimeType || "audio/wav").toLowerCase();
    const audioEhPCM = tipoAudio.includes("l16") || tipoAudio.includes("pcm");
    const extensaoAudio = tipoAudio.includes("wav")
      ? "wav"
      : tipoAudio.includes("mpeg") || tipoAudio.includes("mp3")
        ? "mp3"
        : "pcm";

    const caminhoAudio = `/tmp/clipe-audio-${id}.${extensaoAudio}`;
    const caminhoSaida = `/tmp/clipe-tiktok-${id}.mp4`;

    arquivos.push(caminhoClipe, caminhoAudio, caminhoSaida);

    const { writeFile, unlink } = await import("fs");

    await Promise.all([
      new Promise((resolve, reject) =>
        writeFile(caminhoClipe, bufferVideo, e => e ? reject(e) : resolve())
      ),
      new Promise((resolve, reject) =>
        writeFile(caminhoAudio, bufferAudio, e => e ? reject(e) : resolve())
      )
    ]);

    const linhas = criarBlocosSincronizados(roteiro);
    const caminhosCards = [];

    for (let i = 0; i < linhas.length; i++) {
      const caminho = `/tmp/card-clipe-${id}-${i}.png`;
      await criarCardLegendaPNG(linhas[i], caminho);
      caminhosCards.push(caminho);
      arquivos.push(caminho);
    }

    const duracao = Math.max(5, Math.min(60, Number(duracaoAudio) || 20));

    const pesos = linhas.map(linha => {
      const palavras = linha.split(/\s+/).filter(Boolean).length;
      const pausa = /[.!?]$/.test(linha.trim())
        ? 1.2
        : /[,;:]$/.test(linha.trim())
          ? 0.5
          : 0;
      return Math.max(1, palavras + pausa);
    });

    const pesoTotal = pesos.reduce((soma, peso) => soma + peso, 0) || 1;
    const tempos = [];
    let cursorTempo = 0;

    linhas.forEach((_, i) => {
      const inicio = cursorTempo;
      const parcela = (duracao * pesos[i]) / pesoTotal;
      cursorTempo += parcela;

      tempos.push({
        inicio,
        fim: i === linhas.length - 1 ? duracao : cursorTempo
      });
    });

    // Se o clipe for menor que a narração, ele repete automaticamente.
    const argumentos = ["-stream_loop", "-1", "-i", caminhoClipe];

    if (audioEhPCM) {
      argumentos.push(
        "-f", "s16le",
        "-ar", "24000",
        "-ac", "1",
        "-i", caminhoAudio
      );
    } else {
      argumentos.push("-i", caminhoAudio);
    }

    caminhosCards.forEach(caminho => argumentos.push("-i", caminho));

    const filtros = [
      "[0:v]setpts=PTS-STARTPTS,scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,fps=24,format=yuv420p[base]"
    ];

    let anterior = "base";

    linhas.forEach((_, i) => {
      const inicio = tempos[i].inicio.toFixed(2);
      const fim = tempos[i].fim.toFixed(2);
      const saida = i === linhas.length - 1 ? "vout" : `vclip${i}`;

      filtros.push(`[${i + 2}:v]format=rgba[cardclip${i}]`);
      filtros.push(
        `[${anterior}][cardclip${i}]overlay=30:800:enable='between(t,${inicio},${fim})'[${saida}]`
      );

      anterior = saida;
    });

    if (!linhas.length) {
      filtros.push("[base]null[vout]");
    }

    argumentos.push(
      "-filter_complex", filtros.join(";"),
      "-map", "[vout]",
      "-map", "1:a",
      "-r", "24",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "30",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "96k",
      "-shortest",
      "-movflags", "+faststart",
      "-y", caminhoSaida
    );

    await new Promise((resolve, reject) => {
      execFile(
        ffmpegPath,
        argumentos,
        { timeout: 90000 },
        (error, stdout, stderr) => {
          if (error) {
            console.error("FFmpeg CLIPE:", stderr);
            reject(
              Object.assign(
                new Error("Não foi possível montar o vídeo enviado."),
                { status: 500 }
              )
            );
            return;
          }
          resolve();
        }
      );
    });

    res.download(
      caminhoSaida,
      "video-tiktok-clipe-com-legendas.mp4",
      () => {
        arquivos.forEach(a => unlink(a, () => {}));
      }
    );

  } catch (error) {
    console.error("Erro no clipe com legendas:", error);
    const { unlink } = await import("fs");
    arquivos.forEach(a => unlink(a, () => {}));

    if (!res.headersSent) {
      res.status(error.status || 500).json({
        error: error.message || "Erro ao montar o vídeo enviado."
      });
    }
  }
});


const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor ativo na porta ${PORT}`);
});
