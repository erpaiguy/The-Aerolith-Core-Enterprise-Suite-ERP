// Settings in one place (docs/wave9-plan.md step 9b.1). "You": name, password and two-factor sign-in, the morning
// email, and the legal documents you accepted. "This device": language, theme, how dates and amounts are written,
// and (in the desktop app) updates. "Company", for admins: the company's own settings screens, the server's updates,
// and the legal documents' review and who accepted them.
import { LEGAL_DOCUMENTS } from '@aerolith/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  PageHeader,
  Select,
  Table,
  Tabs,
  toast,
} from '@aerolith/ui';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { api } from '../api/client';
import { LANGUAGES, useLanguage, type Lang } from '../i18n/i18n';
import { useLegalState, type LegalState } from '../legal/Legal';
import { describeError, formatDate, formatDateTime, formatInr } from '../lib/format';
import { formats, setFormats, type DateStyle, type NumberStyle } from '../lib/locale';
import { setTheme, theme, type Theme } from '../lib/theme';
import { desktop } from '../platform';
import { useSession } from '../session/session';
import { useDesktopUpdate, useUpdateStatus } from '../updates/Updates';
import { DigestCard, YourNameCard } from './Passwords';
import { appVersion } from './shell/Personal';

type Section = 'you' | 'device' | 'company';

function LinkRow({ to, title, children }: { to: string; title: string; children: ReactNode }) {
  return (
    <li>
      <Link
        to={to}
        className="flex items-center justify-between gap-3 rounded-md px-3 py-2.5 hover:bg-surface-2"
      >
        <span>
          <span className="block text-sm font-medium text-fg">{title}</span>
          <span className="block text-xs text-fg-muted">{children}</span>
        </span>
        <ChevronRight className="size-4 shrink-0 text-fg-muted" aria-hidden />
      </Link>
    </li>
  );
}

export function SettingsScreen() {
  const session = useSession();
  const admin = session.user?.role === 'admin';
  const [section, setSection] = useState<Section>('you');
  return (
    <div className="space-y-5">
      <PageHeader
        title="Settings"
        subtitle="Your own settings, this device's, and the company's."
      />
      <Tabs
        label="Settings"
        value={section}
        onChange={setSection}
        tabs={[
          { id: 'you', label: 'You' },
          { id: 'device', label: 'This device' },
          ...(admin ? [{ id: 'company' as const, label: 'Company' }] : []),
        ]}
      >
        {section === 'you' && <You />}
        {section === 'device' && <Device />}
        {section === 'company' && admin && <Company />}
      </Tabs>
    </div>
  );
}

function You() {
  const legal = useLegalState();
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <YourNameCard />
      <Card title="Signing in">
        <ul className="-mx-3">
          <LinkRow to="/account/password" title="Password">
            Change the password you sign in with.
          </LinkRow>
          <LinkRow to="/two-factor" title="Two-factor sign-in">
            A code from your phone as well as your password.
          </LinkRow>
        </ul>
      </Card>
      <DigestCard />
      <Card title="Legal documents you accepted">
        {legal.data ? (
          <ul className="space-y-2 text-sm">
            {legal.data.documents
              .filter((d) => d.acceptedAt || d.mustAccept)
              .map((d) => (
                <li key={d.key} className="flex flex-wrap items-baseline justify-between gap-2">
                  <Link to="/legal/$key" params={{ key: d.key }} className="text-accent underline">
                    {d.title}
                  </Link>
                  <span className="text-xs text-fg-muted">
                    {d.acceptedAt
                      ? `Version of ${formatDate(d.version)}, accepted ${formatDateTime(d.acceptedAt)}`
                      : 'Not accepted yet'}
                  </span>
                </li>
              ))}
          </ul>
        ) : (
          <p className="text-sm text-fg-muted">Loading…</p>
        )}
      </Card>
    </div>
  );
}

