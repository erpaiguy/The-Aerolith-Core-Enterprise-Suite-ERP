import { createPrivateKey, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export const APP_CONFIG = Symbol('APP_CONFIG');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  CONTROL_DATABASE_URL: z
    .string()
    .url()
    .default('postgres://bench:bench@127.0.0.1:5432/aerolith_control'),
  SESSION_SIGNING_KEY: z.string().min(32).optional(),
  LICENCE_KEY_PEPPER: z.string().min(32).optional(),
  CONTROL_PLANE_ENC_KEY: z.string().optional(),
  ENTITLEMENT_PRIVATE_KEY_PEM: z.string().optional(),
  TRIAL_DAYS: z.coerce.number().int().positive().default(120),
  TRIAL_GRACE_DAYS: z.coerce.number().int().min(0).default(7),
  MIN_SHORTEN_NOTICE_DAYS: z.coerce.number().int().min(0).default(14),
  ENTITLEMENT_TTL_HOURS: z.coerce.number().int().positive().default(168),
  DEVICES_PER_SEAT: z.coerce.number().int().positive().default(2),
  PUBLIC_API_URL: z.string().url().default('http://127.0.0.1:3000'),
  WEBSITE_URL: z.string().url().default('http://localhost:5173'),
  LOCAL_PG_ADMIN_URL: z.string().url().optional(),
  SUPABASE_API_URL: z.string().url().default('https://api.supabase.com'),
  SUPABASE_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  SUPABASE_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  TENANT_DB_REGION: z.string().default('ap-south-1'),
  PROVISIONING_WORKER: z.enum(['on', 'off']).optional(),
  MAX_TENANT_POOLS: z.coerce.number().int().positive().default(50),
  IMPORT_DIR: z.string().optional(),
  IMPORT_MAX_MB: z.coerce.number().int().positive().max(1024).default(100),
  DOCUMENT_DIR: z.string().min(1).optional(),
  DOCUMENT_MAX_MB: z.coerce.number().int().positive().max(2048).default(200),
  DOCUMENT_JANITOR: z.enum(['on', 'off']).optional(),
  CLAMD_HOST: z.string().min(1).optional(),
  CLAMD_PORT: z.coerce.number().int().positive().max(65535).default(3310),
  RATE_LIMIT_SCALE: z.coerce.number().positive().default(1),
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
  CORS_ORIGINS: z.string().default('app://aerolith'),
  EMAIL_TRANSPORT: z.enum(['smtp', 'file', 'disabled']).optional(),
  EMAIL_FILE_DIR: z.string().default('.mail-outbox'),
  EMAIL_FROM: z.string().min(3).optional(),
  EMAIL_REPLY_TO: z.string().email().optional(),
  SUPPORT_EMAIL: z.string().email().optional(),
  EMAIL_MAX_PER_HOUR: z.coerce.number().int().positive().default(60),
  EMAIL_WORKER: z.enum(['on', 'off']).optional(),
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z.enum(['true', 'false']).default('false'),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),
  SMTP_REQUIRE_TLS: z.enum(['true', 'false']).default('true'),
});

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  controlDatabaseUrl: string;
  /** Signs access tokens and keys refresh-token HMACs. */
  sessionKey: Buffer;
  licenceKeyPepper: Buffer;
  controlPlaneEncKey: Buffer;
  entitlementPrivateKey: KeyObject;
  trialDays: number;
  trialGraceDays: number;
  minShortenNoticeDays: number;
  entitlementTtlHours: number;
  devicesPerSeat: number;
  publicApiUrl: string;
  websiteUrl: string;
  /** Superuser URL of a Postgres server for the local stand-in provider. Unset = provider disabled. */
  localPgAdminUrl: string | null;
  supabase: { apiUrl: string; clientId: string; clientSecret: string; redirectUri: string } | null;
  tenantDbRegion: string;
  provisioningWorker: boolean;
  maxTenantPools: number;
  /** Where uploaded import files wait while the user maps columns (docs/wave1-plan.md step 4). */
  importDir: string;
  importMaxBytes: number;
  /**
   * Tender documents (docs/wave1-plan.md step 10): where the files of tenants on our own Postgres are kept (one
   * folder per tenant), the largest file accepted, and the optional ClamAV daemon that scans each upload.
   */
  documents: {
    dir: string;
    maxBytes: number;
    clamd: { host: string; port: number } | null;
    /** Hourly: the trash retention rule, and files no document uses any more removed. */
    janitor: boolean;
  };
  /** Multiplies every rate limit (tests raise it). */
  rateLimitScale: number;
  /** Trust X-Forwarded-For (only behind a proxy/tunnel that sets it). */
  trustProxy: boolean;
  /** Origins allowed to call the API cross-origin (the desktop app). */
  corsOrigins: string[];
  email: {
    transport: 'smtp' | 'file' | 'disabled';
    fileDir: string;
    from: string;
    replyTo: string | null;
    supportEmail: string | null;
    maxPerHour: number;
    worker: boolean;
    smtp: {
      host: string;
      port: number;
      secure: boolean;
      user: string;
      password: string;
      requireTls: boolean;
    } | null;
  };
  /** Mark cookies Secure (true whenever the public API URL is https). */
  secureCookies: boolean;
  /** Secrets generated for this process only (development/test). Never true in production. */
  ephemeralSecrets: string[];
}

