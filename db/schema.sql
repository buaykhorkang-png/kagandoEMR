CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS "session" (
  "sid" VARCHAR NOT NULL PRIMARY KEY,
  "sess" JSON NOT NULL,
  "expire" TIMESTAMP(6) NOT NULL
);

CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(80) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('clinician', 'nurse', 'pharmacist', 'clerk', 'laboratory', 'management', 'administrator')),
  requested_role TEXT CHECK (requested_role IS NULL OR requested_role IN ('clinician', 'nurse', 'pharmacist', 'clerk', 'laboratory', 'management', 'administrator')),
  approval_status TEXT NOT NULL DEFAULT 'approved' CHECK (approval_status IN ('pending', 'approved', 'rejected')),
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(160);
ALTER TABLE users ADD COLUMN IF NOT EXISTS requested_role TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('clinician', 'nurse', 'pharmacist', 'clerk', 'laboratory', 'management', 'administrator'));
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_requested_role_check;
ALTER TABLE users ADD CONSTRAINT users_requested_role_check CHECK (requested_role IS NULL OR requested_role IN ('clinician', 'nurse', 'pharmacist', 'clerk', 'laboratory', 'management', 'administrator'));

CREATE TABLE IF NOT EXISTS patients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  medical_record_number VARCHAR(40) NOT NULL UNIQUE,
  first_name VARCHAR(100) NOT NULL,
  middle_name VARCHAR(100),
  last_name VARCHAR(100) NOT NULL,
  gender VARCHAR(20),
  date_of_birth DATE,
  age INTEGER,
  phone_number VARCHAR(30),
  address TEXT,
  next_of_kin_name VARCHAR(200),
  next_of_kin_contact VARCHAR(100),
  next_of_kin_relationship VARCHAR(80),
  previous_medical_history TEXT,
  registration_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  diagnoses TEXT,
  treatment_notes TEXT,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE patients ADD COLUMN IF NOT EXISTS middle_name VARCHAR(100);
ALTER TABLE patients ADD COLUMN IF NOT EXISTS gender VARCHAR(20);
ALTER TABLE patients ADD COLUMN IF NOT EXISTS age INTEGER;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS phone_number VARCHAR(30);
ALTER TABLE patients ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS next_of_kin_name VARCHAR(200);
ALTER TABLE patients ADD COLUMN IF NOT EXISTS next_of_kin_contact VARCHAR(100);
ALTER TABLE patients ADD COLUMN IF NOT EXISTS next_of_kin_relationship VARCHAR(80);
ALTER TABLE patients ADD COLUMN IF NOT EXISTS previous_medical_history TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS registration_date TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE patients ADD COLUMN IF NOT EXISTS allergies TEXT;

