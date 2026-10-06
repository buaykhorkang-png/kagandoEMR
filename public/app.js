const root = document.querySelector('#root');
const state = {
  user: null,
  view: 'patients',
  patients: [],
  prescriptions: [],
  appointments: [],
  clerkQueue: [],
  queue: [],
  medicines: [],
  alerts: { lowStock: [], outOfStock: [], expiring: [] },
  laboratoryRequests: [],
  activeVisit: null,
  activeTriageVisit: null,
  users: [],
  permissionConfig: null,
  departments: [],
  settings: [],
  reports: null,
  audit: [],
  dashboard: null,
  activePatient: null,
  showPatientForm: false,
  search: '',
  error: '',
  authView: 'login',
  authNotice: '',
  adminRegistrationAvailable: false
};

const roleNames = {
  clinician: 'Clinician',
  nurse: 'Nurse / Triage',
  pharmacist: 'Pharmacist',
  clerk: 'Clerk',
  laboratory: 'Laboratory',
  management: 'Management',
  administrator: 'Administrator'
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function systemLogo(className = 'system-logo') {
  return `<img class="${className}" src="/images/logo.png" alt="Kagando EMR">`;
}

async function api(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(url, { ...options, headers, credentials: 'same-origin' });
  if (response.status === 204) return null;

  const payload = await response.json().catch(() => ({}));
  if (response.status === 401 && url !== '/api/auth/login') {
    state.user = null;
    render();
  }
  if (!response.ok) throw new Error(payload.error || 'The request could not be completed.');
  return payload;
}

function formatDate(value) {
  if (!value) return 'Not recorded';
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.valueOf()) ? 'Not recorded' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
}

function initials(value) {
  return String(value || 'K').slice(0, 1).toUpperCase();
}

function roleCanSeePatients() {
  return state.user.permissions.includes('patients.view');
}

function navItems() {
  const items = [['dashboard', 'D', `${roleNames[state.user.role] || 'Role'} Dashboard`]];
  if (state.user.permissions.includes('queue.clinical.view') && state.user.permissions.includes('dashboard.nursing')) {
    items.push(['clinical', 'T', 'Triage queue']);
    items.push(['vitals', 'V', 'Vital signs']);
  }
  if (roleCanSeePatients()) items.push(['patients', 'P', 'Patients']);
  if (state.user.permissions.includes('dashboard.clerk') && state.user.permissions.includes('patients.create')) {
    items.push(['registration', 'Reg', 'Patient registration']);
  }
  if (state.user.permissions.includes('dashboard.clerk') && state.user.permissions.includes('patients.checkin')) {
    items.push(['checkin', 'CI', 'Check-in']);
  }
  if ((state.user.permissions.includes('appointments.view') && state.user.permissions.includes('dashboard.clerk')) ||
      (state.user.permissions.includes('appointments.relevant.view') &&
       (state.user.permissions.includes('dashboard.nursing') || state.user.permissions.includes('dashboard.clinical')))) {
    items.push(['appointments', 'Apt', 'Appointments']);
  }
  if (state.user.permissions.includes('queue.clinical.view') && state.user.permissions.includes('dashboard.clinical')) items.push(['clinical', 'Q', 'Clinical queue']);
  if (state.user.permissions.includes('pharmacy.inventory') && state.user.permissions.includes('dashboard.pharmacy')) items.push(['pharmacy', 'Rx', 'Pharmacy']);
  if (state.user.permissions.includes('laboratory.requests.view') && state.user.permissions.includes('dashboard.laboratory')) items.push(['laboratory', 'Lab', 'Laboratory']);
  if (state.user.permissions.includes('reports.view')) items.push(['reports', 'R', 'Reports']);
  if (state.user.permissions.includes('users.manage')) items.push(['users', 'U', 'Staff access']);
  if (state.user.permissions.includes('permissions.manage')) items.push(['permissions', 'Key', 'Roles & permissions']);
  if (state.user.permissions.includes('departments.manage')) items.push(['departments', 'Dep', 'Departments']);
  if (state.user.permissions.includes('settings.manage')) items.push(['settings', 'Cfg', 'System settings']);
  if (state.user.permissions.includes('audit.view')) items.push(['audit', 'A', 'Audit trail']);
  return items;
}

function permissionForView(view) {
  return {
    dashboard: 'dashboard.view',
    patients: 'patients.view',
    registration: 'patients.create',
    checkin: 'patients.checkin',
    appointments: 'appointments.view',
    vitals: 'queue.clinical.view',
    clinical: 'dashboard.clinical',
    pharmacy: 'dashboard.pharmacy',
    laboratory: 'dashboard.laboratory',
    reports: 'reports.view',
    users: 'users.manage',
    permissions: 'permissions.manage',
    departments: 'departments.manage',
    settings: 'settings.manage',
    audit: 'audit.view'
  }[view];
}

function renderLogin() {
  if (state.authView === 'register') return renderRegistration();
  root.innerHTML = `
    <section class="split-container">
      <aside class="visual-panel" aria-label="Kagando EMR">
          <div class="bg-pattern" aria-hidden="true"><svg viewBox="0 0 640 760" preserveAspectRatio="xMidYMid slice"><defs><pattern id="medical-grid" width="42" height="42" patternUnits="userSpaceOnUse"><path d="M42 0H0V42" fill="none" stroke="white" stroke-opacity=".12" stroke-width="1"/><circle cx="0" cy="0" r="2" fill="white" fill-opacity=".25"/></pattern></defs><rect width="640" height="760" fill="url(#medical-grid)"/><circle cx="530" cy="122" r="185" fill="none" stroke="#079A58" stroke-opacity=".36"/><circle cx="530" cy="122" r="225" fill="none" stroke="white" stroke-opacity=".12"/></svg></div>
        <div class="visual-content">
          ${systemLogo('visual-logo')}
          <h1 class="visual-heading">Care, in good order.</h1>
          <p class="visual-subtext">A secure workspace for the people and teams caring for our community.</p>
          <div class="feature-pills">
            <div class="pill"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3 20 6v5c0 5-3.4 8.5-8 10-4.6-1.5-8-5-8-10V6l8-3Z" stroke="currentColor" stroke-width="1.8"/><path d="m8.5 12 2.2 2.2 4.8-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Access shaped around staff roles</span></div>
            <div class="pill"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 5h16v14H4zM8 3v4m8-4v4M4 10h16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M8 14h3m2 0h3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg><span>Patient records in one protected place</span></div>
            <div class="pill"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M8 10V7a4 4 0 1 1 8 0v3m-4 4v3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg><span>Confidential information stays protected</span></div>
          </div>
        </div>
      </aside>
      <div class="form-panel">
        <div class="login-card">
          <header class="card-header">
            ${systemLogo('card-logo')}
            <h2 class="system-title">Welcome back</h2>
            <p class="system-subtitle">Sign in to your Kagando staff account</p>
          </header>
          ${state.authNotice ? `<div class="alert alert-success" role="status"><svg class="alert-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m5 12 4 4L19 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><span>${escapeHtml(state.authNotice)}</span></div>` : ''}
          ${state.error ? `<div class="alert alert-danger" role="alert"><svg class="alert-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M12 8v5m0 3h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span>${escapeHtml(state.error)}</span></div>` : ''}
          <form data-form="login" autocomplete="on">
            <div class="form-group"><label for="login-username">Staff username</label><div class="input-wrapper"><input class="form-input" id="login-username" name="username" autocomplete="username" required maxlength="80" placeholder="Enter your username"><svg class="field-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="8" r="4" stroke="currentColor" stroke-width="1.8"/><path d="M4 21v-1a8 8 0 0 1 16 0v1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></div></div>
            <div class="form-group"><label for="login-password">Password</label><div class="input-wrapper"><input class="form-input password-input" id="login-password" name="password" type="password" autocomplete="current-password" required maxlength="128" placeholder="Enter your password"><svg class="field-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="4" y="10" width="16" height="11" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M8 10V7a4 4 0 1 1 8 0v3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg><button class="password-toggle" type="button" data-action="toggle-password" data-target="login-password" aria-label="Show password" title="Show password"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M2.5 12s3.3-6 9.5-6 9.5 6 9.5 6-3.3 6-9.5 6-9.5-6-9.5-6Z" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="2.5" stroke="currentColor" stroke-width="1.8"/></svg></button></div></div>
            <button class="btn-primary" type="submit">Sign in securely</button>
          </form>
          <div class="security-notice"><svg class="lock-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="4" y="10" width="16" height="11" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M8 10V7a4 4 0 1 1 8 0v3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg><p>Your session is protected. Patient information is available only to authorized staff.</p></div>
          <footer class="card-footer"><p>New staff member? <button class="text-button" type="button" data-action="show-registration">Create an account</button></p></footer>
        </div>
      </div>
    </section>`;
}

function renderRegistration() {
  root.innerHTML = `
    <section class="split-container">
      <aside class="visual-panel" aria-label="Kagando staff access">
        <div class="bg-pattern" aria-hidden="true"><svg viewBox="0 0 640 760" preserveAspectRatio="xMidYMid slice"><defs><pattern id="medical-grid-register" width="42" height="42" patternUnits="userSpaceOnUse"><path d="M42 0H0V42" fill="none" stroke="white" stroke-opacity=".12" stroke-width="1"/><circle cx="0" cy="0" r="2" fill="white" fill-opacity=".25"/></pattern></defs><rect width="640" height="760" fill="url(#medical-grid-register)"/><circle cx="530" cy="122" r="185" fill="none" stroke="#079A58" stroke-opacity=".36"/><circle cx="530" cy="122" r="225" fill="none" stroke="white" stroke-opacity=".12"/></svg></div>
        <div class="visual-content">${systemLogo('visual-logo')}<h1 class="visual-heading">Access follows verified responsibility.</h1><p class="visual-subtext">Requested roles are reviewed and assigned by an administrator before an account can access patient information.</p><div class="feature-pills"><div class="pill"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3 20 6v5c0 5-3.4 8.5-8 10-4.6-1.5-8-5-8-10V6l8-3Z" stroke="currentColor" stroke-width="1.8"/><path d="m8.5 12 2.2 2.2 4.8-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg><span>Accounts stay inactive until approved</span></div></div></div>
      </aside>
      <div class="form-panel"><div class="login-card">
        <header class="card-header">${systemLogo('card-logo')}<h2 class="system-title">Staff registration</h2><p class="system-subtitle">Request a Kagando EMR staff account</p></header>
        ${state.authNotice ? `<div class="alert alert-success" role="status"><svg class="alert-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m5 12 4 4L19 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><span>${escapeHtml(state.authNotice)}</span></div>` : ''}
        ${state.error ? `<div class="alert alert-danger" role="alert"><svg class="alert-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M12 8v5m0 3h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span>${escapeHtml(state.error)}</span></div>` : ''}
        <form data-form="registration" autocomplete="on">
          <div class="form-group"><label for="register-username">Staff username</label><div class="input-wrapper"><input class="form-input" id="register-username" name="username" autocomplete="username" required maxlength="80" placeholder="Choose a username"><svg class="field-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="8" r="4" stroke="currentColor" stroke-width="1.8"/><path d="M4 21v-1a8 8 0 0 1 16 0v1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></div></div>
          <div class="form-group"><label for="register-password">Password</label><div class="input-wrapper"><input class="form-input password-input" id="register-password" name="password" type="password" autocomplete="new-password" required minlength="${state.adminRegistrationAvailable ? 10 : 12}" maxlength="128" placeholder="Create a strong password"><svg class="field-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="4" y="10" width="16" height="11" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M8 10V7a4 4 0 1 1 8 0v3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg><button class="password-toggle" type="button" data-action="toggle-password" data-target="register-password" aria-label="Show password" title="Show password"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M2.5 12s3.3-6 9.5-6 9.5 6 9.5 6-3.3 6-9.5 6-9.5-6-9.5-6Z" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="2.5" stroke="currentColor" stroke-width="1.8"/></svg></button></div><span id="register-password-hint" class="field-hint">${state.adminRegistrationAvailable ? 'Initial admin password must be changed before continuing.' : 'Use at least 12 characters.'}</span></div>
            <div class="form-group"><label for="register-role">Requested role</label><div class="input-wrapper"><select class="form-input" id="register-role" name="requestedRole" required><option value="">Choose a role</option><option value="clerk">Clerk</option><option value="nurse">Nurse / Triage</option><option value="clinician">Clinician</option><option value="pharmacist">Pharmacist</option><option value="laboratory">Laboratory</option>${state.adminRegistrationAvailable ? '<option value="administrator">Administrator (one-time setup)</option>' : ''}</select></div></div>
          <button class="btn-primary" type="submit">Submit registration</button>
        </form>
        <div class="security-notice"><svg class="lock-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="4" y="10" width="16" height="11" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M8 10V7a4 4 0 1 1 8 0v3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg><p>${state.adminRegistrationAvailable ? 'The first administrator account can be created once. It must change its password before accessing patient information.' : 'Staff accounts remain inactive until approved by an administrator.'}</p></div>
        <footer class="card-footer"><p>Already registered? <button class="text-button" type="button" data-action="show-login">Return to sign in</button></p></footer>
      </div></div>
    </section>`;
}

function renderPasswordChange() {
  root.innerHTML = `
    <section class="split-container">
      <aside class="visual-panel" aria-label="Kagando account security">
        <div class="visual-content">${systemLogo('visual-logo')}<h1 class="visual-heading">One last security step.</h1><p class="visual-subtext">Choose a unique password before entering the clinical workspace.</p></div>
      </aside>
      <div class="form-panel"><div class="login-card">
        <header class="card-header">${systemLogo('card-logo')}<h2 class="system-title">Change temporary password</h2><p class="system-subtitle">Use at least 12 characters. Your new password is stored as a one-way hash.</p></header>
        ${state.error ? `<div class="alert alert-danger" role="alert">${escapeHtml(state.error)}</div>` : ''}
        <form data-form="password-change" autocomplete="off">
          <div class="form-group"><label for="new-password">New password</label><div class="input-wrapper"><input class="form-input" id="new-password" name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required placeholder="Choose a unique password"><button class="password-toggle" type="button" data-action="toggle-password" data-target="new-password" aria-label="Show password" title="Show password">Show</button></div></div>
          <button class="btn-primary" type="submit">Save new password</button>
        </form>
        <footer class="card-footer"><p>Signed in as ${escapeHtml(state.user.username)} · <button class="text-button" type="button" data-action="logout">Sign out</button></p></footer>
      </div></div>
    </section>`;
}

function renderShell(content) {
  const items = navItems();
  root.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="sidebar-brand">${systemLogo('sidebar-logo')}</div>
        <div class="nav-label">Workspace</div>
        <ul class="nav-list">${items.map(([view, glyph, label]) => `
          <li><button class="nav-button ${state.view === view ? 'active' : ''}" data-action="navigate" data-view="${view}" ${state.view === view ? 'aria-current="page"' : ''}>
            <span class="nav-glyph" aria-hidden="true">${glyph}</span><span>${label}</span>
          </button></li>`).join('')}
        </ul>
        <div class="sidebar-foot">Confidential clinical workspace<br>Access is recorded for audit.</div>
      </aside>
      <section class="workspace">
        <header class="topbar">
          <div class="topbar-brand">${systemLogo('topbar-logo')}</div>
          <div class="user-chip"><span class="user-initial">${escapeHtml(initials(state.user.username))}</span><span class="user-meta"><strong>${escapeHtml(state.user.username)}</strong><span>${escapeHtml(roleNames[state.user.role] || state.user.role)}</span></span></div>
          <button class="button secondary small" data-action="logout" type="button">Sign out</button>
        </header>
        <main class="workspace-content">${content}</main>
      </section>
    </div>
    <div id="toast-region" aria-live="polite" aria-atomic="true"></div>`;
}

