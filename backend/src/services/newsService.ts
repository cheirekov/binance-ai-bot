import Parser from 'rss-parser';

import { config } from '../config.js';
import { logger } from '../logger.js';

interface CachedNews {
  fetchedAt: number;
  sentiment: number;
  headlines: string[];
}

const parser = new Parser();
let cache: CachedNews | null = null;

const positiveWords = ['surge', 'rally', 'bull', 'growth', 'adoption', 'upgrade', 'approve', 'record'];
const negativeWords = ['hack', 'crash', 'ban', 'sell-off', 'bear', 'lawsuit', 'downturn', 'scam', 'exploit'];

const scoreHeadline = (headline: string): number => {
  const text = headline.toLowerCase();
  let score = 0;
  for (const p of positiveWords) if (text.includes(p)) score += 1;
  for (const n of negativeWords) if (text.includes(n)) score -= 1;
  return score;
};

const fetchFeedSafely = async (feedUrl: string) => {
  const res = await fetch(feedUrl);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const xml = await res.text();
  return parser.parseString(xml);
};

export const getNewsSentiment = async (): Promise<CachedNews> => {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < config.newsCacheMinutes * 60 * 1000) {
    return cache;
  }

  const headlines: string[] = [];
  let totalScore = 0;
  let count = 0;

  for (const feedUrl of config.newsFeeds) {
    try {
      const feed = await fetchFeedSafely(feedUrl);
      for (const item of feed.items.slice(0, 10)) {
        const title = item.title ?? '';
        if (!title) continue;
        headlines.push(title);
        totalScore += scoreHeadline(title);
        count += 1;
      }
    } catch (error) {
      logger.warn({ err: error, feedUrl }, 'Failed to parse news feed');
    }
  }

  const sentiment = count > 0 ? totalScore / count : 0;
  cache = {
    fetchedAt: now,
    sentiment,
    headlines,
  };
  return cache;
};
