export const config = {
  port: parseInt(process.env.PORT || '3000', 10),

  // Kapso
  kapsoApiKey: process.env.KAPSO_API_KEY!,
  kapsoWebhookSecret: process.env.KAPSO_WEBHOOK_SECRET || '',
  phoneNumberId: process.env.KAPSO_PHONE_NUMBER_ID!,

  // Supabase
  supabaseUrl: process.env.SUPABASE_URL!,
  supabaseKey: process.env.SUPABASE_SERVICE_ROLE!,

  // LLM (Anthropic direct)
  llmApiKey: process.env.LLM_API_KEY!,
  llmModel: process.env.LLM_MODEL || 'claude-sonnet-4-20250514',
  llmBaseUrl: process.env.LLM_BASE_URL || 'https://api.anthropic.com',

  // Diego's numbers (owner)
  ownerNumbers: ['17865698666', '16787901191'],

  // Agent identity
  agentName: 'Atlas',
};

export function validateConfig(): void {
  const required = ['kapsoApiKey', 'phoneNumberId', 'supabaseUrl', 'supabaseKey', 'llmApiKey'] as const;
  const missing = required.filter((k) => !config[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }
}
