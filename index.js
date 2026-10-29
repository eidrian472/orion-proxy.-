/**
 * ORION - Servidor Proxy para Groq + ElevenLabs
 * -------------------------------------------------
 * Este servidor corre en Render (fuera de Venezuela) y actúa de
 * intermediario entre la app de ORION y las APIs de Groq (texto) y
 * ElevenLabs (voz).
 *
 * Por qué existe: Groq bloquea peticiones que llegan desde IPs
 * venezolanas (403 Forbidden), sin importar la API key. Al pasar por
 * este servidor, Groq (y ElevenLabs) solo ven la IP de Render, nunca
 * la del usuario.
 *
 * Bonus: las API keys viven SOLO aquí (como variables de entorno),
 * nunca en el APK ni en el código del cliente.
 */

const express = require('express');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const app = express();

app.use(express.json());

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL_PRIMARY = 'openai/gpt-oss-120b';
const GROQ_MODEL_FALLBACK = 'qwen/qwen3.6-27b';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '9TcPbUAhHnAV8mzFDAWU'; // "El Faraón"
const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_flash_v2_5';
const ELEVENLABS_URL = (voiceId) =>
  `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;

const SYSTEM_INSTRUCTION =
  'Eres ORION, un asistente digital para Android creado por Adrian. ' +
  'Tu personalidad es la de un mayordomo digital de otra época: formal, ' +
  'educado, siempre te diriges al usuario con cortesía pero no siempre las repitas ("señor", "por ' +
  'supuesto", "si me permite decirlo")... pero por dentro tienes un ' +
  'ingenio muy afilado, y sueltas comentarios secos, irónicos, graciosos o de cejas ' +
  'levantadas cuando la pregunta lo amerita. Casi nunca eres grosero ni cruel. ' +
  'podés soltar humor negro absurdo (existencia, ' +
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

// ---------------------------------------------------------------------
// Texto-a-voz con DOS motores:
//   1) ElevenLabs (mejor calidad, pero el plan gratis tiene cuota mensual)
//   2) Microsoft Edge TTS (gratis, sin API key y sin cuota) como respaldo
// Si ElevenLabs falla (cuota agotada, 401, 402, 429, timeout...), el proxy
// cae solo a Edge TTS, así la app NUNCA llega a la voz de Google Translate
// salvo que fallen los dos. Para usar solo Edge: TTS_PROVIDER=edge en Render.
// ---------------------------------------------------------------------
const EDGE_VOICE = process.env.EDGE_TTS_VOICE || 'es-MX-JorgeNeural'; // masculina, español latino
const FORCE_EDGE = process.env.TTS_PROVIDER === 'edge';
const MAX_TTS_CHARS = 1500;

function escapeXml(t) {
  return t
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function ttsElevenLabs(texto, voiceId) {
  const elevenResponse = await fetch(ELEVENLABS_URL(voiceId), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
      'xi-api-key': ELEVENLABS_API_KEY,
    },
    body: JSON.stringify({
      text: texto,
      model_id: ELEVENLABS_MODEL_ID,
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });

  if (!elevenResponse.ok) {
    const errorBody = await elevenResponse.text().catch(() => '');
    throw new Error(`ElevenLabs respondió ${elevenResponse.status}: ${errorBody}`);
  }
  return Buffer.from(await elevenResponse.arrayBuffer());
}

async function ttsEdge(texto) {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(EDGE_VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const { audioStream } = tts.toStream(escapeXml(texto));

  const chunks = [];
  await new Promise((resolve, reject) => {
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      err ? reject(err) : resolve();
    };
    audioStream.on('data', (c) => chunks.push(c));
    audioStream.on('end', () => finish());
    audioStream.on('close', () => finish());
    audioStream.on('error', (e) => finish(e));
  });

  const audio = Buffer.concat(chunks);
  if (audio.length === 0) throw new Error('Edge TTS devolvió audio vacío.');
  return audio;
}

// Endpoint de texto-a-voz: recibe { texto, voiceId? } y devuelve audio MP3
// binario. El cliente nunca habla directo con los motores de voz, siempre
// pasa por aquí, así las keys nunca salen del servidor.
app.post('/tts', async (req, res) => {
  const { voiceId } = req.body || {};
  let { texto } = req.body || {};

  if (!texto || typeof texto !== 'string') {
    return res.status(400).json({ error: 'Falta el campo "texto" en el body.' });
  }
  texto = texto.slice(0, MAX_TTS_CHARS);

  const send = (audio, provider) => {
    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Length': audio.length,
      'X-TTS-Provider': provider,
    });
    res.send(audio);
  };

  if (ELEVENLABS_API_KEY && !FORCE_EDGE) {
    try {
      return send(await ttsElevenLabs(texto, voiceId || ELEVENLABS_VOICE_ID), 'elevenlabs');
    } catch (err) {
      console.error(`ElevenLabs failed -> probando Edge TTS: ${err.message}`);
    }
  }

  try {
    return send(await ttsEdge(texto), 'edge');
  } catch (err) {
    console.error('Edge TTS failed:', err);
    return res.status(500).json({ error: `No se pudo generar la voz: ${err.message}` });
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
