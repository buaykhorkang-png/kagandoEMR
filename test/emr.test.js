require('dotenv').config();

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { once } = require('node:events');
const test = require('node:test');
const app = require('../src/server');
const pool = require('../src/db');
const { hashPassword } = require('../src/security/passwords');

test('role-based EMR workflows preserve clinical access boundaries', { timeout: 90000 }, async (t) => {
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
  const medicineIds = [];
  const laboratoryTestIds = [];
  const departmentIds = [];
  let originalFacilitySetting;
  let facilityNameChanged = false;
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
    const payload = response.status === 204
      ? null
      : response.headers.get('content-type') && response.headers.get('content-type').includes('application/json')
        ? await response.json()
        : { html: await response.text() };
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
    const nurse = await addAccount('nurse');
    const laboratory = await addAccount('laboratory');
    const management = await addAccount('management');

    const clerkCookie = await login(clerk);
    const clinicianCookie = await login(clinician);
    const pharmacistCookie = await login(pharmacist);
    const nurseCookie = await login(nurse);
    const laboratoryCookie = await login(laboratory);
    const laboratoryReleaserCookie = adminCookie;
    const clinicianReviewPermission = await request(`/api/admin/users/${clinician.id}/permissions`, {
      cookie: adminCookie,
      method: 'PUT',
      body: {
        permissions: [
          { name: 'laboratory.results.verify', granted: true },
          { name: 'laboratory.results.release', granted: true }
        ]
      }
    });
    assert.equal(clinicianReviewPermission.response.status, 204);
    const laboratoryReviewerCookie = clinicianCookie;
    const managementCookie = await login(management);

    const rolePages = [
      [clerkCookie, '/clerk/dashboard', 200, '/admin/dashboard', 403, '/clinical/consultation', 403],
      [nurseCookie, '/nursing/dashboard', 200, '/clerk/dashboard', 403, '/admin/dashboard', 403],
      [clinicianCookie, '/clinical/dashboard', 200, '/clerk/dashboard', 403, '/admin/dashboard', 403],
      [pharmacistCookie, '/pharmacy/dashboard', 200, '/clinical/consultation', 403, '/clerk/dashboard', 403],
      [laboratoryCookie, '/laboratory/dashboard', 200, '/pharmacy/dashboard', 403, '/admin/dashboard', 403],
      [managementCookie, '/management/dashboard', 200, '/clerk/dashboard', 403, '/pharmacy/dashboard', 403],
      [adminCookie, '/admin/dashboard', 200, '/clerk/dashboard', 403, '/clinical/dashboard', 403]
    ];
    for (const [cookie, allowedPath, allowedStatus, deniedPath, deniedStatus, secondDeniedPath, secondDeniedStatus] of rolePages) {
      assert.equal((await request(allowedPath, { cookie })).response.status, allowedStatus);
      assert.equal((await request(deniedPath, { cookie })).response.status, deniedStatus);
      assert.equal((await request(secondDeniedPath, { cookie })).response.status, secondDeniedStatus);
    }
    const roleDashboardApis = [
      [clerkCookie, 'clerk'], [nurseCookie, 'nursing'], [clinicianCookie, 'clinical'],
      [pharmacistCookie, 'pharmacy'], [laboratoryCookie, 'laboratory'],
      [managementCookie, 'management'], [adminCookie, 'administration']
    ];
    for (const [cookie, dashboardName] of roleDashboardApis) {
      const dashboardResponse = await request(`/api/dashboard/${dashboardName}`, { cookie });
      assert.equal(dashboardResponse.response.status, 200);
      assert.equal(dashboardResponse.payload.role, dashboardName);
      if (dashboardName === 'nursing') {
        assert.deepEqual(Object.keys(dashboardResponse.payload.stats).sort(), [
          'completedTriage', 'inTriage', 'urgentPatients', 'waitingForTriage'
        ].sort());
      }
    }
    const clerkCannotRequestNursingDashboard = await request('/api/dashboard/nursing', { cookie: clerkCookie });
    assert.equal(clerkCannotRequestNursingDashboard.response.status, 403);
    const adminDepartments = await request('/api/admin/departments', { cookie: adminCookie });
    assert.equal(adminDepartments.response.status, 200);
    const clerkDepartments = await request('/api/admin/departments', { cookie: clerkCookie });
    assert.equal(clerkDepartments.response.status, 403);
    const createdDepartment = await request('/api/admin/departments', {
      cookie: adminCookie,
      method: 'POST',
      body: { name: `Test department ${suffix}`, code: `T-${suffix.slice(0, 8).toUpperCase()}`, description: 'Test department only' }
    });
    assert.equal(createdDepartment.response.status, 201);
    departmentIds.push(createdDepartment.payload.department.id);
    const adminSettings = await request('/api/admin/settings', { cookie: adminCookie });
    assert.equal(adminSettings.response.status, 200);
    const nurseSettings = await request('/api/admin/settings', { cookie: nurseCookie });
    assert.equal(nurseSettings.response.status, 403);
    const priorFacilityName = await pool.query(
      `SELECT setting_value, updated_by, updated_at FROM system_settings WHERE setting_key = 'facility_name'`
    );
    originalFacilitySetting = priorFacilityName.rows[0] || null;
    const savedFacilityName = await request('/api/admin/settings/facility_name', {
      cookie: adminCookie,
      method: 'PUT',
      body: { value: `Test ${suffix}` }
    });
    assert.equal(savedFacilityName.response.status, 200);
    facilityNameChanged = true;
    const unknownSetting = await request('/api/admin/settings/database_password', {
      cookie: adminCookie,
      method: 'PUT',
      body: { value: 'not allowed' }
    });
    assert.equal(unknownSetting.response.status, 400);

    const adminDefaultPatients = await request('/api/patients', { cookie: adminCookie });
    assert.equal(adminDefaultPatients.response.status, 403);
    const adminDefaultClinicalQueue = await request('/api/workflow/queue', { cookie: adminCookie });
    assert.equal(adminDefaultClinicalQueue.response.status, 403);
    const adminDefaultPharmacy = await request('/api/pharmacy/medicines', { cookie: adminCookie });
    assert.equal(adminDefaultPharmacy.response.status, 403);
    const adminQueueGrant = await request(`/api/admin/users/${admin.id}/permissions`, {
      cookie: adminCookie,
      method: 'PUT',
      body: { permissions: [{ name: 'queue.clinical.view', granted: true }] }
    });
    assert.equal(adminQueueGrant.response.status, 204);
    const adminQueueAfterGrant = await request('/api/workflow/queue', { cookie: adminCookie });
    assert.equal(adminQueueAfterGrant.response.status, 200);
    const permissionAudit = await pool.query(
      `SELECT 1 FROM audit_events
       WHERE actor_id = $1 AND resource_id = $1 AND action = 'admin.user_permissions_updated'`,
      [admin.id]
    );
    assert.ok(permissionAudit.rowCount >= 1);
    const managementCannotManageAppointments = await request('/api/workflow/appointments', {
      cookie: managementCookie,
      method: 'POST',
      body: { patientId: crypto.randomUUID(), scheduledAt: new Date().toISOString() }
    });
    assert.equal(managementCannotManageAppointments.response.status, 403);
    const nurseCannotCreateAppointments = await request('/api/workflow/appointments', {
      cookie: nurseCookie,
      method: 'POST',
      body: { patientId: crypto.randomUUID(), scheduledAt: new Date().toISOString() }
    });
    assert.equal(nurseCannotCreateAppointments.response.status, 403);
    const managementCanViewReports = await request('/api/reports/daily', { cookie: managementCookie });
    assert.equal(managementCanViewReports.response.status, 200);
    const clerkCannotViewReports = await request('/api/reports/daily', { cookie: clerkCookie });
    assert.equal(clerkCannotViewReports.response.status, 403);
    const adminCanManagePermissions = await request('/api/admin/permissions', { cookie: adminCookie });
    assert.equal(adminCanManagePermissions.response.status, 200);
    const nurseCannotManagePermissions = await request('/api/admin/permissions', { cookie: nurseCookie });
    assert.equal(nurseCannotManagePermissions.response.status, 403);

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
    const unauthenticatedCreate = await request('/api/patients', {
      method: 'POST',
      body: { firstName: 'Unauthenticated', lastName: 'Fictional' }
    });
    assert.equal(unauthenticatedCreate.response.status, 401);
    const missingRequiredName = await request('/api/patients', {
      cookie: clerkCookie,
      method: 'POST',
      body: { lastName: 'Fictional' }
    });
    assert.equal(missingRequiredName.response.status, 400);
    assert.match(missingRequiredName.payload.error, /first and last name are required/i);

    const originalConnect = pool.connect;
    pool.connect = function (...args) {
      const wrapClient = (client) => new Proxy(client, {
        get(target, property) {
          if (property === 'query') {
            return (query, ...queryArgs) => {
              const sql = typeof query === 'string' ? query : query && query.text;
              if (typeof sql === 'string' && sql.startsWith('INSERT INTO patients')) {
                return Promise.reject(Object.assign(new Error('Simulated database write failure.'), { code: 'XX000' }));
              }
              return target.query(query, ...queryArgs);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
      if (typeof args[0] === 'function') {
        return originalConnect.call(this, (error, client, release) => {
          args[0](error, client ? wrapClient(client) : client, release);
        });
      }
      return originalConnect.apply(this, args).then(wrapClient);
    };
    let databaseFailure;
    try {
      databaseFailure = await request('/api/patients', {
        cookie: clerkCookie,
        method: 'POST',
        body: {
          medicalRecordNumber: `DBFAIL-${suffix}`,
          firstName: 'Fictional',
          lastName: 'DatabaseFailure'
        }
      });
    } finally {
      pool.connect = originalConnect;
    }
    assert.equal(databaseFailure.response.status, 500);
    assert.equal(databaseFailure.payload.error, 'Internal server error.');
    assert.equal(JSON.stringify(databaseFailure.payload).includes('XX000'), false);
    const failedWriteCount = await pool.query('SELECT COUNT(*)::int AS count FROM patients WHERE medical_record_number = $1', [`DBFAIL-${suffix}`]);
    assert.equal(failedWriteCount.rows[0].count, 0);

    const created = await request('/api/patients', {
      cookie: clerkCookie,
      method: 'POST',
      body: {
        medicalRecordNumber: `DEMO-${suffix}`,
        firstName: 'Fictional',
        lastName: 'Testpatient',
        dateOfBirth: '1990-04-12',
        nextOfKinName: 'Fictional Relative',
        nextOfKinRelationship: 'Guardian',
        nextOfKinContact: '555-0100',
        previousMedicalHistory: 'No known chronic conditions.'
      }
    });
    assert.equal(created.response.status, 201);
    const patient = created.payload.patient;
    patientIds.push(patient.id);
    auditResourceIds.push(patient.id);
    const otherPatientResponse = await request('/api/patients', {
      cookie: clerkCookie,
      method: 'POST',
      body: {
        medicalRecordNumber: `OTHER-${suffix}`,
        firstName: 'Fictional',
        lastName: 'Otherpatient'
      }
    });
    assert.equal(otherPatientResponse.response.status, 201);
    const otherPatient = otherPatientResponse.payload.patient;
    patientIds.push(otherPatient.id);
    auditResourceIds.push(otherPatient.id);
    assert.match(patient.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    const savedPatientCount = await pool.query('SELECT COUNT(*)::int AS count FROM patients WHERE id = $1', [patient.id]);
    assert.equal(savedPatientCount.rows[0].count, 1);
    assert.equal(patient.next_of_kin_relationship, 'Guardian');
    assert.equal(patient.previous_medical_history, 'No known chronic conditions.');
    assert.equal(Object.hasOwn(patient, 'diagnoses'), false);

    const duplicatePatient = await request('/api/patients', {
      cookie: clerkCookie,
      method: 'POST',
      body: {
        firstName: 'Fictional',
        lastName: 'Testpatient',
        dateOfBirth: '1990-04-12'
      }
    });
    assert.equal(duplicatePatient.response.status, 409);
    const duplicatePatientNumber = await request('/api/patients', {
      cookie: clerkCookie,
      method: 'POST',
      body: {
        medicalRecordNumber: `DEMO-${suffix}`,
        firstName: 'Other',
        lastName: 'Fictional',
        dateOfBirth: '1985-08-22'
      }
    });
    assert.equal(duplicatePatientNumber.response.status, 409);
    assert.match(duplicatePatientNumber.payload.error, /already assigned/i);
    const duplicatePatientNumberCount = await pool.query(
      'SELECT COUNT(*)::int AS count FROM patients WHERE medical_record_number = $1',
      [`DEMO-${suffix}`]
    );
    assert.equal(duplicatePatientNumberCount.rows[0].count, 1);

    const patientList = await request(`/api/patients?search=${encodeURIComponent(`DEMO-${suffix}`)}`, { cookie: clerkCookie });
    assert.equal(patientList.response.status, 200);
    assert.equal(patientList.payload.patients.length, 1);
    assert.equal(Object.hasOwn(patientList.payload.patients[0], 'diagnoses'), false);
    const nurseCannotBrowseUnrelatedPatient = await request(`/api/patients/${patient.id}`, { cookie: nurseCookie });
    assert.equal(nurseCannotBrowseUnrelatedPatient.response.status, 404);
    const pharmacyCannotSearchPatients = await request('/api/patients', { cookie: pharmacistCookie });
    assert.equal(pharmacyCannotSearchPatients.response.status, 403);
    const laboratoryCannotSearchPatients = await request('/api/patients', { cookie: laboratoryCookie });
    assert.equal(laboratoryCannotSearchPatients.response.status, 403);
    const managementCannotSearchPatients = await request('/api/patients', { cookie: managementCookie });
    assert.equal(managementCannotSearchPatients.response.status, 403);

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

    const appointment = await request('/api/workflow/appointments', {
      cookie: clerkCookie,
      method: 'POST',
      body: { patientId: patient.id, scheduledAt: new Date().toISOString(), reason: 'Test appointment' }
    });
    assert.equal(appointment.response.status, 201);
    auditResourceIds.push(appointment.payload.appointment.id);

    const clerkClinicalQueue = await request('/api/workflow/queue', { cookie: clerkCookie });
    assert.equal(clerkClinicalQueue.response.status, 403);
    const clerkWaitingQueue = await request('/api/workflow/front-desk-queue', { cookie: clerkCookie });
    assert.equal(clerkWaitingQueue.response.status, 200);
    const checkin = await request('/api/workflow/check-in', {
      cookie: clerkCookie,
      method: 'POST',
      body: { patientId: patient.id, appointmentId: appointment.payload.appointment.id }
    });
    assert.equal(checkin.response.status, 201);
    assert.equal(checkin.payload.visit.status, 'waiting_triage');
    assert.equal(checkin.payload.visit.queue_number > 0, true);
    auditResourceIds.push(checkin.payload.visit.id);
    const clerkQueueAfterCheckin = await request('/api/workflow/front-desk-queue', { cookie: clerkCookie });
    const clerkQueueEntry = clerkQueueAfterCheckin.payload.visits.find((visit) => visit.id === checkin.payload.visit.id);
    assert.ok(clerkQueueEntry);
    assert.equal(clerkQueueEntry.status, 'waiting_triage');
    assert.equal(Object.hasOwn(clerkQueueEntry, 'diagnosis'), false);
    const nurseCannotUseClerkQueue = await request('/api/workflow/front-desk-queue', { cookie: nurseCookie });
    assert.equal(nurseCannotUseClerkQueue.response.status, 403);
    const duplicateCheckin = await request('/api/workflow/check-in', {
      cookie: clerkCookie,
      method: 'POST',
      body: { patientId: patient.id }
    });
    assert.equal(duplicateCheckin.response.status, 409);

    const nurseQueue = await request('/api/workflow/queue', { cookie: nurseCookie });
    assert.equal(nurseQueue.response.status, 200);
    assert.ok(nurseQueue.payload.visits.some((visit) => visit.id === checkin.payload.visit.id));
    const triageStarted = await request(`/api/workflow/visits/${checkin.payload.visit.id}/triage/start`, {
      cookie: nurseCookie,
      method: 'POST',
      body: {}
    });
    assert.equal(triageStarted.response.status, 200);
    assert.equal(triageStarted.payload.visit.status, 'in_triage');
    const triaged = await request(`/api/workflow/visits/${checkin.payload.visit.id}/triage`, {
      cookie: nurseCookie,
      method: 'POST',
      body: {
        temperature: 38.2,
        bloodPressure: '120/80',
        pulseRate: 86,
        respiratoryRate: 18,
        oxygenSaturation: 98,
        weight: 68.5,
        height: 170,
        painLevel: 2,
        nursingNotes: 'Test triage',
        triagePriority: 'routine',
        sendToClinician: false
      }
    });
    assert.equal(triaged.response.status, 200);
    assert.equal(triaged.payload.visit.status, 'in_triage');
    assert.equal(triaged.payload.visit.pain_level, 2);
    const sentToClinician = await request(`/api/workflow/visits/${checkin.payload.visit.id}/triage`, {
      cookie: nurseCookie,
      method: 'POST',
      body: {
        temperature: 38.2,
        bloodPressure: '120/80',
        pulseRate: 86,
        respiratoryRate: 18,
        oxygenSaturation: 98,
        weight: 68.5,
        height: 170,
        painLevel: 2,
        nursingNotes: 'Test triage',
        triagePriority: 'routine',
        sendToClinician: true
      }
    });
    assert.equal(sentToClinician.response.status, 200);
    assert.equal(sentToClinician.payload.visit.status, 'waiting_clinician');
    const nursingStatsAfterTriage = await request('/api/dashboard/nursing', { cookie: nurseCookie });
    assert.ok(nursingStatsAfterTriage.payload.stats.completedTriage >= 1);
    const clerkQueueAfterTriage = await request('/api/workflow/front-desk-queue', { cookie: clerkCookie });
    assert.equal(clerkQueueAfterTriage.payload.visits.find((visit) => visit.id === checkin.payload.visit.id).status, 'waiting_clinician');
    const nursePermissionRevoked = await request(`/api/admin/users/${nurse.id}/permissions`, {
      cookie: adminCookie,
      method: 'PUT',
      body: { permissions: [{ name: 'triage.create', granted: false }] }
    });
    assert.equal(nursePermissionRevoked.response.status, 204);
    const revokedTriageAction = await request(`/api/workflow/visits/${checkin.payload.visit.id}/triage`, {
      cookie: nurseCookie,
      method: 'POST',
      body: {}
    });
    assert.equal(revokedTriageAction.response.status, 403);

    const started = await request(`/api/visits/${checkin.payload.visit.id}/start`, {
      cookie: clinicianCookie,
      method: 'PATCH',
      body: {}
    });
    assert.equal(started.response.status, 200);
    assert.equal(started.payload.visit.status, 'in_consultation');

    assert.equal((await request('/api/laboratory/catalogue', { cookie: clerkCookie })).response.status, 403);
    const numericTest = await request('/api/laboratory/catalogue', {
      cookie: laboratoryCookie,
      method: 'POST',
      body: {
        code: `NUM-${suffix}`,
        name: 'Fictional numeric QA test',
        resultType: 'numeric',
        unit: 'test units',
        specimenRequirements: 'Fictional test specimen'
      }
    });
    assert.equal(numericTest.response.status, 201);
    laboratoryTestIds.push(numericTest.payload.test.id);
    auditResourceIds.push(numericTest.payload.test.id);
    const qualitativeTest = await request('/api/laboratory/catalogue', {
      cookie: laboratoryCookie,
      method: 'POST',
      body: {
        code: `QUAL-${suffix}`,
        name: 'Fictional qualitative QA test',
        resultType: 'qualitative',
        allowedValues: ['Configured option A', 'Configured option B'],
        specimenRequirements: 'Fictional test specimen'
      }
    });
    assert.equal(qualitativeTest.response.status, 201);
    laboratoryTestIds.push(qualitativeTest.payload.test.id);
    auditResourceIds.push(qualitativeTest.payload.test.id);
    const textTest = await request('/api/laboratory/catalogue', {
      cookie: laboratoryCookie,
      method: 'POST',
      body: {
        code: `TEXT-${suffix}`,
        name: 'Fictional text QA test',
        resultType: 'text',
        specimenRequirements: 'Fictional test specimen'
      }
    });
    assert.equal(textTest.response.status, 201);
    laboratoryTestIds.push(textTest.payload.test.id);
    auditResourceIds.push(textTest.payload.test.id);
    const cancellationTest = await request('/api/laboratory/catalogue', {
      cookie: laboratoryCookie,
      method: 'POST',
      body: {
        code: `CANCEL-${suffix}`,
        name: 'Fictional cancellation QA test',
        resultType: 'text',
        specimenRequirements: 'Fictional test specimen'
      }
    });
    assert.equal(cancellationTest.response.status, 201);
    laboratoryTestIds.push(cancellationTest.payload.test.id);
    auditResourceIds.push(cancellationTest.payload.test.id);
    const invalidQualitativeDefinition = await request('/api/laboratory/catalogue', {
      cookie: laboratoryCookie,
      method: 'POST',
      body: {
        code: `BAD-${suffix}`,
        name: 'Invalid qualitative test',
        resultType: 'qualitative',
        specimenRequirements: 'Fictional test specimen'
      }
    });
    assert.equal(invalidQualitativeDefinition.response.status, 400);
    assert.equal((await request('/api/laboratory/catalogue', { cookie: clinicianCookie })).payload.tests
      .some((item) => item.id === numericTest.payload.test.id), true);
    assert.equal((await request('/api/laboratory/catalogue', { cookie: pharmacistCookie })).response.status, 403);
    const noTestRequest = await request(`/api/laboratory/visits/${checkin.payload.visit.id}/requests`, {
      cookie: clinicianCookie,
      method: 'POST',
      body: { clinicalIndication: 'Fictional QA indication' }
    });
    assert.equal(noTestRequest.response.status, 400);
    const savedClinical = await request(`/api/laboratory/visits/${checkin.payload.visit.id}/requests`, {
      cookie: clinicianCookie,
      method: 'POST',
      body: {
        testId: numericTest.payload.test.id,
        patientId: crypto.randomUUID(),
        clinicalIndication: 'Fictional QA indication',
        priority: 'urgent'
      }
    });
    assert.equal(savedClinical.response.status, 201);
    assert.match(savedClinical.payload.request.request_number, /^LAB-\d{8}-\d{8}$/);
    assert.equal(savedClinical.payload.request.patient_id, patient.id);
    assert.equal(savedClinical.payload.request.visit_id, checkin.payload.visit.id);
    assert.equal(savedClinical.payload.request.status, 'pending');
    auditResourceIds.push(savedClinical.payload.request.id);
    const changedCatalogueAfterOrder = await request(`/api/laboratory/catalogue/${numericTest.payload.test.id}`, {
      cookie: laboratoryCookie,
      method: 'PATCH',
      body: {
        code: `NUM-${suffix}`,
        name: 'Updated fictional numeric QA test',
        resultType: 'text',
        unit: 'changed unit',
        referenceRange: 'No clinical range supplied',
        specimenRequirements: 'Updated fictional test specimen',
        allowedValues: [],
        isActive: true
      }
    });
    assert.equal(changedCatalogueAfterOrder.response.status, 200);
    const duplicateLabRequest = await request(`/api/laboratory/visits/${checkin.payload.visit.id}/requests`, {
      cookie: clinicianCookie,
      method: 'POST',
      body: {
        testId: numericTest.payload.test.id,
        clinicalIndication: 'Duplicate fictional QA indication',
        priority: 'routine'
      }
    });
    assert.equal(duplicateLabRequest.response.status, 409);
    const mismatchedPatientRequest = await pool.query(
      `INSERT INTO lab_requests (visit_id, patient_id, requested_by, test_name, request_number)
       VALUES ($1, $2, $3, 'Mismatched test fixture', $4)`,
      [checkin.payload.visit.id, otherPatient.id, clinician.id, `INVALID-${suffix}`]
    ).then(() => null, (error) => error);
    assert.equal(mismatchedPatientRequest && mismatchedPatientRequest.code, '23503');
    const secondLabRequest = await request(`/api/laboratory/visits/${checkin.payload.visit.id}/requests`, {
      cookie: clinicianCookie,
      method: 'POST',
      body: {
        testId: qualitativeTest.payload.test.id,
        clinicalIndication: 'Confirm qualitative workflow',
        priority: 'routine'
      }
    });
    assert.equal(secondLabRequest.response.status, 201);
    auditResourceIds.push(secondLabRequest.payload.request.id);
    assert.notEqual(savedClinical.payload.request.request_number, secondLabRequest.payload.request.request_number);
    const rejectedLabRequest = await request(`/api/workflow/visits/${checkin.payload.visit.id}/lab-requests`, {
      cookie: clinicianCookie,
      method: 'POST',
      body: {
        testId: textTest.payload.test.id,
        clinicalIndication: 'Confirm specimen rejection workflow',
        priority: 'routine'
      }
    });
    assert.equal(rejectedLabRequest.response.status, 201);
    auditResourceIds.push(rejectedLabRequest.payload.request.id);
    const cancellationRequest = await request(`/api/laboratory/visits/${checkin.payload.visit.id}/requests`, {
      cookie: clinicianCookie,
      method: 'POST',
      body: { testId: cancellationTest.payload.test.id, clinicalIndication: 'Fictional cancellation workflow' }
    });
    assert.equal(cancellationRequest.response.status, 201);
    auditResourceIds.push(cancellationRequest.payload.request.id);
    const unauthorizedRequest = await request(`/api/laboratory/visits/${checkin.payload.visit.id}/requests`, {
      cookie: pharmacistCookie,
      method: 'POST',
      body: { testId: textTest.payload.test.id, clinicalIndication: 'Unauthorized' }
    });
    assert.equal(unauthorizedRequest.response.status, 403);
    const rollbackTest = await request('/api/laboratory/catalogue', {
      cookie: laboratoryCookie,
      method: 'POST',
      body: {
        code: `ROLLBACK-${suffix}`,
        name: 'Fictional persistence rollback QA test',
        resultType: 'text',
        specimenRequirements: 'Fictional test specimen'
      }
    });
    assert.equal(rollbackTest.response.status, 201);
    laboratoryTestIds.push(rollbackTest.payload.test.id);
    auditResourceIds.push(rollbackTest.payload.test.id);
    const processingFailureRequest = await request(`/api/laboratory/visits/${checkin.payload.visit.id}/requests`, {
      cookie: clinicianCookie, method: 'POST',
      body: { testId: rollbackTest.payload.test.id, clinicalIndication: 'Verify laboratory transaction rollback' }
    });
    assert.equal(processingFailureRequest.response.status, 201);
    auditResourceIds.push(processingFailureRequest.payload.request.id);
    assert.equal((await request(`/api/laboratory/requests/${processingFailureRequest.payload.request.id}/specimen`, {
      cookie: laboratoryCookie, method: 'PATCH',
      body: { action: 'receive', specimenIdentifier: `SPEC-${suffix}-FAIL` }
    })).response.status, 200);
    assert.equal((await request(`/api/laboratory/requests/${processingFailureRequest.payload.request.id}/process`, {
      cookie: laboratoryCookie, method: 'POST', body: {}
    })).response.status, 200);
    const originalLabConnect = pool.connect;
    pool.connect = function patchedConnect(...args) {
      const wrapClient = (client) => new Proxy(client, {
        get(target, property) {
          if (property === 'query') {
            return (query, ...queryArgs) => {
              const sql = typeof query === 'string' ? query : query && query.text;
              if (typeof sql === 'string' && sql.startsWith('INSERT INTO lab_result_versions')) {
                return Promise.reject(Object.assign(new Error('Simulated result-version persistence failure.'), { code: 'XX000' }));
              }
              return target.query(query, ...queryArgs);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
      if (typeof args[0] === 'function') {
        return originalLabConnect.call(this, (error, client, release) => {
          args[0](error, client ? wrapClient(client) : client, release);
        });
      }
      return originalLabConnect.apply(this, args).then(wrapClient);
    };
    let resultWriteFailure;
    try {
      resultWriteFailure = await request(`/api/laboratory/requests/${processingFailureRequest.payload.request.id}/results`, {
        cookie: laboratoryCookie, method: 'POST', body: { value: 'Failure test' }
      });
    } finally {
      pool.connect = originalLabConnect;
    }
    assert.equal(resultWriteFailure.response.status, 500);
    const resultWriteRollback = await pool.query(
      `SELECT lr.status, COUNT(rv.id)::int AS versions
       FROM lab_requests lr LEFT JOIN lab_result_versions rv ON rv.request_id = lr.id
       WHERE lr.id = $1 GROUP BY lr.id`,
      [processingFailureRequest.payload.request.id]
    );
    assert.equal(resultWriteRollback.rows[0].status, 'processing');
    assert.equal(resultWriteRollback.rows[0].versions, 0);
    const cancelFailedPersistenceRequest = await request(`/api/laboratory/requests/${processingFailureRequest.payload.request.id}/cancel`, {
      cookie: clinicianCookie, method: 'PATCH',
      body: { reason: 'Fictional rollback scenario complete' }
    });
    assert.equal(cancelFailedPersistenceRequest.response.status, 200);
    assert.equal(cancelFailedPersistenceRequest.payload.request.status, 'cancelled');

    const medicine = await request('/api/pharmacy/medicines', {
      cookie: pharmacistCookie,
      method: 'POST',
      body: {
        name: 'Workflow test medicine',
        strength: '500 mg',
        dosageForm: 'tablet',
        unit: 'tablet',
        minimumStockLevel: 20
      }
    });
    assert.equal(medicine.response.status, 201);
    medicineIds.push(medicine.payload.medicine.id);
    assert.equal(medicine.payload.medicine.current_quantity, 0);
    const duplicateCatalogueMedicine = await request('/api/pharmacy/medicines', {
      cookie: pharmacistCookie,
      method: 'POST',
      body: {
        name: 'Workflow test medicine',
        strength: '500 mg',
        dosageForm: 'tablet',
        unit: 'tablet'
      }
    });
    assert.equal(duplicateCatalogueMedicine.response.status, 409);

    const prescription = await request('/api/prescriptions', {
      cookie: clinicianCookie,
      method: 'POST',
      body: {
        patientId: patient.id,
        consultationId: checkin.payload.visit.id,
        medicineId: medicine.payload.medicine.id,
        dose: '500 mg',
        frequency: '3 times daily',
        duration: '3 days',
        quantity: 9,
        instructions: 'Test only'
      }
    });
    assert.equal(prescription.response.status, 201);
    assert.equal(prescription.payload.prescription.status, 'pending');
    auditResourceIds.push(prescription.payload.prescription.id);
    const clinicianCatalogue = await request('/api/pharmacy/catalogue', { cookie: clinicianCookie });
    assert.equal(clinicianCatalogue.response.status, 200);
    assert.ok(clinicianCatalogue.payload.medicines.some((item) => item.id === medicine.payload.medicine.id));
    assert.equal((await request('/api/pharmacy/catalogue', { cookie: clerkCookie })).response.status, 403);
    const missingPrescriptionMedicine = await request('/api/prescriptions', {
      cookie: clinicianCookie,
      method: 'POST',
      body: { patientId: patient.id, dose: '1 tablet', quantity: 1 }
    });
    assert.equal(missingPrescriptionMedicine.response.status, 400);
    const pharmacistCannotPrescribe = await request('/api/prescriptions', {
      cookie: pharmacistCookie,
      method: 'POST',
      body: { patientId: patient.id, medicineId: medicine.payload.medicine.id, dose: '1 tablet', quantity: 1 }
    });
    assert.equal(pharmacistCannotPrescribe.response.status, 403);

    const pharmacistQueue = await request('/api/prescriptions?search=Testpatient', { cookie: pharmacistCookie });
    assert.equal(pharmacistQueue.response.status, 200);
    assert.ok(pharmacistQueue.payload.prescriptions.some((item) => item.id === prescription.payload.prescription.id));

    const clerkInventory = await request('/api/pharmacy/medicines', { cookie: clerkCookie });
    assert.equal(clerkInventory.response.status, 403);
    const pharmacistAdminPage = await request('/api/admin/users', { cookie: pharmacistCookie });
    assert.equal(pharmacistAdminPage.response.status, 403);
    const nurseAdminPage = await request('/api/admin/users', { cookie: nurseCookie });
    assert.equal(nurseAdminPage.response.status, 403);
    assert.equal((await request('/api/pharmacy/batches', { cookie: clerkCookie })).response.status, 403);
    assert.equal((await request('/api/pharmacy/stock-adjustments', {
      cookie: clerkCookie,
      method: 'POST',
      body: { batchId: crypto.randomUUID(), quantity: 1, reason: 'Unauthorized test' }
    })).response.status, 403);
    assert.equal((await request(`/api/pharmacy/batches/${crypto.randomUUID()}/status`, {
      cookie: clerkCookie,
      method: 'PATCH',
      body: { status: 'quarantined', reason: 'Unauthorized test' }
    })).response.status, 403);

    const initialBatchReceipt = await request('/api/pharmacy/stock-receive', {
      cookie: pharmacistCookie,
      method: 'POST',
      body: {
        medicineId: medicine.payload.medicine.id,
        quantity: 100,
        batchNumber: `WF-${suffix}`,
        expiresAt: '2035-12-31',
        supplier: 'Fictional workflow supplier',
        referenceCode: `INV-${suffix}`
      }
    });
    assert.equal(initialBatchReceipt.response.status, 201);
    auditResourceIds.push(initialBatchReceipt.payload.batch.id);

    const createdCatalogueMedicine = await request('/api/pharmacy/medicines', {
      cookie: pharmacistCookie,
      method: 'POST',
      body: {
        name: `Incoming stock test ${suffix}`,
        genericName: 'Test ingredient',
        strength: '250 mg',
        dosageForm: 'capsule',
        unit: 'capsules',
        minimumStockLevel: 5,
      }
    });
    assert.equal(createdCatalogueMedicine.response.status, 201);
    medicineIds.push(createdCatalogueMedicine.payload.medicine.id);
    assert.equal(createdCatalogueMedicine.payload.medicine.current_quantity, 0);
    const receivedNewMedicine = await request('/api/pharmacy/stock-receive', {
      cookie: pharmacistCookie,
      method: 'POST',
      body: {
        medicineId: createdCatalogueMedicine.payload.medicine.id,
        quantity: 24,
        batchNumber: `B-${suffix}`,
        expiresAt: '2035-12-31',
        supplier: 'Test supplier',
        notes: 'Stock received for inventory workflow test'
      }
    });
    assert.equal(receivedNewMedicine.response.status, 201);
    auditResourceIds.push(receivedNewMedicine.payload.batch.id);
    assert.equal(receivedNewMedicine.payload.medicine.current_quantity, 24);
    assert.equal(receivedNewMedicine.payload.movement.quantity, 24);
    const receivedExistingMedicine = await request('/api/pharmacy/stock-receive', {
      cookie: pharmacistCookie,
      method: 'POST',
      body: {
        medicineId: receivedNewMedicine.payload.medicine.id,
        quantity: 8,
        batchNumber: `B-${suffix}`,
        expiresAt: '2035-12-31',
        notes: 'Second delivery'
      }
    });
    assert.equal(receivedExistingMedicine.response.status, 201);
    assert.equal(receivedExistingMedicine.payload.medicine.current_quantity, 32);
    assert.equal(receivedExistingMedicine.payload.batch.quantity_received, 32);
    assert.equal(receivedExistingMedicine.payload.batch.current_quantity, 32);
    const secondBatchReceipt = await request('/api/pharmacy/stock-receive', {
      cookie: pharmacistCookie,
      method: 'POST',
      body: {
        medicineId: receivedNewMedicine.payload.medicine.id,
        quantity: 6,
        batchNumber: `B2-${suffix}`,
        expiresAt: '2036-12-31',
        notes: 'Separate lot'
      }
    });
    assert.equal(secondBatchReceipt.response.status, 201);
    auditResourceIds.push(secondBatchReceipt.payload.batch.id);
    const listedBatches = await request('/api/pharmacy/batches', { cookie: pharmacistCookie });
    assert.equal(listedBatches.response.status, 200);
    const distinctTestBatches = listedBatches.payload.batches.filter((batch) => batch.medicine_id === receivedNewMedicine.payload.medicine.id);
    assert.equal(distinctTestBatches.length, 2);
    assert.equal(new Set(distinctTestBatches.map((batch) => batch.id)).size, 2);
    const newMedicineMovement = await pool.query(
      `SELECT quantity_before, quantity_after, movement_type FROM stock_movements
       WHERE batch_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [receivedExistingMedicine.payload.batch.id]
    );
    assert.deepEqual(newMedicineMovement.rows[0], {
      quantity_before: 24,
      quantity_after: 32,
      movement_type: 'stock_received'
    });
    const adjustedStock = await request('/api/pharmacy/stock-adjustments', {
      cookie: pharmacistCookie,
      method: 'POST',
      body: { batchId: receivedExistingMedicine.payload.batch.id, quantity: 2, reason: 'Fictional reconciliation test' }
    });
    assert.equal(adjustedStock.response.status, 200);
    assert.equal(adjustedStock.payload.batch.current_quantity, 34);
    const reversedTestAdjustment = await request('/api/pharmacy/stock-adjustments', {
      cookie: pharmacistCookie,
      method: 'POST',
      body: { batchId: receivedExistingMedicine.payload.batch.id, quantity: -2, reason: 'Restore test quantity' }
    });
    assert.equal(reversedTestAdjustment.response.status, 200);
    assert.equal(reversedTestAdjustment.payload.batch.current_quantity, 32);
    const belowZeroAdjustment = await request('/api/pharmacy/stock-adjustments', {
      cookie: pharmacistCookie,
      method: 'POST',
      body: { batchId: receivedExistingMedicine.payload.batch.id, quantity: -100, reason: 'Must be rejected' }
    });
    assert.equal(belowZeroAdjustment.response.status, 400);
    const pharmacyInventoryAfterReceipt = await request('/api/pharmacy/medicines', { cookie: pharmacistCookie });
    assert.ok(pharmacyInventoryAfterReceipt.payload.medicines.some((entry) => entry.id === receivedNewMedicine.payload.medicine.id));
    const missingBatchNumber = await request('/api/pharmacy/stock-receive', {
      cookie: pharmacistCookie,
      method: 'POST',
      body: { medicineId: receivedNewMedicine.payload.medicine.id, quantity: 10 }
    });
    assert.equal(missingBatchNumber.response.status, 400);

    const oversizedDispense = await request('/api/pharmacy/dispense', {
      cookie: pharmacistCookie,
      method: 'POST',
      body: { prescriptionId: prescription.payload.prescription.id, batchId: initialBatchReceipt.payload.batch.id, quantity: 10 }
    });
    assert.equal(oversizedDispense.response.status, 400);
    const unchangedStock = await pool.query('SELECT current_quantity FROM medicines WHERE id = $1', [medicine.payload.medicine.id]);
    assert.equal(unchangedStock.rows[0].current_quantity, 100);
    const prescriptionDateBeforeDispensing = await pool.query(
      'SELECT prescription_date FROM prescriptions WHERE id = $1',
      [prescription.payload.prescription.id]
    );
    const quarantineBatch = await request(`/api/pharmacy/batches/${initialBatchReceipt.payload.batch.id}/status`, {
      cookie: pharmacistCookie,
      method: 'PATCH',
      body: { status: 'quarantined', reason: 'Fictional acceptance test' }
    });
    assert.equal(quarantineBatch.response.status, 200);
    const quarantinedDispense = await request('/api/pharmacy/dispense', {
      cookie: pharmacistCookie,
      method: 'POST',
      body: { prescriptionId: prescription.payload.prescription.id, batchId: initialBatchReceipt.payload.batch.id, quantity: 1 }
    });
    assert.equal(quarantinedDispense.response.status, 400);
    const releaseBatch = await request(`/api/pharmacy/batches/${initialBatchReceipt.payload.batch.id}/status`, {
      cookie: pharmacistCookie,
      method: 'PATCH',
      body: { status: 'active', reason: 'Fictional acceptance test passed' }
    });
    assert.equal(releaseBatch.response.status, 200);
    const dispensingOriginalConnect = pool.connect;
    pool.connect = function (...args) {
      const wrapClient = (client) => new Proxy(client, {
        get(target, property) {
          if (property === 'query') {
            return (query, ...queryArgs) => {
              const sql = typeof query === 'string' ? query : query && query.text;
              if (typeof sql === 'string' && sql.startsWith('INSERT INTO dispensing')) {
                return Promise.reject(Object.assign(new Error('Simulated dispensing write failure.'), { code: 'XX000' }));
              }
              return target.query(query, ...queryArgs);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
      if (typeof args[0] === 'function') {
        return dispensingOriginalConnect.call(this, (error, client, release) => {
          args[0](error, client ? wrapClient(client) : client, release);
        });
      }
      return dispensingOriginalConnect.apply(this, args).then(wrapClient);
    };
    let dispensingFailure;
    try {
      dispensingFailure = await request('/api/pharmacy/dispense', {
        cookie: pharmacistCookie,
        method: 'POST',
        body: { prescriptionId: prescription.payload.prescription.id, batchId: initialBatchReceipt.payload.batch.id, quantity: 1 }
      });
    } finally {
      pool.connect = dispensingOriginalConnect;
    }
    assert.equal(dispensingFailure.response.status, 500);
    assert.equal(dispensingFailure.payload.error, 'Internal server error.');
    const rolledBackDispensing = await pool.query(
      `SELECT m.current_quantity, b.current_quantity AS batch_quantity,
              (SELECT COUNT(*)::int FROM dispensing WHERE prescription_id = $2) AS dispensing_count
       FROM medicines m JOIN medicine_batches b ON b.medicine_id = m.id
       WHERE m.id = $1 AND b.id = $3`,
      [medicine.payload.medicine.id, prescription.payload.prescription.id, initialBatchReceipt.payload.batch.id]
    );
    assert.equal(rolledBackDispensing.rows[0].current_quantity, 100);
    assert.equal(rolledBackDispensing.rows[0].batch_quantity, 100);
    assert.equal(rolledBackDispensing.rows[0].dispensing_count, 0);
    const partialDispense = await request('/api/pharmacy/dispense', {
      cookie: pharmacistCookie,
      method: 'POST',
      body: { prescriptionId: prescription.payload.prescription.id, batchId: initialBatchReceipt.payload.batch.id, quantity: 4 }
    });
    assert.equal(partialDispense.response.status, 200);
    assert.equal(partialDispense.payload.outcome.prescription.status, 'partially_dispensed');
    const duplicatePartial = await request('/api/pharmacy/dispense', {
      cookie: pharmacistCookie,
      method: 'POST',
      body: { prescriptionId: prescription.payload.prescription.id, batchId: initialBatchReceipt.payload.batch.id, quantity: 6 }
    });
    assert.equal(duplicatePartial.response.status, 400);
    const concurrentFinalDispenses = await Promise.all([1, 2].map(() => request('/api/pharmacy/dispense', {
      cookie: pharmacistCookie,
      method: 'POST',
      body: { prescriptionId: prescription.payload.prescription.id, batchId: initialBatchReceipt.payload.batch.id, quantity: 5 }
    })));
    assert.equal(concurrentFinalDispenses.filter((result) => result.response.status === 200).length, 1);
    assert.equal(concurrentFinalDispenses.filter((result) => result.response.status === 404).length, 1);
    const finalDispense = concurrentFinalDispenses.find((result) => result.response.status === 200);
    assert.equal(finalDispense.payload.outcome.prescription.status, 'dispensed');
    const prescriptionDateAfterDispensing = await pool.query(
      'SELECT prescription_date FROM prescriptions WHERE id = $1',
      [prescription.payload.prescription.id]
    );
    assert.equal(prescriptionDateAfterDispensing.rows[0].prescription_date.getTime(),
      prescriptionDateBeforeDispensing.rows[0].prescription_date.getTime());
    const stock = await pool.query('SELECT current_quantity FROM medicines WHERE id = $1', [medicine.payload.medicine.id]);
    assert.equal(stock.rows[0].current_quantity, 91);
    const batchStock = await pool.query('SELECT current_quantity FROM medicine_batches WHERE id = $1', [initialBatchReceipt.payload.batch.id]);
    assert.equal(batchStock.rows[0].current_quantity, 91);
    const statusAfterDispensing = await pool.query('SELECT status FROM visits WHERE id = $1', [checkin.payload.visit.id]);
    assert.equal(statusAfterDispensing.rows[0].status, 'in_consultation');

    const expiredMedicine = await request('/api/pharmacy/medicines', {
      cookie: pharmacistCookie,
      method: 'POST',
      body: { name: 'Expired workflow medicine', unit: 'tablet', minimumStockLevel: 0 }
    });
    assert.equal(expiredMedicine.response.status, 201);
    medicineIds.push(expiredMedicine.payload.medicine.id);
    const expiredPrescription = await request('/api/prescriptions', {
      cookie: clinicianCookie,
      method: 'POST',
      body: { patientId: patient.id, medicineId: expiredMedicine.payload.medicine.id, dose: '1 tablet', quantity: 1 }
    });
    assert.equal(expiredPrescription.response.status, 201);
    auditResourceIds.push(expiredPrescription.payload.prescription.id);
    const expiredReceipt = await request('/api/pharmacy/stock-receive', {
      cookie: pharmacistCookie,
      method: 'POST',
      body: {
        medicineId: expiredMedicine.payload.medicine.id,
        quantity: 5,
        batchNumber: `EXPIRED-${suffix}`,
        expiresAt: '2020-01-01'
      }
    });
    assert.equal(expiredReceipt.response.status, 400);
    const expiredBatchInsert = await pool.query(
      `INSERT INTO medicine_batches (medicine_id, batch_number, expires_at, quantity_received, current_quantity, status)
       VALUES ($1, $2, '2020-01-01', 5, 5, 'expired') RETURNING id`,
      [expiredMedicine.payload.medicine.id, `EXPIRED-${suffix}`]
    );
    await pool.query('UPDATE medicines SET current_quantity = 5 WHERE id = $1', [expiredMedicine.payload.medicine.id]);
    const expiredDispense = await request('/api/pharmacy/dispense', {
      cookie: pharmacistCookie,
      method: 'POST',
      body: { prescriptionId: expiredPrescription.payload.prescription.id, batchId: expiredBatchInsert.rows[0].id, quantity: 1 }
    });
    assert.equal(expiredDispense.response.status, 400);
    const expiredRelease = await request(`/api/pharmacy/batches/${expiredBatchInsert.rows[0].id}/status`, {
      cookie: pharmacistCookie,
      method: 'PATCH',
      body: { status: 'active', reason: 'Expired batch cannot be released' }
    });
    assert.equal(expiredRelease.response.status, 400);
    const expiredStock = await pool.query('SELECT current_quantity FROM medicines WHERE id = $1', [expiredMedicine.payload.medicine.id]);
    assert.equal(expiredStock.rows[0].current_quantity, 5);

    const limitedMedicine = await request('/api/pharmacy/medicines', {
      cookie: pharmacistCookie,
      method: 'POST',
      body: { name: 'Limited workflow medicine', unit: 'tablet', minimumStockLevel: 0 }
    });
    assert.equal(limitedMedicine.response.status, 201);
    medicineIds.push(limitedMedicine.payload.medicine.id);
    const insufficientPrescription = await request('/api/prescriptions', {
      cookie: clinicianCookie,
      method: 'POST',
      body: { patientId: patient.id, medicineId: limitedMedicine.payload.medicine.id, dose: '1 tablet', quantity: 10 }
    });
    assert.equal(insufficientPrescription.response.status, 201);
    auditResourceIds.push(insufficientPrescription.payload.prescription.id);
    const limitedBatchReceipt = await request('/api/pharmacy/stock-receive', {
      cookie: pharmacistCookie,
      method: 'POST',
      body: {
        medicineId: limitedMedicine.payload.medicine.id,
        quantity: 5,
        batchNumber: `LIMIT-${suffix}`,
        expiresAt: '2035-12-31'
      }
    });
    assert.equal(limitedBatchReceipt.response.status, 201);
    auditResourceIds.push(limitedBatchReceipt.payload.batch.id);
    const insufficientDispense = await request('/api/pharmacy/dispense', {
      cookie: pharmacistCookie,
      method: 'POST',
      body: { prescriptionId: insufficientPrescription.payload.prescription.id, batchId: limitedBatchReceipt.payload.batch.id, quantity: 10 }
    });
    assert.equal(insufficientDispense.response.status, 400);
    const limitedStock = await pool.query('SELECT current_quantity FROM medicines WHERE id = $1', [limitedMedicine.payload.medicine.id]);
    assert.equal(limitedStock.rows[0].current_quantity, 5);

    const consultationComplete = await request(`/api/visits/${checkin.payload.visit.id}/complete`, {
      cookie: clinicianCookie,
      method: 'PATCH',
      body: { symptoms: 'Test symptoms', diagnosis: 'Test diagnosis', treatmentNotes: 'Test treatment', followUp: 'Review as needed' }
    });
    assert.equal(consultationComplete.response.status, 200);
    assert.equal(consultationComplete.payload.visit.status, 'lab_requested');

    const labQueue = await request('/api/laboratory/requests', { cookie: laboratoryCookie });
    assert.equal(labQueue.response.status, 200);
    assert.ok(labQueue.payload.requests.some((item) => item.id === savedClinical.payload.request.id));
    assert.equal((await request('/api/workflow/laboratory', { cookie: laboratoryCookie })).response.status, 200);
    assert.equal((await request('/api/laboratory/reports', { cookie: adminCookie })).response.status, 200);
    assert.equal((await request('/api/laboratory/reports', { cookie: clerkCookie })).response.status, 403);
    const labDashboardWithUrgentOrder = await request('/api/dashboard/laboratory', { cookie: laboratoryCookie });
    assert.ok(labDashboardWithUrgentOrder.payload.stats.urgentLabRequests >= 1);
    assert.equal((await request('/api/laboratory/requests')).response.status, 401);
    assert.equal((await request('/api/laboratory/requests', { cookie: clinicianCookie })).response.status, 403);
    assert.equal((await request(`/api/laboratory/requests/${savedClinical.payload.request.id}/process`, {
      cookie: laboratoryCookie,
      method: 'POST',
      body: {}
    })).response.status, 409);
    const missingSpecimenId = await request(`/api/laboratory/requests/${savedClinical.payload.request.id}/specimen`, {
      cookie: laboratoryCookie,
      method: 'PATCH',
      body: { action: 'collect' }
    });
    assert.equal(missingSpecimenId.response.status, 400);
    const collectedSpecimen = await request(`/api/laboratory/requests/${savedClinical.payload.request.id}/specimen`, {
      cookie: laboratoryCookie,
      method: 'PATCH',
      body: { action: 'collect', specimenIdentifier: `SPEC-${suffix}-1` }
    });
    assert.equal(collectedSpecimen.response.status, 200);
    assert.equal(collectedSpecimen.payload.request.status, 'collected');
    assert.equal((await request(`/api/laboratory/requests/${savedClinical.payload.request.id}/process`, {
      cookie: laboratoryCookie, method: 'POST', body: {}
    })).response.status, 409);
    const receivedSpecimen = await request(`/api/laboratory/requests/${savedClinical.payload.request.id}/specimen`, {
      cookie: laboratoryCookie,
      method: 'PATCH',
      body: { action: 'receive', specimenIdentifier: `SPEC-${suffix}-1` }
    });
    assert.equal(receivedSpecimen.response.status, 200);
    assert.equal(receivedSpecimen.payload.request.status, 'received');
    const processingStarted = await request(`/api/laboratory/requests/${savedClinical.payload.request.id}/process`, {
      cookie: laboratoryCookie, method: 'POST', body: {}
    });
    assert.equal(processingStarted.response.status, 200);
    assert.equal(processingStarted.payload.request.status, 'processing');
    const badNumericResult = await request(`/api/laboratory/requests/${savedClinical.payload.request.id}/results`, {
      cookie: laboratoryCookie,
      method: 'POST',
      body: { value: 'not a numeric value' }
    });
    assert.equal(badNumericResult.response.status, 400);
    const unauthorizedResultEntry = await request(`/api/laboratory/requests/${savedClinical.payload.request.id}/results`, {
      cookie: pharmacistCookie, method: 'POST', body: { value: '12.5' }
    });
    assert.equal(unauthorizedResultEntry.response.status, 403);
    const labResult = await request(`/api/laboratory/requests/${savedClinical.payload.request.id}/results`, {
      cookie: laboratoryCookie,
      method: 'POST',
      body: { value: '12.5', comments: 'Fictional numeric test result' }
    });
    assert.equal(labResult.response.status, 201);
    assert.equal(labResult.payload.request.status, 'result_entered');
    assert.equal(labResult.payload.request.catalogue_result_type, 'numeric');
    assert.equal(labResult.payload.request.catalogue_unit, 'test units');
    assert.equal(labResult.payload.request.catalogue_reference_range, null);
    auditResourceIds.push(labResult.payload.result.id);
    const profileBeforeRelease = await request(`/api/patients/${patient.id}`, { cookie: clinicianCookie });
    assert.equal(profileBeforeRelease.payload.patient.labRequests
      .find((item) => item.id === savedClinical.payload.request.id).result, null);
    const revokeVerifyPermission = await request(`/api/admin/users/${laboratory.id}/permissions`, {
      cookie: adminCookie,
      method: 'PUT',
      body: { permissions: [{ name: 'laboratory.results.verify', granted: false }] }
    });
    assert.equal(revokeVerifyPermission.response.status, 204);
    const permissionDeniedVerification = await request(`/api/laboratory/requests/${savedClinical.payload.request.id}/results/${labResult.payload.result.id}/verify`, {
      cookie: laboratoryCookie, method: 'POST', body: {}
    });
    assert.equal(permissionDeniedVerification.response.status, 403);
    const restoreVerifyPermission = await request(`/api/admin/users/${laboratory.id}/permissions`, {
      cookie: adminCookie,
      method: 'PUT',
      body: { permissions: [{ name: 'laboratory.results.verify', granted: true }] }
    });
    assert.equal(restoreVerifyPermission.response.status, 204);
    const entererCannotVerify = await request(`/api/laboratory/requests/${savedClinical.payload.request.id}/results/${labResult.payload.result.id}/verify`, {
      cookie: laboratoryCookie, method: 'POST', body: {}
    });
    assert.equal(entererCannotVerify.response.status, 409);
    const verifiedResult = await request(`/api/laboratory/requests/${savedClinical.payload.request.id}/results/${labResult.payload.result.id}/verify`, {
      cookie: laboratoryReviewerCookie, method: 'POST', body: {}
    });
    assert.equal(verifiedResult.response.status, 200);
    assert.equal(verifiedResult.payload.result.status, 'verified');
    const unauthorizedRelease = await request(`/api/laboratory/requests/${savedClinical.payload.request.id}/results/${labResult.payload.result.id}/release`, {
      cookie: pharmacistCookie, method: 'POST', body: {}
    });
    assert.equal(unauthorizedRelease.response.status, 403);
    const verifierCannotRelease = await request(`/api/laboratory/requests/${savedClinical.payload.request.id}/results/${labResult.payload.result.id}/release`, {
      cookie: laboratoryReviewerCookie, method: 'POST', body: {}
    });
    assert.equal(verifierCannotRelease.response.status, 409);
    const entererCannotRelease = await request(`/api/laboratory/requests/${savedClinical.payload.request.id}/results/${labResult.payload.result.id}/release`, {
      cookie: laboratoryCookie, method: 'POST', body: {}
    });
    assert.equal(entererCannotRelease.response.status, 409);
    const administratorReleasePermission = await request(`/api/admin/users/${admin.id}/permissions`, {
      cookie: adminCookie,
      method: 'PUT',
      body: { permissions: [{ name: 'laboratory.results.release', granted: true }] }
    });
    assert.equal(administratorReleasePermission.response.status, 204);
    const releasedResult = await request(`/api/laboratory/requests/${savedClinical.payload.request.id}/results/${labResult.payload.result.id}/release`, {
      cookie: laboratoryReleaserCookie, method: 'POST', body: {}
    });
    assert.equal(releasedResult.response.status, 200);
    assert.equal(releasedResult.payload.request.status, 'released');
    const revokeAmendPermission = await request(`/api/admin/users/${laboratory.id}/permissions`, {
      cookie: adminCookie,
      method: 'PUT',
      body: { permissions: [{ name: 'laboratory.results.amend', granted: false }] }
    });
    assert.equal(revokeAmendPermission.response.status, 204);
    const permissionDeniedAmendment = await request(`/api/laboratory/requests/${savedClinical.payload.request.id}/results`, {
      cookie: laboratoryCookie, method: 'POST',
      body: { value: '12.6', amendmentReason: 'Restricted permission must be rejected' }
    });
    assert.equal(permissionDeniedAmendment.response.status, 403);
    const restoreAmendPermission = await request(`/api/admin/users/${laboratory.id}/permissions`, {
      cookie: adminCookie,
      method: 'PUT',
      body: { permissions: [{ name: 'laboratory.results.amend', granted: true }] }
    });
    assert.equal(restoreAmendPermission.response.status, 204);
    const unreasonedAmendment = await request(`/api/laboratory/requests/${savedClinical.payload.request.id}/results`, {
      cookie: laboratoryCookie, method: 'POST', body: { value: '12.6' }
    });
    assert.equal(unreasonedAmendment.response.status, 400);
    const correction = await request(`/api/laboratory/requests/${savedClinical.payload.request.id}/results`, {
      cookie: laboratoryCookie,
      method: 'POST',
      body: { value: '12.6', amendmentReason: 'Fictional QA correction', comments: 'Corrected fictional test value' }
    });
    assert.equal(correction.response.status, 201);
    assert.equal(correction.payload.request.status, 'correction_pending');
    auditResourceIds.push(correction.payload.result.id);
    const profileDuringCorrection = await request(`/api/patients/${patient.id}`, { cookie: clinicianCookie });
    assert.equal(profileDuringCorrection.payload.patient.labRequests.find((item) => item.id === savedClinical.payload.request.id).result, '12.5');
    const verifiedCorrection = await request(`/api/laboratory/requests/${savedClinical.payload.request.id}/results/${correction.payload.result.id}/verify`, {
      cookie: laboratoryReviewerCookie, method: 'POST', body: {}
    });
    assert.equal(verifiedCorrection.response.status, 200);
    const releasedCorrection = await request(`/api/laboratory/requests/${savedClinical.payload.request.id}/results/${correction.payload.result.id}/release`, {
      cookie: laboratoryReleaserCookie, method: 'POST', body: {}
    });
    assert.equal(releasedCorrection.response.status, 200);
    assert.equal(releasedCorrection.payload.request.status, 'corrected');
    const resultHistory = await request(`/api/laboratory/requests/${savedClinical.payload.request.id}/history`, { cookie: laboratoryCookie });
    assert.equal(resultHistory.response.status, 200);
    assert.equal(resultHistory.payload.versions.length, 2);
    assert.equal(resultHistory.payload.versions[0].status, 'superseded');
    assert.equal(resultHistory.payload.versions[1].status, 'released');
    assert.equal(resultHistory.payload.versions[1].amendment_reason, 'Fictional QA correction');
    assert.equal((await request(`/api/laboratory/requests/${savedClinical.payload.request.id}/history`, {
      cookie: clinicianCookie
    })).response.status, 403);
    const statusWithOutstandingLab = await pool.query('SELECT status FROM visits WHERE id = $1', [checkin.payload.visit.id]);
    assert.equal(statusWithOutstandingLab.rows[0].status, 'lab_requested');
    const rejectedWithoutReason = await request(`/api/laboratory/requests/${rejectedLabRequest.payload.request.id}/specimen`, {
      cookie: laboratoryCookie,
      method: 'PATCH',
      body: { action: 'reject' }
    });
    assert.equal(rejectedWithoutReason.response.status, 400);
    const rejectedSpecimen = await request(`/api/laboratory/requests/${rejectedLabRequest.payload.request.id}/specimen`, {
      cookie: laboratoryCookie,
      method: 'PATCH',
      body: { action: 'reject', reason: 'Fictional specimen quality failure' }
    });
    assert.equal(rejectedSpecimen.response.status, 200);
    assert.equal(rejectedSpecimen.payload.request.status, 'rejected');
    assert.equal(rejectedSpecimen.payload.request.rejection_reason, 'Fictional specimen quality failure');
    const unauthorizedCancel = await request(`/api/laboratory/requests/${cancellationRequest.payload.request.id}/cancel`, {
      cookie: pharmacistCookie,
      method: 'PATCH',
      body: { reason: 'No cancellation permission' }
    });
    assert.equal(unauthorizedCancel.response.status, 403);
    const cancelledRequest = await request(`/api/laboratory/requests/${cancellationRequest.payload.request.id}/cancel`, {
      cookie: clinicianCookie,
      method: 'PATCH',
      body: { reason: 'Fictional request no longer required' }
    });
    assert.equal(cancelledRequest.response.status, 200);
    assert.equal(cancelledRequest.payload.request.status, 'cancelled');
    const qualitativeReceived = await request(`/api/laboratory/requests/${secondLabRequest.payload.request.id}/specimen`, {
      cookie: laboratoryCookie,
      method: 'PATCH',
      body: { action: 'receive', specimenIdentifier: `SPEC-${suffix}-2` }
    });
    assert.equal(qualitativeReceived.response.status, 200);
    assert.equal((await request(`/api/laboratory/requests/${secondLabRequest.payload.request.id}/process`, {
      cookie: laboratoryCookie, method: 'POST', body: {}
    })).response.status, 200);
    const invalidQualitativeResult = await request(`/api/laboratory/requests/${secondLabRequest.payload.request.id}/results`, {
      cookie: laboratoryCookie,
      method: 'POST',
      body: { value: 'Not configured' }
    });
    assert.equal(invalidQualitativeResult.response.status, 400);
    const unreasonedPostReleaseAmendment = await request(`/api/laboratory/requests/${savedClinical.payload.request.id}/results`, {
      cookie: laboratoryCookie, method: 'POST', body: { value: '12.7' }
    });
    assert.equal(unreasonedPostReleaseAmendment.response.status, 400);
    const qualitativeResult = await request(`/api/laboratory/requests/${secondLabRequest.payload.request.id}/results`, {
      cookie: laboratoryCookie,
      method: 'POST',
      body: { value: 'Configured option A' }
    });
    assert.equal(qualitativeResult.response.status, 201);
    assert.equal(qualitativeResult.payload.result.result_type, 'qualitative');
    auditResourceIds.push(qualitativeResult.payload.result.id);
    assert.equal((await request(`/api/laboratory/requests/${secondLabRequest.payload.request.id}/results/${qualitativeResult.payload.result.id}/verify`, {
      cookie: laboratoryReviewerCookie, method: 'POST', body: {}
    })).response.status, 200);
    const secondLabResult = await request(`/api/laboratory/requests/${secondLabRequest.payload.request.id}/results/${qualitativeResult.payload.result.id}/release`, {
      cookie: laboratoryReleaserCookie, method: 'POST', body: {}
    });
    assert.equal(secondLabResult.response.status, 200);
    assert.equal(secondLabResult.payload.request.status, 'released');
    const labDashboard = await request('/api/dashboard/laboratory', { cookie: laboratoryCookie });
    assert.ok(labDashboard.payload.stats.completedLabRequests >= 2);
    assert.equal(labDashboard.payload.stats.awaitingRelease, 0);
    assert.ok(labDashboard.payload.stats.rejectedLabRequests >= 1);

    const visitStatus = await pool.query('SELECT status FROM visits WHERE id = $1', [checkin.payload.visit.id]);
    assert.equal(visitStatus.rows[0].status, 'completed');
    const profileAfterWorkflow = await request(`/api/patients/${patient.id}`, { cookie: clinicianCookie });
    assert.equal(profileAfterWorkflow.response.status, 200);
    assert.ok(profileAfterWorkflow.payload.patient.visits.some((visit) => visit.id === checkin.payload.visit.id));
    const visibleNumericResult = profileAfterWorkflow.payload.patient.labRequests.find((item) => item.id === savedClinical.payload.request.id);
    assert.equal(visibleNumericResult.status, 'corrected');
    assert.equal(visibleNumericResult.result, '12.6');
    assert.equal(visibleNumericResult.unit, 'test units');
    assert.equal(visibleNumericResult.version_number, 2);
    const visibleQualitativeResult = profileAfterWorkflow.payload.patient.labRequests.find((item) => item.id === secondLabRequest.payload.request.id);
    assert.equal(visibleQualitativeResult.result, 'Configured option A');
    assert.equal(visibleQualitativeResult.status, 'released');

    const dashboard = await request('/api/dashboard', { cookie: clerkCookie });
    assert.equal(dashboard.response.status, 200);
    assert.equal(Number.isInteger(dashboard.payload.stats.totalPatients), true);

    const dailyReport = await request('/api/reports/daily?startDate=2025-01-01&endDate=2025-01-31', { cookie: adminCookie });
    assert.equal(dailyReport.response.status, 200);
    assert.deepEqual(dailyReport.payload.summary.dateRange, { startDate: '2025-01-01', endDate: '2025-01-31' });
    const invalidReportDate = await request('/api/reports/daily?startDate=not-a-date', { cookie: adminCookie });
    assert.equal(invalidReportDate.response.status, 400);
    const invertedReportRange = await request('/api/reports/monthly?startDate=2025-02-01&endDate=2025-01-01', { cookie: adminCookie });
    assert.equal(invertedReportRange.response.status, 400);
    const unauthorizedReport = await request('/api/reports/daily', { cookie: clerkCookie });
    assert.equal(unauthorizedReport.response.status, 403);
    const laboratoryReport = await request('/api/reports/daily?startDate=2020-01-01&endDate=2099-12-31', { cookie: adminCookie });
    assert.ok(laboratoryReport.payload.summary.laboratory.requested >= 4);
    assert.ok(laboratoryReport.payload.summary.laboratory.released >= 3);
    assert.ok(laboratoryReport.payload.summary.laboratory.rejected >= 1);
    assert.ok(laboratoryReport.payload.summary.laboratory.cancelled >= 1);

    const directPatientClinical = await request(`/api/patients/${patient.id}/clinical`, {
      cookie: clinicianCookie,
      method: 'PUT',
      body: { diagnoses: 'Fictional test diagnosis', treatmentNotes: 'Fictional test note' }
    });
    assert.equal(directPatientClinical.response.status, 204);

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
    const disabled = await request(`/api/admin/users/${createdStaff.payload.user.id}/status`, {
      cookie: adminCookie,
      method: 'PATCH',
      body: { isActive: false }
    });
    assert.equal(disabled.response.status, 200);
    const clerkDisabled = await request(`/api/admin/users/${clerk.id}/status`, {
      cookie: adminCookie,
      method: 'PATCH',
      body: { isActive: false }
    });
    assert.equal(clerkDisabled.response.status, 200);
    const revokedSession = await request('/api/admin/users', { cookie: clerkCookie });
    assert.equal(revokedSession.response.status, 401);
  } finally {
    const userIds = Object.values(accounts).map((account) => account.id);
    await pool.query("DELETE FROM \"session\" WHERE sess->'user'->>'id' = ANY($1::text[])", [userIds]).catch(() => {});
    await pool.query('DELETE FROM departments WHERE id = ANY($1::uuid[])', [departmentIds]).catch(() => {});
    if (facilityNameChanged) {
      if (!originalFacilitySetting) {
        await pool.query("DELETE FROM system_settings WHERE setting_key = 'facility_name'").catch(() => {});
      } else {
        await pool.query(
          `UPDATE system_settings SET setting_value = $1, updated_by = $2, updated_at = $3
           WHERE setting_key = 'facility_name'`,
          [originalFacilitySetting.setting_value, originalFacilitySetting.updated_by, originalFacilitySetting.updated_at]
        ).catch(() => {});
      }
    }
    await pool.query(
      'DELETE FROM audit_events WHERE actor_id = ANY($1::uuid[]) OR resource_id = ANY($2::uuid[])',
      [userIds, auditResourceIds]
    ).catch(() => {});
    await pool.query(
      'DELETE FROM audit_logs WHERE actor_id = ANY($1::uuid[]) OR resource_id = ANY($2::uuid[])',
      [userIds, auditResourceIds]
    ).catch(() => {});
    await pool.query('DELETE FROM prescriptions WHERE patient_id = ANY($1::uuid[])', [patientIds]).catch(() => {});
    await pool.query('DELETE FROM medicines WHERE id = ANY($1::uuid[])', [medicineIds]).catch(() => {});
    await pool.query('DELETE FROM patient_care_team WHERE patient_id = ANY($1::uuid[]) OR clinician_id = ANY($2::uuid[])', [patientIds, userIds]).catch(() => {});
    await pool.query('DELETE FROM patients WHERE id = ANY($1::uuid[])', [patientIds]).catch(() => {});
    await pool.query('DELETE FROM lab_test_catalogue WHERE id = ANY($1::uuid[])', [laboratoryTestIds]).catch(() => {});
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]).catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
});