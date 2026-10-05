const root = document.querySelector('#root');
const state = {
  user: null,
  view: 'patients',
  patients: [],
  prescriptions: [],
  users: [],
  audit: [],
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
  pharmacist: 'Pharmacist',
  clerk: 'Clerk',
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
  return ['clinician', 'clerk', 'administrator'].includes(state.user.role);
}

function navItems() {
  const items = [];
  if (roleCanSeePatients()) items.push(['patients', 'P', 'Patients']);
  if (['clinician', 'pharmacist'].includes(state.user.role)) items.push(['pharmacy', 'Rx', 'Prescriptions']);
  if (state.user.role === 'administrator') {
    items.push(['users', 'U', 'Staff access'], ['audit', 'A', 'Audit trail']);
  }
  return items;
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
            <div class="form-group"><label for="register-role">Requested role</label><div class="input-wrapper"><select class="form-input" id="register-role" name="requestedRole" required><option value="">Choose a role</option><option value="clerk">Clerk</option><option value="clinician">Clinician</option><option value="pharmacist">Pharmacist</option>${state.adminRegistrationAvailable ? '<option value="administrator">Administrator (one-time setup)</option>' : ''}</select></div></div>
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
  return `<form class="inline-form" data-form="patient-create">
    <h3>Register patient</h3>
    <div class="detail-facts">
      <div class="field"><label for="new-mrn">Medical record number</label><input id="new-mrn" name="medicalRecordNumber" maxlength="40" required></div>
      <div class="field"><label for="new-dob">Date of birth</label><input id="new-dob" name="dateOfBirth" type="date"></div>
      <div class="field"><label for="new-first">First name</label><input id="new-first" name="firstName" maxlength="100" required></div>
      <div class="field"><label for="new-last">Last name</label><input id="new-last" name="lastName" maxlength="100" required></div>
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
  </div>`;
  let controls = '';

  if (state.user.role === 'clinician') {
    controls = `<form class="inline-form" data-form="clinical">
      <h3>Clinical record</h3>
      <div class="field"><label for="diagnoses">Diagnoses</label><textarea id="diagnoses" name="diagnoses" maxlength="12000">${escapeHtml(patient.diagnoses)}</textarea></div>
      <div class="field"><label for="treatment-notes">Treatment notes</label><textarea id="treatment-notes" name="treatmentNotes" maxlength="20000">${escapeHtml(patient.treatment_notes)}</textarea></div>
      <button class="button" type="submit">Save clinical record</button><p class="error-message" role="alert"></p>
    </form>
    <div class="inline-form"><h3>Prescription</h3><button class="button secondary" type="button" data-action="new-prescription">Write prescription</button></div>`;
  }

  if (['clerk', 'administrator'].includes(state.user.role)) {
    controls = `<form class="inline-form" data-form="patient-update">
      <h3>Patient details</h3>
      <div class="field"><label for="edit-mrn">Medical record number</label><input id="edit-mrn" name="medicalRecordNumber" value="${escapeHtml(patient.medical_record_number)}" maxlength="40" required></div>
      <div class="detail-facts">
        <div class="field"><label for="edit-first">First name</label><input id="edit-first" name="firstName" value="${escapeHtml(patient.first_name)}" maxlength="100" required></div>
        <div class="field"><label for="edit-last">Last name</label><input id="edit-last" name="lastName" value="${escapeHtml(patient.last_name)}" maxlength="100" required></div>
      </div>
      <div class="field"><label for="edit-dob">Date of birth</label><input id="edit-dob" name="dateOfBirth" type="date" value="${escapeHtml(String(patient.date_of_birth || '').slice(0, 10))}"></div>
      <button class="button" type="submit">Save patient details</button><p class="error-message" role="alert"></p>
    </form>`;
  }

  if (state.user.role === 'administrator') {
    const clinicians = state.users.filter((user) => user.role === 'clinician' && user.is_active);
    controls += `<form class="inline-form" data-form="assignment">
      <h3>Care team access</h3>
      <div class="field"><label for="assigned-clinician">Assign clinician</label><select id="assigned-clinician" name="clinicianId" required>
        <option value="">Choose a clinician</option>${clinicians.map((user) => `<option value="${escapeHtml(user.id)}">${escapeHtml(user.username)}</option>`).join('')}
      </select></div><button class="button secondary" type="submit">Grant patient access</button><p class="error-message" role="alert"></p>
    </form>
    <div class="inline-form"><h3>Record lifecycle</h3><p class="notice">Archiving removes the patient from routine search without permanently deleting the record.</p><button class="button danger" data-action="archive-patient" type="button">Archive patient</button></div>`;
  }

  return `<article class="detail-panel">
    <div class="detail-title"><div><h2>${escapeHtml(patient.first_name)} ${escapeHtml(patient.last_name)}</h2><p>Patient record</p></div><button class="button secondary small" data-action="close-patient" type="button">Close</button></div>
    <div class="detail-body">${demographics}${controls}</div>
  </article>`;
}