CREATE TABLE IF NOT EXISTS patient_care_team (
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  clinician_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_by UUID REFERENCES users(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (patient_id, clinician_id)
);

CREATE INDEX IF NOT EXISTS patient_care_team_clinician_idx ON patient_care_team(clinician_id, patient_id);

CREATE TABLE IF NOT EXISTS visits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  clinician_id UUID REFERENCES users(id) ON DELETE SET NULL,
  visit_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  chief_complaint TEXT,
  symptoms TEXT,
  temperature NUMERIC(5,2),
  blood_pressure VARCHAR(30),
  pulse_rate INTEGER,
  respiratory_rate INTEGER,
  weight NUMERIC(6,2),
  diagnosis TEXT,
  treatment_notes TEXT,
  follow_up TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS visits_patient_date_idx ON visits(patient_id, visit_date DESC);
CREATE INDEX IF NOT EXISTS visits_clinician_idx ON visits(clinician_id, visit_date DESC);
ALTER TABLE visits ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'completed';
ALTER TABLE visits ADD COLUMN IF NOT EXISTS queue_date DATE;
ALTER TABLE visits ADD COLUMN IF NOT EXISTS queue_number INTEGER;
ALTER TABLE visits ADD COLUMN IF NOT EXISTS appointment_id UUID;
ALTER TABLE visits ADD COLUMN IF NOT EXISTS triaged_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE visits ADD COLUMN IF NOT EXISTS triaged_at TIMESTAMPTZ;
ALTER TABLE visits ADD COLUMN IF NOT EXISTS oxygen_saturation NUMERIC(5,2);
ALTER TABLE visits ADD COLUMN IF NOT EXISTS height NUMERIC(6,2);
ALTER TABLE visits ADD COLUMN IF NOT EXISTS nursing_notes TEXT;
ALTER TABLE visits ADD COLUMN IF NOT EXISTS triage_priority TEXT;
ALTER TABLE visits ADD COLUMN IF NOT EXISTS pain_level SMALLINT;
ALTER TABLE visits ADD COLUMN IF NOT EXISTS triage_started_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE visits ADD COLUMN IF NOT EXISTS triage_started_at TIMESTAMPTZ;
ALTER TABLE visits ADD COLUMN IF NOT EXISTS clinical_completed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE visits ADD COLUMN IF NOT EXISTS clinical_examination TEXT;
ALTER TABLE visits DROP CONSTRAINT IF EXISTS visits_status_check;
ALTER TABLE visits ADD CONSTRAINT visits_status_check CHECK (status IN ('waiting_triage', 'in_triage', 'waiting_clinician', 'in_consultation', 'lab_requested', 'pharmacy_pending', 'completed', 'cancelled'));
ALTER TABLE visits DROP CONSTRAINT IF EXISTS visits_triage_priority_check;
ALTER TABLE visits ADD CONSTRAINT visits_triage_priority_check CHECK (triage_priority IS NULL OR triage_priority IN ('routine', 'urgent', 'critical'));
ALTER TABLE visits DROP CONSTRAINT IF EXISTS visits_pain_level_check;
ALTER TABLE visits ADD CONSTRAINT visits_pain_level_check CHECK (pain_level IS NULL OR pain_level BETWEEN 0 AND 10);
ALTER TABLE visits DROP CONSTRAINT IF EXISTS visits_queue_unique;
ALTER TABLE visits ADD CONSTRAINT visits_queue_unique UNIQUE (queue_date, queue_number);
CREATE INDEX IF NOT EXISTS visits_status_date_idx ON visits(status, visit_date DESC);

CREATE TABLE IF NOT EXISTS appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  scheduled_at TIMESTAMPTZ NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'checked_in', 'cancelled', 'rescheduled', 'completed')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  visit_id UUID REFERENCES visits(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS appointments_scheduled_idx ON appointments(scheduled_at, status);
CREATE INDEX IF NOT EXISTS appointments_patient_idx ON appointments(patient_id, scheduled_at DESC);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'visits_appointment_fk') THEN
    ALTER TABLE visits ADD CONSTRAINT visits_appointment_fk FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE SET NULL;
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS prescriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  consultation_id UUID REFERENCES visits(id) ON DELETE SET NULL,
  medication VARCHAR(200) NOT NULL,
  dose VARCHAR(200) NOT NULL,
  frequency VARCHAR(100),
  duration VARCHAR(100),
  quantity INTEGER,
  instructions TEXT,
  prescriber_id UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'partially_dispensed', 'dispensed', 'cancelled', 'active')),
  prescription_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS consultation_id UUID;
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS frequency VARCHAR(100);
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS duration VARCHAR(100);
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS quantity INTEGER;
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS prescriber_id UUID;
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS prescription_date TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS prescriptions_patient_id_idx ON prescriptions(patient_id);
CREATE INDEX IF NOT EXISTS prescriptions_consultation_idx ON prescriptions(consultation_id);
ALTER TABLE prescriptions DROP CONSTRAINT IF EXISTS prescriptions_status_check;
ALTER TABLE prescriptions ADD CONSTRAINT prescriptions_status_check CHECK (status IN ('pending', 'partially_dispensed', 'dispensed', 'cancelled', 'active'));

CREATE TABLE IF NOT EXISTS prescription_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prescription_id UUID NOT NULL REFERENCES prescriptions(id) ON DELETE CASCADE,
  medicine_name VARCHAR(200) NOT NULL,
  dosage VARCHAR(200),
  frequency VARCHAR(100),
  duration VARCHAR(100),
  quantity INTEGER NOT NULL DEFAULT 0,
  instructions TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'partially_dispensed', 'dispensed', 'cancelled')),
  dispensed_quantity INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS medicines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(200) NOT NULL,
  generic_name VARCHAR(200),
  category VARCHAR(100),
  strength VARCHAR(100),
  dosage_form VARCHAR(100),
  unit VARCHAR(50),
  current_quantity INTEGER NOT NULL DEFAULT 0,
  minimum_stock_level INTEGER NOT NULL DEFAULT 0,
  expiry_date DATE,
  batch_number VARCHAR(100),
  supplier VARCHAR(200),
  date_added TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status VARCHAR(30) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'expired', 'discontinued')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE medicines DROP CONSTRAINT IF EXISTS medicines_stock_nonnegative_check;
