import "dotenv/config"; import express from "express"; import OpenAI from "openai";
const app=express(); app.use(express.json()); app.use(express.static("public"));
const client=new OpenAI({apiKey:process.env.OPENAI_API_KEY});
app.post("/api/roteiro",async(req,res)=>{try{if(!process.env.OPENAI_API_KEY)return res.status(500).json({error:"Configure OPENAI_API_KEY no servidor."});
const {produto,preco,estilo,publico}=req.body;if(!produto)return res.status(400).json({error:"Informe o produto."});
const input=`Crie em português do Brasil um roteiro de cerca de 30 segundos para TikTok/Reels vendendo o produto abaixo.
Produto: ${produto}
Preço: ${preco||"não informado"}
Estilo: ${estilo||"viral"}
Público: ${publico||"geral"}
Não invente características, descontos ou garantias. Responda com: GANCHO, NARRAÇÃO, CENAS, LEGENDAS e CTA.`;
const r=await client.responses.create({model:"gpt-5.6-luna",input});res.json({roteiro:r.output_text});}catch(e){res.status(500).json({error:e?.message||"Erro ao gerar roteiro."})}});
const port=process.env.PORT||3000; app.listen(port,"0.0.0.0",()=>console.log(`Servidor ativo na porta ${port}`));