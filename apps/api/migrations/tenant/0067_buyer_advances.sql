-- Wave 6 step 2: the ledger for advances from flat buyers. 0066 tried code L4006, which payroll (0048) already uses,
-- so it was skipped everywhere; this adds it under L4020 (skipped where a tenant already used the code or name; the
-- admin then maps the role).
INSERT INTO acc.account (parent_id, is_group, nature, code, name, kind, system_key)
SELECT g.id, false, g.nature, 'L4020', 'Advances from flat buyers', 'ordinary', 'advances_from_buyers'
FROM acc.account g WHERE g.system_key = 'other_current_liabilities'
  AND NOT EXISTS (SELECT 1 FROM acc.account a WHERE a.system_key = 'advances_from_buyers'
    OR lower(a.code) = 'l4020' OR lower(a.name) = 'advances from flat buyers');