function renderPatientForm() {
  if (!state.user.permissions.includes('patients.create')) return '';
  return `<form class="inline-form" data-form="patient-create">
    <h3>Register patient</h3>
    <div class="detail-facts">
      <div class="field"><label for="new-mrn">Medical record number (generated if blank)</label><input id="new-mrn" name="medicalRecordNumber" maxlength="40"></div>
      <div class="field"><label for="new-dob">Date of birth</label><input id="new-dob" name="dateOfBirth" type="date"></div>
      <div class="field"><label for="new-first">First name</label><input id="new-first" name="firstName" maxlength="100" required></div>
      <div class="field"><label for="new-last">Last name</label><input id="new-last" name="lastName" maxlength="100" required></div>
      <div class="field"><label for="new-gender">Gender</label><select id="new-gender" name="gender"><option value="">Not recorded</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option></select></div>
      <div class="field"><label for="new-phone">Phone</label><input id="new-phone" name="phoneNumber" maxlength="30"></div>
      <div class="field"><label for="new-kin">Next of kin</label><input id="new-kin" name="nextOfKinName" maxlength="200"></div>
      <div class="field"><label for="new-kin-contact">Next of kin contact</label><input id="new-kin-contact" name="nextOfKinContact" maxlength="100"></div>
    </div>
    <div class="button-row"><button class="button" type="submit">Create patient</button><button class="button secondary" type="button" data-action="cancel-patient">Cancel</button></div>
    <p class="error-message" role="alert"></p>
  </form>`;
}

function renderPatientRows() {
  if (!state.patients.length) return '<tr><td colspan="4" class="empty-state">No patients match this search.</td></tr>';
  return state.patients.map((patient) => `<tr>
    <td><button class="table-link" data-action="open-patient" data-id="${escapeHtml(patient.id)}">${escapeHtml(patient.last_name)}, ${escapeHtml(patient.first_name)}</button></td>
    <td>${escapeHtml(patient.medical_record_number)}</td>
    <td>${escapeHtml(formatDate(patient.date_of_birth))}</td>
    <td>${escapeHtml(formatDate(patient.updated_at))}</td>
  </tr>`).join('');
}