function renderPatients() {
  const canRegister = ['clerk', 'administrator'].includes(state.user.role);
  const content = `<div class="page-heading">
      <div><p class="eyebrow">Patient records</p><h1>Patients</h1><p>Find and manage records within your role.</p></div>
      ${canRegister ? '<button class="button" data-action="toggle-patient-form" type="button">Register patient</button>' : ''}
    </div>
    <div class="content-grid">
      <section class="section-block">
        <div class="section-head"><h2>Patient list</h2><span>${state.patients.length} shown</span></div>
        <div class="toolbar search-toolbar"><label class="search-box"><input id="patient-search" type="search" value="${escapeHtml(state.search)}" placeholder="Search name or record number" aria-label="Search patients"></label></div>
        <div class="table-wrap"><table><thead><tr><th>Patient</th><th>Record no.</th><th>Date of birth</th><th>Updated</th></tr></thead><tbody>${renderPatientRows()}</tbody></table></div>
        ${state.showPatientForm ? renderPatientForm() : ''}
      </section>
      ${renderPatientDetail()}
    </div>`;
  renderShell(content);
}

function renderPrescriptions() {
  const rows = state.prescriptions.length ? state.prescriptions.map((prescription) => `<tr>
    <td><strong>${escapeHtml(prescription.medication)}</strong><br><span>${escapeHtml(prescription.dose)}</span></td>
    <td>${escapeHtml(prescription.last_name)}, ${escapeHtml(prescription.first_name)}<br><span>${escapeHtml(prescription.medical_record_number)}</span></td>
    <td>${escapeHtml(prescription.instructions || 'No additional instructions')}</td>
    <td><span class="badge ${prescription.status === 'dispensed' ? 'dispensed' : ''}">${escapeHtml(prescription.status)}</span></td>
    <td>${state.user.role === 'pharmacist' && prescription.status === 'active' ? `<button class="button small" data-action="dispense" data-id="${escapeHtml(prescription.id)}">Mark dispensed</button>` : ''}</td>
  </tr>`).join('') : '<tr><td colspan="5" class="empty-state">No prescriptions are available.</td></tr>';
  renderShell(`<div class="page-heading"><div><p class="eyebrow">Medication workflow</p><h1>Prescriptions</h1><p>${state.user.role === 'pharmacist' ? 'Review and dispense active prescriptions.' : 'Review prescriptions for patients in your care.'}</p></div><button class="button secondary" data-action="refresh-prescriptions">Refresh</button></div>
    <section class="section-block"><div class="section-head"><h2>${state.user.role === 'pharmacist' ? 'Dispensing queue' : 'Recent prescriptions'}</h2><span>${state.prescriptions.length} shown</span></div>
    <div class="table-wrap"><table><thead><tr><th>Medication</th><th>Patient</th><th>Instructions</th><th>Status</th><th>Action</th></tr></thead><tbody>${rows}</tbody></table></div></section>`);
}

function renderUsers() {
  const rows = state.users.map((user) => {
    const isPending = user.approval_status === 'pending';
    const status = isPending ? 'Pending approval' : user.is_active ? 'Active' : 'Inactive';
    const action = isPending
      ? `<div class="approval-controls"><select id="approval-role-${escapeHtml(user.id)}" aria-label="Assign role to ${escapeHtml(user.username)}">${['clerk', 'clinician', 'pharmacist', 'administrator'].map((role) => `<option value="${role}" ${role === user.requested_role ? 'selected' : ''}>${escapeHtml(roleNames[role])}</option>`).join('')}</select><button class="button small" data-action="approve-user" data-id="${escapeHtml(user.id)}">Approve</button></div>`
      : user.id === state.user.id ? 'Current account' : `<button class="button secondary small" data-action="toggle-user" data-id="${escapeHtml(user.id)}" data-active="${user.is_active}">${user.is_active ? 'Deactivate' : 'Activate'}</button>`;
    return `<tr><td><strong>${escapeHtml(user.username)}</strong></td><td>${escapeHtml(roleNames[user.role])}${isPending && user.requested_role ? `<br><span class="requested-role">Requested ${escapeHtml(roleNames[user.requested_role])}</span>` : ''}</td><td><span class="badge ${user.is_active ? '' : 'dispensed'}">${status}</span></td><td>${escapeHtml(formatDate(user.created_at))}</td><td>${action}</td></tr>`;
  }).join('');
  renderShell(`<div class="page-heading"><div><p class="eyebrow">Access management</p><h1>Staff access</h1><p>Create accounts with the minimum role they need.</p></div></div>
    <section class="section-block"><div class="section-head"><h2>Add staff account</h2><span>Passwords are hashed before storage</span></div>
      <form class="staff-form" data-form="user-create"><div class="field"><label for="staff-username">Username</label><input id="staff-username" name="username" maxlength="80" required autocomplete="off"></div>
      <div class="field"><label for="staff-role">Role</label><select id="staff-role" name="role"><option value="clerk">Clerk</option><option value="clinician">Clinician</option><option value="pharmacist">Pharmacist</option><option value="administrator">Administrator</option></select></div>
      <div class="field"><label for="staff-password">Temporary password</label><input id="staff-password" name="password" type="password" minlength="12" maxlength="128" required autocomplete="new-password"></div>
      <button class="button" type="submit">Create account</button><p class="error-message" role="alert"></p></form>
    </section>
    <section class="section-block spaced-section"><div class="section-head"><h2>Staff accounts and requests</h2><span>${state.users.length} shown</span></div><div class="table-wrap"><table><thead><tr><th>Username</th><th>Role</th><th>Status</th><th>Created</th><th>Action</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="empty-state">No staff accounts found.</td></tr>'}</tbody></table></div></section>`);
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
  if (state.view === 'pharmacy') return renderPrescriptions();
  if (state.view === 'users') return renderUsers();
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
  if (state.user.role === 'administrator') {
    state.users = (await api('/api/admin/users')).users;
  }
  renderPatients();
}

