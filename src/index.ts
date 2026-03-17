import express from 'express';
import { config, validateConfig } from './config';
import { handleWebhook, getDebugLog } from './webhook';
import { startProactiveCrons } from './proactive';
import { startPoller } from './poller';

validateConfig();

const app = express();
app.use(express.json());

// Health check
app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    agent: config.agentName,
    uptime: process.uptime(),
  });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Kapso webhook
app.post('/webhook', handleWebhook);

// Debug endpoint (temporary)
app.get('/debug', (_req, res) => {
  res.json({ logs: getDebugLog() });
});

// Start server
app.listen(config.port, () => {
  console.log(`[${config.agentName}] Server running on port ${config.port}`);
  startProactiveCrons();
  startPoller();
});
