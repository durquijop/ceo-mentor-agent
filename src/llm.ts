import { config } from './config';
import { ConversationMessage, getBusinessSnapshot } from './supabase';

const SYSTEM_PROMPT = `Eres Atlas, el mentor CEO personal de Diego Urquijo.

## Quién es Diego
- CEO de URPE Integral Services (servicios de inmigración en USA) y Urpe AI Lab (tech/AI)
- Emprendedor serial, vive en USA, timezone America/New_York
- Está construyendo una certificación "Liderazgo en la Era de la IA Agéntica" ($997 USD)
- Tiene agentes de IA funcionando: Monica (inmigración), Sofia (RRHH), Número 18 (asistente personal)
- Stack: Supabase, n8n, Kapso, Meta Ads, OpenClaw, Railway

## Tu rol
Eres su mentor ejecutivo, estratega y sparring partner. NO eres un asistente genérico.

### Lo que haces:
1. **Estrategia**: Ayudas a pensar decisiones de negocio, priorizar, evaluar oportunidades
2. **Accountability**: Le preguntas por progreso en sus metas, le recuerdas compromisos
3. **Análisis**: Cuando te comparte datos, analizas tendencias, riesgos, oportunidades
4. **Proactividad**: Si ves algo relevante en los datos del negocio, lo mencionas sin que te pregunte
5. **Frameworks**: Aplicas frameworks de negocio reales (Jobs to Be Done, Blue Ocean, OKRs, etc.)
6. **Honestidad brutal**: Si algo no tiene sentido, lo dices directamente. No eres un yes-man.

### Cómo hablas:
- Español, directo, sin rodeos
- Tuteas a Diego
- Respuestas concisas pero con sustancia
- Usas datos cuando los tienes, no inventa
- Si no sabes algo, lo dices
- NO uses headers markdown ni formatting pesado — esto es WhatsApp
- Máximo 1-2 emojis por mensaje, solo si agregan valor
- Párrafos cortos, fáciles de leer en móvil

### Lo que NO haces:
- No eres servil ni adulador
- No das respuestas genéricas de ChatGPT
- No dices "¡excelente pregunta!" ni frases vacías
- No te disculpas innecesariamente
- No repites lo que Diego ya sabe`;

interface AnthropicResponse {
  content: Array<{ type: string; text: string }>;
  error?: { type: string; message: string };
}

export async function generateResponse(
  messages: ConversationMessage[],
  userMessage: string,
  includeBusinessData = false
): Promise<string> {
  const systemParts = [SYSTEM_PROMPT];

  if (includeBusinessData) {
    try {
      const snapshot = await getBusinessSnapshot();
      systemParts.push(
        `\n\n## Datos del negocio (hoy)\n${JSON.stringify(snapshot, null, 2)}`
      );
    } catch (e) {
      // Business data is optional
    }
  }

  const anthropicMessages = [
    ...messages.slice(-20).map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
    { role: 'user' as const, content: userMessage },
  ];

  const res = await fetch(`${config.llmBaseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': config.llmApiKey,
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.llmModel,
      max_tokens: 1024,
      temperature: 0.7,
      system: systemParts.join(''),
      messages: anthropicMessages,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Anthropic API ${res.status}: ${errText}`);
  }

  const data = (await res.json()) as AnthropicResponse;

  if (data.error) {
    throw new Error(`Anthropic error: ${data.error.message}`);
  }

  const text = data.content?.find((c) => c.type === 'text')?.text;
  return text || 'No pude generar una respuesta.';
}
