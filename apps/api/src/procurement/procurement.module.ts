import { Module } from '@nestjs/common';
import { ApprovalModule } from '../approvals/approval.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ProjectModule } from '../project/project.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { TenderModule } from '../tender/tender.module.js';
import { InventoryController } from './inventory.controller.js';
import { InventoryService } from './inventory.service.js';
import { ProcurementReportController } from './procurement-report.controller.js';
import { ReconciliationService } from './reconciliation.service.js';
import { RateContractService } from './rate-contract.service.js';
import { RateContractController } from './rate-contract.controller.js';
import { ProcurementReportService } from './procurement-report.service.js';
import { MaterialBudgetController } from './material-budget.controller.js';
import { MaterialBudgetService } from './material-budget.service.js';
import { ProjectRfqController } from './project-rfq.controller.js';
import { PurchaseOrderController } from './purchase-order.controller.js';
import { PurchaseOrderService } from './purchase-order.service.js';
import { ReceiptController } from './receipt.controller.js';
import { ReceiptService } from './receipt.service.js';
import { RequisitionController } from './requisition.controller.js';
import { RequisitionService } from './requisition.service.js';
import { DeliveryController } from './delivery.controller.js';
import { DeliveryService } from './delivery.service.js';
import { VendorMasterController } from './vendor-master.controller.js';
import { VendorMasterService } from './vendor-master.service.js';
import { DocumentsModule } from '../documents/documents.module.js';

@Module({
  imports: [
    ProvisioningModule,
    AuthModule,
    ProjectModule,
    ApprovalModule,
    TenderModule,
    DocumentsModule,
  ],
  controllers: [
    RateContractController,
    RequisitionController,
    MaterialBudgetController,
    ProjectRfqController,
    PurchaseOrderController,
    ReceiptController,
    InventoryController,
    ProcurementReportController,
    VendorMasterController,
    DeliveryController,
  ],
  providers: [
    RequisitionService,
    MaterialBudgetService,
    PurchaseOrderService,
    ReceiptService,
    InventoryService,
    ProcurementReportService,
    ReconciliationService,
    RateContractService,
    VendorMasterService,
    DeliveryService,
  ],
})
export class ProcurementModule {}
