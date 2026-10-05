const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { cleanText, isUuid } = require('../security/validation');
const { recordAudit } = require('../services/audit');
const { withTransaction } = require('../services/transaction');

const router = express.Router();

router.get('/', requireAuth, requireRole('clinician', 'pharmacist'), async (req, res) => {
  const prescriptions = await withTransaction(async (client) => {
    const clinicianFilter = req.user.role === 'clinician'
      ? "AND EXISTS (SELECT 1 FROM patient_care_team pct WHERE pct.patient_id = rx.patient_id AND pct.clinician_id = $1)"
      : '';
    const values = req.user.role === 'clinician' ? [req.user.id] : [];
    const result = await client.query(
      `SELECT rx.id, rx.patient_id, p.medical_record_number, p.first_name, p.last_name,
              rx.medication, rx.dose, rx.instructions, rx.status, rx.created_at
       FROM prescriptions AS rx
       JOIN patients AS p ON p.id = rx.patient_id
       WHERE p.archived_at IS NULL ${clinicianFilter}
       ORDER BY rx.created_at DESC
       LIMIT 100`,
      values
    );
    for (const prescription of result.rows) {
      await recordAudit(client, {
        actorId: req.user.id,
        action: 'prescription.record_listed',
        resourceType: 'prescription',
        resourceId: prescription.id
      });
    }
    return result.rows;
  });

  return res.json({ prescriptions });
});

router.post('/', requireAuth, requireRole('clinician'), async (req, res) => {
  const patientId = req.body && req.body.patientId;
  const medication = cleanText(req.body && req.body.medication, 200, { required: true });
  const dose = cleanText(req.body && req.body.dose, 200, { required: true });
  const instructions = cleanText(req.body && req.body.instructions || '', 2000);
  if (!isUuid(patientId) || !medication || !dose || instructions === null) {
    return res.status(400).json({ error: 'Enter a valid patient, medication, dose, and instructions.' });
  }

  const prescription = await withTransaction(async (client) => {
    const result = await client.query(
      `INSERT INTO prescriptions (patient_id, medication, dose, instructions)
       SELECT p.id, $2, $3, $4
       FROM patients p
       WHERE p.id = $1 AND p.archived_at IS NULL
         AND EXISTS (SELECT 1 FROM patient_care_team pct WHERE pct.patient_id = p.id AND pct.clinician_id = $5)
       RETURNING id, patient_id, medication, dose, instructions, status, created_at`,
      [patientId, medication, dose, instructions, req.user.id]
    );
    if (!result.rowCount) return null;
    await recordAudit(client, {
      actorId: req.user.id,
      action: 'prescription.created',
      resourceType: 'prescription',
      resourceId: result.rows[0].id
    });
    return result.rows[0];
  });

  if (!prescription) return res.status(404).json({ error: 'Assigned patient not found.' });
  return res.status(201).json({ prescription });
});

router.patch('/:id/dispense', requireAuth, requireRole('pharmacist'), async (req, res) => {
  if (!isUuid(req.params.id)) {
    return res.status(400).json({ error: 'Invalid prescription identifier.' });
  }

  const prescription = await withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE prescriptions rx SET status = 'dispensed'
       FROM patients p
       WHERE rx.id = $1 AND rx.patient_id = p.id AND p.archived_at IS NULL AND rx.status = 'active'
       RETURNING rx.id, rx.patient_id, rx.medication, rx.dose, rx.status`,
      [req.params.id]
    );
    if (!result.rowCount) return null;
    await recordAudit(client, {
      actorId: req.user.id,
      action: 'prescription.dispensed',
      resourceType: 'prescription',
      resourceId: req.params.id
    });
    return result.rows[0];
  });

  if (!prescription) return res.status(404).json({ error: 'Active prescription not found.' });
  return res.json({ prescription });
});

router.get('/:id', requireAuth, requireRole('clinician', 'pharmacist'), async (req, res) => {
  if (!isUuid(req.params.id)) {
    return res.status(400).json({ error: 'Invalid prescription identifier.' });
  }

  const prescription = await withTransaction(async (client) => {
    const clinicianFilter = req.user.role === 'clinician'
      ? 'AND EXISTS (SELECT 1 FROM patient_care_team pct WHERE pct.patient_id = p.id AND pct.clinician_id = $2)'
      : '';
    const values = req.user.role === 'clinician' ? [req.params.id, req.user.id] : [req.params.id];
    const result = await client.query(
      `SELECT rx.id, rx.patient_id, p.medical_record_number, p.first_name, p.last_name,
              rx.medication, rx.dose, rx.instructions, rx.status, rx.created_at
       FROM prescriptions AS rx
       JOIN patients AS p ON p.id = rx.patient_id
       WHERE rx.id = $1 AND p.archived_at IS NULL ${clinicianFilter}`,
      values
    );

    if (result.rows[0]) {
      await recordAudit(client, {
        actorId: req.user.id,
        action: 'prescription.record_viewed',
        resourceType: 'prescription',
        resourceId: req.params.id
      });
    }

    return result.rows[0];
  });

  if (!prescription) return res.status(404).json({ error: 'Prescription not found.' });
  return res.json({ prescription });
});

module.exports = router;
