// A BOQ made by mistake is archived, never deleted (docs/wave1-plan.md step 7). It stays readable but changes
// nothing until it is restored.
import { ConflictException } from '@nestjs/common';

export function refuseArchived(b: { archived: boolean }) {
  if (b.archived)
    throw new ConflictException({
      code: 'boq_archived',
      message: 'This BOQ is archived. Restore it to change it.',
    });
}
