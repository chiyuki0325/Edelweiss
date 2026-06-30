import type { CahciuaTool } from './types';
import { createTool } from './types';

const WEB_SEARCH_TIMEOUT_MS = 15_000;

export const createWebSearchTool = (tavilyKey: string): CahciuaTool => createTool({
  name: 'web_search',
  description: 'Search the web using Tavily. Returns an answer and up to 5 results.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query.' },
    },
    required: ['query'],
  },
  execute: async input => {
    const { query } = input as { query: string };
    const resp = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: tavilyKey,
        query,
        search_depth: 'basic',
        include_answer: true,
        max_results: 5,
      }),
      signal: AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return {
        content: JSON.stringify({ error: `Tavily API error: ${resp.status}`, detail: text }),
        requiresFollowUp: true,
      };
    }
    const data = await resp.json() as { answer?: string; results?: { title: string; url: string; content: string }[] };
    return {
      content: JSON.stringify({
        answer: data.answer ?? null,
        results: (data.results ?? []).map(r => ({ title: r.title, url: r.url, snippet: r.content })),
      }),
      requiresFollowUp: true,
    };
  },
});