function renderPatientDetail() {
  const patient = state.activePatient;
  if (!patient) return '<p class="empty-state">Select a patient to view the record.</p>';
  const demographics = `<div class="detail-facts">
    <div class="fact"><span>Record number</span><strong>${escapeHtml(patient.medical_record_number)}</strong></div>
    <div class="fact"><span>Date of birth</span><strong>${escapeHtml(formatDate(patient.date_of_birth))}</strong></div>
    <div class="fact"><span>Gender</span><strong>${escapeHtml(patient.gender || 'Not recorded')}</strong></div>
    <div class="fact"><span>Phone</span><strong>${escapeHtml(patient.phone_number || 'Not recorded')}</strong></div>
    <div class="fact"><span>Next of kin</span><strong>${escapeHtml(patient.next_of_kin_name || 'Not recorded')} · ${escapeHtml(patient.next_of_kin_contact || '—')}</strong></div>
  </div>`;
  let controls = '';

  if (['clinician', 'nurse'].includes(state.user.role) ||
      ['triage.create', 'consultation.start', 'diagnosis.create'].some((permission) => state.user.permissions.includes(permission))) {
    const history = (patient.visits || []).map((visit) => `<li>${escapeHtml(formatDate(visit.visit_date))} · ${escapeHtml(visit.status.replaceAll('_', ' '))}${visit.diagnosis ? ` · ${escapeHtml(visit.diagnosis)}` : ''}</li>`).join('');
    const prescriptions = (patient.prescriptions || []).map((rx) => `<li>${escapeHtml(rx.medication)} · ${escapeHtml(rx.dose)} · ${escapeHtml(rx.status)}</li>`).join('');
    const labRequests = (patient.labRequests || []).map((request) => `<li>${escapeHtml(request.test_name)} · ${escapeHtml(request.status)}${request.result ? ` · ${escapeHtml(request.result)}` : ''}</li>`).join('');
    if (state.user.permissions.includes('diagnosis.create')) {
      controls = `<form class="inline-form" data-form="clinical">
        <h3>Clinical record</h3>
        <div class="field"><label for="diagnoses">Diagnoses</label><textarea id="diagnoses" name="diagnoses" maxlength="12000">${escapeHtml(patient.diagnoses)}</textarea></div>
        <div class="field"><label for="allergies">Allergies</label><textarea id="allergies" name="allergies" maxlength="5000">${escapeHtml(patient.allergies)}</textarea></div>
        <div class="field"><label for="treatment-notes">Treatment notes</label><textarea id="treatment-notes" name="treatmentNotes" maxlength="20000">${escapeHtml(patient.treatment_notes)}</textarea></div>
        <button class="button" type="submit">Save clinical record</button><p class="error-message" role="alert"></p>
      </form>
      <div class="inline-form"><h3>Prescription</h3><button class="button secondary" type="button" data-action="new-prescription">Write prescription</button></div>`;
    } else {
      controls = `<section class="inline-form"><h3>Allergies and clinical notes</h3><p><strong>Allergies:</strong> ${escapeHtml(patient.allergies || 'Not recorded')}</p><p>${escapeHtml(patient.treatment_notes || 'No clinical notes recorded.')}</p></section>`;
    }
    controls += `<section class="inline-form"><h3>Visit history</h3><ul>${history || '<li>No visits recorded.</li>'}</ul><h3>Prescriptions</h3><ul>${prescriptions || '<li>No prescriptions recorded.</li>'}</ul><h3>Laboratory results</h3><ul>${labRequests || '<li>No laboratory requests recorded.</li>'}</ul></section>`;
  }

  if (state.user.permissions.includes('patients.edit')) {
    controls = `<form class="inline-form" data-form="patient-update">
      <h3>Patient details</h3>
      <div class="field"><label for="edit-mrn">Medical record number</label><input id="edit-mrn" name="medicalRecordNumber" value="${escapeHtml(patient.medical_record_number)}" maxlength="40" required></div>
      <div class="detail-facts">
        <div class="field"><label for="edit-first">First name</label><input id="edit-first" name="firstName" value="${escapeHtml(patient.first_name)}" maxlength="100" required></div>
        <div class="field"><label for="edit-last">Last name</label><input id="edit-last" name="lastName" value="${escapeHtml(patient.last_name)}" maxlength="100" required></div>
      </div>
      <div class="field"><label for="edit-dob">Date of birth</label><input id="edit-dob" name="dateOfBirth" type="date" value="${escapeHtml(String(patient.date_of_birth || '').slice(0, 10))}"></div>
      <div class="field"><label for="edit-gender">Gender</label><select id="edit-gender" name="gender"><option value="">Not recorded</option><option value="female" ${patient.gender === 'female' ? 'selected' : ''}>Female</option><option value="male" ${patient.gender === 'male' ? 'selected' : ''}>Male</option><option value="other" ${patient.gender === 'other' ? 'selected' : ''}>Other</option></select></div>
      <div class="field"><label for="edit-phone">Phone</label><input id="edit-phone" name="phoneNumber" value="${escapeHtml(patient.phone_number || '')}" maxlength="30"></div>
      <div class="field"><label for="edit-kin">Next of kin</label><input id="edit-kin" name="nextOfKinName" value="${escapeHtml(patient.next_of_kin_name || '')}" maxlength="200"></div>
      <div class="field"><label for="edit-kin-contact">Next of kin contact</label><input id="edit-kin-contact" name="nextOfKinContact" value="${escapeHtml(patient.next_of_kin_contact || '')}" maxlength="100"></div>
      <button class="button" type="submit">Save patient details</button><p class="error-message" role="alert"></p>
    </form>`;
    if (state.user.permissions.includes('patients.checkin') || state.user.permissions.includes('appointments.create')) {
      controls += '<div class="button-row">';
      if (state.user.permissions.includes('patients.checkin')) controls += `<button class="button" data-action="check-in-patient" data-patient="${escapeHtml(patient.id)}">Check in · get queue number</button>`;
      if (state.user.permissions.includes('appointments.create')) controls += '<button class="button secondary" data-action="show-appointment-book">Book appointment</button>';
      controls += '</div>';
      if (state.showAppointmentForm) controls += appointmentBookingForm(patient.id);
    }
  }

  if (state.user.permissions.includes('patients.assign')) {
    const clinicians = state.users.filter((user) => user.role === 'clinician' && user.is_active);
    controls += `<form class="inline-form" data-form="assignment">
      <h3>Care team access</h3>
      <div class="field"><label for="assigned-clinician">Assign clinician</label><select id="assigned-clinician" name="clinicianId" required>
        <option value="">Choose a clinician</option>${clinicians.map((user) => `<option value="${escapeHtml(user.id)}">${escapeHtml(user.username)}</option>`).join('')}
      </select></div><button class="button secondary" type="submit">Grant patient access</button><p class="error-message" role="alert"></p>
    </form>
    ${state.user.permissions.includes('patients.archive') ? '<div class="inline-form"><h3>Record lifecycle</h3><p class="notice">Archiving removes the patient from routine search without permanently deleting the record.</p><button class="button danger" data-action="archive-patient" type="button">Archive patient</button></div>' : ''}`;
  }

  const currentVisit = (patient.visits || []).find((visit) => !['completed', 'cancelled'].includes(visit.status));
  const visitsSummary = (patient.visits || []).map((visit) => `<li>Queue ${escapeHtml(visit.queue_number || '—')} · ${escapeHtml(visit.status.replaceAll('_', ' '))} · ${escapeHtml(formatDate(visit.visit_date))}</li>`).join('');
  return `<article class="detail-panel">
    <div class="detail-title"><div><h2>${escapeHtml(patient.first_name)} ${escapeHtml(patient.last_name)}</h2><p>Patient record</p></div><div class="button-row"><button class="button secondary small" data-action="print-patient" type="button">Print</button><button class="button secondary small" data-action="close-patient" type="button">Close</button></div></div>
    <div class="detail-body">${demographics}${currentVisit ? `<p class="notice">Current visit: ${escapeHtml(currentVisit.status.replaceAll('_', ' '))} · Queue #${escapeHtml(currentVisit.queue_number || '—')}</p>` : ''}<section class="inline-form"><h3>Visit status history</h3><ul>${visitsSummary || '<li>No visits yet.</li>'}</ul></section>${controls}</div>
  </article>`;
}

function appointmentBookingForm(patientId) {
  return `<form class="inline-form" data-form="appointment-book"><h3>Book an appointment</h3><input type="hidden" name="patientId" value="${escapeHtml(patientId)}">
    <div class="field"><label>Date and time</label><input name="scheduledAt" type="datetime-local" required></div>
    <div class="field"><label>Reason</label><input name="reason" maxlength="1000"></div>
    <button class="button" type="submit">Book appointment</button><button class="button secondary" type="button" data-action="show-appointment-book">Close</button><p class="error-message" role="alert"></p></form>`;
}

function renderDashboard() {
  if (!state.dashboard) {
    renderShell(`<div class="page-heading"><div><p class="eyebrow">Operational workspace</p><h1>Dashboard</h1></div></div>
      <section class="section-block"><p class="empty-state" role="status">Loading live dashboard data from PostgreSQL...</p></section>`);
    return;
  }
  const stats = state.dashboard;

  const metric = (icon, label, value, caption) => `<article class="stat-card">
    <span class="stat-icon" aria-hidden="true">${escapeHtml(icon)}</span>
    <div class="stat-copy"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value ?? 0)}</strong><small>${escapeHtml(caption)}</small></div>
  </article>`;
  let title = 'System overview';
  let metrics = [];
  let detail = '';
  let activeMetric = 'Operational overview';

  if (state.user.role === 'clerk') {
    title = 'Clerk dashboard';
    activeMetric = 'Front desk · Today';
    metrics = [
      metric('P', 'Total patients', stats.totalPatients, 'Active patient records'),
      metric('+', 'New patients today', stats.patientsToday, 'Registered since midnight'),
      metric('A', "Today's appointments", stats.appointmentsToday, 'Scheduled for today'),
      metric('C', 'Checked-in patients', stats.checkedInPatients, 'Active visits today'),
      metric('W', 'Waiting patients', stats.waitingPatients, 'Awaiting a care team'),
      metric('✓', 'Completed visits', stats.completedVisits, 'Closed today')
    ];
    detail = `${appointmentsTable()}${clerkQueue()}`;
  } else if (state.user.role === 'nurse') {
    title = state.view === 'clinical' ? 'Triage queue' : state.view === 'vitals' ? 'Vital signs' : 'Nursing dashboard';
    activeMetric = 'Nursing workflow · Today';
    metrics = [
      metric('W', 'Waiting for triage', stats.waitingForTriage, 'Ready for nursing assessment'),
      metric('T', 'In triage', stats.inTriage, 'Assessment in progress'),
      metric('✓', 'Completed triage', stats.completedTriage, 'Triage documented today'),
      metric('!', 'Urgent / critical', stats.urgentPatients, 'Priority care required')
    ];
    detail = state.view === 'vitals'
      ? nursingVitalSignsTable()
      : state.view === 'appointments' ? appointmentsTable() : nursingQueue();
  } else if (state.user.role === 'clinician') {
    title = 'Clinician dashboard';
    activeMetric = 'Clinical workflow · Today';
    metrics = [
      metric('W', 'Waiting for consultation', stats.waitingPatients, 'Triaged and ready'),
      metric('C', 'In consultation', stats.patientsInConsultation, 'Currently being seen'),
      metric('✓', 'Completed today', stats.completedVisits, 'Visits closed today'),
      metric('A', "Today's appointments", stats.appointmentsToday, 'Checked in today'),
      metric('!', 'Urgent / critical', stats.urgentPatients, 'Active priority cases'),
      metric('F', 'Follow-up patients', stats.followUpPatients, 'Follow-up noted today')
    ];
    detail = state.view === 'appointments' ? `${appointmentsTable()}${clinicalQueue()}` : clinicalQueue();
  } else if (state.view === 'pharmacy' || state.user.role === 'pharmacist') {
    title = 'Pharmacy dashboard';
    metrics = [
      metric('Rx', 'Pending prescriptions', stats.pendingPrescriptions, 'Awaiting dispensing'),
      metric('✓', 'Dispensed today', stats.prescriptionsDispensedToday, 'Issued today'),
      metric('P', 'Pending patients', stats.pharmacyPendingPatients, 'Patients with open prescriptions'),
      metric('!', 'Low stock medicines', stats.lowStockMedicines, 'At or below minimum level'),
      metric('×', 'Out of stock medicines', stats.outOfStockMedicines, 'Unavailable for dispensing')
    ];
    detail = pharmacyDetail();
  } else if (state.user.role === 'laboratory' || state.view === 'laboratory') {
    title = 'Laboratory dashboard';
    metrics = [
      metric('L', 'Pending tests', stats.pendingLabRequests, 'Awaiting processing'),
      metric('T', 'In progress', stats.inProgressLabRequests, 'Currently being processed'),
      metric('✓', 'Completed today', stats.completedLabRequests, 'Results entered today'),
      metric('!', 'Urgent tests', stats.urgentLabRequests, 'From urgent / critical visits')
    ];
    detail = laboratoryQueue();
  } else if (state.user.role === 'management') {
    title = 'Management dashboard';
    metrics = [
      metric('P', 'Total patients', stats.totalPatients, 'Active patient records'),
      metric('+', 'New patients today', stats.patientsToday, 'Registered since midnight'),
      metric('C', 'Consultations today', stats.consultationsToday, 'Visits recorded today'),
      metric('A', "Today's appointments", stats.appointmentsToday, 'Scheduled for today'),
      metric('Rx', 'Pending prescriptions', stats.pendingPrescriptions, 'Awaiting dispensing'),
      metric('L', 'Pending laboratory requests', stats.pendingLabRequests, 'Awaiting processing')
    ];
    detail = `<section class="section-block"><h2>Operational reports</h2><button class="button secondary" data-action="navigate" data-view="reports">View reports</button></section>`;
  } else if (state.user.role === 'administrator') {
    title = 'Administration dashboard';
    metrics = [
      metric('U', 'Total users', stats.totalUsers, 'Staff accounts in the system'),
      metric('✓', 'Active staff', stats.activeStaff, 'Enabled staff accounts'),
      metric('P', 'Total patients', stats.totalPatients, 'Active patient records'),
      metric('V', "Today's visits", stats.visitsToday, 'Visits recorded today'),
      metric('A', 'System activity', stats.auditEventsToday, 'Audit events recorded today'),
      metric('!', 'Pending administrative tasks', stats.pendingAdministrativeTasks, 'Accounts awaiting approval')
    ];
    const rows = (stats.recentActivity || []).map((event) => `<tr><td>${escapeHtml(formatDate(event.occurred_at))}</td><td>${escapeHtml(event.action.replaceAll('.', ' '))}</td><td>${escapeHtml(event.resource_type)}</td><td>${escapeHtml(event.resource_id || '—')}</td></tr>`).join('');
    detail = `<section class="section-block"><div class="section-head"><h2>Recent activity</h2><span>Audit metadata</span></div><div class="table-wrap"><table><thead><tr><th>Time</th><th>Action</th><th>Type</th><th>Record</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="empty-state">No recent activity found.</td></tr>'}</tbody></table></div></section>`;
  } else {
    title = 'Operational dashboard';
    detail = '<p class="empty-state">No dashboard is configured for this account.</p>';
  }

  const triageModal = state.user.role === 'nurse' && state.activeTriageVisit
    ? renderTriageModal(state.queue.find((visit) => visit.id === state.activeTriageVisit))
    : '';
  const content = `<div class="page-heading"><div><p class="eyebrow">${escapeHtml(activeMetric)}</p><h1>${escapeHtml(title)}</h1><p>Live data from Kagando EMR in PostgreSQL.</p></div><button class="button secondary" data-action="refresh-dashboard" type="button">Refresh</button></div>
    <div class="stats-grid">${metrics.join('')}</div>${detail}${triageModal}`;
  renderShell(content);
}

function appointmentsTable() {
  const rows = state.appointments.map((appointment) => `<tr>
    <td>${escapeHtml(new Date(appointment.scheduled_at).toLocaleString())}</td>
    <td><strong>${escapeHtml(appointment.last_name)}, ${escapeHtml(appointment.first_name)}</strong><br><span>${escapeHtml(appointment.medical_record_number)}</span></td>
    <td>${escapeHtml(appointment.reason || '—')}</td><td>${escapeHtml(appointment.status)}</td>
    <td>${appointment.status === 'booked' || appointment.status === 'rescheduled'
      ? `${state.user.permissions.includes('patients.checkin') ? `<button class="button small" data-action="check-in-appointment" data-patient="${escapeHtml(appointment.patient_id)}" data-appointment="${escapeHtml(appointment.id)}">Check in</button>` : ''}
        ${state.user.permissions.includes('appointments.cancel') ? `<button class="button secondary small" data-action="cancel-appointment" data-id="${escapeHtml(appointment.id)}">Cancel</button>` : ''}
        ${state.user.permissions.includes('appointments.edit') ? `<form data-form="appointment-reschedule" data-id="${escapeHtml(appointment.id)}"><input name="scheduledAt" type="datetime-local" required aria-label="New appointment time"><button class="button secondary small" type="submit">Reschedule</button><p class="error-message" role="alert"></p></form>` : ''}`
      : ''}</td>
  </tr>`).join('');
  return `<section class="section-block"><div class="section-head"><h2>Today's appointments</h2><span>${state.appointments.length}</span></div>
    <div class="table-wrap"><table><thead><tr><th>Time</th><th>Patient</th><th>Reason</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="empty-state">No appointments scheduled for today.</td></tr>'}</tbody></table></div>
    ${state.user.permissions.includes('appointments.create') ? `<form class="inline-form" data-form="appointment-book"><h3>Book an appointment</h3>
      <div class="field"><label for="appointment-patient">Patient</label><select id="appointment-patient" name="patientId" required><option value="">Select a patient</option>${state.patients.map((patient) => `<option value="${escapeHtml(patient.id)}" ${state.activePatient?.id === patient.id ? 'selected' : ''}>${escapeHtml(patient.last_name)}, ${escapeHtml(patient.first_name)} · ${escapeHtml(patient.medical_record_number)}</option>`).join('')}</select></div>
      <div class="field"><label for="appointment-time">Date and time</label><input id="appointment-time" name="scheduledAt" type="datetime-local" required></div>
      <div class="field"><label for="appointment-reason">Reason</label><input id="appointment-reason" name="reason" maxlength="1000"></div>
      <button class="button" type="submit">Book appointment</button><p class="error-message" role="alert"></p></form>` : ''}</section>`;
}

