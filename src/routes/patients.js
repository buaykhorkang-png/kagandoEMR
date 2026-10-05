const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { cleanText, isDateOnly, isUuid } = require('../security/validation');
const { recordAudit } = require('../services/audit');
const { withTransaction } = require('../services/transaction');

const router = express.Router();
const demographicsRoles = ['clerk', 'administrator'];
const patientReaderRoles = ['clinician', ...demographicsRoles];

function validDemographics(body) {
  const medicalRecordNumber = cleanText(body.medicalRecordNumber, 40, { required: true });
  const firstName = cleanText(body.firstName, 100, { required: true });
  const lastName = cleanText(body.lastName, 100, { required: true });
  const dateOfBirth = body.dateOfBirth || null;

  if (!medicalRecordNumber || !/^[a-zA-Z0-9-]+$/.test(medicalRecordNumber) ||
      !firstName || !lastName || !isDateOnly(dateOfBirth)) {
    return null;
  }

  return { medicalRecordNumber, firstName, lastName, dateOfBirth };
}

router.get('/', requireAuth, requireRole(...patientReaderRoles), async (req, res) => {
  const search = cleanText(req.query.search || '', 80);
  if (search === null) return res.status(400).json({ error: 'Search text is too long.' });

  const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
  const patients = await withTransaction(async (client) => {
    const clinicianFilter = req.user.role === 'clinician'
      ? 'AND EXISTS (SELECT 1 FROM patient_care_team pct WHERE pct.patient_id = p.id AND pct.clinician_id = $4)'
      : '';
    const values = [pattern, pattern, 50];
    if (req.user.role === 'clinician') values.push(req.user.id);

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

router.post('/', requireAuth, requireRole(...demographicsRoles), async (req, res) => {
  const demographics = validDemographics(req.body || {});
  if (!demographics) return res.status(400).json({ error: 'Enter a valid record number, name, and date of birth.' });

  const patient = await withTransaction(async (client) => {
    const result = await client.query(
      `INSERT INTO patients (medical_record_number, first_name, last_name, date_of_birth)
       VALUES ($1, $2, $3, $4)
       RETURNING id, medical_record_number, first_name, last_name, date_of_birth, updated_at`,
      [demographics.medicalRecordNumber, demographics.firstName, demographics.lastName, demographics.dateOfBirth]
    );
    await recordAudit(client, {
      actorId: req.user.id,
      action: 'patient.created',
      resourceType: 'patient',
      resourceId: result.rows[0].id
    });
    return result.rows[0];
  });

  return res.status(201).json({ patient });
});

router.post('/:id/assignments', requireAuth, requireRole('administrator'), async (req, res) => {
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
      resourceId: req.params.id
    });
    return true;
  });

  if (!assigned) return res.status(404).json({ error: 'Patient or active clinician not found.' });
  return res.status(204).end();
});

router.patch('/:id', requireAuth, requireRole(...demographicsRoles), async (req, res) => {
  const demographics = validDemographics(req.body || {});
  if (!isUuid(req.params.id) || !demographics) {
    return res.status(400).json({ error: 'Enter a valid record number, name, and date of birth.' });
  }

  const patient = await withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE patients
       SET medical_record_number = $1, first_name = $2, last_name = $3,
           date_of_birth = $4, updated_at = NOW()
       WHERE id = $5 AND archived_at IS NULL
       RETURNING id, medical_record_number, first_name, last_name, date_of_birth, updated_at`,
      [demographics.medicalRecordNumber, demographics.firstName, demographics.lastName, demographics.dateOfBirth, req.params.id]
    );
    if (!result.rowCount) return null;
    await recordAudit(client, {
      actorId: req.user.id,
      action: 'patient.demographics_updated',
      resourceType: 'patient',
      resourceId: req.params.id
    });
    return result.rows[0];
  });

  if (!patient) return res.status(404).json({ error: 'Patient not found.' });
  return res.json({ patient });
});

router.patch('/:id/archive', requireAuth, requireRole('administrator'), async (req, res) => {
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
      resourceId: req.params.id
    });
    return true;
  });

  if (!archived) return res.status(404).json({ error: 'Patient not found.' });
  return res.status(204).end();
});

router.get('/:id', requireAuth, requireRole(...patientReaderRoles), async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid patient identifier.' });

  const includeClinical = req.user.role === 'clinician';
  const patient = await withTransaction(async (client) => {
    const columns = includeClinical
      ? 'id, medical_record_number, first_name, last_name, date_of_birth, diagnoses, treatment_notes'
      : 'id, medical_record_number, first_name, last_name, date_of_birth';
    const assignmentFilter = includeClinical
      ? 'AND EXISTS (SELECT 1 FROM patient_care_team pct WHERE pct.patient_id = patients.id AND pct.clinician_id = $2)'
      : '';
    const values = includeClinical ? [req.params.id, req.user.id] : [req.params.id];
    const result = await client.query(
      `SELECT ${columns} FROM patients WHERE id = $1 AND archived_at IS NULL ${assignmentFilter}`,
      values
    );
    if (result.rows[0]) {
      await recordAudit(client, {
        actorId: req.user.id,
        action: 'patient.record_viewed',
        resourceType: 'patient',
        resourceId: req.params.id
      });
    }
    return result.rows[0];
  });

  if (!patient) return res.status(404).json({ error: 'Patient not found.' });
  return res.json({ patient });
});

router.put('/:id/clinical', requireAuth, requireRole('clinician'), async (req, res) => {
  const diagnoses = cleanText(req.body && req.body.diagnoses || '', 12000);
  const treatmentNotes = cleanText(req.body && req.body.treatmentNotes || '', 20000);
  if (!isUuid(req.params.id) || diagnoses === null || treatmentNotes === null) {
    return res.status(400).json({ error: 'Invalid clinical record.' });
  }

  const saved = await withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE patients p SET diagnoses = $1, treatment_notes = $2, updated_at = NOW()
       WHERE p.id = $3 AND p.archived_at IS NULL
         AND EXISTS (SELECT 1 FROM patient_care_team pct WHERE pct.patient_id = p.id AND pct.clinician_id = $4)
       RETURNING p.id`,
      [diagnoses, treatmentNotes, req.params.id, req.user.id]
    );
    if (!result.rowCount) return false;
    await recordAudit(client, {
      actorId: req.user.id,
      action: 'patient.clinical_record_updated',
      resourceType: 'patient',
      resourceId: req.params.id
    });
    return true;
  });

  if (!saved) return res.status(404).json({ error: 'Patient not found.' });
  return res.status(204).end();
});

module.exports = router;
