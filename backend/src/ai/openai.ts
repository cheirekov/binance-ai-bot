import OpenAI from 'openai';

import { config } from '../config.js';

let client: OpenAI | null = null;

export const getClient = (): OpenAI | null => {
  if (client) return client;
  if (!config.aiApiKey) return null;
  client = new OpenAI({ apiKey: config.aiApiKey, baseURL: config.aiBaseUrl || undefined });
  return client;
};
