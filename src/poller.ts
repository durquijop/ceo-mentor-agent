import { config } from './config';
import { getOrCreateSession, getRecentMessages, saveMessage, updateSessionContext } from './supabase';
import { generateResponse } from './llm';
import { sendText, markAsRead } from './whatsapp';

const POLL_INTERVAL_MS = 5000; // 5 seconds
const KAPSO_BASE = 'https://app.kapso.ai/api/meta/v21.0';

// Track last processed message ID per conversation to avoid duplicates
const processedMessages = new Set<string>();
let lastPollTimestamp: string | null = null;

function isOwner(phone: string): boolean {
  const clean = phone.replace(/\D/g, '');
  return config.ownerNumbers.some((n) => clean.endsWith(n));
}

interface KapsoMessageResponse {
  data: Array<{
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
    kapso?: {
      direction: 'inbound' | 'outbound';
      content?: string;
      phone_number?: string;
      contact_name?: string;
    };
  }>;
  paging?: {
    cursors?: { before?: string; after?: string };
  };
}

function extractText(msg: KapsoMessageResponse['data'][0]): string | null {
  if (msg.kapso?.content) return msg.kapso.content;
  if (msg.type === 'text' && msg.text?.body) return msg.text.body;
  if (msg.type === 'interactive') {
    if (msg.interactive?.button_reply) return `[Botón: ${msg.interactive.button_reply.title}]`;
    if (msg.interactive?.list_reply) return `[Lista: ${msg.interactive.list_reply.title}]`;
  }
  if (msg.type === 'audio') return '[Audio recibido]';
  if (msg.type === 'image') return '[Imagen recibida]';
  return null;
}

async function fetchRecentMessages(): Promise<KapsoMessageResponse['data']> {
  const since = lastPollTimestamp || new Date(Date.now() - 60000).toISOString(); // last 60s on first poll

  const url = `${KAPSO_BASE}/${config.phoneNumberId}/messages?direction=inbound&since=${encodeURIComponent(since)}&limit=10&fields=kapso(direction,content,phone_number,contact_name)`;

  const res = await fetch(url, {
    headers: { 'X-API-Key': config.kapsoApiKey },
  });

  if (!res.ok) {
    console.error(`[poller] Kapso API error: ${res.status} ${res.statusText}`);
    return [];
  }

  const data = (await res.json()) as KapsoMessageResponse;
  return data.data || [];
}

async function processMessage(msg: KapsoMessageResponse['data'][0]): Promise<void> {
  if (processedMessages.has(msg.id)) return;
  processedMessages.add(msg.id);

  // Prevent set from growing unbounded
  if (processedMessages.size > 1000) {
    const entries = Array.from(processedMessages);
    entries.splice(0, 500).forEach((id) => processedMessages.delete(id));
  }

  const from = (msg.kapso?.phone_number || msg.from || '').replace(/\D/g, '');
  if (!from || !isOwner(from)) {
    console.log(`[poller] Skipping non-owner: ${from}`);
    return;
  }

  const text = extractText(msg);
  if (!text) {
    console.log(`[poller] No text from type=${msg.type}`);
    return;
  }

  console.log(`[poller] New message from ${from}: "${text.slice(0, 80)}"`);

  try {
    // Mark as read
    try { await markAsRead(msg.id); } catch (_) {}

    const contactName = msg.kapso?.contact_name;
    await getOrCreateSession(from, contactName);
    const history = await getRecentMessages(from);

    await saveMessage(from, 'user', text);

    const includeData = shouldIncludeBusinessData(text);
    const response = await generateResponse(history, text, includeData);

    await saveMessage(from, 'assistant', response);
    await updateSessionContext(from, {});
    await sendText(from, response);

    console.log(`[poller] Responded to ${from} (${response.length} chars)`);
  } catch (error) {
    console.error(`[poller] Error processing message ${msg.id}:`, error);
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

async function poll(): Promise<void> {
  try {
    const messages = await fetchRecentMessages();

    // Process oldest first
    for (const msg of messages.reverse()) {
      // Only process inbound messages
      if (msg.kapso?.direction !== 'inbound') continue;
      await processMessage(msg);
    }

    // Update timestamp for next poll
    lastPollTimestamp = new Date().toISOString();
  } catch (error) {
    console.error('[poller] Poll error:', error);
  }
}

export function startPoller(): void {
  console.log(`[poller] Starting message poller (every ${POLL_INTERVAL_MS / 1000}s)`);

  // Initial poll
  poll();

  // Recurring poll
  setInterval(poll, POLL_INTERVAL_MS);
}
