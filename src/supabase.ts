import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from './config';

let client: SupabaseClient;

export function getSupabase(): SupabaseClient {
  if (!client) {
    client = createClient(config.supabaseUrl, config.supabaseKey);
  }
  return client;
}

// ── Conversation memory ──

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
}

export interface MentorSession {
  id?: number;
  phone: string;
  context: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export async function getOrCreateSession(phone: string): Promise<MentorSession> {
  const sb = getSupabase();
  const { data } = await sb
    .from('mentor_sessions')
    .select('*')
    .eq('phone', phone)
    .single();

  if (data) return data as MentorSession;

  const { data: created, error } = await sb
    .from('mentor_sessions')
    .insert({ phone, context: {} })
    .select()
    .single();

  if (error) throw new Error(`Failed to create session: ${error.message}`);
  return created as MentorSession;
}

export async function updateSessionContext(
  phone: string,
  context: Record<string, unknown>
): Promise<void> {
  const sb = getSupabase();
  await sb
    .from('mentor_sessions')
    .update({ context, updated_at: new Date().toISOString() })
    .eq('phone', phone);
}

export async function getRecentMessages(
  phone: string,
  limit = 30
): Promise<ConversationMessage[]> {
  const sb = getSupabase();
  const { data } = await sb
    .from('mentor_messages')
    .select('role, content, created_at')
    .eq('phone', phone)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (!data) return [];
  return data
    .reverse()
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
      timestamp: m.created_at,
    }));
}

export async function saveMessage(
  phone: string,
  role: 'user' | 'assistant',
  content: string
): Promise<void> {
  const sb = getSupabase();
  await sb.from('mentor_messages').insert({
    phone,
    role,
    content,
    created_at: new Date().toISOString(),
  });
}

// ── Business data queries (for proactive insights) ──

export async function getBusinessSnapshot(): Promise<Record<string, unknown>> {
  const sb = getSupabase();
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const monthStart = `${today.slice(0, 7)}-01`;

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

  return {
    date: today,
    conversations_today: convToday.count || 0,
    conversations_month: convMonth.count || 0,
    appointments_month: citasMonth.count || 0,
    new_contacts_month: contactsMonth.count || 0,
  };
}