function Device() {
  const { lang, setLang } = useLanguage();
  const [t, setT] = useState<Theme>(theme());
  const [f, setF] = useState(formats());
  const sample = new Date(2026, 9, 20);
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card title="Look and language">
        <div className="space-y-4">
          <Field
            label="Language"
            hint="The site screens (daily report, muster, stores, quality, safety) are translated."
          >
            <Select value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Theme">
            <Select
              value={t}
              onChange={(e) => {
                const next = e.target.value as Theme;
                setT(next);
                setTheme(next);
              }}
            >
              <option value="system">As this computer is set</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </Select>
          </Field>
        </div>
      </Card>
      <Card title="Dates and amounts">
        <form
          className="space-y-4"
          data-no-unsaved
          onSubmit={(e) => {
            e.preventDefault();
            setFormats(f);
          }}
        >
          <Field label="Dates">
            <Select
              value={f.date}
              onChange={(e) => setF({ ...f, date: e.target.value as DateStyle })}
            >
              <option value="medium">20 Oct 2026</option>
              <option value="numeric">20/10/2026</option>
              <option value="iso">2026-10-20</option>
            </Select>
          </Field>
          <Field label="Amounts">
            <Select
              value={f.number}
              onChange={(e) => setF({ ...f, number: e.target.value as NumberStyle })}
            >
              <option value="indian">Indian: ₹1,00,000</option>
              <option value="international">International: ₹100,000</option>
            </Select>
          </Field>
          <p className="text-xs text-fg-muted">
            Now: {formatDate(sample.toISOString())} · {formatInr('100000')}. Saving redraws the app.
          </p>
          <Button type="submit" variant="secondary">
            Save
          </Button>
        </form>
      </Card>
      {desktop() && <DesktopUpdates />}
    </div>
  );
}

function DesktopUpdates() {
  const state = useDesktopUpdate();
  const bridge = desktop()?.updates;
  const [busy, setBusy] = useState(false);
  if (!bridge)
    return (
      <Card title="Updates">
        <p className="text-sm text-fg-muted">
          This version of the desktop app updates by hand: install the new version over it.
        </p>
      </Card>
    );
  return (
    <Card title="Updates of this app">
      <div className="space-y-4 text-sm">
        <p>
          Version {appVersion()}
          {state?.checkedAt ? `, checked ${formatDateTime(state.checkedAt)}` : ''}.
        </p>
        <Field label="Install updates">
          <Select
            value={state?.mode ?? 'auto'}
            onChange={(e) => void bridge.setMode(e.target.value as 'auto' | 'manual')}
          >
            <option value="auto">Automatically, when I close the app</option>
            <option value="manual">Only when I choose</option>
          </Select>
        </Field>
        {state?.ready ? (
          <Alert tone="info">
            Version {state.ready.version} is downloaded and checked.{' '}
            <Button size="sm" onClick={() => void bridge.restart()}>
              Restart and update
            </Button>
          </Alert>
        ) : (
          state?.note && <p className="text-fg-muted">{state.note}</p>
        )}
        <Button
          variant="secondary"
          busy={busy || !!state?.checking}
          onClick={async () => {
            setBusy(true);
            await bridge.check();
            setBusy(false);
          }}
        >
          Check for updates
        </Button>
      </div>
    </Card>
  );
}

function Company() {
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card title="The company">
        <ul className="-mx-3">
          <LinkRow to="/settings/companies" title="Companies and letterhead">
            Legal names, PAN, GSTIN, addresses and the letterhead on printed documents.
          </LinkRow>
          <LinkRow to="/accounts/setup" title="Books">
            Financial year, books mode, numbering of vouchers and locked months.
          </LinkRow>
          <LinkRow to="/settings/approvals" title="Approval rules">
            Who approves what, and above which amounts.
          </LinkRow>
          <LinkRow to="/users" title="Users and permissions">
            People, roles, access profiles and two-factor sign-in for the company.
          </LinkRow>
          <LinkRow to="/settings/tenders" title="Tender settings">
            Folders, bid criteria and submission checklists for new tenders.
          </LinkRow>
          <LinkRow to="/backups" title="Backups and audit export">
            The nightly backup, restore checks, and the books for your auditors.
          </LinkRow>
          <LinkRow to="/settings/integrations" title="Integrations">
            API keys and webhooks for other systems.
          </LinkRow>
          <LinkRow to="/settings/imports" title="Imports">
            Bring in masters and opening data from spreadsheets.
          </LinkRow>
          <LinkRow to="/settings/audit" title="Audit trail">
            Who did what, and when.
          </LinkRow>
        </ul>
      </Card>
      <ServerUpdates />
      <LegalReview />
    </div>
  );
}