/**
 * Production refuses to start without every secret. Development and test generate throwaway secrets so the
 * app runs out of the box; anything signed or encrypted with them is useless after a restart.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // An empty value (`SMTP_HOST=` copied from .env.example) means "not set", not "set to an invalid value".
  const e = envSchema.parse(
    Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== '')),
  );
  const ephemeral: string[] = [];
  const required = <T>(name: string, value: T | undefined, make: () => T): T => {
    if (value !== undefined) return value;
    if (e.NODE_ENV === 'production') throw new Error(`${name} must be set in production`);
    ephemeral.push(name);
    return make();
  };

  const encKey = Buffer.from(
    required('CONTROL_PLANE_ENC_KEY', e.CONTROL_PLANE_ENC_KEY, () =>
      randomBytes(32).toString('base64'),
    ),
    'base64',
  );
  if (encKey.length !== 32)
    throw new Error('CONTROL_PLANE_ENC_KEY must be 32 bytes, base64-encoded');

  const pem = required('ENTITLEMENT_PRIVATE_KEY_PEM', e.ENTITLEMENT_PRIVATE_KEY_PEM, () =>
    generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  );
  const entitlementPrivateKey = createPrivateKey(pem.replace(/\\n/g, '\n'));
  if (entitlementPrivateKey.asymmetricKeyType !== 'ed25519')
    throw new Error('ENTITLEMENT_PRIVATE_KEY_PEM must be an Ed25519 key');

  return {
    env: e.NODE_ENV,
    controlDatabaseUrl: e.CONTROL_DATABASE_URL,
    sessionKey: Buffer.from(
      required('SESSION_SIGNING_KEY', e.SESSION_SIGNING_KEY, () =>
        randomBytes(32).toString('base64url'),
      ),
    ),
    licenceKeyPepper: Buffer.from(
      required('LICENCE_KEY_PEPPER', e.LICENCE_KEY_PEPPER, () =>
        randomBytes(32).toString('base64url'),
      ),
    ),
    controlPlaneEncKey: encKey,
    entitlementPrivateKey,
    trialDays: e.TRIAL_DAYS,
    trialGraceDays: e.TRIAL_GRACE_DAYS,
    minShortenNoticeDays: e.MIN_SHORTEN_NOTICE_DAYS,
    entitlementTtlHours: e.ENTITLEMENT_TTL_HOURS,
    devicesPerSeat: e.DEVICES_PER_SEAT,
    publicApiUrl: e.PUBLIC_API_URL,
    websiteUrl: e.WEBSITE_URL,
    localPgAdminUrl: e.LOCAL_PG_ADMIN_URL ?? null,
    supabase:
      e.SUPABASE_OAUTH_CLIENT_ID && e.SUPABASE_OAUTH_CLIENT_SECRET
        ? {
            apiUrl: e.SUPABASE_API_URL,
            clientId: e.SUPABASE_OAUTH_CLIENT_ID,
            clientSecret: e.SUPABASE_OAUTH_CLIENT_SECRET,
            redirectUri: new URL('/api/onboarding/supabase/callback', e.PUBLIC_API_URL).toString(),
          }
        : null,
    tenantDbRegion: e.TENANT_DB_REGION,
    provisioningWorker: (e.PROVISIONING_WORKER ?? (e.NODE_ENV === 'test' ? 'off' : 'on')) === 'on',
    maxTenantPools: e.MAX_TENANT_POOLS,
    importDir: e.IMPORT_DIR ?? join(tmpdir(), 'aerolith-imports'),
    importMaxBytes: e.IMPORT_MAX_MB * 1024 * 1024,
    documents: documentsConfig(e),
    rateLimitScale: e.RATE_LIMIT_SCALE,
    trustProxy: e.TRUST_PROXY === 'true',
    corsOrigins: e.CORS_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    email: emailConfig(e),
    secureCookies: e.PUBLIC_API_URL.startsWith('https://'),
    ephemeralSecrets: ephemeral,
  };
}

/**
 * Documents: production must name the folder (a Docker volume), so files never land in a container's own disk and
 * vanish with it. Development keeps them under the working directory.
 */
