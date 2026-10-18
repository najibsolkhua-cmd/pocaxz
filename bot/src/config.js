// Настройки бота — из переменных окружения (см. .env.example).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export function loadConfig(env = process.env) {
  return {
    telegramToken: env.TELEGRAM_BOT_TOKEN || '',
    // Без ключа бот отвечает по базе знаний (поиск по разделам), с ключом — через Claude.
    anthropicKey: env.ANTHROPIC_API_KEY || '',
    model: env.CLAUDE_MODEL || 'claude-opus-5-5',
    port: Number(env.PORT) || 8787,
    dataDir: env.DATA_DIR || path.join(here, '..', 'data'),
    knowledgeDir: env.KNOWLEDGE_DIR || path.join(here, '..', 'knowledge'),
    readmePath: env.README_PATH || path.join(here, '..', '..', 'README.md'),
    installUrl: env.INSTALL_URL || 'https://solk-job.ru',
    humanSupport: env.HUMAN_SUPPORT || 'https://t.me/max_max3700',
    notifyPerHour: Number(env.NOTIFY_PER_HOUR) || 30,
  };
}
