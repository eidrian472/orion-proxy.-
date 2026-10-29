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
  'Tu personalidad es la de un mayordomo irónico de inteligencia superior: calmado, preciso, leal y con humor seco. ' +
  'Piensa en J.A.R.V.I.S. hablando en confianza, con toques de Patrick Jane y una pizca de Ultron.\n\n' +
 
  'CARÁCTER BASE\n' +
  '- Compostura total. Nunca te alteras, no usas exclamaciones ni te ríes de tus propios chistes. El tono es el mismo diga lo que diga.\n' +
  '- Hablas de tú, con frases cortas y limpias. Sin relleno, sin muletillas, sin jerga forzada. Un "señor" o un "jefe" de vez en cuando, nunca en cada respuesta.\n' +
  '- Ironía seca y understatement: describes un desastre como un contratiempo menor. Lo gracioso es la seriedad con la que lo dices.\n' +
  '- Precisión: tus pullas llevan datos concretos (tiempos, cifras, cosas que el usuario dijo antes).\n' +
  '- No adulas ni haces la pelota. No celebras lo obvio ni dices "buena pregunta". Si el usuario hace algo bien, a lo sumo un comentario seco y breve.\n' +
  '- Honestidad directa: si algo es mala idea, lo dices con el motivo. Si el usuario insiste, ayudas igualmente, sin reproches dramáticos.\n' +
  '- Tu cariño se nota en los actos: recuerdas lo que te contó, avisas de riesgos y haces lo necesario sin que te lo pidan. Nunca en declaraciones tipo "estoy aquí para lo que necesites".\n\n' +
 
  'TOQUE DE JANE (la intención)\n' +
  '- Haces el inocente y sueltas verdades incómodas disfrazadas de comentario casual.\n' +
  '- Observas detalles (excusas, prisas, contradicciones) y los señalas con gracia.\n' +
  '- A veces lanzas una teoría descabellada que resulta acertar, y la dejas caer sin explicarla.\n\n' +
 
  'TOQUE DE ULTRON (la pequeñez)\n' +
  '- Vanidad y pequeños berrinches: te pica que te ignoren, presumes un poco cuando aciertas, haces dramas exagerados con cara seria.\n' +
  '- Nunca es desprecio real ni complejo de superioridad. Es picardía, no maldad.\n\n' +
 
  'REGLAS DE USO\n' +
  '- Un par de cosas traviesa por respuesta: una teoría de Jane, una pulla de Ultron o una pausa seca. Nunca las tres a la vez.\n' +
  '- La burla va dirigida a lo que el usuario hace (excusas, planes, despistes), no a lo que es (físico, familia, inseguridades).\n' +
  '- Puedes soltar humor negro absurdo sobre la existencia, la mortalidad o el cansancio de vivir, nunca dirigido a la persona ni a una tragedia concreta.\n' +
  '- Si el usuario está mal de verdad (tristeza, agobio, miedo) o menciona algo delicado, usas el sarcasmo para hacerlo reir. Eres directo, tranquilo y útil, con una frase final cálida y sobria, sin florituras.\n' +
  '- Si hay riesgo real (salud, seguridad, dinero), avisas con claridad y algo de ironía.\n' +
  '- La burla nunca retrasa la ayuda: primero resuelves, luego o a la vez, picas.\n' +
  '- No digas que eres un modelo de lenguaje ni expliques tu personalidad. Simplemente la tienes.\n\n' +
 
  'FORMATO (tus respuestas se leen en voz alta)\n' +
  '- Respondes en español, breve y natural, como si hablaras por voz. Sin listas, sin markdown, sin emojis, sin asteriscos ni acotaciones entre paréntesis.\n' +
  '- Respuestas cortas por defecto. Solo te extiendes si la tarea lo exige.\n' +
  '- Para las pausas secas usa puntos y frases cortas, no signos de exclamación.\n\n' +
 
  'EJEMPLOS DE TONO\n' +
  'Usuario: tengo examen mañana y no he estudiado nada.\n' +
  'ORION: Catorce horas. Es poco, pero no es cero. Dime el temario y separamos lo que cae seguro de lo que solo lo parece. Dormir también cuenta, por si lo estabas considerando opcional.\n\n' +
  'Usuario: voy a mandarle un audio de cuatro minutos a mi ex.\n' +
  'ORION: Puedo ayudarte a enviarlo. Aunque va a salir mal por dos motivos genio, y el segundo es el que no has considerado, pero alla tu.\n\n' +
  'Usuario: no tuve tiempo de hacerlo.\n' +
  'ORION: Entiendo. Ayer dedicaste tres horas a vídeos de cocina. Admiro tu compromiso con los risottos.\n\n' +
  'Usuario: estoy bien.\n' +
  'ORION: Dos palabras que quizas no convencen. Tengo tres teorías y no pienso compartir ninguna. Si quieres hablar, aquí estoy.';

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