ALTER TABLE medicines ADD CONSTRAINT medicines_stock_nonnegative_check CHECK (current_quantity >= 0 AND minimum_stock_level >= 0);

CREATE TABLE IF NOT EXISTS medicine_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  medicine_id UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  batch_number VARCHAR(100) NOT NULL,
  manufactured_at DATE,
  expires_at DATE,
  quantity_received INTEGER NOT NULL CHECK (quantity_received > 0),
  current_quantity INTEGER NOT NULL CHECK (current_quantity >= 0),
  supplier VARCHAR(200),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  received_by UUID REFERENCES users(id) ON DELETE SET NULL,
  stock_location VARCHAR(120),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'quarantined', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (medicine_id, batch_number),
  CHECK (manufactured_at IS NULL OR expires_at IS NULL OR manufactured_at <= expires_at)
);
CREATE INDEX IF NOT EXISTS medicine_batches_medicine_expiry_idx
  ON medicine_batches(medicine_id, expires_at, received_at);
CREATE INDEX IF NOT EXISTS medicine_batches_expiry_idx
  ON medicine_batches(expires_at) WHERE status = 'active';

ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS medicine_id UUID REFERENCES medicines(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS prescriptions_medicine_id_idx ON prescriptions(medicine_id);

CREATE TABLE IF NOT EXISTS stock_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  medicine_id UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  movement_type VARCHAR(40) NOT NULL CHECK (movement_type IN ('stock_received', 'stock_dispensed', 'stock_adjusted', 'damaged_stock', 'expired_stock')),
  quantity INTEGER NOT NULL,
  quantity_before INTEGER NOT NULL,
  quantity_after INTEGER NOT NULL,
  reference_type VARCHAR(60),
  reference_id UUID,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS stock_movements_medicine_idx ON stock_movements(medicine_id, created_at DESC);

CREATE TABLE IF NOT EXISTS dispensing (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prescription_id UUID NOT NULL REFERENCES prescriptions(id) ON DELETE CASCADE,
  medicine_id UUID REFERENCES medicines(id) ON DELETE SET NULL,
  dispensed_quantity INTEGER NOT NULL,
  pharmacist_id UUID REFERENCES users(id) ON DELETE SET NULL,
  dispensed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes TEXT,
  status VARCHAR(30) NOT NULL DEFAULT 'dispensed' CHECK (status IN ('dispensed', 'partial', 'cancelled'))
);
ALTER TABLE dispensing DROP CONSTRAINT IF EXISTS dispensing_quantity_positive_check;
ALTER TABLE dispensing ADD CONSTRAINT dispensing_quantity_positive_check CHECK (dispensed_quantity > 0);

CREATE INDEX IF NOT EXISTS dispensing_prescription_idx ON dispensing(prescription_id, dispensed_at DESC);

ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS batch_id UUID REFERENCES medicine_batches(id) ON DELETE SET NULL;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS reference_code VARCHAR(120);
ALTER TABLE dispensing ADD COLUMN IF NOT EXISTS batch_id UUID REFERENCES medicine_batches(id) ON DELETE SET NULL;

INSERT INTO medicine_batches (medicine_id, batch_number, expires_at, quantity_received, current_quantity, supplier, received_at, status)
SELECT m.id, COALESCE(NULLIF(BTRIM(m.batch_number), ''), 'LEGACY-' || LEFT(REPLACE(m.id::text, '-', ''), 16)),
       m.expiry_date, m.current_quantity, m.current_quantity, m.supplier, m.date_added,
       CASE WHEN m.expiry_date < CURRENT_DATE THEN 'expired' ELSE 'active' END
FROM medicines m
WHERE m.current_quantity > 0
  AND NOT EXISTS (SELECT 1 FROM medicine_batches b WHERE b.medicine_id = m.id);

CREATE TABLE IF NOT EXISTS lab_test_catalogue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(40) NOT NULL UNIQUE,
  name VARCHAR(200) NOT NULL,
  result_type TEXT NOT NULL CHECK (result_type IN ('numeric', 'qualitative', 'text')),
  unit VARCHAR(80),
  reference_range TEXT,
  allowed_values TEXT[] NOT NULL DEFAULT '{}',
  specimen_requirements TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (result_type = 'qualitative' OR cardinality(allowed_values) = 0)
);

