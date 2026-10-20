// Help (docs/wave9-plan.md step 9b.2): the topic of a page by its route pattern, the search's scoring, the
// diagnostics text, and that every page in the main menu has help.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  browserName,
  diagnosticsText,
  mailtoLink,
  supportBody,
  type Diagnostics,
} from './diagnostics';
import { isHelpKey } from './HelpMenu';
import {
  fillRoute,
  paramsOf,
  routeScore,
  searchTopics,
  topicByRoute,
  topicFor,
  words,
} from './lookup';
import { TOPICS, type HelpTopic } from './topics';

const ID = '0b0e6a3c-2f8e-4a51-9d1e-3c5b7f0a9e21';

describe('topicFor', () => {
  it('finds a page by its fixed address', () => {
    expect(topicFor('/orders')?.title).toBe('Orders');
    expect(topicFor('/')?.title).toBe('Home');
    expect(topicFor('/accounts/payables')?.title).toBe('Payables');
  });

  it('fills "$name" parts with any value, and prefers fixed parts over them', () => {
    expect(topicFor(`/orders/${ID}`)?.route).toBe('/orders/$orderId');
    expect(topicFor(`/orders/revision/${ID}`)?.route).toBe('/orders/revision/$revisionId');
    expect(topicFor('/accounts/vouchers/new')?.route).toBe('/accounts/vouchers/new');
    expect(topicFor(`/accounts/vouchers/${ID}`)?.route).toBe('/accounts/vouchers/$voucherId');
    expect(topicFor(`/projects/${ID}/wbs`)?.route).toBe('/projects/$projectId/wbs');
    expect(topicFor('/registers/ncrs')?.title).toBe('NCRs');
  });

  it('ignores the query and hash, and falls back to the page above an unknown one', () => {
    expect(topicFor('/clients?kind=vendor')?.title).toBe('Parties');
    expect(topicFor(`/projects/${ID}#orders`)?.route).toBe('/projects/$projectId');
    expect(topicFor(`/projects/${ID}/something-new`)?.route).toBe('/projects/$projectId');
    expect(topicFor('/no-such-page')).toBeNull();
  });

  it('scores patterns by their fixed parts', () => {
    expect(routeScore('/orders/$orderId', '/orders/x')).toBe(1);
    expect(routeScore('/orders/revision/$id', '/orders/revision/x')).toBe(2);
    expect(routeScore('/orders/$orderId', '/orders')).toBeNull();
    expect(routeScore('/receipts/$id', '/orders/x')).toBeNull();
  });

  it('reads and fills the parts of an address', () => {
    const params = paramsOf('/projects/$projectId/wbs', `/projects/${ID}/wbs`);
    expect(params).toEqual({ projectId: ID });
    expect(fillRoute('/projects/$projectId/macro', params)).toBe(`/projects/${ID}/macro`);
    expect(fillRoute('/orders/$orderId', params)).toBeNull();
    expect(fillRoute('/orders', {})).toBe('/orders');
    expect(paramsOf('/orders/$orderId', '/receipts/x')).toEqual({});
  });
});

describe('searchTopics', () => {
  const t = (title: string, extra: Partial<HelpTopic> = {}): HelpTopic => ({
    route: `/${title.toLowerCase().replace(/\W+/g, '-')}`,
    group: 'Getting started',
    title,
    purpose: '',
    steps: [],
    ...extra,
  });

  it('puts a word in the title before one in the purpose, steps or fields', () => {
    const list = [
      t('Steps', { steps: ['Record the receipt.'] }),
      t('Purpose', { purpose: 'Every receipt there is.' }),
      t('Goods receipt'),
      t('Fields', { fields: [{ name: 'Mode', meaning: 'How the receipt came.' }] }),
    ];
    expect(searchTopics('receipt', list).map((h) => h.topic.title)).toEqual([
      'Goods receipt',
      'Purpose',
      'Steps',
      'Fields',
    ]);
  });

  it('needs every word, matches plurals and word starts, and ignores case', () => {
    const list = [t('Goods receipts'), t('Client receipt'), t('Orders')];
    expect(searchTopics('GOODS receipt', list).map((h) => h.topic.title)).toEqual([
      'Goods receipts',
    ]);
    expect(searchTopics('order', list).map((h) => h.topic.title)).toEqual(['Orders']);
    expect(searchTopics('rece', list)).toHaveLength(2);
    expect(searchTopics('   ', list)).toEqual([]);
    expect(words('Stock-ageing, the Orders’ glass')).toEqual([
      'stock',
      'ageing',
      'the',
      'order',
      'glass',
    ]);
  });

  it('finds the real topics a person would look for', () => {
    expect(searchTopics('receipt')[0]?.topic.title).toMatch(/receipt/i);
    expect(searchTopics('receipt').map((h) => h.topic.title)).toContain('Goods receipts');
    expect(searchTopics('trial balance')[0]?.topic.title).toBe('Trial balance');
    expect(searchTopics('GSTIN').length).toBeGreaterThan(0);
  });
});

