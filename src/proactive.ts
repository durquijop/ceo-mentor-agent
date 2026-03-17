import cron from 'node-cron';
import { config } from './config';
import { getBusinessSnapshot, getRecentMessages } from './supabase';
import { generateResponse } from './llm';
import { sendText } from './whatsapp';

const DIEGO_PHONE = config.ownerNumbers[0]; // primary number

export function startProactiveCrons(): void {
  // Morning briefing — 8:00 AM ET (Mon-Fri)
  cron.schedule('0 12 * * 1-5', async () => {
    console.log('[proactive] Running morning briefing...');
    try {
      await sendMorningBriefing();
    } catch (e) {
      console.error('[proactive] Morning briefing failed:', e);
    }
  }, { timezone: 'America/New_York' });

  // Evening reflection — 8:00 PM ET (Mon-Fri)
  cron.schedule('0 0 * * 2-6', async () => {
    console.log('[proactive] Running evening reflection...');
    try {
      await sendEveningReflection();
    } catch (e) {
      console.error('[proactive] Evening reflection failed:', e);
    }
  }, { timezone: 'America/New_York' });

  // Weekly strategy — Sunday 7:00 PM ET
  cron.schedule('0 23 * * 0', async () => {
    console.log('[proactive] Running weekly strategy...');
    try {
      await sendWeeklyStrategy();
    } catch (e) {
      console.error('[proactive] Weekly strategy failed:', e);
    }
  }, { timezone: 'America/New_York' });

  console.log('[proactive] Crons scheduled: morning briefing (8am), evening reflection (8pm), weekly strategy (Sun 7pm)');
}

async function sendMorningBriefing(): Promise<void> {
  const snapshot = await getBusinessSnapshot();
  const history = await getRecentMessages(DIEGO_PHONE, 5);

  const prompt = `Es lunes a viernes, 8 AM. Genera un briefing matutino CORTO para Diego como su mentor CEO.

Datos del negocio:
${JSON.stringify(snapshot, null, 2)}

Incluye:
1. Un dato relevante del negocio (si hay algo notable)
2. Una pregunta de accountability sobre sus prioridades
3. Un micro-consejo o provocación estratégica

Máximo 4-5 líneas. Empieza directo, sin saludo genérico. Esto es WhatsApp — sé conciso.`;

  const response = await generateResponse(history, prompt, false);
  await sendText(DIEGO_PHONE, response);
  console.log('[proactive] Morning briefing sent');
}

async function sendEveningReflection(): Promise<void> {
  const history = await getRecentMessages(DIEGO_PHONE, 10);

  const prompt = `Es de noche. Genera una reflexión breve de cierre de día para Diego como su mentor CEO.

Si hubo conversación hoy, referencia algo de lo que hablaron.
Si no, pregunta cómo fue el día y qué logró.

Incluye:
1. Una pregunta reflexiva (no genérica)
2. Un recordatorio de prioridades si aplica

Máximo 3-4 líneas. Sin saludo formal. WhatsApp — conciso.`;

  const response = await generateResponse(history, prompt, false);
  await sendText(DIEGO_PHONE, response);
  console.log('[proactive] Evening reflection sent');
}

async function sendWeeklyStrategy(): Promise<void> {
  const snapshot = await getBusinessSnapshot();
  const history = await getRecentMessages(DIEGO_PHONE, 15);

  const prompt = `Es domingo por la noche. Genera un mini-análisis semanal para Diego como su mentor CEO.

Datos del negocio:
${JSON.stringify(snapshot, null, 2)}

Incluye:
1. Tendencia del mes basada en los datos
2. Una pregunta estratégica para la semana que viene
3. Un desafío o experimento concreto para probar esta semana

Máximo 8-10 líneas. Directo, provocativo, útil. WhatsApp format.`;

  const response = await generateResponse(history, prompt, false);
  await sendText(DIEGO_PHONE, response);
  console.log('[proactive] Weekly strategy sent');
}