function ServerUpdates() {
  const status = useUpdateStatus();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const s = status.data;
  return (
    <Card title="Updates of the server">
      <div className="space-y-3 text-sm">
        <p>
          This server runs version {s?.current ?? '…'}.
          {s?.checkedAt ? ` Checked ${formatDateTime(s.checkedAt)}.` : ''}
        </p>
        {s && !s.configured && (
          <Alert tone="info">
            Release checks are not set up on this server: give it UPDATE_MANIFEST_URL and
            RELEASE_PUBLIC_KEY (see docs/release.md), or update by hand.
          </Alert>
        )}
        {s?.available && s.latest && (
          <Alert tone={s.required ? 'warning' : 'info'}>
            Version {s.latest.version} is out{s.required ? ' and fixes something important' : ''}.
            To update the server, run on it:{' '}
            <code className="font-mono">docker compose pull &amp;&amp; docker compose up -d</code>{' '}
            (a backup is taken first if you follow docs/release.md).
          </Alert>
        )}
        {s?.problem && <Alert tone="warning">{s.problem}</Alert>}
        <Button
          variant="secondary"
          busy={busy}
          disabled={!s?.configured}
          onClick={async () => {
            setBusy(true);
            try {
              qc.setQueryData(
                ['updates'],
                await api.request('/api/updates/check', { method: 'POST' }),
              );
              toast.success('Checked for updates');
            } catch (err) {
              toast.error('Could not check', describeError(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          Check now
        </Button>
      </div>
    </Card>
  );
}

function LegalReview() {
  const legal = useLegalState();
  const qc = useQueryClient();
  const accepted = useQuery({
    queryKey: ['legal-acceptances'],
    queryFn: () =>
      api.request<
        { username: string; name: string; document: string; version: string; acceptedAt: string }[]
      >('/api/tenant/legal/acceptances'),
  });
  const title = (key: string) => LEGAL_DOCUMENTS.find((d) => d.key === key)?.title ?? key;
  const review = async (document: string, reviewed: boolean) => {
    try {
      qc.setQueryData(
        ['legal'],
        await api.request<LegalState>('/api/tenant/legal/review', {
          method: 'POST',
          body: { document, reviewed },
        }),
      );
      toast.success(reviewed ? `${title(document)} marked reviewed` : 'Review taken back');
    } catch (err) {
      toast.error('Could not save', describeError(err));
    }
  };
  return (
    <Card title="Legal documents" className="lg:col-span-2">
      <p className="mb-3 text-sm text-fg-muted">
        These are drafts until your lawyer has read them. Mark each version reviewed once they have:
        its page then stops saying it is a draft.
      </p>
      <ul className="mb-5 space-y-2">
        {legal.data?.documents.map((d) => (
          <li key={d.key} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>
              <Link to="/legal/$key" params={{ key: d.key }} className="text-accent underline">
                {d.title}
              </Link>{' '}
              <span className="text-xs text-fg-muted">version of {formatDate(d.version)}</span>
            </span>
            {d.reviewed ? (
              <span className="flex items-center gap-2">
                <Badge tone="success">Reviewed by {d.reviewed.by}</Badge>
                <Button size="sm" variant="ghost" onClick={() => void review(d.key, false)}>
                  Take back
                </Button>
              </span>
            ) : (
              <Button size="sm" variant="secondary" onClick={() => void review(d.key, true)}>
                Mark reviewed by our lawyer
              </Button>
            )}
          </li>
        ))}
      </ul>
      <h3 className="mb-2 text-sm font-semibold">Who accepted which version</h3>
      {accepted.data?.length ? (
        <Table>
          <thead>
            <tr>
              <th>Person</th>
              <th>Document</th>
              <th>Version</th>
              <th>Accepted</th>
            </tr>
          </thead>
          <tbody>
            {accepted.data.map((a) => (
              <tr key={`${a.username}-${a.document}-${a.version}`}>
                <td>
                  {a.name} <span className="text-fg-muted">({a.username})</span>
                </td>
                <td>{title(a.document)}</td>
                <td>{formatDate(a.version)}</td>
                <td>{formatDateTime(a.acceptedAt)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <p className="text-sm text-fg-muted">Nobody yet.</p>
      )}
    </Card>
  );
}
