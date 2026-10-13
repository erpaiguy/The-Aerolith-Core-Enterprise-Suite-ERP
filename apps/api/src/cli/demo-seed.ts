// Fills a fresh Aerolith Core install with a demo company and prints every sign-in. For trying the app by hand only;
// never on a production install. Everything goes through the API's own routes (in-process, no network), so the data
// is exactly what the screens would have made.
//   docker compose ... exec -T api node dist/cli/demo-seed.js --demo > demo-credentials.txt
// DEMO_OUT=<path> also writes the sign-ins there, with a .json beside it for the walkthrough tests.
// Refuses to run twice on the same install: the demo admin's email is the marker.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Sql } from 'postgres';

import { AppModule } from '../app.module.js';
import { OperatorAuthService } from '../auth/operator-auth.service.js';
import { timeStep, totpCode } from '../auth/totp.js';
import { configureApp } from '../bootstrap.js';
import { loadConfig } from '../config/config.js';
import { open } from '../crypto/secretbox.js';
import { CONTROL_DB } from '../db/db.module.js';
import { ProvisioningService } from '../provisioning/provisioning.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { seedCompany } from './demo-data.js';

export const DEMO = {
  operatorEmail: 'owner@aerolith.demo',
  operatorPassword: 'Aerolith-Console-Demo-26',
  adminEmail: 'admin@deshmukh-infra.demo',
  adminPassword: 'Deshmukh-Infra-Demo-26',
  company: 'Deshmukh Infra Pvt Ltd',
  staffPassword: 'Site-Office-Demo-26',
  portalPassword: 'Portal-Demo-2026',
};

type H = Record<string, string>;
interface Res {
  statusCode: number;
  body: string;
  json: <T>() => T;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class Seeder {
  readonly log: string[] = [];
  readonly failures: string[] = [];
  /** When each record the seeder made was made (on the simulated clock): fixups.ts moves created_at there. */
  readonly stamps = new Map<string, number>();
  constructor(
    readonly app: NestFastifyApplication,
    readonly control: Sql,
  ) {}

  async call<T = unknown>(
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    headers: H,
    payload?: unknown,
  ): Promise<T> {
    const res = (await this.app.inject({
      method,
      url: `/api${url}`,
      headers,
      ...(payload === undefined ? {} : { payload: payload as object }),
    })) as unknown as Res;
    if (res.statusCode >= 300)
      throw new Error(`${method} ${url} -> ${res.statusCode} ${res.body.slice(0, 500)}`);
    if (!res.body) return undefined as T;
    const out = res.json<T>();
    if (method === 'POST') {
      const id = (out as { id?: unknown } | null)?.id;
      if (typeof id === 'string' && UUID.test(id) && !this.stamps.has(id))
        this.stamps.set(id, Date.now());
    }
    return out;
  }
  post<T = unknown>(url: string, payload: unknown, headers: H) {
    return this.call<T>('POST', url, headers, payload ?? {});
  }
  get<T = unknown>(url: string, headers: H) {
    return this.call<T>('GET', url, headers);
  }
  put<T = unknown>(url: string, payload: unknown, headers: H) {
    return this.call<T>('PUT', url, headers, payload ?? {});
  }
  /** multipart/form-data with one file field. */
  async upload<T = unknown>(
    url: string,
    headers: H,
    name: string,
    mime: string,
    bytes: Buffer,
    fields: Record<string, string> = {},
  ) {
    const boundary = `----aerolith${randomUUID().slice(0, 8)}`;
    const parts = [
      ...Object.entries(fields).map(([k, v]) =>
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`),
      ),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ];
    const res = (await this.app.inject({
      method: 'POST',
      url: `/api${url}`,
      payload: Buffer.concat(parts),
      headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` },
    })) as unknown as Res;
    if (res.statusCode >= 300)
      throw new Error(`upload ${url} -> ${res.statusCode} ${res.body.slice(0, 500)}`);
    return res.json<T>();
  }
  note(line: string) {
    this.log.push(line);
    process.stdout.write(`  ${line}\n`);
  }
}

async function waitForStep(step: number) {
  while (timeStep(new Date()) < step) await new Promise((r) => setTimeout(r, 1000));
}

