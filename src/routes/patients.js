const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { cleanText, isDateOnly, isUuid } = require('../security/validation');
const { recordAudit } = require('../services/audit');
const { withTransaction } = require('../services/transaction');

const router = express.Router();
async function generateMedicalRecordNumber(client, preferredNumber) {
  const sanitizedPreferred = cleanText(preferredNumber || '', 40);
  if (sanitizedPreferred && /^[a-zA-Z0-9-]+$/.test(sanitizedPreferred)) {
    const existing = await client.query('SELECT 1 FROM patients WHERE medical_record_number = $1', [sanitizedPreferred]);
    if (!existing.rowCount) {
      return sanitizedPreferred;
    }
  }

  const configuredPrefix = await client.query(
    `SELECT setting_value FROM system_settings WHERE setting_key = 'patient_mrn_prefix'`
  );
  const prefix = configuredPrefix.rows[0] ? configuredPrefix.rows[0].setting_value : 'KGH';
  let nextNumber = 1;
  while (true) {
    const candidate = `${prefix}-${String(nextNumber).padStart(6, '0')}`;
    const existing = await client.query('SELECT 1 FROM patients WHERE medical_record_number = $1', [candidate]);
    if (!existing.rowCount) {
      return candidate;
    }
    nextNumber += 1;
  }
}

function validDemographics(body) {
  const medicalRecordNumber = cleanText(body.medicalRecordNumber || '', 40);
  const firstName = cleanText(body.firstName, 100, { required: true });
  const middleName = cleanText(body.middleName || '', 100);
  const lastName = cleanText(body.lastName, 100, { required: true });
  const gender = cleanText(body.gender || '', 20);
  const dateOfBirth = body.dateOfBirth || null;
  const age = body.age !== undefined && body.age !== null && body.age !== '' ? Number(body.age) : null;
  const phoneNumber = cleanText(body.phoneNumber || '', 30);
  const address = cleanText(body.address || '', 5000);
  const nextOfKinName = cleanText(body.nextOfKinName || '', 200);
  const nextOfKinContact = cleanText(body.nextOfKinContact || '', 100);

  if ((medicalRecordNumber !== '' && !/^[a-zA-Z0-9-]+$/.test(medicalRecordNumber)) ||
      !firstName || !lastName || !isDateOnly(dateOfBirth) ||
      (age !== null && (!Number.isInteger(age) || age < 0 || age > 150))) {
    return null;
  }

  return {
    medicalRecordNumber,
    firstName,
    middleName: middleName === null ? null : middleName,
    lastName,
    gender: gender || null,
    dateOfBirth,
    age: age === null ? null : age,
    phoneNumber: phoneNumber || null,
    address: address || null,
    nextOfKinName: nextOfKinName || null,
    nextOfKinContact: nextOfKinContact || null
  };
}

router.get('/', requireAuth, requirePermission('patients.view'), async (req, res) => {
  const search = cleanText(req.query.search || '', 80);
  if (search === null) return res.status(400).json({ error: 'Search text is too long.' });

  const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
  const patients = await withTransaction(async (client) => {
    const clinicianFilter = req.user.role === 'clinician'
      ? 'AND EXISTS (SELECT 1 FROM patient_care_team pct WHERE pct.patient_id = p.id AND pct.clinician_id = $4)'
      : req.user.role === 'nurse'
        ? `AND EXISTS (SELECT 1 FROM visits nv WHERE nv.patient_id = p.id
             AND (nv.triaged_by = $4 OR (nv.visit_date::date = CURRENT_DATE
                  AND nv.status NOT IN ('completed', 'cancelled'))))`
      : '';
    const values = [pattern, pattern, 50];
    if (['clinician', 'nurse'].includes(req.user.role)) values.push(req.user.id);

    const result = await client.query(
            `SELECT p.id, p.medical_record_number, p.first_name, p.last_name, p.date_of_birth,
              p.updated_at
       FROM patients p
       WHERE p.archived_at IS NULL
         AND ($1 = '%%' OR p.medical_record_number ILIKE $1 ESCAPE '\\'
              OR p.first_name ILIKE $2 ESCAPE '\\' OR p.last_name ILIKE $2 ESCAPE '\\')
         ${clinicianFilter}
       ORDER BY p.last_name, p.first_name
       LIMIT $3`,
      values
    );
    for (const patient of result.rows) {
      await recordAudit(client, {
        actorId: req.user.id,
        action: 'patient.record_listed',
        resourceType: 'patient',
        resourceId: patient.id
      });
    }
    return result.rows;
  });

  return res.json({ patients });
});

