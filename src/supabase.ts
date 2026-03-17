import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from './config';

let client: SupabaseClient;

export function getSupabase(): SupabaseClient {
  if (!client) {
    client = createClient(config.supabaseUrl, config.supabaseKey);
  }
  return client;
}

// ── Constants (Atlas in Supabase) ──

const ATLAS_AGENTE_ID = 100;
const ATLAS_EMPRESA_ID = 13; // Urpe Ai Lab
const ATLAS_NUMERO_ID = 62;

// ── Types ──

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
}

export interface MentorSession {
  conversacion_id: number;
  contacto_id: number;
  phone: string;
}

// ── Contact management (wp_contactos) ──

async function getOrCreateContact(phone: string, contactName?: string): Promise<number> {
  const sb = getSupabase();

  const { data: existing } = await sb
    .from('wp_contactos')
    .select('id')
    .eq('telefono', phone)
    .eq('empresa_id', ATLAS_EMPRESA_ID)
    .limit(1)
    .single();

  if (existing) return existing.id;

  const { data: created, error } = await sb
    .from('wp_contactos')
    .insert({
      telefono: phone,
      nombre: contactName || null,
      origen: 'Whatsapp',
      notas: 'Creado automáticamente por Atlas',
      is_active: true,
      empresa_id: ATLAS_EMPRESA_ID,
      estado: 'prospecto',
      es_calificado: 'evaluando',
      suscripcion: true,
    })
    .select('id')
    .single();

  if (error) {
    console.error('[supabase] Failed to create contact:', error.message);
    throw error;
  }
  return created!.id;
}

// ── Conversation management (wp_conversaciones) ──

async function getOrCreateConversation(contactoId: number): Promise<number> {
  const sb = getSupabase();
  const now = new Date().toISOString();

  // Find active conversation for this contact with Atlas
  const { data: existing } = await sb
    .from('wp_conversaciones')
    .select('id')
    .eq('contacto_id', contactoId)
    .eq('agente_id', ATLAS_AGENTE_ID)
    .eq('empresa_id', ATLAS_EMPRESA_ID)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (existing) return existing.id;

  const { data: created, error } = await sb
    .from('wp_conversaciones')
    .insert({
      agente_id: ATLAS_AGENTE_ID,
      contacto_id: contactoId,
      fecha_inicio: now,
      canal: 'whatsapp',
      empresa_id: ATLAS_EMPRESA_ID,
      numero_id: ATLAS_NUMERO_ID,
    })
    .select('id')
    .single();

  if (error) {
    console.error('[supabase] Failed to create conversation:', error.message);
    throw error;
  }
  return created!.id;
}

// ── Session (contact + conversation lookup) ──

export async function getOrCreateSession(phone: string, contactName?: string): Promise<MentorSession> {
  const contactoId = await getOrCreateContact(phone, contactName);
  const conversacionId = await getOrCreateConversation(contactoId);
  return { conversacion_id: conversacionId, contacto_id: contactoId, phone };
}

export async function updateSessionContext(
  phone: string,
  context: Record<string, unknown>
): Promise<void> {
  // Update last message timestamp on conversation
  const sb = getSupabase();
  const session = await getOrCreateSession(phone);
  await sb
    .from('wp_conversaciones')
    .update({
      fecha_ultimo_mensaje_usuario: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', session.conversacion_id);
}

// ── Messages (wp_mensajes) ──

export async function getRecentMessages(
  phone: string,
  limit = 30
): Promise<ConversationMessage[]> {
  const sb = getSupabase();

  // Find contact
  const { data: contact } = await sb
    .from('wp_contactos')
    .select('id')
    .eq('telefono', phone)
    .eq('empresa_id', ATLAS_EMPRESA_ID)
    .limit(1)
    .single();

  if (!contact) return [];

  // Find conversation
  const { data: conv } = await sb
    .from('wp_conversaciones')
    .select('id')
    .eq('contacto_id', contact.id)
    .eq('agente_id', ATLAS_AGENTE_ID)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (!conv) return [];

  const { data: messages } = await sb
    .from('wp_mensajes')
    .select('contenido, remitente, created_at')
    .eq('conversacion_id', conv.id)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (!messages) return [];

  return messages.reverse().map((m: any) => ({
    role: m.remitente === 'usuario' ? 'user' as const : 'assistant' as const,
    content: m.contenido,
    timestamp: m.created_at,
  }));
}

export async function saveMessage(
  phone: string,
  role: 'user' | 'assistant',
  content: string
): Promise<void> {
  const sb = getSupabase();
  const session = await getOrCreateSession(phone);

  await sb.from('wp_mensajes').insert({
    conversacion_id: session.conversacion_id,
    contenido: content,
    tipo: 'texto',
    remitente: role === 'user' ? 'usuario' : 'agente',
    status: 'enviado',
    empresa_id: ATLAS_EMPRESA_ID,
    metadata: {
      canal: 'whatsapp',
      agente_id: ATLAS_AGENTE_ID,
    },
  });
}

// ── Business data queries ──

export async function getBusinessSnapshot(): Promise<Record<string, unknown>> {
  const sb = getSupabase();
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const monthStart = `${today.slice(0, 7)}-01`;

  try {
    // URPE Integral (empresa_id=4) business data
    const [convToday, convMonth, citasMonth, contactsMonth] = await Promise.all([
      sb.from('wp_conversaciones').select('id', { count: 'exact', head: true })
        .gte('fecha_inicio', today).eq('empresa_id', 4),
      sb.from('wp_conversaciones').select('id', { count: 'exact', head: true })
        .gte('fecha_inicio', monthStart).eq('empresa_id', 4),
      sb.from('wp_citas').select('id, estado', { count: 'exact' })
        .gte('created_at', monthStart).eq('empresa_id', 4),
      sb.from('wp_contactos').select('id', { count: 'exact', head: true })
        .gte('created_at', monthStart),
    ]);

    // Urpe Ai Lab (empresa_id=13) data
    const [aiLabConvMonth, aiLabContactsMonth] = await Promise.all([
      sb.from('wp_conversaciones').select('id', { count: 'exact', head: true })
        .gte('fecha_inicio', monthStart).eq('empresa_id', ATLAS_EMPRESA_ID),
      sb.from('wp_contactos').select('id', { count: 'exact', head: true })
        .gte('created_at', monthStart).eq('empresa_id', ATLAS_EMPRESA_ID),
    ]);

    return {
      date: today,
      urpe_integral: {
        conversations_today: convToday.count || 0,
        conversations_month: convMonth.count || 0,
        appointments_month: citasMonth.count || 0,
        new_contacts_month: contactsMonth.count || 0,
      },
      urpe_ai_lab: {
        conversations_month: aiLabConvMonth.count || 0,
        contacts_month: aiLabContactsMonth.count || 0,
      },
    };
  } catch (e) {
    console.error('[supabase] Business snapshot failed:', e);
    return { date: today, error: 'Could not fetch business data' };
  }
}
