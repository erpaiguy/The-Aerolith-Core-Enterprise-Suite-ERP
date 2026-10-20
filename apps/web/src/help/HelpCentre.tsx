// The Help centre at /help (docs/wave9-plan.md step 9b.2): every screen's help by menu group with a search over them,
// the keyboard shortcuts, what's new in each release, the legal terms, and a support request with diagnostics.
import { LEGAL_DOCUMENTS } from '@aerolith/shared';
import { Card, EmptyState, Input, PageHeader, Tabs } from '@aerolith/ui';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { searchTopics } from './lookup';
import { SHORTCUTS } from './shortcuts';
import { SupportForm } from './SupportForm';
import { HELP_GROUPS, TOPICS, type HelpTopic } from './topics';
import { TopicView } from './TopicView';
import { WHATS_NEW } from './whats-new';

export const HELP_SECTIONS = ['topics', 'shortcuts', 'whats-new', 'support', 'legal'] as const;
export type HelpSection = (typeof HELP_SECTIONS)[number];
export interface HelpSearch {
  section?: HelpSection;
  /** The page support is asked about (the Help centre is not it). */
  from?: string;
}

/** The /help route's search: a known section, and a page path without its query. */
export function validateHelpSearch(s: Record<string, unknown>): HelpSearch {
  const out: HelpSearch = {};
  if (typeof s.section === 'string' && (HELP_SECTIONS as readonly string[]).includes(s.section))
    out.section = s.section as HelpSection;
  if (typeof s.from === 'string' && s.from.startsWith('/'))
    out.from = s.from.split(/[?#]/)[0]!.slice(0, 200);
  return out;
}

const TAB_LABEL: Record<HelpSection, string> = {
  topics: 'Help topics',
  shortcuts: 'Keyboard shortcuts',
  'whats-new': 'What’s new',
  support: 'Get support',
  legal: 'Terms and privacy',
};

export function HelpCentreScreen({ section = 'topics', from }: HelpSearch) {
  const navigate = useNavigate();
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Help centre"
        subtitle="How each screen works, the keyboard shortcuts, what is new, and how to reach support. Press ? or F1 on any page for its help."
      />
      <Tabs
        label="Help centre"
        tabs={HELP_SECTIONS.map((id) => ({ id, label: TAB_LABEL[id] }))}
        value={section}
        onChange={(id) =>
          void navigate({ to: '/help', search: { section: id, ...(from ? { from } : {}) } })
        }
      >
        <div className="pt-4">
          {section === 'topics' ? <Topics /> : null}
          {section === 'shortcuts' ? <Shortcuts /> : null}
          {section === 'whats-new' ? <WhatsNew /> : null}
          {section === 'support' ? <SupportForm page={from ?? '/help'} /> : null}
          {section === 'legal' ? <Legal /> : null}
        </div>
      </Tabs>
    </div>
  );
}

function TopicItem({ topic, onOpen }: { topic: HelpTopic; onOpen: (t: HelpTopic) => void }) {
  return (
    <details id={`help-${topic.route}`} className="rounded-md border border-line bg-surface">
      <summary className="cursor-pointer px-3 py-2 text-sm">
        <span className="font-medium text-fg">{topic.title}</span>
        <span className="ml-2 text-fg-muted">{topic.purpose}</span>
      </summary>
      <div className="border-t border-line px-3 py-3">
        <TopicView topic={topic} onOpen={onOpen} />
      </div>
    </details>
  );
}

function Topics() {
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<HelpTopic | null>(null);
  const hits = text.trim() ? searchTopics(text, TOPICS, 30) : [];
  if (picked)
    return (
      <Card>
        <button
          type="button"
          onClick={() => setPicked(null)}
          className="mb-3 text-sm text-accent underline"
        >
          Back to all topics
        </button>
        <TopicView topic={picked} onOpen={setPicked} headingLevel={2} />
      </Card>
    );
  return (
    <div className="space-y-4">
      <Input
        type="search"
        aria-label="Search help topics"
        placeholder="Search help: a screen or a task…"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {text.trim() ? (
        hits.length ? (
          <section aria-label="Topics found" className="space-y-2">
            {hits.map((h) => (
              <TopicItem key={h.topic.route} topic={h.topic} onOpen={setPicked} />
            ))}
          </section>
        ) : (
          <EmptyState title="No help found.">
            Try other words, or ask{' '}
            <Link to="/help" search={{ section: 'support' }} className="underline">
              support
            </Link>
            .
          </EmptyState>
        )
      ) : (
        HELP_GROUPS.map((g) => {
          const list = TOPICS.filter((t) => t.group === g);
          return list.length ? (
            <section key={g} aria-label={g} className="space-y-2">
              <h2 className="text-sm font-semibold text-fg-muted">{g}</h2>
              {list.map((t) => (
                <TopicItem key={t.route} topic={t} onOpen={setPicked} />
              ))}
            </section>
          ) : null;
        })
      )}
    </div>
  );
}

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {keys.map((k, i) => (
        <span key={k} className="flex items-center gap-1">
          {i ? <span className="text-xs text-fg-subtle">or</span> : null}
          <kbd className="rounded border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-fg">
            {k}
          </kbd>
        </span>
      ))}
    </span>
  );
}

function Shortcuts() {
  return (
    <div className="space-y-4">
      {SHORTCUTS.map((g) => (
        <Card key={g.where} title={g.where}>
          <table className="w-full text-sm">
            <thead className="sr-only">
              <tr>
                <th scope="col">Keys</th>
                <th scope="col">What it does</th>
              </tr>
            </thead>
            <tbody>
              {g.shortcuts.map((s) => (
                <tr key={s.keys.join() + s.does} className="border-t border-line first:border-t-0">
                  <td className="w-56 py-1.5 pr-3 align-top">
                    <Keys keys={s.keys} />
                  </td>
                  <td className="py-1.5 text-fg">{s.does}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ))}
    </div>
  );
}

function WhatsNew() {
  return (
    <div className="space-y-4">
      {WHATS_NEW.map((r) => (
        <Card key={r.version} title={`Version ${r.version}: ${r.title}`}>
          <p className="text-sm text-fg-muted">{r.summary}</p>
          {r.sections.map((s) => (
            <div key={s.heading} className="mt-3">
              <h3 className="text-sm font-medium text-fg">{s.heading}</h3>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-fg">
                {s.items.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            </div>
          ))}
        </Card>
      ))}
    </div>
  );
}

function Legal() {
  return (
    <Card title="Terms and privacy">
      <ul className="space-y-2 text-sm">
        {LEGAL_DOCUMENTS.map((d) => (
          <li key={d.key}>
            <Link to="/legal/$key" params={{ key: d.key }} className="text-accent underline">
              {d.title}
            </Link>
            <span className="ml-2 text-fg-muted">
              version of {d.version}
              {d.acceptedBy === 'admins' ? ', accepted by administrators for the company' : ''}
            </span>
          </li>
        ))}
        <li>
          <Link to="/licences" className="text-accent underline">
            Third-party licences
          </Link>
          <span className="ml-2 text-fg-muted">the open-source parts the app is built with</span>
        </li>
      </ul>
    </Card>
  );
}