router.post('/', requireAuth, requirePermission('patients.create'), async (req, res) => {
  const demographics = validDemographics(req.body || {});
  if (!demographics) return res.status(400).json({ error: 'Enter a valid name and date of birth.' });

  const patient = await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('patient-mrn-generation'))");
    const medicalRecordNumber = await generateMedicalRecordNumber(client, demographics.medicalRecordNumber);
    const result = await client.query(
      `INSERT INTO patients (medical_record_number, first_name, middle_name, last_name, gender, date_of_birth, age, phone_number, address, next_of_kin_name, next_of_kin_contact, registration_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
       RETURNING id, medical_record_number, first_name, middle_name, last_name, gender, date_of_birth, age, phone_number, address, next_of_kin_name, next_of_kin_contact, registration_date, updated_at`,
      [
        medicalRecordNumber,
        demographics.firstName,
        demographics.middleName,
        demographics.lastName,
        demographics.gender,
        demographics.dateOfBirth,
        demographics.age,
        demographics.phoneNumber,
        demographics.address,
        demographics.nextOfKinName,
        demographics.nextOfKinContact
      ]
    );
    await recordAudit(client, {
      actorId: req.user.id,
      action: 'patient.created',
      resourceType: 'patient',
      resourceId: result.rows[0].id,
      module: 'patient',
      description: 'Patient registered in EMR.'
    });
    return result.rows[0];
  });

  return res.status(201).json({ patient });
});

router.post('/:id/assignments', requireAuth, requirePermission('patients.assign'), async (req, res) => {
  const clinicianId = req.body && req.body.clinicianId;
  if (!isUuid(req.params.id) || !isUuid(clinicianId)) {
    return res.status(400).json({ error: 'Invalid patient or clinician identifier.' });
  }

  const assigned = await withTransaction(async (client) => {
    const patient = await client.query('SELECT id FROM patients WHERE id = $1 AND archived_at IS NULL', [req.params.id]);
    const clinician = await client.query("SELECT id FROM users WHERE id = $1 AND role = 'clinician' AND is_active = TRUE", [clinicianId]);
    if (!patient.rowCount || !clinician.rowCount) return false;

    await client.query(
      `INSERT INTO patient_care_team (patient_id, clinician_id, assigned_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (patient_id, clinician_id) DO NOTHING`,
      [req.params.id, clinicianId, req.user.id]
    );
    await recordAudit(client, {
      actorId: req.user.id,
      action: 'patient.clinician_assigned',
      resourceType: 'patient',
      resourceId: req.params.id,
      module: 'patient',
      description: 'Clinician assigned to patient care team.'
    });
    return true;
  });

  if (!assigned) return res.status(404).json({ error: 'Patient or active clinician not found.' });
  return res.status(204).end();
});

router.patch('/:id', requireAuth, requirePermission('patients.edit'), async (req, res) => {
  const demographics = validDemographics(req.body || {});
  if (!isUuid(req.params.id) || !demographics) {
    return res.status(400).json({ error: 'Enter a valid record number, name, and date of birth.' });
  }

  const patient = await withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE patients
       SET medical_record_number = $1, first_name = $2, middle_name = $3, last_name = $4,
           gender = $5, date_of_birth = $6, age = $7, phone_number = $8, address = $9,
           next_of_kin_name = $10, next_of_kin_contact = $11, updated_at = NOW()
       WHERE id = $12 AND archived_at IS NULL
       RETURNING id, medical_record_number, first_name, middle_name, last_name, gender, date_of_birth, age, phone_number, address, next_of_kin_name, next_of_kin_contact, updated_at`,
      [
        demographics.medicalRecordNumber,
        demographics.firstName,
        demographics.middleName,
        demographics.lastName,
        demographics.gender,
        demographics.dateOfBirth,
        demographics.age,
        demographics.phoneNumber,
        demographics.address,
        demographics.nextOfKinName,
        demographics.nextOfKinContact,
        req.params.id
      ]
    );
    if (!result.rowCount) return null;
    await recordAudit(client, {
      actorId: req.user.id,
      action: 'patient.demographics_updated',
      resourceType: 'patient',
      resourceId: req.params.id,
      module: 'patient',
      description: 'Patient demographics updated.'
    });
    return result.rows[0];
  });

  if (!patient) return res.status(404).json({ error: 'Patient not found.' });
  return res.json({ patient });
});

router.patch('/:id/archive', requireAuth, requirePermission('patients.archive'), async (req, res) => {
  if (!isUuid(req.params.id) || req.body && req.body.confirm !== true) {
    return res.status(400).json({ error: 'Explicit archive confirmation is required.' });
  }

  const archived = await withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE patients SET archived_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND archived_at IS NULL RETURNING id`,
      [req.params.id]
    );
    if (!result.rowCount) return false;
    await recordAudit(client, {
      actorId: req.user.id,
      action: 'patient.archived',
      resourceType: 'patient',
      resourceId: req.params.id,
      module: 'patient',
      description: 'Patient record archived and hidden from routine searches.'
    });
    return true;
  });

  if (!archived) return res.status(404).json({ error: 'Patient not found.' });
  return res.status(204).end();
});

