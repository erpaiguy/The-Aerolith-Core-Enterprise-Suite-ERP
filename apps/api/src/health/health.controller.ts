import { Controller, Get } from '@nestjs/common';
import { buildHealthReport, type HealthReport } from '@aerolith/shared';
import { API_VERSION } from '../version.js';

@Controller('health')
export class HealthController {
  @Get()
  check(): HealthReport {
    return buildHealthReport('api', API_VERSION);
  }
}
