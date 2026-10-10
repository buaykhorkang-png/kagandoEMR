# Kagando EMR

A local, role-aware electronic medical records MVP with an Express API, PostgreSQL storage, and a browser interface. It is not clinically validated or certified for hospital use. Use fictional records during development.

## Local setup

1. Install Node.js 20+ and PostgreSQL 13+.
2. Install packages with `npm install`.
3. Copy `.env.example` to `.env` and set the local database values. `.env` is ignored by Git.
4. Create the configured PostgreSQL database, then apply the schema with `npm run db:migrate`.
5. Create the first administrator in an interactive terminal with `npm run admin:create` (12+ character password), or use `npm run admin:provision` for a temporary bootstrap password that is forcibly changed at first sign-in. Both password prompts are hidden.
6. Start the app with `npm start`, then open `http://localhost:3000`.

After updating the application to a version that changes the database schema, run `npm run db:migrate` against the configured database before starting the app.

To recover an existing administrator account, run `npm run admin:reset` in an interactive terminal. It prompts for the existing username and a new hidden temporary password, then requires a password change at next sign-in.

The browser never receives database credentials. Passwords are stored as bcrypt hashes. Authentication uses server-side PostgreSQL sessions; the browser does not store passwords or tokens. Production requires HTTPS and verified database TLS with `DB_SSL=true` (configure the trusted CA through the Node.js certificate store where needed).

## Workflows and access

- Access is checked against the PostgreSQL permission catalog on every authenticated API request. Default least-privilege role grants are seeded by the schema; administrators can manage role grants and per-user overrides from Roles & permissions. A permission change takes effect on the next request. Dashboard APIs and dashboard URLs are separately permission-checked.
- Clerks register and update patient demographics. They cannot read clinical notes or prescriptions.
- Nurses see patients in their active or personally triaged workflow; patient search does not expose unrelated records.
- Staff can register from the sign-in screen and request a role. New non-admin accounts remain inactive until an administrator approves them. The Administrator option appears only while no administrator record exists; the first signup is activated once, protected by a database lock, and must change its temporary password before accessing EMR data. Subsequent administrator signup attempts are rejected by the server. Administrators can also create/deactivate staff directly, assign clinicians to patients, review audit metadata, and archive records. The last active administrator cannot be deactivated.
- Clinicians see only patients assigned to them, may update diagnoses and treatment notes, request configured laboratory tests for an active assigned encounter, view released results in the patient/encounter record, and create prescriptions for those patients.
- Pharmacists see prescription and dispensing fields only and can mark active prescriptions as dispensed.
- Appointment schedule access is limited to clerks and clinical users with explicitly scoped relevant-appointment permissions; only appointment managers can create, reschedule, or cancel appointments. Clinicians can request follow-ups only for assigned patients.
- Administrators can maintain departments and a small allowlisted set of non-secret system settings; department and settings changes are audited.
- The Clerk dashboard shows today's appointments and active queue with queue numbers and workflow status, without exposing clinical details. Check-in creates a `waiting_triage` visit; triage advances it to `waiting_clinician`, and clinicians manage consultations and related laboratory or pharmacy work.
- The Clinical dashboard separates the nurse's triage queue, vital-sign view, and triage workspace from the clinician's consultation queue. Starting triage records `in_triage`; saving observations keeps the visit there, while “Save & send to clinician” advances it to `waiting_clinician`. Triage observations include pain level and are audited. Open laboratory requests or undispensed prescriptions keep a completed consultation in the appropriate `lab_requested` or `pharmacy_pending` state; completing all required work completes the visit and its appointment.
- Laboratory test definitions are configured in the Laboratory dashboard; each definition specifies numeric, qualitative, or text results, optional units/reference text, permitted qualitative values, and specimen requirements. Clinicians request tests against an active assigned encounter; the server derives the patient from that encounter and PostgreSQL enforces the patient/encounter relationship. Each request receives a unique number and snapshots the applicable test definition. Laboratory staff record collection or receipt, specimen identifiers, rejection reasons, processing, and results. Results require a different authorized user to verify and a different authorized user to release; only released versions appear to clinicians. Corrections create a new version with a required reason, preserve prior releases, and remain subject to the same review/release steps. Request, specimen, result, verification, release, correction, rejection, and cancellation actions are audited.
- The Pharmacy dashboard reads pending prescriptions and live inventory from PostgreSQL. Catalogue setup is separate from stock receipt: staff add a medicine to the catalogue, then receive a numbered batch with expiry details. Repeated receipts for the same medicine and batch number add to that batch; distinct lots remain separate. Batch adjustments require a reason, and batches can be quarantined or released with an audit record. Dispensing validates the selected batch and atomically decreases batch and medicine balances, records stock movement/audit events, and updates prescription and visit status. When a batch is not specified by a legacy request, eligible stock is allocated earliest-expiry-first. Clinician prescriptions link to catalogue medicines.
- Patient and prescription access, clinical changes, assignments, dispensing, user changes, and archival are recorded transactionally in `audit_events`.
- Patient records are archived, never permanently deleted through the application interface.
- Operational reports are derived from PostgreSQL and accept validated inclusive `YYYY-MM-DD` start/end dates; callers must have the `reports.view` permission.

## Current scope and limitations

This project is an EMR MVP, not a validated or production-ready clinical information system. Batch balances are maintained alongside medicine-level aggregate balances; historical positive aggregate stock is preserved and represented by a `LEGACY-...` batch during migration, but historical stock movements and dispensings are not retroactively assigned to lots. Review that backfill against facility stock records before relying on it operationally. The inventory workflow does not yet capture purchase costs or storage conditions, and reporting is not a complete batch-level reconciliation suite. The laboratory workflow supports one scalar or text result per test request; multi-analyte panels, instrument interfaces, external reference interval validation, and facility-specific laboratory quality-control procedures are not implemented. The application deliberately seeds no clinical test definitions, units, ranges, result values, or interpretations: authorized facility staff must configure and validate definitions before use. Legacy pending requests without a test definition must be mapped by authorized laboratory staff before processing; legacy completed results are retained as historical released text versions because the prior system had no review lifecycle. Referral, discharge, and left-before-completion workflows are not implemented. Dashboards load live API data when opened or refreshed, but do not push updates to other open sessions. These workflows require facility-specific design, clinical validation, authorization review, and additional implementation before real-world use.

## Checks and backups

Run `npm run check`, `npm test`, and `npm audit`. The end-to-end test uses temporary fictional records and catalogue definitions in the configured local PostgreSQL database and removes them afterward.

For a manual encrypted backup, use PostgreSQL's custom archive format and encrypt the resulting file with your organization's key-management tooling. Example: `pg_dump --format=custom --file=electronic.dump electronic`. Store backups outside the application workspace, restrict access, schedule regular backups, and test restoration. Do not place backup files or credentials in source control.

## Before real hospital use

Change every development credential; generate a unique random production session secret; use a restricted production database account, private network access, and verified TLS; serve only over HTTPS; configure encrypted backups and restore tests; review least-privilege access, clinical workflows, audit retention, incident response, and security controls; conduct independent security testing; and obtain hospital authorization plus applicable health-data/privacy review. This MVP is a starting point, not a compliance certification or substitute for clinical governance.