async function loadPrescriptions() {
  state.prescriptions = (await api('/api/prescriptions')).prescriptions;
  renderPrescriptions();
}

async function loadUsers() {
  state.users = (await api('/api/admin/users')).users;
  renderUsers();
}

async function loadAudit() {
  state.audit = (await api('/api/admin/audit?limit=100')).events;
  renderAudit();
}

async function navigate(view) {
  state.view = view;
  state.error = '';
  render();
  try {
    if (view === 'patients') await loadPatients();
    if (view === 'pharmacy') await loadPrescriptions();
    if (view === 'users') await loadUsers();
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
      state.view = user.role === 'pharmacist' ? 'pharmacy' : user.role === 'administrator' ? 'users' : 'patients';
      await navigate(state.view);
    } else if (form.dataset.form === 'password-change') {
      const { user } = await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify(values) });
      state.user = user;
      state.view = user.role === 'pharmacist' ? 'pharmacy' : user.role === 'administrator' ? 'users' : 'patients';
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
    } else if (form.dataset.form === 'prescription') {
      values.patientId = state.activePatient.id;
      await api('/api/prescriptions', { method: 'POST', body: JSON.stringify(values) });
      toast('Prescription created.');
      await navigate('pharmacy');
    } else if (form.dataset.form === 'user-create') {
      await api('/api/admin/users', { method: 'POST', body: JSON.stringify(values) });
      await loadUsers();
      toast('Staff account created.');
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
    if (action === 'new-prescription') {
      const panel = document.querySelector('.detail-panel');
      if (panel && !panel.querySelector('[data-form="prescription"]')) {
        panel.insertAdjacentHTML('beforeend', `<form class="inline-form" data-form="prescription"><h3>New prescription</h3><div class="field"><label for="medication">Medication</label><input id="medication" name="medication" maxlength="200" required></div><div class="field"><label for="dose">Dose</label><input id="dose" name="dose" maxlength="200" required></div><div class="field"><label for="instructions">Instructions</label><textarea id="instructions" name="instructions" maxlength="2000"></textarea></div><button class="button" type="submit">Create prescription</button><p class="error-message" role="alert"></p></form>`);
      }
    }
    if (action === 'archive-patient' && window.confirm('Archive this patient? The record will be retained and removed from routine search.')) {
      await api(`/api/patients/${encodeURIComponent(state.activePatient.id)}/archive`, { method: 'PATCH', body: JSON.stringify({ confirm: true }) });
      state.activePatient = null;
      await loadPatients();
      toast('Patient archived.');
    }
    if (action === 'dispense') {
      await api(`/api/prescriptions/${encodeURIComponent(id)}/dispense`, { method: 'PATCH', body: JSON.stringify({}) });
      await loadPrescriptions();
      toast('Prescription marked dispensed.');
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
    if (action === 'refresh-prescriptions') await loadPrescriptions();
    if (action === 'refresh-audit') await loadAudit();
  } catch (error) {
    toast(error.message);
  }
});

let searchTimer;
document.addEventListener('input', (event) => {
  if (event.target.id !== 'patient-search') return;
  state.search = event.target.value;
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => loadPatients().catch((error) => toast(error.message)), 220);
});

document.addEventListener('change', (event) => {
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
    state.view = user.role === 'pharmacist' ? 'pharmacy' : user.role === 'administrator' ? 'users' : 'patients';
    await navigate(state.view);
  } catch {
    render();
  }
}

bootstrap();
