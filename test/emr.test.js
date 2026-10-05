require('dotenv').config();

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { once } = require('node:events');
const test = require('node:test');
const app = require('../src/server');
const pool = require('../src/db');
const { hashPassword } = require('../src/security/passwords');

test('role-based EMR workflows preserve clinical access boundaries', { timeout: 45000 }, async (t) => {
  try {
    await pool.query('SELECT 1');
  } catch {
    t.skip('PostgreSQL is unavailable.');
    return;
  }

  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
  const password = 'Test-Only-Password-4821';
  const accounts = {};
  const patientIds = [];
  const auditResourceIds = [];
  const server = app.listen(0);
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function addAccount(role, label = role) {
    const username = `test.${label}.${suffix}`;
    const result = await pool.query(
      `INSERT INTO users (username, password_hash, role)
       VALUES ($1, $2, $3) RETURNING id, username`,
      [username, await hashPassword(password), role]
    );
    accounts[label] = result.rows[0];
    return result.rows[0];
  }

  async function request(path, { cookie, method = 'GET', body } = {}) {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const payload = response.status === 204 ? null : await response.json();
    return { response, payload };
  }

  async function login(account) {
    const { response } = await request('/api/auth/login', {
      method: 'POST',
      body: { username: account.username, password }
    });
    assert.equal(response.status, 200);
    const cookies = response.headers.getSetCookie();
    return cookies[0].split(';', 1)[0];
  }

  try {
    const initialAdminUsername = `test.initialadmin.${suffix}`;
    const registrationOptions = await request('/api/auth/registration-options');
    let admin;
    if (registrationOptions.payload.administratorRegistrationAvailable) {
      const initialAdminSignup = await request('/api/auth/register', {
        method: 'POST',
        body: { username: initialAdminUsername, password, requestedRole: 'administrator' }
      });
      assert.equal(initialAdminSignup.response.status, 201);
      const adminLookup = await pool.query(
        'SELECT id, username FROM users WHERE username = $1',
        [initialAdminUsername]
      );
      admin = adminLookup.rows[0];
      accounts.initialAdmin = admin;
      const initialAdminCookie = await login(admin);
      const adminBlocked = await request('/api/admin/users', { cookie: initialAdminCookie });
      assert.equal(adminBlocked.response.status, 403);
      const adminPasswordChange = await request('/api/auth/change-password', {
        cookie: initialAdminCookie,
        method: 'POST',
        body: { password: 'Changed-Initial-Admin-Password-5728' }
      });
      assert.equal(adminPasswordChange.response.status, 200);
      const adminAllowed = await request('/api/admin/users', { cookie: initialAdminCookie });
      assert.equal(adminAllowed.response.status, 200);
      const closedOptions = await request('/api/auth/registration-options');
      assert.equal(closedOptions.payload.administratorRegistrationAvailable, false);
    } else {
      const existingAdmins = await pool.query("SELECT id FROM users WHERE role = 'administrator' LIMIT 1");
      assert.ok(existingAdmins.rowCount > 0);
    }

    const secondAdminSignup = await request('/api/auth/register', {
      method: 'POST',
      body: { username: `test.secondadmin.${suffix}`, password, requestedRole: 'administrator' }
    });
    assert.equal(secondAdminSignup.response.status, 409);

    admin = await addAccount('administrator', 'test-admin');
    const adminCookie = await login(admin);
    const clerk = await addAccount('clerk');
    const clinician = await addAccount('clinician');
    const pharmacist = await addAccount('pharmacist');

    const clerkCookie = await login(clerk);
    const clinicianCookie = await login(clinician);
    const pharmacistCookie = await login(pharmacist);

    const signupUsername = `test.signup.${suffix}`;
    const adminSignup = await request('/api/auth/register', {
      method: 'POST',
      body: { username: signupUsername, password, requestedRole: 'administrator' }
    });
    assert.equal(adminSignup.response.status, 409);

    const signup = await request('/api/auth/register', {
      method: 'POST',
      body: { username: signupUsername, password, requestedRole: 'pharmacist' }
    });
    assert.equal(signup.response.status, 202);
    assert.equal(signup.payload.status, 'pending');

    const pendingLogin = await request('/api/auth/login', {
      method: 'POST',
      body: { username: signupUsername, password }
    });
    assert.equal(pendingLogin.response.status, 401);

    const pendingUsers = await request('/api/admin/users', { cookie: adminCookie });
    const pendingUser = pendingUsers.payload.users.find((user) => user.username === signupUsername);
    assert.ok(pendingUser);
    accounts.signup = pendingUser;
    assert.equal(pendingUser.approval_status, 'pending');
    assert.equal(pendingUser.is_active, false);

    const approved = await request(`/api/admin/users/${pendingUser.id}/approval`, {
      cookie: adminCookie,
      method: 'PATCH',
      body: { role: 'clerk' }
    });
    assert.equal(approved.response.status, 200);
    assert.equal(approved.payload.user.role, 'clerk');
    assert.equal(approved.payload.user.is_active, true);

    const approvedLogin = await request('/api/auth/login', {
      method: 'POST',
      body: { username: signupUsername, password }
    });
    assert.equal(approvedLogin.response.status, 200);
    assert.equal(approvedLogin.payload.user.role, 'clerk');
    const approvedCookie = approvedLogin.response.headers.getSetCookie()[0].split(';', 1)[0];
    const elevatedRoute = await request('/api/admin/users', { cookie: approvedCookie });
    assert.equal(elevatedRoute.response.status, 403);

    const temporaryAdminUsername = `test.tempadmin.${suffix}`;
    const temporaryAdminResult = await pool.query(
      `INSERT INTO users (username, password_hash, role, must_change_password)
       VALUES ($1, $2, 'administrator', TRUE) RETURNING id, username`,
      [temporaryAdminUsername, await hashPassword(password)]
    );
    accounts.temporaryAdmin = temporaryAdminResult.rows[0];
    const temporaryAdminCookie = await login(accounts.temporaryAdmin);
    const blockedUntilChanged = await request('/api/admin/users', { cookie: temporaryAdminCookie });
    assert.equal(blockedUntilChanged.response.status, 403);
    const changedPassword = await request('/api/auth/change-password', {
      cookie: temporaryAdminCookie,
      method: 'POST',
      body: { password: 'New-Strong-Test-Password-5721' }
    });
    assert.equal(changedPassword.response.status, 200);
    assert.equal(changedPassword.payload.user.mustChangePassword, false);
    const allowedAfterChange = await request('/api/admin/users', { cookie: temporaryAdminCookie });
    assert.equal(allowedAfterChange.response.status, 200);

    const staticPage = await fetch(`${baseUrl}/`);
    assert.equal(staticPage.status, 200);
    assert.match(await staticPage.text(), /Kagando EMR/);

    const noSession = await request('/api/patients');
    assert.equal(noSession.response.status, 401);

    const created = await request('/api/patients', {
      cookie: clerkCookie,
      method: 'POST',
      body: {
        medicalRecordNumber: `DEMO-${suffix}`,
        firstName: 'Fictional',
        lastName: 'Testpatient',
        dateOfBirth: '1990-04-12'
      }
    });
    assert.equal(created.response.status, 201);
    const patient = created.payload.patient;
    patientIds.push(patient.id);
    auditResourceIds.push(patient.id);
    assert.equal(Object.hasOwn(patient, 'diagnoses'), false);

    const patientList = await request(`/api/patients?search=${encodeURIComponent(`DEMO-${suffix}`)}`, { cookie: clerkCookie });
    assert.equal(patientList.response.status, 200);
    assert.equal(patientList.payload.patients.length, 1);
    assert.equal(Object.hasOwn(patientList.payload.patients[0], 'diagnoses'), false);

    const clinicalDenied = await request(`/api/patients/${patient.id}/clinical`, {
      cookie: clerkCookie,
      method: 'PUT',
      body: { diagnoses: 'denied', treatmentNotes: 'denied' }
    });
    assert.equal(clinicalDenied.response.status, 403);

    const assigned = await request(`/api/patients/${patient.id}/assignments`, {
      cookie: adminCookie,
      method: 'POST',
      body: { clinicianId: clinician.id }
    });
    assert.equal(assigned.response.status, 204);

    const clinicianRecord = await request(`/api/patients/${patient.id}`, { cookie: clinicianCookie });
    assert.equal(clinicianRecord.response.status, 200);
    assert.equal(Object.hasOwn(clinicianRecord.payload.patient, 'treatment_notes'), true);

    const savedClinical = await request(`/api/patients/${patient.id}/clinical`, {
      cookie: clinicianCookie,
      method: 'PUT',
      body: { diagnoses: 'Fictional test diagnosis', treatmentNotes: 'Fictional test note' }
    });
    assert.equal(savedClinical.response.status, 204);

    const prescription = await request('/api/prescriptions', {
      cookie: clinicianCookie,
      method: 'POST',
      body: { patientId: patient.id, medication: 'Demo medication', dose: '1 tablet', instructions: 'Test only' }
    });
    assert.equal(prescription.response.status, 201);
    auditResourceIds.push(prescription.payload.prescription.id);

    const pharmacistQueue = await request('/api/prescriptions', { cookie: pharmacistCookie });
    assert.equal(pharmacistQueue.response.status, 200);
    assert.equal(pharmacistQueue.payload.prescriptions.length, 1);

    const clerkQueue = await request('/api/prescriptions', { cookie: clerkCookie });
    assert.equal(clerkQueue.response.status, 403);

    const dispensed = await request(`/api/prescriptions/${prescription.payload.prescription.id}/dispense`, {
      cookie: pharmacistCookie,
      method: 'PATCH',
      body: {}
    });
    assert.equal(dispensed.response.status, 200);
    assert.equal(dispensed.payload.prescription.status, 'dispensed');

    const unassignedCreated = await request('/api/patients', {
      cookie: clerkCookie,
      method: 'POST',
      body: {
        medicalRecordNumber: `UNASSIGNED-${suffix}`,
        firstName: 'Another',
        lastName: 'Fictional',
        dateOfBirth: ''
      }
    });
    assert.equal(unassignedCreated.response.status, 201);
    patientIds.push(unassignedCreated.payload.patient.id);
    auditResourceIds.push(unassignedCreated.payload.patient.id);
    const unassignedAccess = await request(`/api/patients/${unassignedCreated.payload.patient.id}`, { cookie: clinicianCookie });
    assert.equal(unassignedAccess.response.status, 404);

    const adminUsers = await request('/api/admin/users', { cookie: adminCookie });
    assert.equal(adminUsers.response.status, 200);
    const createdStaff = await request('/api/admin/users', {
      cookie: adminCookie,
      method: 'POST',
      body: { username: `test.disabled.${suffix}`, password, role: 'clerk' }
    });
    assert.equal(createdStaff.response.status, 201);
    assert.equal(Object.hasOwn(createdStaff.payload.user, 'password_hash'), false);
    accounts.disabled = createdStaff.payload.user;
    const disabledCookie = await login(createdStaff.payload.user);
    const disabled = await request(`/api/admin/users/${createdStaff.payload.user.id}/status`, {
      cookie: adminCookie,
      method: 'PATCH',
      body: { isActive: false }
    });
    assert.equal(disabled.response.status, 200);
    const revokedSession = await request('/api/admin/users', { cookie: disabledCookie });
    assert.equal(revokedSession.response.status, 401);
  } finally {
    const userIds = Object.values(accounts).map((account) => account.id);
    await pool.query("DELETE FROM \"session\" WHERE sess->'user'->>'id' = ANY($1::text[])", [userIds]).catch(() => {});
    await pool.query(
      'DELETE FROM audit_events WHERE actor_id = ANY($1::uuid[]) OR resource_id = ANY($2::uuid[])',
      [userIds, auditResourceIds]
    ).catch(() => {});
    await pool.query('DELETE FROM prescriptions WHERE patient_id = ANY($1::uuid[])', [patientIds]).catch(() => {});
    await pool.query('DELETE FROM patient_care_team WHERE patient_id = ANY($1::uuid[]) OR clinician_id = ANY($2::uuid[])', [patientIds, userIds]).catch(() => {});
    await pool.query('DELETE FROM patients WHERE id = ANY($1::uuid[])', [patientIds]).catch(() => {});
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]).catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
});