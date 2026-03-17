import { Request, Response } from 'express';
import { config } from './config';
import { getOrCreateSession, getRecentMessages, saveMessage, updateSessionContext } from './supabase';
import { generateResponse } from './llm';
import { sendText, markAsRead, sendReaction } from './whatsapp';

interface KapsoWebhookBody {
  message?: {
    id: string;
    from: string;
    timestamp: string;
    type: string;
    text?: { body: string };
    interactive?: {
      type: string;
      button_reply?: { id: string; title: string };
      list_reply?: { id: string; title: string; description?: string };
    };
    image?: { id: string; caption?: string };
    audio?: { id: string; voice?: boolean };
    document?: { id: string; filename?: string; caption?: string };
    location?: { latitude: number; longitude: number; name?: string };
  };
  conversation?: {
    id: string;
    phone_number: string;
    contact_name?: string;
  };
  whatsapp_config?: {
    phone_number_id: string;
    display_phone_number: string;
  };
  is_new_conversation?: boolean;
}

function extractMessageText(message: KapsoWebhookBody['message']): string | null {
  if (!message) return null;

  if (message.type === 'text' && message.text?.body) {
    return message.text.body;
  }
  if (message.type === 'interactive') {
    if (message.interactive?.button_reply) {
      return `[Botón: ${message.interactive.button_reply.title}]`;
    }
    if (message.interactive?.list_reply) {
      return `[Lista: ${message.interactive.list_reply.title}]`;
    }
  }
  if (message.type === 'image') {
    return message.image?.caption || '[Imagen recibida]';
  }
  if (message.type === 'audio') {
    return '[Audio recibido - transcripción no disponible]';
  }
  if (message.type === 'document') {
    return message.document?.caption || `[Documento: ${message.document?.filename || 'archivo'}]`;
  }
  if (message.type === 'location') {
    return `[Ubicación: ${message.location?.name || `${message.location?.latitude},${message.location?.longitude}`}]`;
  }

  return null;
}

function isOwner(phone: string): boolean {
  const clean = phone.replace(/\D/g, '');
  return config.ownerNumbers.some((n) => clean.endsWith(n));
}

// Store last N webhook payloads for debugging
const debugLog: Array<{ ts: string; body: unknown }> = [];

export function getDebugLog() {
  return debugLog;
}

export async function handleWebhook(req: Request, res: Response): Promise<void> {
  // Respond immediately to avoid Kapso timeout
  res.sendStatus(200);

  try {
    const body = req.body;
    console.log(`[webhook] RAW BODY: ${JSON.stringify(body).slice(0, 500)}`);

    // Store for debug endpoint
    debugLog.push({ ts: new Date().toISOString(), body });
    if (debugLog.length > 20) debugLog.shift();

    // Kapso v1 webhook format: the message might be nested differently
    // Try multiple possible structures
    let message = body.message;
    let from: string | undefined;

    // Kapso v1 format: { message: { from, type, text, ... } }
    if (message?.from) {
      from = message.from;
    }
    // Meta/Kapso raw format: { entry: [{ changes: [{ value: { messages: [...] } }] }] }
    else if (body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
      const metaMsg = body.entry[0].changes[0].value.messages[0];
      message = metaMsg;
      from = metaMsg.from;
      console.log(`[webhook] Detected Meta raw webhook format`);
    }

    if (!message) {
      console.log(`[webhook] No message found in body. Keys: ${Object.keys(body).join(', ')}`);
      return;
    }

    if (!from) {
      console.log(`[webhook] No 'from' in message. Keys: ${Object.keys(message).join(', ')}`);
      return;
    }

    // Only respond to owner's numbers
    if (!isOwner(from)) {
      console.log(`[webhook] Ignored message from non-owner: ${from}`);
      return;
    }

    const text = extractMessageText(message);
    if (!text) return;

    console.log(`[webhook] Message from ${from}: ${text.slice(0, 100)}`);

    // Mark as read + show typing
    try {
      await markAsRead(message.id);
    } catch (e) {
      // Non-critical
    }

    // Get/create session and recent messages
    const contactName = body.conversation?.contact_name;
    const session = await getOrCreateSession(from, contactName);
    const history = await getRecentMessages(from);

    // Save user message
    await saveMessage(from, 'user', text);

    // Decide whether to include business data
    const includeData = shouldIncludeBusinessData(text);

    // Generate response
    const response = await generateResponse(history, text, includeData);

    // Save assistant message
    await saveMessage(from, 'assistant', response);

    // Update conversation timestamp
    await updateSessionContext(from, {});

    // Send response via WhatsApp
    await sendText(from, response);

    console.log(`[webhook] Response sent to ${from} (${response.length} chars)`);
  } catch (error) {
    console.error('[webhook] Error processing message:', error);
  }
}

function shouldIncludeBusinessData(text: string): boolean {
  const triggers = [
    'datos', 'reporte', 'métricas', 'kpi', 'números', 'ventas',
    'leads', 'conversiones', 'citas', 'negocio', 'empresa',
    'cómo va', 'como va', 'status', 'estado', 'dashboard',
    'revenue', 'recaudo', 'clientes',
  ];
  const lower = text.toLowerCase();
  return triggers.some((t) => lower.includes(t));
}
