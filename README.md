# Kagando EMR

A local, role-aware electronic medical records MVP with an Express API, PostgreSQL storage, and a browser interface. It is not clinically validated or certified for hospital use. Use fictional records during development.

## Local setup

1. Install Node.js 20+ and PostgreSQL 13+.
2. Install packages with `npm install`.
3. Copy `.env.example` to `.env` and set the local database values. `.env` is ignored by Git.
4. Create the configured PostgreSQL database, then apply the schema with `npm run db:migrate`.
5. Create the first administrator in an interactive terminal with `npm run admin:create` (12+ character password), or use `npm run admin:provision` for a temporary bootstrap password that is forcibly changed at first sign-in. Both password prompts are hidden.
6. Start the app with `npm start`, then open `http://localhost:3000`.

The browser never receives database credentials. Passwords are stored as bcrypt hashes. Authentication uses server-side PostgreSQL sessions; the browser does not store passwords or tokens. Production requires HTTPS and verified database TLS with `DB_SSL=true` (configure the trusted CA through the Node.js certificate store where needed).

## Workflows and access

- Clerks register and update patient demographics. They cannot read clinical notes or prescriptions.
- Staff can register from the sign-in screen and request a role. New non-admin accounts remain inactive until an administrator approves them. The Administrator option appears only while no administrator record exists; the first signup is activated once, protected by a database lock, and must change its temporary password before accessing EMR data. Subsequent administrator signup attempts are rejected by the server. Administrators can also create/deactivate staff directly, assign clinicians to patients, review audit metadata, maintain demographics, and archive records. The last active administrator cannot be deactivated.
- Clinicians see only patients assigned to them, may update diagnoses and treatment notes, and may create prescriptions for those patients.
- Pharmacists see prescription and dispensing fields only and can mark active prescriptions as dispensed.
- Patient and prescription access, clinical changes, assignments, dispensing, user changes, and archival are recorded transactionally in `audit_events`.
- Patient records are archived, never permanently deleted through the application interface.

## Checks and backups

Run `npm run check`, `npm test`, and `npm audit`. The end-to-end test uses temporary fictional records in the configured local PostgreSQL database and removes them afterward.

For a manual encrypted backup, use PostgreSQL's custom archive format and encrypt the resulting file with your organization's key-management tooling. Example: `pg_dump --format=custom --file=electronic.dump electronic`. Store backups outside the application workspace, restrict access, schedule regular backups, and test restoration. Do not place backup files or credentials in source control.

## Before real hospital use

Change every development credential; generate a unique random production session secret; use a restricted production database account, private network access, and verified TLS; serve only over HTTPS; configure encrypted backups and restore tests; review least-privilege access, clinical workflows, audit retention, incident response, and security controls; conduct independent security testing; and obtain hospital authorization plus applicable health-data/privacy review. This MVP is a starting point, not a compliance certification or substitute for clinical governance.
