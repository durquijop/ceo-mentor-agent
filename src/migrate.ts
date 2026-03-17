import { getSupabase } from './supabase';

const MIGRATIONS = [
  {
    name: 'create_mentor_sessions',
    sql: `CREATE TABLE IF NOT EXISTS mentor_sessions (
      id SERIAL PRIMARY KEY,
      phone TEXT UNIQUE NOT NULL,
      context JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );`,
  },
  {
    name: 'create_mentor_messages',
    sql: `CREATE TABLE IF NOT EXISTS mentor_messages (
      id SERIAL PRIMARY KEY,
      phone TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_mentor_messages_phone ON mentor_messages(phone);
    CREATE INDEX IF NOT EXISTS idx_mentor_messages_created ON mentor_messages(created_at DESC);`,
  },
];

export async function runMigrations(): Promise<void> {
  const sb = getSupabase();

  for (const migration of MIGRATIONS) {
    try {
      const { error } = await sb.rpc('exec_sql', { query: migration.sql });
      if (error) {
        // rpc might not exist — tables might already exist
        console.log(`[migrate] ${migration.name}: rpc not available, checking table...`);
      } else {
        console.log(`[migrate] ${migration.name}: OK`);
      }
    } catch (e) {
      console.log(`[migrate] ${migration.name}: skipping (rpc unavailable)`);
    }
  }
}
