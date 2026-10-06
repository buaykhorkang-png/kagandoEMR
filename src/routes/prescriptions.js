const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { cleanText, isUuid } = require('../security/validation');
const { recordAudit } = require('../services/audit');
const { withTransaction } = require('../services/transaction');

const router = express.Router();

router.get('/', requireAuth, requirePermission('prescriptions.view'), async (req, res) => {
  const search = cleanText(req.query.search || '', 80);
  if (search === null) return res.status(400).json({ error: 'Search text is too long.' });
  const prescriptions = await withTransaction(async (client) => {
    const clinicianFilter = req.user.role === 'clinician'
      ? "AND EXISTS (SELECT 1 FROM patient_care_team pct WHERE pct.patient_id = rx.patient_id AND pct.clinician_id = $1)"
      : '';
    const values = req.user.role === 'clinician' ? [req.user.id, `%${search}%`] : [`%${search}%`];
    const searchParameter = req.user.role === 'clinician' ? '$2' : '$1';
    const result = await client.query(
      `SELECT rx.id, rx.patient_id, p.medical_record_number, p.first_name, p.last_name,
              rx.medication, rx.dose, rx.frequency, rx.duration, rx.quantity, rx.instructions,
              rx.status, rx.created_at, rx.consultation_id,
              COALESCE((SELECT SUM(d.dispensed_quantity) FROM dispensing d
                        WHERE d.prescription_id = rx.id AND d.status <> 'cancelled'), 0)::int AS dispensed_quantity
       FROM prescriptions AS rx
       JOIN patients AS p ON p.id = rx.patient_id
       WHERE p.archived_at IS NULL ${clinicianFilter}
         AND ($${req.user.role === 'clinician' ? '2' : '1'} = '%%'
              OR p.medical_record_number ILIKE ${searchParameter}
              OR p.first_name ILIKE ${searchParameter} OR p.last_name ILIKE ${searchParameter})
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

router.post('/', requireAuth, requirePermission('prescriptions.create'), async (req, res) => {
  const patientId = req.body && req.body.patientId;
  const consultationId = req.body && req.body.consultationId;
  const medication = cleanText(req.body && req.body.medication, 200, { required: true });
  const dose = cleanText(req.body && req.body.dose, 200, { required: true });
  const frequency = cleanText(req.body && req.body.frequency || '', 100);
  const duration = cleanText(req.body && req.body.duration || '', 100);
  const quantity = req.body && req.body.quantity !== undefined && req.body.quantity !== null && req.body.quantity !== '' ? Number(req.body.quantity) : null;
  const instructions = cleanText(req.body && req.body.instructions || '', 2000);
  if (!isUuid(patientId) || (consultationId && !isUuid(consultationId)) || !medication || !dose || instructions === null || !Number.isInteger(quantity) || quantity < 1) {
    return res.status(400).json({ error: 'Enter a valid patient, medication, dose, and instructions.' });
  }

  const prescription = await withTransaction(async (client) => {
    const result = await client.query(
      `INSERT INTO prescriptions (patient_id, consultation_id, medication, dose, frequency, duration, quantity, instructions, prescriber_id, status)
       SELECT p.id, $2, $3, $4, $5, $6, $7, $8, $9, 'pending'
       FROM patients p
       WHERE p.id = $1 AND p.archived_at IS NULL
         AND EXISTS (SELECT 1 FROM patient_care_team pct WHERE pct.patient_id = p.id AND pct.clinician_id = $9)
         AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM visits v WHERE v.id = $2 AND v.patient_id = p.id AND v.clinician_id = $9 AND v.status = 'in_consultation'))
       RETURNING id, patient_id, consultation_id, medication, dose, frequency, duration, quantity, instructions, status, created_at`,
      [patientId, consultationId || null, medication, dose, frequency || null, duration || null, quantity, instructions, req.user.id]
    );
    if (!result.rowCount) return null;
    await recordAudit(client, {
      actorId: req.user.id,
      action: 'prescription.created',
      resourceType: 'prescription',
      resourceId: result.rows[0].id,
      module: 'prescription',
      description: 'Prescription created for patient.'
    });
    return result.rows[0];
  });

  if (!prescription) return res.status(404).json({ error: 'Assigned patient not found.' });
  return res.status(201).json({ prescription });
});

router.patch('/:id/dispense', requireAuth, requirePermission('pharmacy.dispense'), async (req, res) => {
  if (!isUuid(req.params.id)) {
    return res.status(400).json({ error: 'Invalid prescription identifier.' });
  }

  return res.status(400).json({ error: 'Dispensing requires a medicine and quantity through /api/pharmacy/dispense.' });
});

router.get('/:id', requireAuth, requirePermission('prescriptions.view'), async (req, res) => {
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
              rx.medication, rx.dose, rx.frequency, rx.duration, rx.quantity, rx.instructions, rx.status, rx.created_at
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
