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
  const medicineIds = [];
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
    assert.equal(permissionAudit.rowCount, 1);
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
    assert.equal(nursingStatsAfterTriage.payload.stats.completedTriage, 1);
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

    const savedClinical = await request(`/api/workflow/visits/${checkin.payload.visit.id}/lab-requests`, {
      cookie: clinicianCookie,
      method: 'POST',
      body: { testName: 'Blood panel', clinicalNotes: 'Test lab request' }
    });
    assert.equal(savedClinical.response.status, 201);
    auditResourceIds.push(savedClinical.payload.request.id);
    const secondLabRequest = await request(`/api/workflow/visits/${checkin.payload.visit.id}/lab-requests`, {
      cookie: clinicianCookie,
      method: 'POST',
      body: { testName: 'Second workflow panel', clinicalNotes: 'Confirm outstanding request handling' }
    });
    assert.equal(secondLabRequest.response.status, 201);
    auditResourceIds.push(secondLabRequest.payload.request.id);

    const prescription = await request('/api/prescriptions', {
      cookie: clinicianCookie,
      method: 'POST',
      body: {
        patientId: patient.id,
        consultationId: checkin.payload.visit.id,
        medication: 'Workflow test medicine',
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

    const pharmacistQueue = await request('/api/prescriptions?search=Testpatient', { cookie: pharmacistCookie });
    assert.equal(pharmacistQueue.response.status, 200);
    assert.ok(pharmacistQueue.payload.prescriptions.some((item) => item.id === prescription.payload.prescription.id));

    const clerkInventory = await request('/api/pharmacy/medicines', { cookie: clerkCookie });
    assert.equal(clerkInventory.response.status, 403);
    const pharmacistAdminPage = await request('/api/admin/users', { cookie: pharmacistCookie });
    assert.equal(pharmacistAdminPage.response.status, 403);
    const nurseAdminPage = await request('/api/admin/users', { cookie: nurseCookie });
    assert.equal(nurseAdminPage.response.status, 403);

    const medicine = await request('/api/pharmacy/medicines', {
      cookie: pharmacistCookie,
      method: 'POST',
      body: {
        name: 'Workflow test medicine',
        unit: 'tablet',
        quantity: 100,
        minimumStockLevel: 20,
        expiryDate: '2035-12-31'
      }
    });
    assert.equal(medicine.response.status, 201);
    medicineIds.push(medicine.payload.medicine.id);

    const receivedNewMedicine = await request('/api/pharmacy/stock-receive', {
      cookie: pharmacistCookie,
      method: 'POST',
      body: {
        medicineId: 'new',
        medicineName: `Incoming stock test ${suffix}`,
        genericName: 'Test ingredient',
        strength: '250 mg',
        dosageForm: 'capsule',
        unit: 'capsules',
        quantity: 24,
        minimumStockLevel: 5,
        batchNumber: `B-${suffix}`,
        supplier: 'Test supplier',
        notes: 'Stock received for inventory workflow test'
      }
    });
    assert.equal(receivedNewMedicine.response.status, 201);
    medicineIds.push(receivedNewMedicine.payload.medicine.id);
    assert.equal(receivedNewMedicine.payload.medicine.current_quantity, 24);
    assert.equal(receivedNewMedicine.payload.movement.quantity, 24);
    const receivedExistingMedicine = await request('/api/pharmacy/stock-receive', {
      cookie: pharmacistCookie,
      method: 'POST',
      body: {
        medicineId: receivedNewMedicine.payload.medicine.id,
        quantity: 8,
        notes: 'Second delivery'
      }
    });
    assert.equal(receivedExistingMedicine.response.status, 201);
    assert.equal(receivedExistingMedicine.payload.medicine.current_quantity, 32);
    const newMedicineMovement = await pool.query(
      `SELECT quantity_before, quantity_after, movement_type FROM stock_movements
       WHERE medicine_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [receivedNewMedicine.payload.medicine.id]
    );
    assert.deepEqual(newMedicineMovement.rows[0], {
      quantity_before: 24,
      quantity_after: 32,
      movement_type: 'stock_received'
    });
    const pharmacyInventoryAfterReceipt = await request('/api/pharmacy/medicines', { cookie: pharmacistCookie });
    assert.ok(pharmacyInventoryAfterReceipt.payload.medicines.some((entry) => entry.id === receivedNewMedicine.payload.medicine.id));
    const missingMedicineName = await request('/api/pharmacy/stock-receive', {
      cookie: pharmacistCookie,
      method: 'POST',
      body: { medicineId: 'new', quantity: 10 }
    });
    assert.equal(missingMedicineName.response.status, 400);

    const oversizedDispense = await request('/api/pharmacy/dispense', {
      cookie: pharmacistCookie,
      method: 'POST',
      body: { prescriptionId: prescription.payload.prescription.id, medicineId: medicine.payload.medicine.id, quantity: 10 }
    });
    assert.equal(oversizedDispense.response.status, 400);
    const unchangedStock = await pool.query('SELECT current_quantity FROM medicines WHERE id = $1', [medicine.payload.medicine.id]);
    assert.equal(unchangedStock.rows[0].current_quantity, 100);

    const partialDispense = await request('/api/pharmacy/dispense', {
      cookie: pharmacistCookie,
      method: 'POST',
      body: { prescriptionId: prescription.payload.prescription.id, medicineId: medicine.payload.medicine.id, quantity: 4 }
    });
    assert.equal(partialDispense.response.status, 200);
    assert.equal(partialDispense.payload.outcome.prescription.status, 'partially_dispensed');
    const duplicatePartial = await request('/api/pharmacy/dispense', {
      cookie: pharmacistCookie,
      method: 'POST',
      body: { prescriptionId: prescription.payload.prescription.id, medicineId: medicine.payload.medicine.id, quantity: 6 }
    });
    assert.equal(duplicatePartial.response.status, 400);
    const finalDispense = await request('/api/pharmacy/dispense', {
      cookie: pharmacistCookie,
      method: 'POST',
      body: { prescriptionId: prescription.payload.prescription.id, medicineId: medicine.payload.medicine.id, quantity: 5 }
    });
    assert.equal(finalDispense.response.status, 200);
    assert.equal(finalDispense.payload.outcome.prescription.status, 'dispensed');
    const stock = await pool.query('SELECT current_quantity FROM medicines WHERE id = $1', [medicine.payload.medicine.id]);
    assert.equal(stock.rows[0].current_quantity, 91);
    const statusAfterDispensing = await pool.query('SELECT status FROM visits WHERE id = $1', [checkin.payload.visit.id]);
    assert.equal(statusAfterDispensing.rows[0].status, 'in_consultation');

    const expiredPrescription = await request('/api/prescriptions', {
      cookie: clinicianCookie,
      method: 'POST',
      body: { patientId: patient.id, medication: 'Expired workflow medicine', dose: '1 tablet', quantity: 1 }
    });
    assert.equal(expiredPrescription.response.status, 201);
    auditResourceIds.push(expiredPrescription.payload.prescription.id);
    const expiredMedicine = await request('/api/pharmacy/medicines', {
      cookie: pharmacistCookie,
      method: 'POST',
      body: { name: 'Expired workflow medicine', quantity: 5, minimumStockLevel: 0, expiryDate: '2020-01-01' }
    });
    assert.equal(expiredMedicine.response.status, 201);
    medicineIds.push(expiredMedicine.payload.medicine.id);
    const expiredDispense = await request('/api/pharmacy/dispense', {
      cookie: pharmacistCookie,
      method: 'POST',
      body: { prescriptionId: expiredPrescription.payload.prescription.id, medicineId: expiredMedicine.payload.medicine.id, quantity: 1 }
    });
    assert.equal(expiredDispense.response.status, 400);
    const expiredStock = await pool.query('SELECT current_quantity FROM medicines WHERE id = $1', [expiredMedicine.payload.medicine.id]);
    assert.equal(expiredStock.rows[0].current_quantity, 5);

    const insufficientPrescription = await request('/api/prescriptions', {
      cookie: clinicianCookie,
      method: 'POST',
      body: { patientId: patient.id, medication: 'Limited workflow medicine', dose: '1 tablet', quantity: 10 }
    });
    assert.equal(insufficientPrescription.response.status, 201);
    auditResourceIds.push(insufficientPrescription.payload.prescription.id);
    const limitedMedicine = await request('/api/pharmacy/medicines', {
      cookie: pharmacistCookie,
      method: 'POST',
      body: { name: 'Limited workflow medicine', quantity: 5, minimumStockLevel: 0, expiryDate: '2035-12-31' }
    });
    assert.equal(limitedMedicine.response.status, 201);
    medicineIds.push(limitedMedicine.payload.medicine.id);
    const insufficientDispense = await request('/api/pharmacy/dispense', {
      cookie: pharmacistCookie,
      method: 'POST',
      body: { prescriptionId: insufficientPrescription.payload.prescription.id, medicineId: limitedMedicine.payload.medicine.id, quantity: 10 }
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

    const labQueue = await request('/api/workflow/laboratory', { cookie: laboratoryCookie });
    assert.equal(labQueue.response.status, 200);
    assert.ok(labQueue.payload.requests.some((item) => item.id === savedClinical.payload.request.id));
    const labResult = await request(`/api/workflow/laboratory/${savedClinical.payload.request.id}`, {
      cookie: laboratoryCookie,
      method: 'PATCH',
      body: { result: 'Normal' }
    });
    assert.equal(labResult.response.status, 200);
    assert.equal(labResult.payload.request.status, 'completed');
    const statusWithOutstandingLab = await pool.query('SELECT status FROM visits WHERE id = $1', [checkin.payload.visit.id]);
    assert.equal(statusWithOutstandingLab.rows[0].status, 'lab_requested');
    const secondLabResult = await request(`/api/workflow/laboratory/${secondLabRequest.payload.request.id}`, {
      cookie: laboratoryCookie,
      method: 'PATCH',
      body: { result: 'Normal' }
    });
    assert.equal(secondLabResult.response.status, 200);

    const visitStatus = await pool.query('SELECT status FROM visits WHERE id = $1', [checkin.payload.visit.id]);
    assert.equal(visitStatus.rows[0].status, 'completed');
    const profileAfterWorkflow = await request(`/api/patients/${patient.id}`, { cookie: clinicianCookie });
    assert.equal(profileAfterWorkflow.response.status, 200);
    assert.ok(profileAfterWorkflow.payload.patient.visits.some((visit) => visit.id === checkin.payload.visit.id));
    assert.ok(profileAfterWorkflow.payload.patient.labRequests.some((item) => item.id === savedClinical.payload.request.id));

    const dashboard = await request('/api/dashboard', { cookie: clerkCookie });
    assert.equal(dashboard.response.status, 200);
    assert.equal(Number.isInteger(dashboard.payload.stats.totalPatients), true);

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
    await pool.query('DELETE FROM prescriptions WHERE patient_id = ANY($1::uuid[])', [patientIds]).catch(() => {});
    await pool.query('DELETE FROM medicines WHERE id = ANY($1::uuid[])', [medicineIds]).catch(() => {});
    await pool.query('DELETE FROM patient_care_team WHERE patient_id = ANY($1::uuid[]) OR clinician_id = ANY($2::uuid[])', [patientIds, userIds]).catch(() => {});
    await pool.query('DELETE FROM patients WHERE id = ANY($1::uuid[])', [patientIds]).catch(() => {});
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]).catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
});