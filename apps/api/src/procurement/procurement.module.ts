import { Module } from '@nestjs/common';
import { ApprovalModule } from '../approvals/approval.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ProjectModule } from '../project/project.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { TenderModule } from '../tender/tender.module.js';
import { InventoryController } from './inventory.controller.js';
import { InventoryService } from './inventory.service.js';
import { MaterialBudgetController } from './material-budget.controller.js';
import { MaterialBudgetService } from './material-budget.service.js';
import { ProjectRfqController } from './project-rfq.controller.js';
import { PurchaseOrderController } from './purchase-order.controller.js';
import { PurchaseOrderService } from './purchase-order.service.js';
import { ReceiptController } from './receipt.controller.js';
import { ReceiptService } from './receipt.service.js';
import { RequisitionController } from './requisition.controller.js';
import { RequisitionService } from './requisition.service.js';

@Module({
  imports: [ProvisioningModule, AuthModule, ProjectModule, ApprovalModule, TenderModule],
  controllers: [
    RequisitionController,
    MaterialBudgetController,
    ProjectRfqController,
    PurchaseOrderController,
    ReceiptController,
    InventoryController,
  ],
  providers: [
    RequisitionService,
    MaterialBudgetService,
    PurchaseOrderService,
    ReceiptService,
    InventoryService,
  ],
})
export class ProcurementModule {}
