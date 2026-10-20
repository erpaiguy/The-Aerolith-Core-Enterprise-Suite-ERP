// One help topic as the Help panel and the Help centre show it (docs/wave9-plan.md step 9b.2): what the screen is
// for, the steps, the fields, and related topics. A related topic opens in place; "Go to the page" appears when its
// address can be made from the current one (a project's other sections, say).
import { Link } from '@tanstack/react-router';
import { fillRoute, topicByRoute } from './lookup';
import type { HelpTopic } from './topics';

export function TopicView({
  topic,
  params = {},
  onOpen,
  headingLevel = 3,
  goTo = true,
}: {
  topic: HelpTopic;
  /** Values for the '$name' parts of related addresses, from the page the help is for. */
  params?: Record<string, string>;
  /** Show a related topic; without it related topics are not listed. */
  onOpen?: (t: HelpTopic) => void;
  headingLevel?: 2 | 3;
  /** False on the page the topic is about. */
  goTo?: boolean;
}) {
  const H = headingLevel === 2 ? 'h2' : 'h3';
  const Sub = headingLevel === 2 ? 'h3' : 'h4';
  const related = (topic.related ?? [])
    .map((r) => topicByRoute(r))
    .filter((t): t is HelpTopic => !!t);
  const here = goTo ? fillRoute(topic.route, params) : null;
  return (
    <article className="space-y-3 text-sm" aria-label={`Help: ${topic.title}`}>
      <div>
        <H className="text-base font-semibold text-fg">{topic.title}</H>
        <p className="mt-1 text-fg-muted">{topic.purpose}</p>
      </div>
      <div>
        <Sub className="font-medium text-fg">How to</Sub>
        <ol className="mt-1 list-decimal space-y-1 pl-5 text-fg">
          {topic.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      </div>
      {topic.fields?.length ? (
        <div>
          <Sub className="font-medium text-fg">Fields</Sub>
          <dl className="mt-1 space-y-1">
            {topic.fields.map((f) => (
              <div key={f.name}>
                <dt className="inline font-medium text-fg">{f.name}: </dt>
                <dd className="inline text-fg-muted">{f.meaning}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
      {onOpen && related.length ? (
        <div>
          <Sub className="font-medium text-fg">Related</Sub>
          <ul className="mt-1 flex flex-wrap gap-2">
            {related.map((t) => (
              <li key={t.route}>
                <button
                  type="button"
                  onClick={() => onOpen(t)}
                  className="rounded-md border border-line px-2 py-1 text-xs text-accent hover:bg-surface-2"
                >
                  {t.title}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {here ? (
        <p>
          <Link to={here as never} className="text-accent underline">
            Go to {topic.title}
          </Link>
        </p>
      ) : null}
    </article>
  );
}