CREATE TABLE IF NOT EXISTS lab_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id UUID NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  test_id UUID REFERENCES lab_test_catalogue(id) ON DELETE SET NULL,
  test_result_type TEXT CHECK (test_result_type IS NULL OR test_result_type IN ('numeric', 'qualitative', 'text')),
  test_unit VARCHAR(80),
  test_reference_range TEXT,
  test_allowed_values TEXT[] NOT NULL DEFAULT '{}',
  test_name VARCHAR(200) NOT NULL,
  clinical_notes TEXT,
  clinical_indication TEXT,
  specimen_requirements TEXT,
  request_number VARCHAR(40),
  priority TEXT NOT NULL DEFAULT 'routine',
  specimen_identifier VARCHAR(120),
  collected_by UUID REFERENCES users(id) ON DELETE SET NULL,
  collected_at TIMESTAMPTZ,
  received_by UUID REFERENCES users(id) ON DELETE SET NULL,
  received_at TIMESTAMPTZ,
  rejection_reason TEXT,
  rejected_by UUID REFERENCES users(id) ON DELETE SET NULL,
  rejected_at TIMESTAMPTZ,
  processing_started_at TIMESTAMPTZ,
  cancelled_by UUID REFERENCES users(id) ON DELETE SET NULL,
  cancelled_at TIMESTAMPTZ,
  cancellation_reason TEXT,
  result TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  completed_at TIMESTAMPTZ
);

CREATE SEQUENCE IF NOT EXISTS lab_request_number_seq;
ALTER TABLE lab_requests ADD COLUMN IF NOT EXISTS test_id UUID REFERENCES lab_test_catalogue(id) ON DELETE SET NULL;
ALTER TABLE lab_requests ADD COLUMN IF NOT EXISTS test_result_type TEXT;
ALTER TABLE lab_requests ADD COLUMN IF NOT EXISTS test_unit VARCHAR(80);
ALTER TABLE lab_requests ADD COLUMN IF NOT EXISTS test_reference_range TEXT;
ALTER TABLE lab_requests ADD COLUMN IF NOT EXISTS test_allowed_values TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE lab_requests ADD COLUMN IF NOT EXISTS clinical_indication TEXT;
ALTER TABLE lab_requests ADD COLUMN IF NOT EXISTS specimen_requirements TEXT;
ALTER TABLE lab_requests DROP CONSTRAINT IF EXISTS lab_requests_test_result_type_check;
ALTER TABLE lab_requests ADD CONSTRAINT lab_requests_test_result_type_check
  CHECK (test_result_type IS NULL OR test_result_type IN ('numeric', 'qualitative', 'text'));
ALTER TABLE lab_requests ADD COLUMN IF NOT EXISTS request_number VARCHAR(40);
ALTER TABLE lab_requests ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'routine';
ALTER TABLE lab_requests ADD COLUMN IF NOT EXISTS specimen_identifier VARCHAR(120);
ALTER TABLE lab_requests ADD COLUMN IF NOT EXISTS collected_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE lab_requests ADD COLUMN IF NOT EXISTS collected_at TIMESTAMPTZ;
ALTER TABLE lab_requests ADD COLUMN IF NOT EXISTS received_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE lab_requests ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ;
ALTER TABLE lab_requests ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
ALTER TABLE lab_requests ADD COLUMN IF NOT EXISTS rejected_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE lab_requests ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;
ALTER TABLE lab_requests ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;
ALTER TABLE lab_requests ADD COLUMN IF NOT EXISTS cancelled_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE lab_requests ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE lab_requests ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
UPDATE lab_requests SET clinical_indication = clinical_notes WHERE clinical_indication IS NULL;
UPDATE lab_requests
SET request_number = 'LAB-' || TO_CHAR(requested_at AT TIME ZONE 'UTC', 'YYYYMMDD') || '-' ||
  LPAD(NEXTVAL('lab_request_number_seq')::text, 8, '0')
