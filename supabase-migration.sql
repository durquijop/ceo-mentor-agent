-- CEO Mentor Agent — Tables
-- Run this in Supabase Dashboard → SQL Editor

CREATE TABLE IF NOT EXISTS mentor_sessions (
  id SERIAL PRIMARY KEY,
  phone TEXT UNIQUE NOT NULL,
  context JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mentor_messages (
  id SERIAL PRIMARY KEY,
  phone TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mentor_messages_phone ON mentor_messages(phone);
CREATE INDEX IF NOT EXISTS idx_mentor_messages_created ON mentor_messages(created_at DESC);

-- Enable RLS but allow service_role full access
ALTER TABLE mentor_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mentor_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_mentor_sessions" ON mentor_sessions
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "service_role_all_mentor_messages" ON mentor_messages
  FOR ALL USING (auth.role() = 'service_role');