function clerkQueue() {
  const rows = state.clerkQueue.map((visit) => `<tr>
    <td>${escapeHtml(visit.queue_number || '—')}</td>
    <td><strong>${escapeHtml(visit.last_name)}, ${escapeHtml(visit.first_name)}</strong><br><span>${escapeHtml(visit.medical_record_number)}</span></td>
    <td>${escapeHtml(displayAge(visit))} · ${escapeHtml(visit.gender || '—')}</td>
    <td>${escapeHtml(arrivalTime(visit.visit_date))}</td>
    <td><span class="badge">${escapeHtml(visit.status.replaceAll('_', ' '))}</span></td>
    <td><button class="button secondary small" data-action="open-patient" data-id="${escapeHtml(visit.patient_id)}">Open record</button></td>
  </tr>`).join('');
  return `<section class="section-block"><div class="section-head"><h2>Patients in today's queue</h2><span>${state.clerkQueue.length} checked in</span></div>
    <div class="table-wrap"><table><thead><tr><th>Queue</th><th>Patient</th><th>Age / Sex</th><th>Arrival</th><th>Status</th><th>Action</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="empty-state">No patients are currently waiting for care.</td></tr>'}</tbody></table></div>
  </section>`;
}

function displayAge(visit) {
  return visit.patient_age === null || visit.patient_age === undefined ? '—' : `${visit.patient_age} yrs`;
}

function arrivalTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '—' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function waitTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '—';
  const minutes = Math.max(0, Math.floor((Date.now() - date.valueOf()) / 60000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} hr ${minutes % 60} min`;
}

function nursingQueue() {
  const visits = state.queue.filter((visit) => ['waiting_triage', 'in_triage'].includes(visit.status));
  const rows = visits.map((visit) => `<tr>
    <td><strong>#${escapeHtml(visit.queue_number || '—')}</strong></td>
    <td><strong>${escapeHtml(visit.last_name)}, ${escapeHtml(visit.first_name)}</strong><br><span>${escapeHtml(visit.medical_record_number)}</span></td>
    <td>${escapeHtml(displayAge(visit))} · ${escapeHtml(visit.gender || '—')}</td>
    <td><span class="badge ${['urgent', 'critical'].includes(visit.triage_priority) ? 'priority-high' : ''}">${escapeHtml(visit.triage_priority || 'Pending')}</span></td>
    <td>${escapeHtml(arrivalTime(visit.visit_date))}</td>
    <td>${escapeHtml(waitTime(visit.visit_date))}</td>
    <td><button class="button small" data-action="open-triage" data-id="${escapeHtml(visit.id)}">${visit.status === 'in_triage' ? 'Continue triage' : 'Triage'}</button></td>
  </tr>`).join('');
  return `<section class="section-block nursing-queue">
    <div class="section-head"><h2>Patients waiting for triage</h2><span>${visits.length} patients</span></div>
    <div class="table-wrap"><table><thead><tr><th>Queue</th><th>Patient</th><th>Age / Sex</th><th>Priority</th><th>Arrival</th><th>Wait time</th><th>Action</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" class="empty-state">No patients are waiting for triage.</td></tr>'}</tbody></table></div>
  </section>`;
}

function nursingVitalSignsTable() {
  const visits = state.queue.filter((visit) => visit.triaged_at || ['waiting_clinician', 'in_consultation', 'lab_requested', 'pharmacy_pending'].includes(visit.status));
  const rows = visits.map((visit) => `<tr>
    <td>#${escapeHtml(visit.queue_number || '—')}</td>
    <td><strong>${escapeHtml(visit.last_name)}, ${escapeHtml(visit.first_name)}</strong><br><span>${escapeHtml(visit.medical_record_number)}</span></td>
    <td>${escapeHtml(visit.temperature ?? '—')} °C</td>
    <td>${escapeHtml(visit.blood_pressure || '—')}</td>
    <td>${escapeHtml(visit.pulse_rate ?? '—')}</td>
    <td>${escapeHtml(visit.respiratory_rate ?? '—')}</td>
    <td>${escapeHtml(visit.oxygen_saturation ?? '—')}%</td>
    <td><span class="badge">${escapeHtml(visit.status.replaceAll('_', ' '))}</span></td>
  </tr>`).join('');
  return `<section class="section-block">
    <div class="section-head"><h2>Recorded vital signs</h2><span>${visits.length} active records</span></div>
    <div class="table-wrap"><table><thead><tr><th>Queue</th><th>Patient</th><th>Temp.</th><th>Blood pressure</th><th>Pulse</th><th>Resp. rate</th><th>SpO₂</th><th>Status</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="8" class="empty-state">No completed triage observations are available.</td></tr>'}</tbody></table></div>
  </section>`;
}

function renderTriageModal(visit) {
  if (!visit) return '';
  return `<div class="modal-backdrop">
    <section class="triage-modal" role="dialog" aria-modal="true" aria-labelledby="triage-title">
      <header class="triage-modal-head"><div><p class="eyebrow">Nursing assessment · Queue #${escapeHtml(visit.queue_number || '—')}</p>
        <h2 id="triage-title">${escapeHtml(visit.last_name)}, ${escapeHtml(visit.first_name)}</h2>
        <p>${escapeHtml(visit.medical_record_number)} · ${escapeHtml(displayAge(visit))} · ${escapeHtml(visit.gender || 'Sex not recorded')}</p></div>
        <button class="button secondary small" type="button" data-action="close-triage">Close</button></header>
      <div class="triage-context"><strong>Allergies</strong><span>${escapeHtml(visit.allergies || 'None recorded')}</span>
        ${visit.chief_complaint ? `<strong>Presenting concern</strong><span>${escapeHtml(visit.chief_complaint)}</span>` : ''}</div>
      <form class="triage-form" data-form="triage" data-id="${escapeHtml(visit.id)}">
        <div class="detail-facts">
          <div class="field"><label>Temperature °C</label><input name="temperature" type="number" min="1" max="50" step="0.1" value="${escapeHtml(visit.temperature ?? '')}" required></div>
          <div class="field"><label>Blood pressure</label><input name="bloodPressure" maxlength="30" value="${escapeHtml(visit.blood_pressure || '')}" placeholder="e.g. 120/80" required></div>
          <div class="field"><label>Pulse / min</label><input name="pulseRate" type="number" min="1" max="300" value="${escapeHtml(visit.pulse_rate ?? '')}" required></div>
          <div class="field"><label>Respiratory rate / min</label><input name="respiratoryRate" type="number" min="1" max="100" value="${escapeHtml(visit.respiratory_rate ?? '')}" required></div>
          <div class="field"><label>Oxygen saturation %</label><input name="oxygenSaturation" type="number" min="1" max="100" step="0.1" value="${escapeHtml(visit.oxygen_saturation ?? '')}" required></div>
          <div class="field"><label>Weight kg</label><input name="weight" type="number" min="0.1" max="500" step="0.1" value="${escapeHtml(visit.weight ?? '')}" required></div>
          <div class="field"><label>Height cm</label><input name="height" type="number" min="1" max="300" step="0.1" value="${escapeHtml(visit.height ?? '')}" required></div>
          <div class="field"><label>Pain level (0–10)</label><input name="painLevel" type="number" min="0" max="10" value="${escapeHtml(visit.pain_level ?? '')}" required></div>
          <div class="field"><label>Triage priority</label><select name="triagePriority">
            <option value="routine" ${visit.triage_priority === 'routine' ? 'selected' : ''}>Normal</option>
            <option value="urgent" ${visit.triage_priority === 'urgent' ? 'selected' : ''}>Urgent</option>
            <option value="critical" ${visit.triage_priority === 'critical' ? 'selected' : ''}>Critical</option>
          </select></div>
        </div>
        <div class="field"><label>Nursing notes</label><textarea name="nursingNotes" maxlength="5000">${escapeHtml(visit.nursing_notes || '')}</textarea></div>
        <div class="button-row"><button class="button secondary" type="submit" value="false">Save triage</button>
          <button class="button" type="submit" value="true">Save &amp; send to clinician</button></div>
        <p class="error-message" role="alert"></p>
      </form>
    </section>
  </div>`;
}

function clinicalQueue() {
  const clinicianVisits = state.queue.filter((visit) => visit.status !== 'waiting_triage' && visit.status !== 'in_triage');
  const rows = clinicianVisits.map((visit) => {
    let action = '';
    if (visit.status === 'waiting_clinician' && state.user.permissions.includes('consultation.start')) {
      action = `<button class="button small" data-action="start-consultation" data-id="${escapeHtml(visit.id)}">Start consultation</button>`;
    } else if (visit.status === 'in_consultation' && state.user.permissions.includes('consultation.complete')) {
      action = `<button class="button secondary small" data-action="open-consultation" data-id="${escapeHtml(visit.id)}">Open workspace</button>`;
    } else {
      action = `<button class="button secondary small" data-action="open-visit-patient" data-patient="${escapeHtml(visit.patient_id)}">Review record</button>`;
    }
    return `<tr>
      <td><strong>#${escapeHtml(visit.queue_number || '—')}</strong></td>
      <td><strong>${escapeHtml(visit.last_name)}, ${escapeHtml(visit.first_name)}</strong><br><span>${escapeHtml(visit.medical_record_number)}</span></td>
      <td>${escapeHtml(displayAge(visit))} · ${escapeHtml(visit.gender || '—')}</td>
      <td><span class="badge ${['urgent', 'critical'].includes(visit.triage_priority) ? 'priority-high' : ''}">${escapeHtml(visit.triage_priority || 'Normal')}</span></td>
      <td>${escapeHtml(waitTime(visit.visit_date))}</td>
      <td><span class="badge">${escapeHtml(visit.status.replaceAll('_', ' '))}</span></td>
      <td>${action}</td>
    </tr>`;
  }).join('');
  const activeVisit = state.queue.find((visit) => visit.id === state.activeVisit && visit.status === 'in_consultation');
  return `<section class="section-block clinician-queue">
    <div class="section-head"><h2>Patients waiting for consultation</h2><span>${clinicianVisits.filter((visit) => visit.status === 'waiting_clinician').length} waiting</span></div>
    <div class="table-wrap"><table><thead><tr><th>Queue</th><th>Patient</th><th>Age / Sex</th><th>Priority</th><th>Wait</th><th>Status</th><th>Action</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" class="empty-state">No patients are currently in the clinical queue.</td></tr>'}</tbody></table></div>
  </section>${activeVisit ? consultationWorkspace(activeVisit) : ''}`;
}

function consultationWorkspace(visit) {
  return `<section class="section-block consultation-workspace">
    <div class="section-head"><h2>Consultation workspace · Queue #${escapeHtml(visit.queue_number || '—')}</h2>
      <span class="badge ${['urgent', 'critical'].includes(visit.triage_priority) ? 'priority-high' : ''}">${escapeHtml(visit.triage_priority || 'Normal')}</span></div>
    <div class="detail-facts">
      <div class="fact"><span>Patient</span><strong>${escapeHtml(visit.last_name)}, ${escapeHtml(visit.first_name)} · ${escapeHtml(visit.medical_record_number)}</strong></div>
      <div class="fact"><span>Age / sex</span><strong>${escapeHtml(displayAge(visit))} · ${escapeHtml(visit.gender || 'Not recorded')}</strong></div>
      <div class="fact"><span>Allergies</span><strong>${escapeHtml(visit.allergies || 'None recorded')}</strong></div>
      <div class="fact"><span>Presenting concern</span><strong>${escapeHtml(visit.chief_complaint || 'Not recorded')}</strong></div>
      <div class="fact"><span>Vital signs</span><strong>${escapeHtml(visit.temperature ?? '—')} °C · BP ${escapeHtml(visit.blood_pressure || '—')} · Pulse ${escapeHtml(visit.pulse_rate ?? '—')} · SpO₂ ${escapeHtml(visit.oxygen_saturation ?? '—')}%</strong></div>
    </div>
    <div class="button-row"><button class="button secondary small" data-action="open-visit-patient" data-patient="${escapeHtml(visit.patient_id)}">Open medical history</button></div>
    <form class="inline-form" data-form="clinical-complete" data-id="${escapeHtml(visit.id)}">
      <h3>Consultation</h3><div class="field"><label>Symptoms</label><textarea name="symptoms" maxlength="4000">${escapeHtml(visit.symptoms || '')}</textarea></div>
      <div class="field"><label>Clinical examination</label><textarea name="clinicalExamination" maxlength="12000">${escapeHtml(visit.clinical_examination || '')}</textarea></div>
      <div class="field"><label>Diagnosis</label><textarea name="diagnosis" maxlength="5000" required>${escapeHtml(visit.diagnosis || '')}</textarea></div>
      <div class="field"><label>Treatment plan</label><textarea name="treatmentNotes" maxlength="20000">${escapeHtml(visit.treatment_notes || '')}</textarea></div>
      <div class="field"><label>Follow-up</label><textarea name="followUp" maxlength="2000">${escapeHtml(visit.follow_up || '')}</textarea></div>
      <button class="button" type="submit">Complete consultation</button><p class="error-message" role="alert"></p></form>
    <div class="consultation-actions">
      <form class="inline-form" data-form="prescription" data-id="${escapeHtml(visit.id)}" data-patient="${escapeHtml(visit.patient_id)}"><h3>Prescription</h3>
        <div class="detail-facts"><div class="field"><label>Medicine</label><input name="medication" maxlength="200" required></div><div class="field"><label>Dose</label><input name="dose" maxlength="200" required></div>
        <div class="field"><label>Frequency</label><input name="frequency" maxlength="100"></div><div class="field"><label>Duration</label><input name="duration" maxlength="100"></div>
        <div class="field"><label>Quantity</label><input name="quantity" type="number" min="1" required></div></div>
        <div class="field"><label>Instructions</label><textarea name="instructions" maxlength="2000"></textarea></div>
        <button class="button secondary" type="submit">Send prescription to pharmacy</button><p class="error-message" role="alert"></p></form>
      <form class="inline-form" data-form="lab-request" data-id="${escapeHtml(visit.id)}"><h3>Laboratory request</h3>
        <div class="field"><label>Test</label><input name="testName" maxlength="200" required></div><div class="field"><label>Clinical notes</label><textarea name="clinicalNotes" maxlength="2000"></textarea></div>
        <button class="button secondary" type="submit">Send to laboratory</button><p class="error-message" role="alert"></p></form>
      ${state.user.permissions.includes('appointments.followup.create') ? `<form class="inline-form" data-form="followup" data-patient="${escapeHtml(visit.patient_id)}"><h3>Schedule follow-up</h3>
        <div class="field"><label>Date and time</label><input name="scheduledAt" type="datetime-local" required></div>
        <div class="field"><label>Reason</label><input name="reason" maxlength="1000"></div>
        <button class="button secondary" type="submit">Request follow-up appointment</button><p class="error-message" role="alert"></p></form>` : ''}
    </div>
  </section>`;
}

function pharmacyDetail() {
  const alerts = state.alerts;
  const medicines = state.medicines.map((medicine) => `<option value="${escapeHtml(medicine.id)}">${escapeHtml(medicine.name)} · ${escapeHtml(medicine.current_quantity)} ${escapeHtml(medicine.unit || 'units')}</option>`).join('');
  const prescriptions = state.prescriptions.map((prescription) => `<article class="section-block">
    <div class="section-head"><h2>${escapeHtml(prescription.medication)} · ${escapeHtml(prescription.dose)}</h2><span class="badge">${escapeHtml(prescription.status.replaceAll('_', ' '))}</span></div>
    <p>${escapeHtml(prescription.last_name)}, ${escapeHtml(prescription.first_name)} · ${escapeHtml(prescription.medical_record_number)}</p>
    <p>${escapeHtml(prescription.frequency || 'Frequency not recorded')} · ${escapeHtml(prescription.duration || 'Duration not recorded')} · Prescribed: ${escapeHtml(prescription.quantity)} · ${escapeHtml(prescription.instructions || '')}</p>
    ${['pending', 'active', 'partially_dispensed'].includes(prescription.status) ? `<form class="inline-form" data-form="dispense" data-id="${escapeHtml(prescription.id)}"><h3>Dispense medicine</h3><div class="detail-facts">
      <div class="field"><label>Inventory medicine</label><select name="medicineId" required><option value="">Select medicine</option>${medicines}</select></div>
      <div class="field"><label>Quantity now (remaining ${escapeHtml(Math.max(0, Number(prescription.quantity || 0) - Number(prescription.dispensed_quantity || 0)))})</label><input name="quantity" type="number" min="1" max="${escapeHtml(Math.max(0, Number(prescription.quantity || 0) - Number(prescription.dispensed_quantity || 0)))}" required></div></div>
      <div class="field"><label>Pharmacy notes</label><textarea name="notes" maxlength="1000"></textarea></div>
      <button class="button" type="submit">Record dispensing</button><p class="error-message" role="alert"></p></form>` : ''}
    </article>`).join('');
  const inventory = state.medicines.map((medicine) => `<tr><td>${escapeHtml(medicine.name)}</td><td>${escapeHtml(medicine.current_quantity)} ${escapeHtml(medicine.unit || '')}</td><td>${escapeHtml(medicine.minimum_stock_level)}</td><td>${escapeHtml(medicine.expiry_date || '—')}</td><td>${medicine.current_quantity === 0 ? 'Out of stock' : medicine.current_quantity <= medicine.minimum_stock_level ? 'Low stock' : 'Available'}</td></tr>`).join('');
  return `<section class="section-block"><div class="section-head"><h2>Prescription queue</h2><span>${state.prescriptions.length} records</span></div>
    <label class="search-box"><input id="prescription-search" type="search" value="${escapeHtml(state.search)}" placeholder="Search patient or prescription"></label>
    ${prescriptions || '<p class="empty-state">No prescriptions available.</p>'}</section>
    <section class="section-block spaced-section"><div class="section-head"><h2>Stock alerts</h2><span>${alerts.lowStock.length} low · ${alerts.outOfStock.length} out · ${alerts.expiring.length} expiring</span></div>
      <p>Expired/near-expiry stock is blocked by the dispensing transaction.</p>
      <form class="inline-form" data-form="medicine-create"><h3>Add inventory medicine</h3>
        <div class="detail-facts"><div class="field"><label>Name</label><input name="name" maxlength="200" required></div><div class="field"><label>Generic name</label><input name="genericName" maxlength="200"></div><div class="field"><label>Unit</label><input name="unit" maxlength="50"></div><div class="field"><label>Opening quantity</label><input name="quantity" type="number" min="0" value="0" required></div><div class="field"><label>Minimum stock</label><input name="minimumStockLevel" type="number" min="0" value="0" required></div><div class="field"><label>Expiry date</label><input name="expiryDate" type="date"></div></div>
        <button class="button" type="submit">Add medicine</button><p class="error-message" role="alert"></p></form>
      <div class="table-wrap"><table><thead><tr><th>Medicine</th><th>Available</th><th>Minimum</th><th>Expiry</th><th>Alert</th></tr></thead><tbody>${inventory || '<tr><td colspan="5" class="empty-state">No inventory medicines.</td></tr>'}</tbody></table></div>
      <form class="inline-form" data-form="stock-receive"><h3>Receive stock</h3>
        <div class="detail-facts">
          <div class="field"><label>Medicine in inventory</label><select name="medicineId" id="stock-medicine-select" required>
            <option value="">Select an existing medicine</option>${medicines}<option value="new">+ Add a new medicine</option>
          </select></div>
          <div class="field"><label>Quantity received</label><input name="quantity" type="number" min="1" step="1" required></div>
          <div class="field"><label>Receipt notes</label><input name="notes" maxlength="1000" placeholder="Supplier, invoice, or delivery details"></div>
        </div>
        <div class="stock-new-medicine" id="stock-new-medicine-fields" hidden>
          <h3>New medicine details</h3>
          <p class="field-hint">This creates the inventory record and adds the received quantity in one transaction.</p>
          <div class="detail-facts">
            <div class="field"><label>Medicine name</label><input name="medicineName" maxlength="200" required disabled></div>
            <div class="field"><label>Generic name</label><input name="genericName" maxlength="200" disabled></div>
            <div class="field"><label>Strength</label><input name="strength" maxlength="100" placeholder="e.g. 500 mg" disabled></div>
            <div class="field"><label>Dosage form</label><input name="dosageForm" maxlength="100" placeholder="e.g. tablet, syrup" disabled></div>
            <div class="field"><label>Unit</label><input name="unit" maxlength="50" placeholder="e.g. tablets, bottles" disabled></div>
            <div class="field"><label>Minimum stock alert</label><input name="minimumStockLevel" type="number" min="0" step="1" value="0" disabled></div>
            <div class="field"><label>Expiry date</label><input name="expiryDate" type="date" disabled></div>
            <div class="field"><label>Batch number</label><input name="batchNumber" maxlength="100" disabled></div>
            <div class="field"><label>Supplier</label><input name="supplier" maxlength="200" disabled></div>
          </div>
        </div>
        <button class="button secondary" type="submit">Receive stock</button><p class="error-message" role="alert"></p></form></section>`;
}

function laboratoryQueue() {
  const rows = state.laboratoryRequests.map((request) => `<form class="section-block inline-form" data-form="lab-result" data-id="${escapeHtml(request.id)}">
    <h2>${escapeHtml(request.test_name)} · ${escapeHtml(request.last_name)}, ${escapeHtml(request.first_name)}</h2>
    <p>${escapeHtml(request.medical_record_number)} · Queue #${escapeHtml(request.queue_number || '—')} · ${escapeHtml(request.clinical_notes || '')}</p>
    <div class="field"><label>Result</label><textarea name="result" maxlength="12000" required></textarea></div>
    <button class="button" type="submit">Record result</button><p class="error-message" role="alert"></p></form>`).join('');
  return `<section class="section-block"><div class="section-head"><h2>Pending laboratory requests</h2><span>${state.laboratoryRequests.length}</span></div>${rows || '<p class="empty-state">No laboratory requests pending.</p>'}</section>`;
}

function renderPatients() {
  const canRegister = state.user.permissions.includes('patients.create');
  const title = state.view === 'registration' ? 'Patient registration'
    : state.view === 'checkin' ? 'Patient check-in' : 'Patients';
  const content = `<div class="page-heading">
      <div><p class="eyebrow">Patient records</p><h1>${escapeHtml(title)}</h1><p>${state.view === 'checkin' ? 'Search for a registered patient, open the demographic record, and check them in to the clinical queue.' : 'Find and manage records within your role.'}</p></div>
      ${canRegister ? '<button class="button" data-action="toggle-patient-form" type="button">Register patient</button>' : ''}
    </div>
    <div class="content-grid">
      <section class="section-block">
        <div class="section-head"><h2>Patient list</h2><span>${state.patients.length} shown</span></div>
        <div class="toolbar search-toolbar"><label class="search-box"><input id="patient-search" type="search" value="${escapeHtml(state.search)}" placeholder="Search name or record number" aria-label="Search patients"></label></div>
        <div class="table-wrap"><table><thead><tr><th>Patient</th><th>Record no.</th><th>Date of birth</th><th>Updated</th></tr></thead><tbody>${renderPatientRows()}</tbody></table></div>
        ${state.showPatientForm || state.view === 'registration' ? renderPatientForm() : ''}
      </section>
      ${renderPatientDetail()}
    </div>`;
  renderShell(content);
}

function renderPrescriptions() {
  if (state.user.permissions.includes('pharmacy.inventory')) {
    renderShell(`<div class="page-heading"><div><p class="eyebrow">Inventory and dispensing</p><h1>Pharmacy</h1><p>Dispense only against a valid prescription; each issue updates stock transactionally.</p></div><button class="button secondary" data-action="refresh-prescriptions">Refresh</button></div>${pharmacyDetail()}`);
    return;
  }
  const rows = state.prescriptions.length ? state.prescriptions.map((prescription) => `<tr>
    <td><strong>${escapeHtml(prescription.medication)}</strong><br><span>${escapeHtml(prescription.dose)}</span></td>
    <td>${escapeHtml(prescription.last_name)}, ${escapeHtml(prescription.first_name)}<br><span>${escapeHtml(prescription.medical_record_number)}</span></td>
    <td>${escapeHtml(prescription.instructions || 'No additional instructions')}</td>
    <td><span class="badge ${prescription.status === 'dispensed' ? 'dispensed' : ''}">${escapeHtml(prescription.status)}</span></td>
    <td>${escapeHtml(prescription.frequency || '—')} · ${escapeHtml(prescription.duration || '—')} · Qty ${escapeHtml(prescription.quantity)}</td>
  </tr>`).join('') : '<tr><td colspan="5" class="empty-state">No prescriptions are available.</td></tr>';
  renderShell(`<div class="page-heading"><div><p class="eyebrow">Medication workflow</p><h1>Prescriptions</h1><p>Review prescriptions for patients in your care.</p></div><button class="button secondary" data-action="refresh-prescriptions">Refresh</button></div>
    <section class="section-block"><div class="section-head"><h2>Recent prescriptions</h2><span>${state.prescriptions.length} shown</span></div>
    <div class="table-wrap"><table><thead><tr><th>Medication</th><th>Patient</th><th>Instructions</th><th>Status</th><th>Details</th></tr></thead><tbody>${rows}</tbody></table></div></section>`);
}

function renderUsers() {
  const rows = state.users.map((user) => {
    const isPending = user.approval_status === 'pending';
    const status = isPending ? 'Pending approval' : user.is_active ? 'Active' : 'Inactive';
    const action = isPending
      ? `<div class="approval-controls"><select id="approval-role-${escapeHtml(user.id)}" aria-label="Assign role to ${escapeHtml(user.username)}">${['clerk', 'nurse', 'clinician', 'pharmacist', 'laboratory', 'management', 'administrator'].map((role) => `<option value="${role}" ${role === user.requested_role ? 'selected' : ''}>${escapeHtml(roleNames[role])}</option>`).join('')}</select><button class="button small" data-action="approve-user" data-id="${escapeHtml(user.id)}">Approve</button></div>`
      : user.id === state.user.id ? 'Current account' : `<button class="button secondary small" data-action="toggle-user" data-id="${escapeHtml(user.id)}" data-active="${user.is_active}">${user.is_active ? 'Deactivate' : 'Activate'}</button>`;
    return `<tr><td><strong>${escapeHtml(user.username)}</strong></td><td>${escapeHtml(roleNames[user.role])}${isPending && user.requested_role ? `<br><span class="requested-role">Requested ${escapeHtml(roleNames[user.requested_role])}</span>` : ''}</td><td><span class="badge ${user.is_active ? '' : 'dispensed'}">${status}</span></td><td>${escapeHtml(formatDate(user.created_at))}</td><td>${action}</td></tr>`;
  }).join('');
  renderShell(`<div class="page-heading"><div><p class="eyebrow">Access management</p><h1>Staff access</h1><p>Create accounts with the minimum role they need.</p></div></div>
    <section class="section-block"><div class="section-head"><h2>Add staff account</h2><span>Passwords are hashed before storage</span></div>
      <form class="staff-form" data-form="user-create"><div class="field"><label for="staff-username">Username</label><input id="staff-username" name="username" maxlength="80" required autocomplete="off"></div>
      <div class="field"><label for="staff-role">Role</label><select id="staff-role" name="role"><option value="clerk">Clerk</option><option value="nurse">Nurse / Triage</option><option value="clinician">Clinician</option><option value="pharmacist">Pharmacist</option><option value="laboratory">Laboratory</option><option value="management">Management</option><option value="administrator">Administrator</option></select></div>
      <div class="field"><label for="staff-password">Temporary password</label><input id="staff-password" name="password" type="password" minlength="12" maxlength="128" required autocomplete="new-password"></div>
      <button class="button" type="submit">Create account</button><p class="error-message" role="alert"></p></form>
    </section>
    <section class="section-block spaced-section"><div class="section-head"><h2>Staff accounts and requests</h2><span>${state.users.length} shown</span></div><div class="table-wrap"><table><thead><tr><th>Username</th><th>Role</th><th>Status</th><th>Created</th><th>Action</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="empty-state">No staff accounts found.</td></tr>'}</tbody></table></div></section>`);
}

