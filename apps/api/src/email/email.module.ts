import { Module } from '@nestjs/common';
import { EmailOwnerController } from './email.controller.js';
import { EmailWorker } from './email-worker.service.js';

@Module({
  controllers: [EmailOwnerController],
  providers: [EmailWorker],
  exports: [EmailWorker],
})
export class EmailModule {}
