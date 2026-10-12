import { Module } from '@nestjs/common';
import { ApprovalModule } from '../approvals/approval.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ProjectModule } from '../project/project.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { AssetController } from './assets.controller.js';
import { AssetService } from './assets.service.js';
import { BankController } from './bank.controller.js';
import { BankService } from './bank.service.js';
import { ClientBillController } from './client-bill.controller.js';
import { ClientBillService } from './client-bill.service.js';
import { EquipmentController } from './equipment.controller.js';
import { EquipmentService } from './equipment.service.js';
import { GstController } from './gst.controller.js';
import { GstService } from './gst.service.js';
import { LedgerController } from './ledger.controller.js';
import { LedgerService } from './ledger.service.js';
import { PayableController } from './payable.controller.js';
import { PayableService } from './payable.service.js';
import { ReceivableController } from './receivable.controller.js';
import { ReceivableService } from './receivable.service.js';
import { TdsReturnController } from './tds-returns.controller.js';
import { TdsReturnService } from './tds-returns.service.js';
import { StatementController } from './statements.controller.js';
import { StatementService } from './statements.service.js';
import { TallyController } from './tally.controller.js';
import { TallyService } from './tally.service.js';
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
    TdsReturnController,
    BankController,
    StatementController,
    TallyController,
    AssetController,
    EquipmentController,
  ],
  providers: [
    LedgerService,
    ClientBillService,
    ReceivableService,
    PayableService,
    SubcontractService,
    GstService,
    TdsReturnService,
    BankService,
    StatementService,
    TallyService,
    AssetService,
    EquipmentService,
  ],
  exports: [LedgerService],
})
export class AccountsModule {}
