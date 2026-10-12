-- Wave 6 step 1 (docs/wave6-plan.md): the CRM before a tender. Contacts at parties; leads with their stage, value,
-- probability and expected award month; interactions with follow-ups; a lead converted to a tender follows it.
CREATE SCHEMA crm;
GRANT USAGE ON SCHEMA crm TO aerolith_app;

CREATE TABLE crm.contact (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id uuid NOT NULL REFERENCES platform.party (id),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 120),
  role text NOT NULL DEFAULT '' CHECK (length(role) <= 120),
  phone text NOT NULL DEFAULT '' CHECK (length(phone) <= 40),
  email text NOT NULL DEFAULT '' CHECK (length(email) <= 254),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES platform."user" (id)
);
CREATE INDEX contact_party ON crm.contact (party_id);
SELECT platform.secure_table('crm.contact');

CREATE TABLE crm.lead (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 3 AND 300),
  party_id uuid REFERENCES platform.party (id),
  organisation text CHECK (organisation IS NULL OR length(trim(organisation)) BETWEEN 2 AND 200),
  contact_id uuid REFERENCES crm.contact (id),
  source text NOT NULL DEFAULT 'other' CHECK (source IN
    ('referral', 'repeat_client', 'website', 'cold_call', 'event', 'portal', 'other')),
  segment text NOT NULL DEFAULT 'buildings' CHECK (segment IN
    ('buildings', 'interiors', 'joinery', 'mep', 'real_estate', 'other')),
  location text NOT NULL DEFAULT '' CHECK (length(location) <= 200),
  value numeric(20, 2) CHECK (value IS NULL OR value >= 0),
  probability int CHECK (probability IS NULL OR probability BETWEEN 0 AND 100),   -- NULL: the stage's default
  expected_month date CHECK (expected_month IS NULL OR extract(day FROM expected_month) = 1),
  stage text NOT NULL DEFAULT 'new' CHECK (stage IN
    ('new', 'qualified', 'proposal', 'negotiation', 'tender', 'won', 'lost', 'dropped')),
  reason text NOT NULL DEFAULT '' CHECK (length(reason) <= 1000),
  owner_id uuid NOT NULL REFERENCES platform."user" (id),
  tender_id uuid UNIQUE REFERENCES tender.tender (id),
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 4000),
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES platform."user" (id),
  row_version int NOT NULL DEFAULT 1,
  CHECK (party_id IS NOT NULL OR organisation IS NOT NULL),
  CHECK (stage <> 'tender' OR tender_id IS NOT NULL),
  CHECK (stage NOT IN ('lost', 'dropped') OR length(trim(reason)) > 0)
);
CREATE INDEX lead_owner ON crm.lead (owner_id);
CREATE INDEX lead_party ON crm.lead (party_id);
SELECT platform.secure_table('crm.lead');
REVOKE DELETE, TRUNCATE ON crm.lead FROM aerolith_app;

CREATE TABLE crm.interaction (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES crm.lead (id),
  kind text NOT NULL CHECK (kind IN ('call', 'meeting', 'site_visit', 'email', 'note')),
  happened_at timestamptz NOT NULL,
  summary text NOT NULL CHECK (length(trim(summary)) BETWEEN 1 AND 4000),
  contact_id uuid REFERENCES crm.contact (id),
  follow_up_on date,
  follow_up text NOT NULL DEFAULT '' CHECK (length(follow_up) <= 500),
  follow_up_done_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES platform."user" (id),
  CHECK (follow_up_on IS NOT NULL OR (follow_up = '' AND follow_up_done_at IS NULL))
);
CREATE INDEX interaction_lead ON crm.interaction (lead_id, happened_at DESC);
CREATE INDEX interaction_follow_up ON crm.interaction (follow_up_on) WHERE follow_up_on IS NOT NULL AND follow_up_done_at IS NULL;
SELECT platform.secure_table('crm.interaction');
REVOKE DELETE, TRUNCATE ON crm.interaction FROM aerolith_app;
