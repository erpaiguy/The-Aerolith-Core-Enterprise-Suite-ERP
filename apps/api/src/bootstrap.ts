// Shared HTTP setup for the server and the tests, so tests exercise the same prefix and CORS rules as production.
import { randomBytes } from 'node:crypto';
import multipart from '@fastify/multipart';
import { Logger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { CLIENT_HEADER } from './auth/cookie.js';
import { APP_CONFIG, type AppConfig } from './config/config.js';

export function configureApp(app: NestFastifyApplication): NestFastifyApplication {
  const config = app.get<AppConfig>(APP_CONFIG);
  app.setGlobalPrefix('api');
  // Same-origin browser requests need no CORS. Listed origins (e.g. the desktop app's app://aerolith) may call the API
  // with a bearer token; cookies are never sent cross-origin.
  app.enableCors({
    origin: config.corsOrigins,
    credentials: false,
    allowedHeaders: ['authorization', 'content-type', CLIENT_HEADER],
    exposedHeaders: [REQUEST_ID_HEADER, 'content-disposition'],
    methods: ['GET', 'POST'],
    maxAge: 600,
  });
  // File uploads (BOQ import). Limits are set per route; these are the outer bounds.
  void app.register(multipart, {
    limits: { fileSize: config.importMaxBytes, files: 1, fields: 10, parts: 20 },
  });
  requestIds(app.getHttpAdapter().getInstance() as FastifyInstance);
  return app;
}

/** Sent on every response; the error dialog shows it so a person can quote it to support (docs/wave9-plan.md 9a.2). */
export const REQUEST_ID_HEADER = 'x-request-id';
const refs = new WeakMap<FastifyRequest, string>();
/** The request's reference: 10 letters and digits, unambiguous to read out over the phone. */
export const requestRef = (req: FastifyRequest) => refs.get(req);

function requestIds(fastify: FastifyInstance) {
  const log = new Logger('Request');
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  fastify.addHook('onRequest', (req, reply, done) => {
    const ref = [...randomBytes(10)].map((b) => alphabet[b % alphabet.length]).join('');
    refs.set(req, ref);
    void reply.header(REQUEST_ID_HEADER, ref);
    // The API's own answers are never framed, sniffed or cached by a shared cache, even when reached without the
    // web server in front (step 9b.5). Routes that serve files set their own type, disposition and policy.
    void reply.header('X-Content-Type-Options', 'nosniff');
    void reply.header('X-Frame-Options', 'DENY');
    void reply.header('Referrer-Policy', 'no-referrer');
    if (!reply.hasHeader('Cache-Control')) void reply.header('Cache-Control', 'no-store');
    done();
  });
  // Server faults are logged with the reference the person was shown, next to the stack Nest logs.
  fastify.addHook('onResponse', (req, reply, done) => {
    if (reply.statusCode >= 500)
      log.error(`${refs.get(req)} ${req.method} ${req.url.split('?')[0]} -> ${reply.statusCode}`);
    done();
  });
}
