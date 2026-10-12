-- Wave 3 step 8a (docs/wave3-plan.md): the ledger the year end's closing stock is posted against ("changes in
-- inventories", Schedule III), skipped where a tenant already used the code or name; the admin then maps the role.
INSERT INTO acc.account (parent_id, is_group, nature, code, name, kind, system_key)
SELECT g.id, false, g.nature, 'X1090', 'Changes in inventories', 'ordinary', 'inventory_change'
FROM acc.account g
WHERE g.system_key = 'materials_consumed'
  AND NOT EXISTS (SELECT 1 FROM acc.account a WHERE lower(a.code) = 'x1090' OR lower(a.name) = 'changes in inventories');