router.get('/:id', requireAuth, requirePermission('patients.view'), async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid patient identifier.' });

  const includeClinical = ['clinician', 'nurse'].includes(req.user.role);
  const patient = await withTransaction(async (client) => {
    const columns = includeClinical
      ? 'id, medical_record_number, first_name, middle_name, last_name, gender, date_of_birth, age, phone_number, address, next_of_kin_name, next_of_kin_contact, diagnoses, treatment_notes, allergies, registration_date, created_at, updated_at'
      : 'id, medical_record_number, first_name, middle_name, last_name, gender, date_of_birth, age, phone_number, address, next_of_kin_name, next_of_kin_contact, registration_date, created_at, updated_at';
    const assignmentFilter = req.user.role === 'clinician'
      ? 'AND EXISTS (SELECT 1 FROM patient_care_team pct WHERE pct.patient_id = patients.id AND pct.clinician_id = $2)'
      : req.user.role === 'nurse'
        ? `AND EXISTS (SELECT 1 FROM visits nv WHERE nv.patient_id = patients.id
             AND (nv.triaged_by = $2 OR (nv.visit_date::date = CURRENT_DATE
                  AND nv.status NOT IN ('completed', 'cancelled'))))`
      : '';
    const values = ['clinician', 'nurse'].includes(req.user.role) ? [req.params.id, req.user.id] : [req.params.id];
    const result = await client.query(
      `SELECT ${columns} FROM patients WHERE id = $1 AND archived_at IS NULL ${assignmentFilter}`,
      values
    );

    if (!result.rows[0]) return null;

    const visits = await client.query(
      includeClinical
        ? `SELECT * FROM visits WHERE patient_id = $1 ORDER BY visit_date DESC, created_at DESC LIMIT 50`
        : `SELECT id, visit_date, status, queue_number FROM visits WHERE patient_id = $1 ORDER BY visit_date DESC, created_at DESC LIMIT 50`,
      [req.params.id]
    );
    const prescriptions = includeClinical
      ? await client.query(
        `SELECT id, consultation_id, medication, dose, frequency, duration, quantity, instructions, status, prescription_date
         FROM prescriptions WHERE patient_id = $1 ORDER BY prescription_date DESC, created_at DESC LIMIT 50`,
        [req.params.id])
      : { rows: [] };
    const labRequests = includeClinical
      ? await client.query(
        `SELECT id, visit_id, test_name, clinical_notes, result, status, requested_at, completed_at
         FROM lab_requests WHERE patient_id = $1 ORDER BY requested_at DESC LIMIT 50`,
        [req.params.id])
      : { rows: [] };

    await recordAudit(client, {
      actorId: req.user.id,
      action: 'patient.record_viewed',
      resourceType: 'patient',
      resourceId: req.params.id,
      module: 'patient',
      description: 'Patient record accessed.'
    });

    return { ...result.rows[0], visits: visits.rows, prescriptions: prescriptions.rows, labRequests: labRequests.rows };
  });

  if (!patient) return res.status(404).json({ error: 'Patient not found.' });
  return res.json({ patient });
});

router.put('/:id/clinical', requireAuth, requirePermission('diagnosis.create'), async (req, res) => {
  const diagnoses = cleanText(req.body && req.body.diagnoses || '', 12000);
  const treatmentNotes = cleanText(req.body && req.body.treatmentNotes || '', 20000);
  const allergies = cleanText(req.body && req.body.allergies || '', 5000);
  if (!isUuid(req.params.id) || diagnoses === null || treatmentNotes === null || allergies === null) {
    return res.status(400).json({ error: 'Invalid clinical record.' });
  }

  const saved = await withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE patients p SET diagnoses = $1, treatment_notes = $2, allergies = $3, updated_at = NOW()
       WHERE p.id = $4 AND p.archived_at IS NULL
         AND EXISTS (SELECT 1 FROM patient_care_team pct WHERE pct.patient_id = p.id AND pct.clinician_id = $5)
       RETURNING p.id`,
      [diagnoses, treatmentNotes, allergies, req.params.id, req.user.id]
    );
    if (!result.rowCount) return false;
    await recordAudit(client, {
      actorId: req.user.id,
      action: 'patient.clinical_record_updated',
      resourceType: 'patient',
      resourceId: req.params.id,
      module: 'patient',
      description: 'Clinical diagnosis and treatment record updated.'
    });
    return true;
  });

  if (!saved) return res.status(404).json({ error: 'Patient not found.' });
  return res.status(204).end();
});

module.exports = router;
