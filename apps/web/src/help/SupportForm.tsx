// Get support (docs/wave9-plan.md step 9b.2): the person says what happened and what they expected; the app adds a
// diagnostics block (version, browser or desktop, platform, page, time, the last requests' references), shows all of
// it to read, and offers to copy it or open an email to support. There is no support service: nothing is sent by the
// app itself. The address is the product's support address when set, else the company's own email on its letterhead.
import { Alert, Button, Card, Field, Input, Textarea, toast } from '@aerolith/ui';
import { useState } from 'react';
import { useCompanies } from '../accounts/model';
import { recentRequests } from '../api/client';
import { isDesktop } from '../platform';
import { useLetterhead } from '../print/Letterhead';
import { appVersion } from '../screens/shell/Personal';
import {
  SUPPORT_EMAIL,
  browserName,
  diagnosticsText,
  mailtoLink,
  supportBody,
} from './diagnostics';
import { topicFor } from './lookup';

function platformName(): string {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return nav.userAgentData?.platform || nav.platform || '';
}

/** The address support requests go to, and where it came from. */
function useSupportAddress(): { to: string; whose: 'support' | 'company' | null } {
  const companies = useCompanies();
  const main = companies.data?.companies.find((c) => c.isDefault) ?? companies.data?.companies[0];
  const head = useLetterhead(SUPPORT_EMAIL ? null : main?.id);
  if (SUPPORT_EMAIL) return { to: SUPPORT_EMAIL, whose: 'support' };
  const email = head.data?.email.trim();
  return email ? { to: email, whose: 'company' } : { to: '', whose: null };
}

export function SupportForm({ page }: { page: string }) {
  const [subject, setSubject] = useState('');
  const [happened, setHappened] = useState('');
  const [expected, setExpected] = useState('');
  const [taken, setTaken] = useState(() => new Date());
  const address = useSupportAddress();
  const diagnostics = diagnosticsText({
    version: appVersion(),
    client: isDesktop() ? 'Desktop app' : 'Browser',
    browser: browserName(navigator.userAgent),
    platform: platformName(),
    page,
    screen: topicFor(page)?.title ?? null,
    at: taken,
    requests: recentRequests(),
  });
  const title = subject.trim() || 'Support request';
  const body = supportBody({ subject, happened, expected }, diagnostics);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${title}\n\n${body}`);
      toast.success('Copied: paste it into an email or a message to support');
    } catch {
      toast.error('Could not copy. Select the text below and copy it.');
    }
  };
  return (
    <div className="space-y-4">
      <Card title="Ask for support">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void copy();
          }}
        >
          <Field label="Subject">
            <Input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={120}
              placeholder="e.g. Cannot post a voucher"
            />
          </Field>
          <Field label="What happened" hint="The steps you took and any message you saw.">
            <Textarea value={happened} onChange={(e) => setHappened(e.target.value)} />
          </Field>
          <Field label="What you expected">
            <Textarea value={expected} onChange={(e) => setExpected(e.target.value)} />
          </Field>
          <p className="text-xs text-fg-muted">
            Do not type passwords, codes or other people’s personal details here.
          </p>
        </form>
      </Card>
      <Card
        title="Diagnostics"
        actions={
          <Button size="sm" variant="ghost" onClick={() => setTaken(new Date())}>
            Read again
          </Button>
        }
      >
        <p className="mb-2 text-sm text-fg-muted">
          This is added to your request so support can find the problem. It holds no passwords,
          sign-in tokens or business records.
        </p>
        <pre
          aria-label="Diagnostics"
          tabIndex={0}
          className="overflow-x-auto rounded-md bg-surface-2 p-3 text-xs whitespace-pre-wrap text-fg"
        >
          {diagnostics}
        </pre>
      </Card>
      {address.whose === null ? (
        <Alert tone="info">
          No support address is set. The email opens without one: type your administrator’s address.
        </Alert>
      ) : address.whose === 'company' ? (
        <p className="text-sm text-fg-muted">
          The email goes to your company’s contact, {address.to}, who passes it on to support.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={() => void copy()}>
          Copy
        </Button>
        <a
          href={mailtoLink(address.to, title, body)}
          className="inline-flex items-center justify-center rounded-md border border-line bg-surface-2 px-3.5 py-2 text-sm font-medium text-fg hover:bg-surface-3"
        >
          Email to support
        </a>
      </div>
    </div>
  );
}
