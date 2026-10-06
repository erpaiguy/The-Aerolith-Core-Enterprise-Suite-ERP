import { Global, Logger, Module } from '@nestjs/common';
import { APP_CONFIG, loadConfig } from './config.js';

@Global()
@Module({
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: () => {
        const config = loadConfig();
        if (config.ephemeralSecrets.length > 0 && config.env !== 'test') {
          new Logger('Config').warn(
            `Using throwaway secrets for: ${config.ephemeralSecrets.join(', ')}. Set them in .env (see .env.example).`,
          );
        }
        return config;
      },
    },
  ],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
