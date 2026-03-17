import { Request, Response } from 'express';
import { config } from './config';
import { getOrCreateSession, getRecentMessages, saveMessage, updateSessionContext } from './supabase';
import { generateResponse } from './llm';
import { sendText, markAsRead } from './whatsapp';

// ── Kapso v2 webhook payload types ──
// Docs: https://docs.kapso.ai/docs/platform/webhooks/event-types

interface KapsoMessage {
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  interactive?: {
    type: string;
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
    nfm_reply?: { response_json: string };
  };
  image?: { id: string; caption?: string };
  audio?: { id: string; voice?: boolean };
  document?: { id: string; filename?: string; caption?: string };
  location?: { latitude: number; longitude: number; name?: string };
  from?: string; // present in Meta raw format
  kapso?: {
    direction: 'inbound' | 'outbound';
    status: string;
    content?: string;
    has_media?: boolean;
  };
}

interface KapsoWebhookBody {
  message?: KapsoMessage;
  conversation?: {
    id: string;
    phone_number: string;
    phone_number_id?: string;
    status?: string;
    kapso?: {
      contact_name?: string;
      messages_count?: number;
    };
  };
  is_new_conversation?: boolean;
  phone_number_id?: string;
  // Meta raw format
  entry?: Array<{
    changes: Array<{
      value: {
        messages?: Array<KapsoMessage>;
        contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
      };
    }>;
  }>;
}

function extractMessageText(message: KapsoMessage): string | null {
  // Kapso v2: use kapso.content if available
  if (message.kapso?.content) {
    return message.kapso.content;
  }
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
const debugLog: Array<{ ts: string; body: unknown; note?: string }> = [];

export function getDebugLog() {
  return debugLog;
}

export async function handleWebhook(req: Request, res: Response): Promise<void> {
  res.sendStatus(200);

  try {
    const body: KapsoWebhookBody = req.body;
    const bodyStr = JSON.stringify(body).slice(0, 500);
    console.log(`[webhook] BODY: ${bodyStr}`);

    debugLog.push({ ts: new Date().toISOString(), body });
    if (debugLog.length > 20) debugLog.shift();

    let message: KapsoMessage | undefined;
    let from: string | undefined;
    let contactName: string | undefined;

    // ── Format 1: Kapso v2 webhook (default) ──
    // { message: { id, type, text, kapso: { direction, content } }, conversation: { phone_number } }
    if (body.message && body.conversation?.phone_number) {
      message = body.message;
      from = body.conversation.phone_number.replace(/\D/g, '');
      contactName = body.conversation.kapso?.contact_name;

      // Skip outbound messages (our own replies echoed back)
      if (message.kapso?.direction === 'outbound') {
        console.log(`[webhook] Skipping outbound message`);
        return;
      }
    }
    // ── Format 2: Kapso v2 with from in message ──
    else if (body.message?.from) {
      message = body.message;
      from = body.message.from.replace(/\D/g, '');
      contactName = body.conversation?.kapso?.contact_name;
    }
    // ── Format 3: Meta raw webhook format ──
    else if (body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
      const value = body.entry[0].changes[0].value;
      message = value.messages![0];
      from = message.from?.replace(/\D/g, '');
      contactName = value.contacts?.[0]?.profile?.name;
      console.log(`[webhook] Detected Meta raw format`);
    }

    if (!message) {
      console.log(`[webhook] No message. Keys: ${Object.keys(body).join(', ')}`);
      debugLog[debugLog.length - 1].note = 'no_message';
      return;
    }

    if (!from) {
      console.log(`[webhook] No phone number found`);
      debugLog[debugLog.length - 1].note = 'no_from';
      return;
    }

    if (!isOwner(from)) {
      console.log(`[webhook] Non-owner: ${from}`);
      debugLog[debugLog.length - 1].note = `non_owner:${from}`;
      return;
    }

    const text = extractMessageText(message);
    if (!text) {
      console.log(`[webhook] No text extractable from type=${message.type}`);
      debugLog[debugLog.length - 1].note = `no_text:${message.type}`;
      return;
    }

    console.log(`[webhook] Processing: ${from} → "${text.slice(0, 80)}"`);
    debugLog[debugLog.length - 1].note = `processing:${from}`;

    // Mark as read + typing
    try { await markAsRead(message.id); } catch (_) {}

    const session = await getOrCreateSession(from, contactName);
    const history = await getRecentMessages(from);

    await saveMessage(from, 'user', text);

    const includeData = shouldIncludeBusinessData(text);
    const response = await generateResponse(history, text, includeData);

    await saveMessage(from, 'assistant', response);
    await updateSessionContext(from, {});
    await sendText(from, response);

    console.log(`[webhook] Sent to ${from} (${response.length} chars)`);
    debugLog[debugLog.length - 1].note = `sent:${response.length}`;
  } catch (error) {
    console.error('[webhook] ERROR:', error);
    debugLog.push({ ts: new Date().toISOString(), body: { error: String(error) }, note: 'error' });
    if (debugLog.length > 20) debugLog.shift();
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
