import { Module } from '@nestjs/common';
import { ApprovalModule } from '../approvals/approval.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ProjectModule } from '../project/project.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { ClientBillController } from './client-bill.controller.js';
import { ClientBillService } from './client-bill.service.js';
import { GstController } from './gst.controller.js';
import { GstService } from './gst.service.js';
import { LedgerController } from './ledger.controller.js';
import { LedgerService } from './ledger.service.js';
import { PayableController } from './payable.controller.js';
import { PayableService } from './payable.service.js';
import { ReceivableController } from './receivable.controller.js';
import { ReceivableService } from './receivable.service.js';
import { SubcontractController } from './subcontract.controller.js';
import { SubcontractService } from './subcontract.service.js';

/** Wave 3's money (docs/wave3-plan.md): the books first; billing, payables and the rest post into them. */
@Module({
  imports: [ProvisioningModule, AuthModule, ProjectModule, ApprovalModule],
  controllers: [
    LedgerController,
    ClientBillController,
    ReceivableController,
    PayableController,
    SubcontractController,
    GstController,
  ],
  providers: [
    LedgerService,
    ClientBillService,
    ReceivableService,
    PayableService,
    SubcontractService,
    GstService,
  ],
  exports: [LedgerService],
})
export class AccountsModule {}
