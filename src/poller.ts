import { config } from './config';
import { getOrCreateSession, getRecentMessages, saveMessage, updateSessionContext } from './supabase';
import { generateResponse } from './llm';
import { sendText, markAsRead } from './whatsapp';

const POLL_INTERVAL_MS = 5000;
const KAPSO_BASE = 'https://app.kapso.ai/api/meta/v21.0';

// Track processed message IDs to avoid duplicates
const processedIds = new Set<string>();
let initialized = false;

function isOwner(phone: string): boolean {
  const clean = phone.replace(/\D/g, '');
  return config.ownerNumbers.some((n) => clean.endsWith(n));
}

interface KapsoMsg {
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
}

function extractText(msg: KapsoMsg): string | null {
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

async function fetchLatest(): Promise<KapsoMsg[]> {
  // Fetch latest inbound messages (no 'since' — just latest N)
  const url = `${KAPSO_BASE}/${config.phoneNumberId}/messages?direction=inbound&limit=10&fields=kapso(direction,content,phone_number,contact_name)`;

  const res = await fetch(url, {
    headers: { 'X-API-Key': config.kapsoApiKey },
  });

  if (!res.ok) {
    console.error(`[poller] API ${res.status}: ${await res.text().catch(() => '')}`);
    return [];
  }

  const json = (await res.json()) as { data?: KapsoMsg[] };
  return json.data || [];
}

async function processMessage(msg: KapsoMsg): Promise<void> {
  const from = (msg.kapso?.phone_number || msg.from || '').replace(/\D/g, '');
  if (!from || !isOwner(from)) return;

  const text = extractText(msg);
  if (!text) return;

  console.log(`[poller] Processing ${msg.id.slice(-12)} from ${from}: "${text.slice(0, 60)}"`);

  try {
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

    console.log(`[poller] Sent ${response.length} chars to ${from}`);
  } catch (error) {
    console.error(`[poller] Error on ${msg.id}:`, error);
  }
}

function shouldIncludeBusinessData(text: string): boolean {
  const triggers = [
    'datos', 'reporte', 'métricas', 'kpi', 'números', 'ventas',
    'leads', 'conversiones', 'citas', 'negocio', 'empresa',
    'cómo va', 'como va', 'status', 'estado', 'dashboard',
    'revenue', 'recaudo', 'clientes',
  ];
  return triggers.some((t) => text.toLowerCase().includes(t));
}

async function poll(): Promise<void> {
  try {
    const messages = await fetchLatest();

    if (!initialized) {
      // First poll: just mark all existing messages as "seen" so we don't reply to old ones
      for (const msg of messages) {
        processedIds.add(msg.id);
      }
      initialized = true;
      console.log(`[poller] Initialized — marked ${messages.length} existing messages as seen`);
      return;
    }

    // Find new messages (not yet processed), process oldest first
    const newMsgs = messages.filter((m) => !processedIds.has(m.id)).reverse();

    for (const msg of newMsgs) {
      processedIds.add(msg.id);
      if (msg.kapso?.direction !== 'inbound') continue;
      await processMessage(msg);
    }

    // Cap the set size
    if (processedIds.size > 500) {
      const arr = Array.from(processedIds);
      arr.splice(0, 250).forEach((id) => processedIds.delete(id));
    }
  } catch (error) {
    console.error('[poller] Error:', error);
  }
}

export function startPoller(): void {
  console.log(`[poller] Starting (interval=${POLL_INTERVAL_MS / 1000}s, owners=${config.ownerNumbers.join(',')})`);
  poll().catch((e) => console.error('[poller] Init failed:', e));
  setInterval(() => poll().catch((e) => console.error('[poller] Cycle failed:', e)), POLL_INTERVAL_MS);
}
