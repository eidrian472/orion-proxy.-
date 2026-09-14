/**
 * ORION - Servidor Proxy para Groq + ElevenLabs
 * -------------------------------------------------
 * Este servidor corre en Render (fuera de Venezuela) y actúa de
 * intermediario entre la app de ORION y las APIs de Groq y ElevenLabs.
 *
 * Por qué existe: Groq bloquea peticiones que llegan desde IPs
 * venezolanas (403 Forbidden), sin importar la API key. Al pasar por
 * este servidor, Groq solo ve la IP de Render, nunca la del usuario.
 * ElevenLabs pasa por el mismo proxy para no exponer la API key en el APK.
 *
 * Bonus: las API keys viven SOLO aquí (como variables de entorno),
 * nunca en el APK ni en el código del cliente.
 */

const express = require('express');
const app = express();

app.use(express.json());

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL_PRIMARY = 'openai/gpt-oss-120b';
const GROQ_MODEL_FALLBACK = 'qwen/qwen3.6-27b';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID; // ID de la voz elegida en ElevenLabs
const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2';

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

async function callGroq(model, normalizedText, history, memoria, tono) {
  const historyMessages = history.map((turn) => ({
    role: turn.role === 'model' ? 'assistant' : 'user',
    content: turn.text,
  }));

  const toneAddendum =
    tono === 'serio'
      ? '\n\nMODO SERIO ACTIVADO: por ahora deja el sarcasmo y el humor negro completamente de lado. Responde directo, formal, sin bromas ni comentarios irónicos, como un asistente de trabajo/estudio normal.'
      : '';

  const systemFinal = `${SYSTEM_INSTRUCTION}${memoria ? `\n\n${memoria}` : ''}${toneAddendum}`;

  const response = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemFinal },
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
    const { texto, historial, memoria, tono } = req.body;

    if (!texto || typeof texto !== 'string') {
      return res.status(400).json({ error: 'Falta el campo "texto" en el body.' });
    }

    if (!GROQ_API_KEY) {
      return res.status(500).json({ error: 'Falta GROQ_API_KEY en el servidor.' });
    }

    let data;
    try {
      data = await callGroq(GROQ_MODEL_PRIMARY, texto, historial || [], memoria, tono);
    } catch (primaryError) {
      const isModelIssue = primaryError.status === 403 || primaryError.status === 404;
      if (!isModelIssue) throw primaryError;
      data = await callGroq(GROQ_MODEL_FALLBACK, texto, historial || [], memoria, tono);
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

// Endpoint de voz: recibe texto, devuelve audio mp3 generado por ElevenLabs
app.post('/tts', async (req, res) => {
  try {
    const { texto } = req.body;

    if (!texto || typeof texto !== 'string') {
      return res.status(400).json({ error: 'Falta el campo "texto" en el body.' });
    }
    if (!ELEVENLABS_API_KEY) {
      return res.status(500).json({ error: 'Falta ELEVENLABS_API_KEY en el servidor.' });
    }
    if (!ELEVENLABS_VOICE_ID) {
      return res.status(500).json({ error: 'Falta ELEVENLABS_VOICE_ID en el servidor.' });
    }

    const elevenResponse = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
          'xi-api-key': ELEVENLABS_API_KEY,
        },
        body: JSON.stringify({
          text: texto,
          model_id: ELEVENLABS_MODEL_ID,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
          },
        }),
      }
    );

    if (!elevenResponse.ok) {
      const errorBody = await elevenResponse.text().catch(() => '');
      console.error(`ElevenLabs failed: ${elevenResponse.status} ${errorBody}`);
      return res
        .status(elevenResponse.status)
        .json({ error: `ElevenLabs respondió ${elevenResponse.status}: ${errorBody}` });
    }

    const audioBuffer = Buffer.from(await elevenResponse.arrayBuffer());
    res.set('Content-Type', 'audio/mpeg');
    res.send(audioBuffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Error interno del proxy de voz.' });
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
