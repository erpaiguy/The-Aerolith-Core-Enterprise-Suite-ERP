// Shared HTTP setup for the server and the tests, so tests exercise the same prefix and CORS rules as production.
import multipart from '@fastify/multipart';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
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
    methods: ['GET', 'POST'],
    maxAge: 600,
  });
  // File uploads (BOQ import). Limits are set per route; these are the outer bounds.
  void app.register(multipart, {
    limits: { fileSize: config.importMaxBytes, files: 1, fields: 10, parts: 20 },
  });
  return app;
}
