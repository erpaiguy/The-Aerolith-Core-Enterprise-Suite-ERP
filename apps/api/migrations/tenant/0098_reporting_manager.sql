-- Leave to the reporting manager (docs/wave8-plan.md step 8c.5): an approval level may go to the submitter's own
-- reporting manager (their employee record's manager); and while an approver is on approved leave, their own
-- reporting manager stands in for them, as a delegation set by hand would.
ALTER TABLE platform.approval_rule
  DROP CONSTRAINT approval_rule_approver_check,
  ADD CONSTRAINT approval_rule_approver_check
    CHECK (approver IN ('project_lead', 'manager', 'admin', 'user', 'designation', 'reporting_manager'));
ALTER TABLE platform.approval_step
  DROP CONSTRAINT approval_step_approver_check,
  ADD CONSTRAINT approval_step_approver_check
    CHECK (approver IN ('project_lead', 'manager', 'admin', 'user', 'designation', 'reporting_manager'));
CREATE INDEX IF NOT EXISTS employee_manager ON hr.employee (manager_id) WHERE manager_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS leave_application_approved ON hr.leave_application (from_date, to_date)
  WHERE status = 'approved';