function documentsConfig(e: z.infer<typeof envSchema>): AppConfig['documents'] {
  if (!e.DOCUMENT_DIR && e.NODE_ENV === 'production')
    throw new Error('DOCUMENT_DIR must be set in production (a persistent volume)');
  return {
    dir: e.DOCUMENT_DIR ?? join(process.cwd(), '.documents'),
    maxBytes: e.DOCUMENT_MAX_MB * 1024 * 1024,
    clamd: e.CLAMD_HOST ? { host: e.CLAMD_HOST, port: e.CLAMD_PORT } : null,
    janitor: (e.DOCUMENT_JANITOR ?? (e.NODE_ENV === 'test' ? 'off' : 'on')) === 'on',
  };
}

/**
 * Email: production must say explicitly how mail is sent (smtp, or disabled on purpose). Development defaults to
 * writing .eml files. Unencrypted SMTP is refused in production.
 */
function emailConfig(e: z.infer<typeof envSchema>): AppConfig['email'] {
  const transport = e.EMAIL_TRANSPORT ?? (e.NODE_ENV === 'production' ? undefined : 'file');
  if (!transport) throw new Error('EMAIL_TRANSPORT must be set in production (smtp, or disabled)');
  const requireTls = e.SMTP_REQUIRE_TLS === 'true';
  if (e.NODE_ENV === 'production' && !requireTls)
    throw new Error('SMTP_REQUIRE_TLS=false is not allowed in production');
  if (transport === 'smtp' && (!e.SMTP_HOST || !e.EMAIL_FROM))
    throw new Error('EMAIL_TRANSPORT=smtp needs SMTP_HOST and EMAIL_FROM');
  return {
    transport,
    fileDir: e.EMAIL_FILE_DIR,
    from: e.EMAIL_FROM ?? 'Aerolith Core <no-reply@localhost>',
    replyTo: e.EMAIL_REPLY_TO ?? null,
    supportEmail: e.SUPPORT_EMAIL ?? null,
    maxPerHour: e.EMAIL_MAX_PER_HOUR,
    worker:
      transport !== 'disabled' &&
      (e.EMAIL_WORKER ?? (e.NODE_ENV === 'test' ? 'off' : 'on')) === 'on',
    smtp:
      transport === 'smtp'
        ? {
            host: e.SMTP_HOST!,
            port: e.SMTP_PORT,
            secure: e.SMTP_SECURE === 'true',
            user: e.SMTP_USER,
            password: e.SMTP_PASSWORD,
            requireTls,
          }
        : null,
  };
}