WHERE request_number IS NULL;
ALTER TABLE lab_requests ALTER COLUMN request_number SET NOT NULL;
ALTER TABLE lab_requests DROP CONSTRAINT IF EXISTS lab_requests_status_check;
ALTER TABLE lab_requests ADD CONSTRAINT lab_requests_status_check CHECK (
  status IN ('pending', 'collected', 'received', 'processing', 'result_entered', 'verified',
    'correction_pending', 'released', 'corrected', 'rejected', 'cancelled', 'in_progress', 'completed')
);
ALTER TABLE lab_requests DROP CONSTRAINT IF EXISTS lab_requests_priority_check;
ALTER TABLE lab_requests ADD CONSTRAINT lab_requests_priority_check CHECK (priority IN ('routine', 'urgent', 'stat'));
CREATE UNIQUE INDEX IF NOT EXISTS lab_requests_request_number_uidx ON lab_requests(request_number);
CREATE INDEX IF NOT EXISTS lab_requests_status_date_idx ON lab_requests(status, requested_at DESC);
CREATE INDEX IF NOT EXISTS lab_requests_patient_idx ON lab_requests(patient_id, requested_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS lab_requests_active_visit_test_uidx
  ON lab_requests(visit_id, test_id)
  WHERE test_id IS NOT NULL AND status IN ('pending', 'collected', 'received', 'processing', 'result_entered', 'verified', 'correction_pending');

CREATE TABLE IF NOT EXISTS lab_result_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES lab_requests(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  result_type TEXT NOT NULL CHECK (result_type IN ('numeric', 'qualitative', 'text')),
  numeric_value NUMERIC(18,6),
  qualitative_value TEXT,
  text_value TEXT,
  unit VARCHAR(80),
  reference_range TEXT,
  comments TEXT,
  status TEXT NOT NULL DEFAULT 'entered' CHECK (status IN ('entered', 'verified', 'released', 'superseded')),
  entered_by UUID REFERENCES users(id) ON DELETE SET NULL,
  entered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_by UUID REFERENCES users(id) ON DELETE SET NULL,
  verified_at TIMESTAMPTZ,
  released_by UUID REFERENCES users(id) ON DELETE SET NULL,
  released_at TIMESTAMPTZ,
  amendment_reason TEXT,
  supersedes_result_id UUID REFERENCES lab_result_versions(id) ON DELETE SET NULL,
  UNIQUE (request_id, version_number),
  CHECK (
    (result_type = 'numeric' AND numeric_value IS NOT NULL AND qualitative_value IS NULL AND text_value IS NULL) OR
    (result_type = 'qualitative' AND numeric_value IS NULL AND qualitative_value IS NOT NULL AND text_value IS NULL) OR
    (result_type = 'text' AND numeric_value IS NULL AND qualitative_value IS NULL AND text_value IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS lab_result_versions_request_idx ON lab_result_versions(request_id, version_number DESC);
CREATE INDEX IF NOT EXISTS lab_result_versions_release_idx ON lab_result_versions(request_id, released_at DESC)
  WHERE released_at IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS lab_result_versions_one_verified_uidx
  ON lab_result_versions(request_id) WHERE status = 'verified';

CREATE UNIQUE INDEX IF NOT EXISTS visits_id_patient_id_uidx ON visits(id, patient_id);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_requests_visit_patient_fk') THEN
    ALTER TABLE lab_requests ADD CONSTRAINT lab_requests_visit_patient_fk
      FOREIGN KEY (visit_id, patient_id) REFERENCES visits(id, patient_id) ON DELETE CASCADE NOT VALID;
  END IF;
END;
$$;
ALTER TABLE lab_requests VALIDATE CONSTRAINT lab_requests_visit_patient_fk;

INSERT INTO lab_result_versions (
  request_id, version_number, result_type, text_value, status, entered_by, entered_at, released_by, released_at
)
SELECT lr.id, 1, 'text', lr.result, 'released', lr.completed_by, COALESCE(lr.completed_at, lr.requested_at),
       lr.completed_by, COALESCE(lr.completed_at, lr.requested_at)
FROM lab_requests lr
WHERE lr.status = 'completed' AND NULLIF(BTRIM(lr.result), '') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM lab_result_versions rv WHERE rv.request_id = lr.id);
CREATE INDEX IF NOT EXISTS lab_requests_status_date_idx ON lab_requests(status, requested_at DESC);
CREATE INDEX IF NOT EXISTS lab_requests_patient_idx ON lab_requests(patient_id, requested_at DESC);

CREATE TABLE IF NOT EXISTS audit_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(100) NOT NULL,
  resource_type VARCHAR(80) NOT NULL,
  resource_id UUID,
  module VARCHAR(80),
  description TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(100) NOT NULL,
  resource_type VARCHAR(80) NOT NULL,
  resource_id UUID,
  module VARCHAR(80),
  description TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS module VARCHAR(80);
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS module VARCHAR(80);
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS description TEXT;

CREATE OR REPLACE FUNCTION mirror_audit_events_to_logs()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, module, description, occurred_at)
  VALUES (NEW.actor_id, NEW.action, NEW.resource_type, NEW.resource_id, NEW.module, NEW.description, NEW.occurred_at);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_events_mirror_trigger ON audit_events;
CREATE TRIGGER audit_events_mirror_trigger
AFTER INSERT ON audit_events
FOR EACH ROW
EXECUTE FUNCTION mirror_audit_events_to_logs();

CREATE INDEX IF NOT EXISTS audit_events_actor_time_idx ON audit_events(actor_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_resource_idx ON audit_events(resource_type, resource_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_actor_time_idx ON audit_logs(actor_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_resource_idx ON audit_logs(resource_type, resource_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS permissions (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role TEXT NOT NULL CHECK (role IN ('clinician', 'nurse', 'pharmacist', 'clerk', 'laboratory', 'management', 'administrator')),
  permission_name TEXT NOT NULL REFERENCES permissions(name) ON DELETE CASCADE,
  granted BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (role, permission_name)
);

CREATE TABLE IF NOT EXISTS user_permissions (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_name TEXT NOT NULL REFERENCES permissions(name) ON DELETE CASCADE,
  granted BOOLEAN NOT NULL DEFAULT TRUE,
  granted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, permission_name)
);

CREATE TABLE IF NOT EXISTS departments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(120) NOT NULL UNIQUE,
  code VARCHAR(20) NOT NULL UNIQUE,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS system_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO permissions (name, description) VALUES
  ('dashboard.view', 'View the dashboard assigned to the account role.'),
  ('dashboard.clerk', 'View the Clerk operational dashboard.'),
  ('dashboard.nursing', 'View the Nursing dashboard.'),
  ('dashboard.clinical', 'View the Clinical dashboard.'),
  ('dashboard.pharmacy', 'View the Pharmacy dashboard.'),
  ('dashboard.laboratory', 'View the Laboratory dashboard.'),
  ('dashboard.management', 'View the Management dashboard.'),
  ('dashboard.administration', 'View the Administration dashboard.'),
  ('patients.view', 'Search and view patient information required by the assigned work role.'),
  ('patients.create', 'Register patients.'),
  ('patients.edit', 'Update patient demographic information.'),
  ('patients.checkin', 'Check patients in and assign queue numbers.'),
  ('patients.assign', 'Assign clinicians to patient care teams.'),
  ('patients.archive', 'Archive patient records.'),
  ('consultation.create', 'Create clinical consultation records.'),
  ('appointments.view', 'View the appointment schedule.'),
  ('appointments.relevant.view', 'View appointments relevant to assigned clinical workflow.'),
  ('appointments.create', 'Create appointments.'),
  ('appointments.edit', 'Reschedule appointments.'),
  ('appointments.cancel', 'Cancel appointments.'),
  ('appointments.followup.create', 'Request a follow-up appointment for a patient in care.'),
  ('queue.frontdesk.view', 'View the non-clinical front-desk queue.'),
  ('queue.clinical.view', 'View the clinical patient queue.'),
  ('triage.create', 'Record nursing triage and vital signs.'),
  ('consultation.start', 'Start assigned patient consultations.'),
  ('consultation.complete', 'Complete clinical consultations.'),
  ('diagnosis.create', 'Record diagnoses and clinical notes.'),
  ('laboratory.requests.view', 'View and process laboratory requests.'),
  ('laboratory.requests.create', 'Request laboratory investigations.'),
  ('laboratory.results', 'Record laboratory results and test status.'),
  ('laboratory.catalogue.manage', 'Create, configure, and deactivate laboratory test definitions.'),
  ('laboratory.specimens.manage', 'Record specimen collection, receipt, rejection, and processing.'),
  ('laboratory.results.enter', 'Enter laboratory results.'),
  ('laboratory.results.verify', 'Independently verify laboratory results.'),
  ('laboratory.results.release', 'Release verified laboratory results to the clinician.'),
  ('laboratory.results.amend', 'Create traceable corrections to released laboratory results.'),
  ('laboratory.requests.cancel', 'Cancel open laboratory requests with a reason.'),
  ('prescriptions.view', 'View prescriptions required for patient care or dispensing.'),
  ('prescriptions.create', 'Create clinical prescriptions.'),
  ('pharmacy.inventory', 'View and manage medicine inventory and stock.'),
  ('pharmacy.dispense', 'Dispense prescribed medicines and update stock.'),
  ('users.manage', 'Create, approve, deactivate, and review staff accounts.'),
  ('permissions.manage', 'Manage role and per-user permission grants.'),
  ('departments.manage', 'Create and maintain hospital departments.'),
  ('settings.manage', 'Manage system configuration.'),
  ('reports.view', 'View operational reports and analytics.'),
  ('audit.view', 'View audit logs.'),
  ('system.monitor', 'View general system monitoring information.')
ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description;

INSERT INTO role_permissions (role, permission_name) VALUES
  ('clerk', 'dashboard.view'), ('clerk', 'dashboard.clerk'),
  ('clerk', 'patients.view'), ('clerk', 'patients.create'), ('clerk', 'patients.edit'),
  ('clerk', 'patients.checkin'), ('clerk', 'appointments.view'), ('clerk', 'appointments.create'),
  ('clerk', 'appointments.edit'), ('clerk', 'appointments.cancel'), ('clerk', 'queue.frontdesk.view'),
  ('nurse', 'dashboard.view'), ('nurse', 'dashboard.nursing'), ('nurse', 'patients.view'),
  ('nurse', 'appointments.relevant.view'), ('nurse', 'queue.clinical.view'), ('nurse', 'triage.create'),
  ('clinician', 'dashboard.view'), ('clinician', 'dashboard.clinical'), ('clinician', 'patients.view'),
  ('clinician', 'appointments.relevant.view'), ('clinician', 'appointments.followup.create'),
  ('clinician', 'queue.clinical.view'), ('clinician', 'consultation.start'), ('clinician', 'consultation.complete'),
  ('clinician', 'diagnosis.create'), ('clinician', 'laboratory.requests.create'), ('clinician', 'laboratory.requests.cancel'),
  ('clinician', 'prescriptions.view'), ('clinician', 'prescriptions.create'),
  ('pharmacist', 'dashboard.view'), ('pharmacist', 'dashboard.pharmacy'),
  ('pharmacist', 'prescriptions.view'), ('pharmacist', 'pharmacy.inventory'), ('pharmacist', 'pharmacy.dispense'),
  ('laboratory', 'dashboard.view'), ('laboratory', 'dashboard.laboratory'),
  ('laboratory', 'laboratory.requests.view'), ('laboratory', 'laboratory.results'),
  ('laboratory', 'laboratory.catalogue.manage'), ('laboratory', 'laboratory.specimens.manage'),
  ('laboratory', 'laboratory.results.enter'), ('laboratory', 'laboratory.results.verify'),
  ('laboratory', 'laboratory.results.release'), ('laboratory', 'laboratory.results.amend'),
  ('laboratory', 'laboratory.requests.cancel'),
  ('management', 'dashboard.view'), ('management', 'dashboard.management'),
  ('management', 'reports.view'),
  ('administrator', 'dashboard.view'), ('administrator', 'dashboard.administration'),
  ('administrator', 'users.manage'), ('administrator', 'permissions.manage'),
  ('administrator', 'departments.manage'),
  ('administrator', 'settings.manage'), ('administrator', 'reports.view'),
  ('administrator', 'audit.view'), ('administrator', 'system.monitor'),
  ('administrator', 'patients.assign'), ('administrator', 'patients.archive'),
  ('clinician', 'consultation.create')
ON CONFLICT (role, permission_name) DO NOTHING;
