import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { UpdatesController } from './updates.controller.js';
import { UpdatesService } from './updates.service.js';

@Module({
  imports: [AuthModule],
  controllers: [UpdatesController],
  providers: [UpdatesService],
  exports: [UpdatesService],
})
export class UpdatesModule {}
