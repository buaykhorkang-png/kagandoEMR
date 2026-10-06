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

CREATE TABLE IF NOT EXISTS lab_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id UUID NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  test_name VARCHAR(200) NOT NULL,
  clinical_notes TEXT,
  result TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  completed_at TIMESTAMPTZ
);
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
  ('clinician', 'diagnosis.create'), ('clinician', 'laboratory.requests.create'),
  ('clinician', 'prescriptions.view'), ('clinician', 'prescriptions.create'),
  ('pharmacist', 'dashboard.view'), ('pharmacist', 'dashboard.pharmacy'),
  ('pharmacist', 'prescriptions.view'), ('pharmacist', 'pharmacy.inventory'), ('pharmacist', 'pharmacy.dispense'),
  ('laboratory', 'dashboard.view'), ('laboratory', 'dashboard.laboratory'),
  ('laboratory', 'laboratory.requests.view'), ('laboratory', 'laboratory.results'),
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
