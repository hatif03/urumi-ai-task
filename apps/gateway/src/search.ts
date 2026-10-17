import type { PublicTool } from "./router.ts";

// BM25 over the permitted catalog. A catalog of hundreds of tools is searched in memory per request;
// ranking a few hundred short documents costs microseconds, and no model call or index is needed.
const K1 = 1.2;
const B = 0.75;
const NAME_WEIGHT = 3;

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((word) => (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word));
}

function documentFor(tool: PublicTool): string[] {
  const properties = Object.keys(((tool.inputSchema as { properties?: Record<string, unknown> }).properties) ?? {});
  const nameTokens = tokenize(`${tool.slug} ${tool.upstreamName}`);
  return [...Array.from({ length: NAME_WEIGHT }, () => nameTokens).flat(), ...tokenize(tool.description), ...tokenize(properties.join(" "))];
}

export type SearchHit = { tool: PublicTool; score: number };

export function searchTools(tools: PublicTool[], query: string, limit = 8): SearchHit[] {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length || !tools.length) return [];
  const docs = tools.map(documentFor);
  const average = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length || 1;
  const hits: SearchHit[] = [];
  docs.forEach((doc, index) => {
    const counts = new Map<string, number>();
    for (const token of doc) counts.set(token, (counts.get(token) ?? 0) + 1);
    let score = 0;
    for (const term of terms) {
      const tf = counts.get(term) ?? 0;
      if (!tf) continue;
      const containing = docs.filter((other) => other.includes(term)).length;
      const idf = Math.log(1 + (docs.length - containing + 0.5) / (containing + 0.5));
      score += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * doc.length) / average)));
    }
    if (score > 0) hits.push({ tool: tools[index]!, score });
  });
  return hits.sort((a, b) => b.score - a.score).slice(0, Math.min(Math.max(limit, 1), 25));
}
