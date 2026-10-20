// Finding help (docs/wave9-plan.md step 9b.2): the topic of the page at an address, matched against the topics'
// route patterns, and a simple scored search over every topic's title, purpose, steps and fields.
import { TOPICS, type HelpTopic } from './topics';

const parts = (path: string) => path.split(/[?#]/)[0]!.split('/').filter(Boolean);

/**
 * How well a route pattern fits an address: the number of fixed parts it matched (a better fit than a '$name' part),
 * or null when it does not fit.
 */
export function routeScore(pattern: string, path: string): number | null {
  const want = parts(pattern);
  const got = parts(path);
  if (want.length !== got.length) return null;
  let score = 0;
  for (let i = 0; i < want.length; i++) {
    if (want[i]!.startsWith('$')) continue;
    if (want[i] !== got[i]) return null;
    score++;
  }
  return score;
}

/** The topic of the page at this address; failing that, of the page it sits under (never Home for an unknown page). */
export function topicFor(path: string, topics: HelpTopic[] = TOPICS): HelpTopic | null {
  let segs = parts(path);
  while (true) {
    const at = `/${segs.join('/')}`;
    let best: HelpTopic | null = null;
    let bestScore = -1;
    for (const t of topics) {
      const s = routeScore(t.route, at);
      if (s !== null && s > bestScore) {
        best = t;
        bestScore = s;
      }
    }
    if (best) return best;
    if (segs.length <= 1) return null;
    segs = segs.slice(0, -1);
  }
}

/** The '$name' parts of an address, read with a pattern it fits ({} when it does not fit). */
export function paramsOf(pattern: string, path: string): Record<string, string> {
  if (routeScore(pattern, path) === null) return {};
  const got = parts(path);
  const out: Record<string, string> = {};
  parts(pattern).forEach((p, i) => {
    if (p.startsWith('$')) out[p.slice(1)] = got[i]!;
  });
  return out;
}

/** A pattern made into an address with these values; null when one is missing. */
export function fillRoute(pattern: string, params: Record<string, string>): string | null {
  const out: string[] = [];
  for (const p of parts(pattern)) {
    if (!p.startsWith('$')) out.push(p);
    else if (params[p.slice(1)]) out.push(params[p.slice(1)]!);
    else return null;
  }
  return `/${out.join('/')}`;
}

export const topicByRoute = (route: string, topics: HelpTopic[] = TOPICS): HelpTopic | undefined =>
  topics.find((t) => t.route === route);

/** Lower-case words; a plural 's' dropped from longer words so "orders" finds "order". */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

function hits(haystack: string, word: string): number {
  const ws = words(haystack);
  if (ws.includes(word)) return 2;
  return ws.some((w) => w.startsWith(word)) ? 1 : 0;
}

export interface HelpHit {
  topic: HelpTopic;
  score: number;
}

/**
 * Topics that hold every word of the query, best first. A word in the title counts most, then the purpose, the
 * fields' names, the steps and the fields' meanings; a whole word counts double a word's start.
 */
export function searchTopics(query: string, topics: HelpTopic[] = TOPICS, limit = 12): HelpHit[] {
  const q = words(query);
  if (!q.length) return [];
  const phrase = query.trim().toLowerCase();
  const out: HelpHit[] = [];
  for (const t of topics) {
    let total = 0;
    let all = true;
    for (const w of q) {
      const s =
        hits(t.title, w) * 10 +
        hits(t.purpose, w) * 4 +
        hits((t.fields ?? []).map((f) => f.name).join(' '), w) * 3 +
        hits(t.steps.join(' '), w) * 2 +
        hits((t.fields ?? []).map((f) => f.meaning).join(' '), w);
      if (!s) {
        all = false;
        break;
      }
      total += s;
    }
    if (!all) continue;
    if (t.title.toLowerCase().includes(phrase)) total += 20;
    out.push({ topic: t, score: total });
  }
  return out
    .sort((a, b) => b.score - a.score || a.topic.title.localeCompare(b.topic.title))
    .slice(0, limit);
}