function renderPermissions() {
  const roles = ['clerk', 'nurse', 'clinician', 'pharmacist', 'laboratory', 'management', 'administrator'];
  const forms = roles.map((role) => {
    const granted = new Set((state.permissionConfig.roles || [])
      .filter((entry) => entry.role === role && entry.granted)
      .map((entry) => entry.permission_name));
    const checks = (state.permissionConfig.catalog || []).map((permission) =>
      `<label class="permission-option"><input type="checkbox" name="permissions" value="${escapeHtml(permission.name)}" ${granted.has(permission.name) ? 'checked' : ''}>
        <span><strong>${escapeHtml(permission.name)}</strong><small>${escapeHtml(permission.description)}</small></span></label>`
    ).join('');
    return `<details class="section-block"><summary>${escapeHtml(roleNames[role])}</summary>
      <form class="inline-form" data-form="role-permissions" data-role="${escapeHtml(role)}">
        <div class="permission-grid">${checks}</div>
        <button class="button" type="submit">Save ${escapeHtml(roleNames[role])} permissions</button><p class="error-message" role="alert"></p>
      </form></details>`;
  }).join('');
  renderShell(`<div class="page-heading"><div><p class="eyebrow">Access control</p><h1>Roles & permissions</h1><p>Permission changes take effect on the next API request.</p></div></div>
    <p class="notice">Administrators can grant only the permissions required for a role. Avoid granting clinical or dispensing permissions to unrelated roles.</p>${forms}`);
}

function renderReports() {
  const summary = state.reports;
  if (!summary) {
    renderShell(`<div class="page-heading"><div><p class="eyebrow">Operational analytics</p><h1>Reports</h1></div></div><p class="empty-state" role="status">Loading reports...</p>`);
    return;
  }
  renderShell(`<div class="page-heading"><div><p class="eyebrow">Operational analytics</p><h1>Reports</h1><p>Aggregated system activity; detailed records remain protected by role permissions.</p></div><button class="button secondary" data-action="refresh-reports">Refresh</button></div>
    <section class="section-block"><h2>Recent activity</h2><div class="stats-grid">
      <div class="stat-card"><span>Patients registered</span><strong>${escapeHtml(summary.daily.patients)}</strong></div>
      <div class="stat-card"><span>Consultations</span><strong>${escapeHtml(summary.daily.consultations)}</strong></div>
      <div class="stat-card"><span>Diagnoses</span><strong>${escapeHtml(summary.daily.diagnoses)}</strong></div>
      <div class="stat-card"><span>Prescriptions</span><strong>${escapeHtml(summary.daily.prescriptions)}</strong></div>
      <div class="stat-card"><span>Medicines dispensed</span><strong>${escapeHtml(summary.daily.medicinesDispensed)}</strong></div>
      <div class="stat-card"><span>Stock activity</span><strong>${escapeHtml(summary.daily.stockActivity)}</strong></div>
    </div></section>`);
}

function renderDepartments() {
  const rows = state.departments.map((department) => `<tr>
    <td><strong>${escapeHtml(department.name)}</strong></td><td>${escapeHtml(department.code)}</td>
    <td>${escapeHtml(department.description || '—')}</td><td>${department.is_active ? 'Active' : 'Inactive'}</td>
    <td><button class="button secondary small" data-action="toggle-department" data-id="${escapeHtml(department.id)}"
      data-name="${escapeHtml(department.name)}" data-code="${escapeHtml(department.code)}"
      data-description="${escapeHtml(department.description || '')}" data-active="${department.is_active}">
      ${department.is_active ? 'Deactivate' : 'Activate'}</button></td></tr>`).join('');
  renderShell(`<div class="page-heading"><div><p class="eyebrow">Administration</p><h1>Departments</h1></div></div>
    <form class="inline-form" data-form="department-create"><h2>Add department</h2>
      <div class="detail-facts"><div class="field"><label>Name</label><input name="name" maxlength="120" required></div>
      <div class="field"><label>Code (2-20 uppercase letters, numbers, hyphens)</label><input name="code" maxlength="20" pattern="[A-Z0-9-]{2,20}" required></div>
      <div class="field"><label>Description</label><textarea name="description" maxlength="2000"></textarea></div></div>
      <button class="button" type="submit">Create department</button><p class="error-message" role="alert"></p></form>
    <section class="section-block"><div class="section-head"><h2>Department records</h2><span>${state.departments.length}</span></div>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Code</th><th>Description</th><th>Status</th><th>Action</th></tr></thead><tbody>
        ${rows || '<tr><td colspan="5" class="empty-state">No departments are configured.</td></tr>'}</tbody></table></div></section>`);
}

function renderSettings() {
  const values = new Map((state.settings || []).map((setting) => [setting.setting_key, setting.setting_value]));
  const fields = [
    ['facility_name', 'Facility name', values.get('facility_name') || 'Kagando EMR', 200],
    ['patient_mrn_prefix', 'Medical record number prefix', values.get('patient_mrn_prefix') || 'KGH', 10]
  ];
  const forms = fields.map(([key, label, value, maxLength]) => `<form class="inline-form" data-form="system-setting" data-key="${key}">
    <h2>${escapeHtml(label)}</h2><div class="field"><label for="setting-${key}">${escapeHtml(label)}</label>
    <input id="setting-${key}" name="value" value="${escapeHtml(value)}" maxlength="${maxLength}" required
      ${key === 'patient_mrn_prefix' ? 'pattern="[A-Z0-9]{2,10}"' : ''}></div>
    <button class="button" type="submit">Save setting</button><p class="error-message" role="alert"></p></form>`).join('');
  renderShell(`<div class="page-heading"><div><p class="eyebrow">Administration</p><h1>System settings</h1><p>Only supported non-secret settings are exposed here.</p></div></div>${forms}`);
}