describe('the topics', () => {
  it('cover at least 60 screens, each route once, with steps and a purpose', () => {
    expect(TOPICS.length).toBeGreaterThanOrEqual(60);
    expect(new Set(TOPICS.map((x) => x.route)).size).toBe(TOPICS.length);
    for (const x of TOPICS) {
      expect(x.purpose.length, x.route).toBeGreaterThan(10);
      expect(x.steps.length, x.route).toBeGreaterThan(0);
    }
  });

  it('only relate to topics that exist', () => {
    for (const x of TOPICS)
      for (const r of x.related ?? []) expect(topicByRoute(r), `${x.route} → ${r}`).toBeDefined();
  });

  it('cover every page in the main menu and the project workspace', () => {
    const shell = readFileSync(join(process.cwd(), 'src/screens/AppShell.tsx'), 'utf8');
    const menu = shell.slice(
      shell.indexOf('const menu: Group[]'),
      shell.indexOf('// Every page in the menu'),
    );
    const pages = [...menu.matchAll(/to: '([^']+)'/g)].map((m) => m[1]!);
    const workspace = [...shell.matchAll(/to: `\$\{home\}(\/[a-z-]+)`/g)].map(
      (m) => `/projects/${ID}${m[1]}`,
    );
    expect(pages.length).toBeGreaterThan(60);
    const missing = [...pages, ...workspace, '/approvals', '/'].filter((p) => {
      const found = topicFor(p);
      // A project section must have its own topic, not the project page's.
      return !found || (p.startsWith(`/projects/${ID}/`) && found.route === '/projects/$projectId');
    });
    expect(missing).toEqual([]);
  });
});

describe('diagnostics', () => {
  const d: Diagnostics = {
    version: '0.9.0',
    client: 'Browser',
    browser: 'Chrome 130',
    platform: 'Linux x86_64',
    page: '/orders?q=Sharma%20Steel#top',
    screen: 'Orders',
    at: new Date('2026-10-20T05:30:00.000Z'),
    requests: [
      {
        at: '2026-10-20T05:29:58.000Z',
        method: 'GET',
        path: '/api/tenant/orders',
        status: 200,
        ref: 'K7P2QX9M4A',
      },
      {
        at: '2026-10-20T05:29:59.000Z',
        method: 'POST',
        path: '/api/tenant/x?token=secret',
        status: 0,
        ref: null,
      },
    ],
  };

  it('says the version, where it runs, the page without its query, the time and the requests', () => {
    const text = diagnosticsText(d);
    expect(text).toBe(
      [
        'App version: 0.9.0',
        'Running in: Browser (Chrome 130)',
        'Platform: Linux x86_64',
        'Page: /orders (Orders)',
        'Time: 2026-10-20T05:30:00.000Z',
        'Recent requests (newest last):',
        '  2026-10-20T05:29:58.000Z GET /api/tenant/orders 200 ref K7P2QX9M4A',
        '  2026-10-20T05:29:59.000Z POST /api/tenant/x no answer',
      ].join('\n'),
    );
    expect(text).not.toMatch(/Sharma|secret|token/);
  });

  it('says so when there were no requests', () => {
    expect(diagnosticsText({ ...d, requests: [], screen: null, page: '/help' })).toContain(
      'Page: /help\nTime: 2026-10-20T05:30:00.000Z\nRecent requests (newest last):\n  none',
    );
  });

  it('puts the person’s words before the diagnostics, and makes a mailto link', () => {
    const body = supportBody({ subject: 'S', happened: 'It broke', expected: '' }, 'DIAG');
    expect(body).toBe(
      'What happened:\nIt broke\n\nWhat I expected:\n(not given)\n\n--- Diagnostics ---\nDIAG',
    );
    expect(mailtoLink('help@example.in', 'A & B', 'x\ny')).toBe(
      'mailto:help@example.in?subject=A%20%26%20B&body=x%0Ay',
    );
    expect(mailtoLink('', 'S', 'B')).toBe('mailto:?subject=S&body=B');
  });

  it('names the browser from its user agent', () => {
    expect(
      browserName(
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      ),
    ).toBe('Chrome 130');
    expect(
      browserName(
        'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0',
      ),
    ).toBe('Edge 130');
    expect(
      browserName('Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0'),
    ).toBe('Firefox 131');
    expect(
      browserName(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
      ),
    ).toBe('Safari 18');
  });
});

describe('the help key', () => {
  const press = (
    key: string,
    target: EventTarget = document.body,
    init: KeyboardEventInit = {},
  ) => {
    const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    Object.defineProperty(e, 'target', { value: target });
    return e;
  };

  it('is ? or F1 outside fields, without Ctrl, Alt or Cmd', () => {
    expect(isHelpKey(press('?'))).toBe(true);
    expect(isHelpKey(press('F1'))).toBe(true);
    expect(isHelpKey(press('/'))).toBe(false);
    expect(isHelpKey(press('?', document.body, { ctrlKey: true }))).toBe(false);
    expect(isHelpKey(press('?', document.createElement('input')))).toBe(false);
    expect(isHelpKey(press('?', document.createElement('textarea')))).toBe(false);
  });

  it('is not one a page already took', () => {
    const e = press('?');
    e.preventDefault();
    expect(isHelpKey(e)).toBe(false);
  });
});