async function main() {
  if (!process.argv.includes('--demo')) {
    console.error(
      'This fills the install with a demo company and known passwords. Run it with --demo on a demo install only.',
    );
    process.exitCode = 2;
    return;
  }
  // The in-process app must not start the background loops that the running server already has.
  for (const k of ['PROVISIONING_WORKER', 'REPORTS_WORKER', 'WEBHOOK_WORKER', 'EMAIL_WORKER'])
    process.env[k] ??= 'off';
  // Thousands of sign-in-free calls in a few minutes: the per-route limits are for people, not for this.
  process.env.RATE_LIMIT_SCALE ??= '1000';
  const config = loadConfig();
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: ['error'],
  });
  configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const control = app.get<Sql>(CONTROL_DB);
  const s = new Seeder(app, control);
  try {
    const [done] =
      await control`SELECT 1 FROM core.owner_account WHERE lower(email) = ${DEMO.adminEmail}`;
    if (done) {
      console.error(
        `The demo is already on this install (${DEMO.adminEmail}). Start from an empty database to seed again.`,
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write('Seeding the demo company...\n');

    // --- the owner console's operator ---
    const { temporaryPassword } = await app
      .get(OperatorAuthService)
      .createOperator(DEMO.operatorEmail, 'Demo Owner', 'owner');
    const first = await s.post<{ enrollmentToken: string }>(
      '/owner/auth/login',
      { email: DEMO.operatorEmail, password: temporaryPassword },
      {},
    );
    const opMfa = await s.post<{ secret: string }>(
      '/auth/mfa/enroll',
      { enrollmentToken: first.enrollmentToken },
      {},
    );
    const opStep = timeStep(new Date());
    const opRecovery = await s.post<{ recoveryCodes: string[] }>(
      '/auth/mfa/confirm',
      { enrollmentToken: first.enrollmentToken, code: totpCode(opMfa.secret, opStep) },
      {},
    );
    const opLogin = await s.post<{ accessToken: string }>(
      '/owner/auth/login',
      {
        email: DEMO.operatorEmail,
        password: temporaryPassword,
        code: totpCode(opMfa.secret, opStep + 1),
      },
      {},
    );
    const changed = await s.post<{ accessToken: string }>(
      '/owner/auth/change-password',
      { currentPassword: temporaryPassword, newPassword: DEMO.operatorPassword },
      { authorization: `Bearer ${opLogin.accessToken}` },
    );
    const owner = { authorization: `Bearer ${changed.accessToken}` };

    // --- the tenant: trial, its database, a licence with room for the demo's people ---
    const trial = await s.post<{ tenantId: string; licenceId: string; licenceKey: string }>(
      '/owner/tenants',
      { email: DEMO.adminEmail, tenantName: DEMO.company },
      owner,
    );
    await s.post(
      `/owner/tenants/${trial.tenantId}/provision`,
      { provider: 'local_postgres' },
      owner,
    );
    // The running server's provisioning worker usually takes it; if none is running, provision here.
    for (let i = 0; ; i++) {
      const db = await s.get<{ status: string; lastError: string | null }>(
        `/owner/tenants/${trial.tenantId}/database`,
        owner,
      );
      if (db.status === 'ready') break;
      if (db.status === 'failed') throw new Error(`provisioning failed: ${db.lastError}`);
      if (i === 5)
        await app
          .get(ProvisioningService)
          .runUntilSettled(trial.tenantId)
          .catch(() => undefined);
      if (i > 120) throw new Error('provisioning timed out');
      await new Promise((r) => setTimeout(r, 1000));
    }
    await control`INSERT INTO core.tier (id, name, seat_cap, role_caps) VALUES ('demo', 'Demo', 25, NULL)
      ON CONFLICT DO NOTHING`;
    // Room for every person on their own browser and phone while trying it out.
    await control`UPDATE core.licence SET tier_id = 'demo', seat_cap = 25, max_devices = 50 WHERE id = ${trial.licenceId}`;

    // --- the tenant admin: password from the setup email, authenticator ---
    const entitlement = (
      await s.post<{ token: string }>(
        '/licences/activate',
        { key: trial.licenceKey, deviceId: randomUUID(), platform: 'browser' },
        {},
      )
    ).token;
    const [mail] = await control<{ data: { link: string } }[]>`
      SELECT data FROM core.email_outbox WHERE template = 'admin_password_setup' AND lower(to_email) = ${DEMO.adminEmail}
      ORDER BY created_at DESC LIMIT 1`;
    const setup = new URL(open(mail!.data.link, config.controlPlaneEncKey)).searchParams.get(
      'token',
    )!;
    await s.post('/auth/admin/set-password', { token: setup, newPassword: DEMO.adminPassword }, {});
    const adminLogin = (code?: string) =>
      s.post<{ accessToken: string; enrollmentToken: string }>(
        '/auth/login',
        {
          entitlementToken: entitlement,
          identifier: DEMO.adminEmail,
          password: DEMO.adminPassword,
          client: 'desktop',
          ...(code ? { code } : {}),
        },
        {},
      );
    const enrol = await adminLogin();
    const adMfa = await s.post<{ secret: string }>(
      '/auth/mfa/enroll',
      { enrollmentToken: enrol.enrollmentToken },
      {},
    );
    const adStep = timeStep(new Date());
    const adRecovery = await s.post<{ recoveryCodes: string[] }>(
      '/auth/mfa/confirm',
      { enrollmentToken: enrol.enrollmentToken, code: totpCode(adMfa.secret, adStep) },
      {},
    );
    // A code is accepted once: sign in with the next window's code after waiting for it, so the person's first sign-in
    // (with the current code from their app) is never refused as a repeat.
    await waitForStep(adStep + 1);
    const admin = {
      authorization: `Bearer ${(await adminLogin(totpCode(adMfa.secret, adStep + 1))).accessToken}`,
    };
    await waitForStep(adStep + 2);

    const tenantDb = await app.get(TenantConnections).forTenant(trial.tenantId);
    const out = await seedCompany(s, tenantDb, {
      admin,
      entitlement,
      tenantId: trial.tenantId,
      licenceId: trial.licenceId,
    });

    const web = process.env.DEMO_WEB_URL ?? 'http://localhost:8080';
    const ownerUrl = process.env.DEMO_OWNER_URL ?? 'http://localhost:8081';
    const lines = [
      'AEROLITH CORE DEMO: SIGN-INS (demo data only; do not reuse these passwords)',
      '',
      `Web app: ${web}`,
      `Licence key (enter once per browser, on the first screen): ${trial.licenceKey}`,
      '',
      'Tenant admin (needs an authenticator app: add the secret below as a time-based account):',
      `  email ${DEMO.adminEmail}  password ${DEMO.adminPassword}`,
      `  authenticator secret ${adMfa.secret}`,
      `  recovery codes ${adRecovery.recoveryCodes.join(' ')}`,
      '',
      'Staff (username + password, no authenticator):',
      ...out.staff
        .filter((u) => u.active)
        .map(
          (u) => `  ${u.username.padEnd(10)} ${DEMO.staffPassword}  ${u.role.padEnd(8)} ${u.what}`,
        ),
      'Former staff (their sign-in is turned off; shows what a deactivated user looks like):',
      ...out.staff.filter((u) => !u.active).map((u) => `  ${u.username.padEnd(10)} ${u.what}`),
      '',
      `Portal (vendors, subcontractors, clients): ${web}/portal/${trial.tenantId}`,
      ...out.portal.map(
        (u) => `  ${u.email.padEnd(30)} ${DEMO.portalPassword}  ${u.kind.padEnd(13)} ${u.party}`,
      ),
      '',
      `Owner console: ${ownerUrl} (this PC only)`,
      `  email ${DEMO.operatorEmail}  password ${DEMO.operatorPassword}`,
      `  authenticator secret ${opMfa.secret}`,
      `  recovery codes ${opRecovery.recoveryCodes.join(' ')}`,
      '',
      `Public API key (reports:read, tally), acts as the admin: ${out.apiKey}`,
      `  try: curl -s -H "Authorization: Bearer <key>" ${web}/api/v1/views`,
      '',
      `Detail pages (for the walkthrough tests): ${out.paths.join(' ')}`,
      '',
      'What is in it:',
      ...s.log.map((l) => `  - ${l}`),
      '',
    ];
    // Printed first: the sign-ins must never be lost to a file that cannot be written (the API container's folder is
    // read-only to it). Save them with: ... demo-seed.js --demo > demo-credentials.txt
    process.stdout.write(`\n${lines.join('\n')}\n`);
    const file = process.env.DEMO_OUT;
    if (file) {
      writeFileSync(file, lines.join('\n'));
      // The same, for the walkthrough test (tests/e2e/demo).
      writeFileSync(
        file.replace(/\.txt$/, '') + '.json',
        JSON.stringify(
          {
            licenceKey: trial.licenceKey,
            tenantId: trial.tenantId,
            admin: { email: DEMO.adminEmail, password: DEMO.adminPassword, secret: adMfa.secret },
            staff: out.staff
              .filter((u) => u.active)
              .map((u) => ({
                username: u.username,
                password: DEMO.staffPassword,
                role: u.role,
              })),
            portal: out.portal.map((u) => ({
              email: u.email,
              password: DEMO.portalPassword,
              kind: u.kind,
            })),
            paths: out.paths,
          },
          null,
          2,
        ),
      );
      process.stdout.write(`Also written to ${file}.\n`);
    }
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