function renderAudit() {
  const rows = state.audit.map((event) => `<tr><td>${escapeHtml(formatDate(event.occurred_at))}</td><td><strong>${escapeHtml(event.action.replaceAll('.', ' '))}</strong></td><td>${escapeHtml(event.resource_type)}</td><td>${escapeHtml(event.resource_id || '—')}</td><td>${escapeHtml(event.actor_id || 'System')}</td></tr>`).join('');
  renderShell(`<div class="page-heading"><div><p class="eyebrow">Accountability</p><h1>Audit trail</h1><p>Recent record access and administrative actions.</p></div><button class="button secondary" data-action="refresh-audit">Refresh</button></div>
    <section class="section-block"><div class="section-head"><h2>Recent events</h2><span>Newest first</span></div><div class="table-wrap"><table><thead><tr><th>Time</th><th>Action</th><th>Record type</th><th>Record ID</th><th>Staff ID</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="empty-state">No audit events recorded.</td></tr>'}</tbody></table></div></section>`);
}

function render() {
  if (!state.user) {
    renderLogin();
    return;
  }
  if (state.view === 'password-change') return renderPasswordChange();
  if (state.view === 'dashboard') return renderDashboard();
  if (state.view === 'pharmacy') return renderPrescriptions();
  if (state.view === 'clinical' || state.view === 'appointments' || state.view === 'laboratory' || state.view === 'vitals') return renderDashboard();
  if (state.view === 'reports') return renderReports();
  if (state.view === 'users') return renderUsers();
  if (state.view === 'permissions') return renderPermissions();
  if (state.view === 'departments') return renderDepartments();
  if (state.view === 'settings') return renderSettings();
  if (state.view === 'audit') return renderAudit();
  renderPatients();
}

function toast(message) {
  const region = document.querySelector('#toast-region');
  if (!region) return;
  region.innerHTML = `<div class="toast" role="status">${escapeHtml(message)}</div>`;
  window.setTimeout(() => { if (region.isConnected) region.replaceChildren(); }, 3000);
}

async function loadPatients() {
  const payload = await api(`/api/patients?search=${encodeURIComponent(state.search)}`);
  state.patients = payload.patients;
  const searchFocused = document.activeElement && document.activeElement.id === 'patient-search';
  const cursorPosition = searchFocused ? document.activeElement.selectionStart : null;
  renderPatients();
  if (searchFocused) {
    const input = document.querySelector('#patient-search');
    input.focus();
    input.setSelectionRange(cursorPosition, cursorPosition);
  }
}

async function openPatient(id) {
  const payload = await api(`/api/patients/${encodeURIComponent(id)}`);
  state.activePatient = payload.patient;
  if (state.user.permissions.includes('patients.assign') && state.user.permissions.includes('users.manage')) {
    state.users = (await api('/api/admin/users')).users;
  }
  renderPatients();
}

async function loadPrescriptions() {
  state.prescriptions = (await api(`/api/prescriptions?search=${encodeURIComponent(state.search)}`)).prescriptions;
  renderPrescriptions();
}

async function loadAppointments() {
  state.appointments = (await api('/api/workflow/appointments')).appointments;
}

async function loadClinicalQueue() {
  state.queue = (await api('/api/workflow/queue')).visits;
}

async function loadPharmacyData() {
  const [prescriptions, medicines, alerts] = await Promise.all([
    api(`/api/prescriptions?search=${encodeURIComponent(state.search)}`),
    api('/api/pharmacy/medicines'),
    api('/api/pharmacy/alerts')
  ]);
  state.prescriptions = prescriptions.prescriptions;
  state.medicines = medicines.medicines;
  state.alerts = alerts;
}

async function loadLaboratoryQueue() {
  state.laboratoryRequests = (await api('/api/workflow/laboratory')).requests;
}

async function loadUsers() {
  state.users = (await api('/api/admin/users')).users;
  renderUsers();
}

async function loadPermissions() {
  state.permissionConfig = await api('/api/admin/permissions');
  renderPermissions();
}

async function loadDepartments() {
  state.departments = (await api('/api/admin/departments')).departments;
  renderDepartments();
}

async function loadSettings() {
  state.settings = (await api('/api/admin/settings')).settings;
  renderSettings();
}

async function loadReports() {
  const daily = (await api('/api/reports/daily')).summary;
  state.reports = { daily };
  renderReports();
}

async function loadAudit() {
  state.audit = (await api('/api/admin/audit?limit=100')).events;
  renderAudit();
}

async function loadDashboard() {
  const roleDashboards = {
    clerk: 'clerk',
    nurse: 'nursing',
    clinician: 'clinical',
    pharmacist: 'pharmacy',
    laboratory: 'laboratory',
    management: 'management',
    administrator: 'administration'
  };
  const dashboard = state.view === 'clinical' && state.user.role === 'clinician' ? 'clinical'
      : state.view === 'laboratory' ? 'laboratory'
        : roleDashboards[state.user.role];
  const { stats } = await api(`/api/dashboard/${encodeURIComponent(dashboard)}`);
  state.dashboard = stats;
  if (state.user.permissions.includes('patients.create') || state.user.permissions.includes('appointments.create')) {
    state.patients = (await api('/api/patients')).patients;
  }
  if (state.user.permissions.includes('appointments.view') || state.user.permissions.includes('appointments.relevant.view')) {
    state.appointments = (await api('/api/workflow/appointments')).appointments;
  }
  if (state.user.permissions.includes('queue.frontdesk.view')) {
    state.clerkQueue = (await api('/api/workflow/front-desk-queue')).visits;
  }
  if (state.user.permissions.includes('queue.clinical.view')) {
    state.queue = (await api('/api/workflow/queue')).visits;
  }
  if (state.user.permissions.includes('pharmacy.inventory')) await loadPharmacyData();
  if (state.user.permissions.includes('laboratory.requests.view')) await loadLaboratoryQueue();
  renderDashboard();
}

async function navigate(view) {
  const requiredPermission = view === 'clinical' && state.user.role === 'nurse'
    ? 'dashboard.nursing'
    : permissionForView(view);
  const hasViewPermission = view === 'appointments'
    ? state.user.permissions.some((permission) => ['appointments.view', 'appointments.relevant.view'].includes(permission))
    : Boolean(requiredPermission && state.user.permissions.includes(requiredPermission));
  const missingClinicalQueuePermission = view === 'clinical' && !state.user.permissions.includes('queue.clinical.view');
  if (!hasViewPermission || missingClinicalQueuePermission) {
    state.view = 'dashboard';
    state.error = 'Access denied.';
    renderDashboard();
    return;
  }
  state.view = view;
  if (view === 'registration') state.showPatientForm = true;
  if (view === 'checkin') state.showPatientForm = false;
  state.error = '';
  render();
  try {
    if (['dashboard', 'appointments', 'clinical', 'laboratory', 'vitals'].includes(view)) await loadDashboard();
    if (['patients', 'registration', 'checkin'].includes(view)) await loadPatients();
    if (view === 'pharmacy') {
      if (state.user.permissions.includes('pharmacy.inventory')) {
        await loadPharmacyData();
        renderPrescriptions();
      } else await loadPrescriptions();
    }
    if (view === 'users') await loadUsers();
    if (view === 'permissions') await loadPermissions();
    if (view === 'departments') await loadDepartments();
    if (view === 'settings') await loadSettings();
    if (view === 'reports') await loadReports();
    if (view === 'audit') await loadAudit();
  } catch (error) {
    toast(error.message);
  }
}

