// Email content. Plain text is the source of truth; the HTML is the same words in a minimal, inline-styled layout
// that renders in Outlook, Gmail and phone mail apps. Every interpolated value is HTML-escaped.

export interface RenderContext {
  productName: string;
  websiteUrl: string;
  supportEmail: string | null;
}

/** Values the worker resolves before rendering (decrypted links, the licence key). */
export interface TemplateInput {
  template: string;
  data: Record<string, unknown>;
  link?: string | undefined;
  licenceKey?: string | undefined;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export class UnknownTemplateError extends Error {}

const esc = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const date = (iso: unknown): string =>
  typeof iso === 'string'
    ? new Date(iso).toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'Asia/Kolkata',
      })
    : '';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

type Block =
  | { p: string }
  | { button: { label: string; href: string } }
  | { code: string }
  | { small: string };

function compose(ctx: RenderContext, subject: string, blocks: Block[]): RenderedEmail {
  const footer = `${ctx.productName} · ${ctx.websiteUrl}${ctx.supportEmail ? ` · ${ctx.supportEmail}` : ''}`;
  const text = [
    ...blocks.map((b) =>
      'p' in b
        ? b.p
        : 'button' in b
          ? `${b.button.label}:\n${b.button.href}`
          : 'code' in b
            ? `    ${b.code}`
            : b.small,
    ),
    '',
    '--',
    footer,
  ].join('\n\n');
  const htmlBlocks = blocks
    .map((b) => {
      if ('p' in b)
        return `<p style="margin:0 0 16px;font-size:15px;line-height:1.5;color:#16191f">${esc(b.p)}</p>`;
      if ('small' in b)
        return `<p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:#4d5562">${esc(b.small)}</p>`;
      if ('code' in b)
        return `<p style="margin:0 0 16px;padding:12px 16px;background:#f0f2f5;border-radius:6px;font-family:Consolas,Menlo,monospace;font-size:17px;letter-spacing:1px;color:#16191f">${esc(b.code)}</p>`;
      return `<p style="margin:0 0 20px"><a href="${esc(b.button.href)}" style="display:inline-block;padding:11px 20px;background:#c2410c;color:#ffffff;text-decoration:none;border-radius:6px;font-size:15px;font-weight:600">${esc(b.button.label)}</a></p>
<p style="margin:0 0 16px;font-size:12px;line-height:1.5;color:#7b8494">If the button does not work, copy this address into your browser:<br>${esc(b.button.href)}</p>`;
    })
    .join('\n');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:24px 12px;background:#f5f6f8;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #d9dde3;border-radius:8px;padding:28px 24px">
<p style="margin:0 0 20px;font-size:13px;font-weight:700;color:#c2410c;letter-spacing:.5px;text-transform:uppercase">${esc(ctx.productName)}</p>
${htmlBlocks}
</div>
<p style="max-width:560px;margin:16px auto 0;font-size:12px;color:#7b8494;text-align:center">${esc(footer)}</p>
</body></html>`;
  return { subject, text, html };
}

export function renderEmail(input: TemplateInput, ctx: RenderContext): RenderedEmail {
  const d = input.data;
  switch (input.template) {
    case 'licence_key':
      return compose(ctx, `Your ${ctx.productName} licence key`, [
        {
          p: `Welcome to ${ctx.productName}${str(d.tenantName) ? `, ${str(d.tenantName)}` : ''}. Here is your licence key:`,
        },
        { code: input.licenceKey ?? '' },
        {
          p: `Download the Windows app or open it in your browser at ${ctx.websiteUrl}, then enter this key once on each computer or browser you use. Spaces and lowercase are fine.`,
        },
        { p: `Your trial runs until ${date(d.endsAt)}.` },
        { small: 'Keep this email. If you lose the key, contact support and we can resend it.' },
      ]);
    case 'admin_password_setup':
      return compose(ctx, `Set your ${ctx.productName} admin password`, [
        { p: 'You are the admin of your company account. Create your password to get started:' },
        { button: { label: 'Create password', href: input.link ?? '' } },
        { p: 'At your first sign-in you will also set up an authenticator app on your phone.' },
        { small: 'This link works once and expires in 7 days.' },
      ]);
    case 'admin_password_reset':
      return compose(ctx, `Reset your ${ctx.productName} password`, [
        {
          p: 'Someone asked to reset the admin password for this email address. If it was you, choose a new password:',
        },
        { button: { label: 'Choose a new password', href: input.link ?? '' } },
        {
          small:
            'This link works once and expires in 30 minutes. If you did not ask for this, ignore this email; your password stays the same.',
        },
      ]);
    case 'admin_password_changed':
      return compose(ctx, `Your ${ctx.productName} password was changed`, [
        {
          p: 'The admin password for your account was just changed, and every device was signed out.',
        },
        { p: 'If you did not do this, contact support immediately.' },
      ]);
    case 'onboarding_link':
      return compose(ctx, `Connect your database to ${ctx.productName}`, [
        {
          p: 'Your company data lives in your own Supabase account. Connect it to finish setting up:',
        },
        { button: { label: 'Connect Supabase', href: input.link ?? '' } },
        { small: `This link expires on ${date(d.expiresAt)}.` },
      ]);
    case 'trial_changed':
      return compose(
        ctx,
        d.kind === 'extended' ? 'Your trial has been extended' : 'Your trial end date has changed',
        [
          { p: `Your ${ctx.productName} trial now ends on ${date(d.endsAt)}.` },
          ...(str(d.reason) ? [{ p: str(d.reason) }] : []),
        ],
      );
    case 'test':
      return compose(ctx, `${ctx.productName} test email`, [
        {
          p: 'This is a test message from the owner console. If you can read it, email delivery works.',
        },
      ]);
    default:
      throw new UnknownTemplateError(`unknown email template: ${input.template}`);
  }
}
