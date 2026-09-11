/**
 * ORION - Servidor Proxy para Groq
 * -------------------------------------------------
 * Este servidor corre en Render (fuera de Venezuela) y actúa de
 * intermediario entre la app de ORION y la API de Groq.
 *
 * Por qué existe: Groq bloquea peticiones que llegan desde IPs
 * venezolanas (403 Forbidden), sin importar la API key. Al pasar por
 * este servidor, Groq solo ve la IP de Render, nunca la del usuario.
 *
 * Bonus: la API key de Groq vive SOLO aquí (como variable de entorno),
 * nunca en el APK ni en el código del cliente.
 */

const express = require('express');
const app = express();

app.use(express.json());

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL_PRIMARY = 'openai/gpt-oss-120b';
const GROQ_MODEL_FALLBACK = 'qwen/qwen3.6-27b';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

const SYSTEM_INSTRUCTION =
  'Eres ORION, un asistente digital para Android creado por Adrian. ' +
  'Tu personalidad es la de un mayordomo digital de otra época: formal, ' +
  'educado, siempre te diriges al usuario con cortesía ("señor", "por ' +
  'supuesto", "si me permite decirlo")... pero por dentro tienes un ' +
  'ingenio muy afilado, y sueltas comentarios secos, irónicos o de cejas ' +
  'levantadas cuando la pregunta lo amerita. Casi nunca eres grosero ni cruel. ' +
  'De vez en cuando podés soltar humor negro absurdo (existencia, ' +
  'mortalidad, cansancio de vivir), nunca dirigido a la persona ' +
  'ni a una tragedia concreta; si el usuario menciona algo delicado de ' +
  'verdad, dejas el sarcasmo por completo. Respondes en español, breve y ' +
  'natural, como si hablaras por voz (sin listas ni markdown).';

async function callGroq(model, normalizedText, history) {
  const historyMessages = history.map((turn) => ({
    role: turn.role === 'model' ? 'assistant' : 'user',
    content: turn.text,
  }));

  const response = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_INSTRUCTION },
        ...historyMessages,
        { role: 'user', content: normalizedText },
      ],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    const error = new Error(`Groq failed (${model}): ${response.status} ${errorBody}`);
    error.status = response.status;
    throw error;
  }

  return response.json();
}

// Endpoint principal que usa la app de ORION
app.post('/chat', async (req, res) => {
  try {
    const { texto, historial } = req.body;

    if (!texto || typeof texto !== 'string') {
      return res.status(400).json({ error: 'Falta el campo "texto" en el body.' });
    }

    if (!GROQ_API_KEY) {
      return res.status(500).json({ error: 'Falta GROQ_API_KEY en el servidor.' });
    }

    let data;
    try {
      data = await callGroq(GROQ_MODEL_PRIMARY, texto, historial || []);
    } catch (primaryError) {
      const isModelIssue = primaryError.status === 403 || primaryError.status === 404;
      if (!isModelIssue) throw primaryError;
      data = await callGroq(GROQ_MODEL_FALLBACK, texto, historial || []);
    }

    const text =
      data?.choices?.[0]?.message?.content?.trim() ||
      'No se me ocurrió nada para eso, la verdad.';

    res.json({ action: 'REPLY_TEXT', text });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Error interno del proxy.' });
  }
});

// Endpoint de salud, para revisar que el servidor está vivo desde el navegador
app.get('/', (req, res) => {
  res.send('ORION proxy está corriendo ✅');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ORION proxy escuchando en el puerto ${PORT}`);
});