function formValues(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function setFormError(form, message) {
  const target = form.querySelector('.error-message');
  if (target) target.textContent = message;
}

async function handleSubmit(event) {
  const form = event.target.closest('form[data-form]');
  if (!form) return;
  event.preventDefault();
  const button = form.querySelector('button[type="submit"]');
  if (button) button.disabled = true;
  setFormError(form, '');

  try {
    const values = formValues(form);
    if (form.dataset.form === 'login') {
      const { user } = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(values) });
      state.user = user;
      if (user.mustChangePassword) {
        state.view = 'password-change';
        renderPasswordChange();
        return;
      }
      state.view = 'dashboard';
      await navigate(state.view);
    } else if (form.dataset.form === 'password-change') {
      const { user } = await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify(values) });
      state.user = user;
      state.view = 'dashboard';
      await navigate(state.view);
    } else if (form.dataset.form === 'registration') {
      const payload = await api('/api/auth/register', { method: 'POST', body: JSON.stringify(values) });
      state.authView = 'login';
      state.authNotice = payload.message;
      state.error = '';
      renderLogin();
    } else if (form.dataset.form === 'patient-create') {
      const { patient } = await api('/api/patients', { method: 'POST', body: JSON.stringify(values) });
      state.showPatientForm = false;
      state.search = '';
      await loadPatients();
      await openPatient(patient.id);
      toast('Patient record created.');
    } else if (form.dataset.form === 'patient-update') {
      const { patient } = await api(`/api/patients/${encodeURIComponent(state.activePatient.id)}`, { method: 'PATCH', body: JSON.stringify(values) });
      state.activePatient = { ...state.activePatient, ...patient };
      renderPatients();
      toast('Patient details saved.');
    } else if (form.dataset.form === 'clinical') {
      await api(`/api/patients/${encodeURIComponent(state.activePatient.id)}/clinical`, { method: 'PUT', body: JSON.stringify(values) });
      state.activePatient = { ...state.activePatient, ...values };
      renderPatients();
      toast('Clinical record saved.');
    } else if (form.dataset.form === 'assignment') {
      await api(`/api/patients/${encodeURIComponent(state.activePatient.id)}/assignments`, { method: 'POST', body: JSON.stringify(values) });
      toast('Clinician access granted.');
      form.reset();
    } else if (form.dataset.form === 'prescription' && !form.dataset.id) {
      values.patientId = state.activePatient.id;
      await api('/api/prescriptions', { method: 'POST', body: JSON.stringify(values) });
      await openPatient(state.activePatient.id);
      toast('Prescription sent to pharmacy.');
    } else if (form.dataset.form === 'user-create') {
      await api('/api/admin/users', { method: 'POST', body: JSON.stringify(values) });
      await loadUsers();
      toast('Staff account created.');
    } else if (form.dataset.form === 'role-permissions') {
      const permissions = Array.from(new FormData(form).getAll('permissions'));
      await api(`/api/admin/permissions/roles/${encodeURIComponent(form.dataset.role)}`, {
        method: 'PUT',
        body: JSON.stringify({ permissions })
      });
      await loadPermissions();
      toast('Role permissions updated.');
    } else if (form.dataset.form === 'department-create') {
      await api('/api/admin/departments', { method: 'POST', body: JSON.stringify(values) });
      await loadDepartments();
      toast('Department created.');
    } else if (form.dataset.form === 'system-setting') {
      await api(`/api/admin/settings/${encodeURIComponent(form.dataset.key)}`, {
        method: 'PUT',
        body: JSON.stringify({ value: values.value })
      });
      await loadSettings();
      toast('System setting saved.');
    } else if (form.dataset.form === 'appointment-book') {
      await api('/api/workflow/appointments', { method: 'POST', body: JSON.stringify(values) });
      state.showAppointmentForm = false;
      state.appointments = (await api('/api/workflow/appointments')).appointments;
      if (state.view === 'dashboard' || state.view === 'appointments') renderDashboard();
      toast('Appointment booked.');
    } else if (form.dataset.form === 'appointment-reschedule') {
      await api(`/api/workflow/appointments/${encodeURIComponent(form.dataset.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'reschedule', scheduledAt: values.scheduledAt })
      });
      state.appointments = (await api('/api/workflow/appointments')).appointments;
      renderDashboard();
      toast('Appointment rescheduled.');
    } else if (form.dataset.form === 'followup') {
      values.patientId = form.dataset.patient;
      await api('/api/workflow/appointments/follow-up', { method: 'POST', body: JSON.stringify(values) });
      form.reset();
      toast('Follow-up appointment requested.');
    } else if (form.dataset.form === 'triage') {
      values.sendToClinician = event.submitter && event.submitter.value === 'true';
      await api(`/api/workflow/visits/${encodeURIComponent(form.dataset.id)}/triage`, { method: 'POST', body: JSON.stringify(values) });
      state.activeTriageVisit = null;
      await loadClinicalQueue();
      if (state.view === 'dashboard') await loadDashboard();
      else renderDashboard();
      toast(values.sendToClinician ? 'Triage saved and patient sent to the clinician queue.' : 'Triage observations saved.');
    } else if (form.dataset.form === 'clinical-complete') {
      await api(`/api/visits/${encodeURIComponent(form.dataset.id)}/complete`, { method: 'PATCH', body: JSON.stringify(values) });
      await loadClinicalQueue();
      if (state.view === 'dashboard') await loadDashboard();
      else renderDashboard();
      toast('Consultation completed.');
    } else if (form.dataset.form === 'prescription' && form.dataset.id) {
      values.patientId = form.dataset.patient;
      values.consultationId = form.dataset.id;
      await api('/api/prescriptions', { method: 'POST', body: JSON.stringify(values) });
      await loadClinicalQueue();
      if (state.view === 'dashboard') await loadDashboard();
      else renderDashboard();
      toast('Prescription sent to pharmacy.');
    } else if (form.dataset.form === 'lab-request') {
      await api(`/api/workflow/visits/${encodeURIComponent(form.dataset.id)}/lab-requests`, { method: 'POST', body: JSON.stringify(values) });
      await loadClinicalQueue();
      if (state.view === 'dashboard') await loadDashboard();
      else renderDashboard();
      toast('Laboratory request sent.');
    } else if (form.dataset.form === 'dispense') {
      values.prescriptionId = form.dataset.id;
      await api('/api/pharmacy/dispense', { method: 'POST', body: JSON.stringify(values) });
      await loadPharmacyData();
      if (state.view === 'dashboard') await loadDashboard();
      else renderPrescriptions();
      toast('Dispensing recorded and stock updated.');
    } else if (form.dataset.form === 'medicine-create') {
      values.quantity = Number(values.quantity);
      values.minimumStockLevel = Number(values.minimumStockLevel);
      await api('/api/pharmacy/medicines', { method: 'POST', body: JSON.stringify(values) });
      await loadPharmacyData();
      if (state.view === 'dashboard') await loadDashboard();
      else renderPrescriptions();
      toast('Medicine added to inventory.');
    } else if (form.dataset.form === 'stock-receive') {
      values.quantity = Number(values.quantity);
      const received = await api('/api/pharmacy/stock-receive', { method: 'POST', body: JSON.stringify(values) });
      await loadPharmacyData();
      if (state.view === 'dashboard') await loadDashboard();
      else renderPrescriptions();
      toast(`${received.medicine.name}: ${received.medicine.current_quantity} ${received.medicine.unit || 'units'} in stock.`);
    } else if (form.dataset.form === 'lab-result') {
      await api(`/api/workflow/laboratory/${encodeURIComponent(form.dataset.id)}`, { method: 'PATCH', body: JSON.stringify(values) });
      await loadLaboratoryQueue();
      if (state.view === 'dashboard') await loadDashboard();
      else renderDashboard();
      toast('Laboratory result recorded and linked to the visit.');
    }
  } catch (error) {
    if (['login', 'registration', 'password-change'].includes(form.dataset.form)) state.error = error.message;
    setFormError(form, error.message);
    if (form.dataset.form === 'login' || form.dataset.form === 'registration') renderLogin();
    if (form.dataset.form === 'password-change') renderPasswordChange();
  } finally {
    if (button && button.isConnected) button.disabled = false;
  }
}

document.addEventListener('submit', handleSubmit);

document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const { action, id } = button.dataset;
  try {
    if (action === 'navigate') await navigate(button.dataset.view);
    if (action === 'open-triage') {
      if (button.dataset.id) {
        const visit = state.queue.find((entry) => entry.id === button.dataset.id);
        if (visit && visit.status === 'waiting_triage') {
          await api(`/api/workflow/visits/${encodeURIComponent(visit.id)}/triage/start`, { method: 'POST', body: JSON.stringify({}) });
        }
        state.activeTriageVisit = button.dataset.id;
        await loadClinicalQueue();
        renderDashboard();
      }
    }
    if (action === 'close-triage') {
      state.activeTriageVisit = null;
      renderDashboard();
    }
    if (action === 'toggle-password') {
      const input = document.getElementById(button.dataset.target);
      if (input) {
        const reveal = input.type === 'password';
        input.type = reveal ? 'text' : 'password';
        button.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
        button.title = reveal ? 'Hide password' : 'Show password';
      }
    }
    if (action === 'show-registration') {
      const options = await api('/api/auth/registration-options');
      state.adminRegistrationAvailable = options.administratorRegistrationAvailable === true;
      state.authView = 'register';
      state.authNotice = '';
      state.error = '';
      renderLogin();
    }
    if (action === 'show-login') { state.authView = 'login'; state.error = ''; renderLogin(); }
    if (action === 'logout') {
      await api('/api/auth/logout', { method: 'POST' });
      state.user = null;
      state.activePatient = null;
      state.error = '';
      render();
    }
    if (action === 'toggle-patient-form') { state.showPatientForm = !state.showPatientForm; renderPatients(); }
    if (action === 'cancel-patient') { state.showPatientForm = false; renderPatients(); }
    if (action === 'open-patient') await openPatient(id);
    if (action === 'close-patient') { state.activePatient = null; renderPatients(); }
    if (action === 'show-appointment-book') { state.showAppointmentForm = !state.showAppointmentForm; renderPatients(); }
    if (action === 'check-in-patient' || action === 'check-in-appointment') {
      const payload = await api('/api/workflow/check-in', {
        method: 'POST',
        body: JSON.stringify({
          patientId: button.dataset.patient,
          ...(button.dataset.appointment ? { appointmentId: button.dataset.appointment } : {})
        })
      });
      toast(`Checked in. Queue number ${payload.visit.queue_number}.`);
      if (state.user.permissions.includes('appointments.view')) {
        state.appointments = (await api('/api/workflow/appointments')).appointments;
      }
      if (state.activePatient) await openPatient(state.activePatient.id);
      if (state.view === 'dashboard') await loadDashboard();
      else renderDashboard();
    }
    if (action === 'cancel-appointment') {
      await api(`/api/workflow/appointments/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ action: 'cancel' }) });
      state.appointments = (await api('/api/workflow/appointments')).appointments;
      if (state.view === 'dashboard') await loadDashboard();
      else renderDashboard();
      toast('Appointment cancelled.');
    }
    if (action === 'start-consultation') {
      await api(`/api/visits/${encodeURIComponent(id)}/start`, { method: 'PATCH', body: JSON.stringify({}) });
      state.activeVisit = id;
      await loadClinicalQueue();
      if (state.view === 'dashboard') await loadDashboard();
      else renderDashboard();
      toast('Consultation started.');
    }
    if (action === 'open-consultation') {
      state.activeVisit = id;
      renderDashboard();
    }
    if (action === 'open-visit-patient') await openPatient(button.dataset.patient);
    if (action === 'print-patient') window.print();
    if (action === 'refresh-dashboard') await loadDashboard();
    if (action === 'new-prescription') {
      const panel = document.querySelector('.detail-panel');
      if (panel && !panel.querySelector('[data-form="prescription"]')) {
        panel.insertAdjacentHTML('beforeend', `<form class="inline-form" data-form="prescription"><h3>New prescription</h3><div class="field"><label for="medication">Medication</label><input id="medication" name="medication" maxlength="200" required></div><div class="field"><label for="dose">Dose</label><input id="dose" name="dose" maxlength="200" required></div><div class="detail-facts"><div class="field"><label for="frequency">Frequency</label><input id="frequency" name="frequency" maxlength="100"></div><div class="field"><label for="duration">Duration</label><input id="duration" name="duration" maxlength="100"></div><div class="field"><label for="quantity">Quantity</label><input id="quantity" name="quantity" type="number" min="1" required></div></div><div class="field"><label for="instructions">Instructions</label><textarea id="instructions" name="instructions" maxlength="2000"></textarea></div><button class="button" type="submit">Create prescription</button><p class="error-message" role="alert"></p></form>`);
      }
    }
    if (action === 'archive-patient' && window.confirm('Archive this patient? The record will be retained and removed from routine search.')) {
      await api(`/api/patients/${encodeURIComponent(state.activePatient.id)}/archive`, { method: 'PATCH', body: JSON.stringify({ confirm: true }) });
      state.activePatient = null;
      await loadPatients();
      toast('Patient archived.');
    }
    if (action === 'toggle-user') {
      await api(`/api/admin/users/${encodeURIComponent(id)}/status`, { method: 'PATCH', body: JSON.stringify({ isActive: button.dataset.active !== 'true' }) });
      await loadUsers();
      toast('Staff access updated.');
    }
    if (action === 'approve-user') {
      const role = document.querySelector(`#approval-role-${CSS.escape(id)}`).value;
      await api(`/api/admin/users/${encodeURIComponent(id)}/approval`, { method: 'PATCH', body: JSON.stringify({ role }) });
      await loadUsers();
      toast('Account approved and role assigned.');
    }
    if (action === 'refresh-prescriptions') {
      if (state.user.permissions.includes('pharmacy.inventory')) {
        await loadPharmacyData();
        renderPrescriptions();
      } else await loadPrescriptions();
    }
    if (action === 'refresh-audit') await loadAudit();
    if (action === 'refresh-reports') await loadReports();
    if (action === 'toggle-department') {
      await api(`/api/admin/departments/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: button.dataset.name,
          code: button.dataset.code,
          description: button.dataset.description,
          isActive: button.dataset.active !== 'true'
        })
      });
      await loadDepartments();
      toast('Department status updated.');
    }
  } catch (error) {
    toast(error.message);
  }
});

let searchTimer;
document.addEventListener('input', (event) => {
  if (!['patient-search', 'prescription-search'].includes(event.target.id)) return;
  state.search = event.target.value;
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    const load = event.target.id === 'patient-search'
      ? loadPatients()
      : state.user.permissions.includes('pharmacy.inventory') ? loadPharmacyData().then(renderPrescriptions) : loadPrescriptions();
    load.catch((error) => toast(error.message));
  }, 220);
});

document.addEventListener('change', (event) => {
  if (event.target.id === 'stock-medicine-select') {
    const fields = document.querySelector('#stock-new-medicine-fields');
    if (!fields) return;
    const isNewMedicine = event.target.value === 'new';
    fields.hidden = !isNewMedicine;
    fields.querySelectorAll('input').forEach((input) => {
      input.disabled = !isNewMedicine;
    });
    return;
  }
  if (event.target.id !== 'register-role') return;
  const isInitialAdmin = event.target.value === 'administrator';
  const password = document.querySelector('#register-password');
  const hint = document.querySelector('#register-password-hint');
  if (!password || !hint) return;
  password.minLength = isInitialAdmin ? 10 : 12;
  hint.textContent = isInitialAdmin
    ? 'Temporary password must be 10+ characters and will have to be changed before continuing.'
    : 'Use at least 12 characters.';
});

async function bootstrap() {
  try {
    const { user } = await api('/api/auth/me');
    if (!user) {
      render();
      return;
    }
    state.user = user;
    if (user.mustChangePassword) {
      state.view = 'password-change';
      renderPasswordChange();
      return;
    }
    state.view = 'dashboard';
    await navigate(state.view);
  } catch {
    render();
  }
}

bootstrap();
