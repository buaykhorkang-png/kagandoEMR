const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { cleanText, isUuid } = require('../security/validation');
const { recordAudit } = require('../services/audit');
const { withTransaction } = require('../services/transaction');

const router = express.Router();

function validateVisit(body) {
  const chiefComplaint = cleanText(body && body.chiefComplaint || '', 2000, { required: true });
  const symptoms = cleanText(body && body.symptoms || '', 4000);
  const diagnosis = cleanText(body && body.diagnosis || '', 5000);
  const treatmentNotes = cleanText(body && body.treatmentNotes || '', 20000);
  const followUp = cleanText(body && body.followUp || '', 2000);
  const bloodPressure = cleanText(body && body.bloodPressure || '', 30);
  const temperature = body && body.temperature !== undefined && body.temperature !== null && body.temperature !== '' ? Number(body.temperature) : null;
  const pulseRate = body && body.pulseRate !== undefined && body.pulseRate !== null && body.pulseRate !== '' ? Number(body.pulseRate) : null;
  const respiratoryRate = body && body.respiratoryRate !== undefined && body.respiratoryRate !== null && body.respiratoryRate !== '' ? Number(body.respiratoryRate) : null;
  const weight = body && body.weight !== undefined && body.weight !== null && body.weight !== '' ? Number(body.weight) : null;

  const hasTemperature = body && body.temperature !== undefined && body.temperature !== null && body.temperature !== '';
  const hasPulseRate = body && body.pulseRate !== undefined && body.pulseRate !== null && body.pulseRate !== '';
  const hasRespiratoryRate = body && body.respiratoryRate !== undefined && body.respiratoryRate !== null && body.respiratoryRate !== '';
  const hasWeight = body && body.weight !== undefined && body.weight !== null && body.weight !== '';

  if (!chiefComplaint || !hasTemperature || !hasPulseRate || !hasRespiratoryRate || !hasWeight ||
      !Number.isFinite(temperature) || !Number.isFinite(pulseRate) || !Number.isFinite(respiratoryRate) || !Number.isFinite(weight)) {
    return null;
  }

  return {
    chiefComplaint,
    symptoms: symptoms === null ? '' : symptoms,
    diagnosis: diagnosis === null ? '' : diagnosis,
    treatmentNotes: treatmentNotes === null ? '' : treatmentNotes,
    followUp: followUp === null ? '' : followUp,
    bloodPressure: bloodPressure === null ? '' : bloodPressure,
    temperature: Number.isFinite(temperature) ? temperature : null,
    pulseRate: Number.isFinite(pulseRate) ? pulseRate : null,
    respiratoryRate: Number.isFinite(respiratoryRate) ? respiratoryRate : null,
    weight: Number.isFinite(weight) ? weight : null
  };
}

router.post('/', requireAuth, requirePermission('consultation.create'), async (req, res) => {
  const patientId = req.body && req.body.patientId;
  const value = validateVisit(req.body || {});
  if (!isUuid(patientId) || !value) {
    return res.status(400).json({ error: 'Provide a valid patient and complete consultation details.' });
  }

  const visit = await withTransaction(async (client) => {
    const assignment = await client.query(
      `SELECT patient_id FROM patient_care_team
       WHERE patient_id = $1 AND clinician_id = $2`,
      [patientId, req.user.id]
    );
    if (!assignment.rowCount) {
      return { error: 'Patient not assigned to your care.' };
    }

    const result = await client.query(
      `INSERT INTO visits (patient_id, clinician_id, chief_complaint, symptoms, temperature, blood_pressure,
         pulse_rate, respiratory_rate, weight, diagnosis, treatment_notes, follow_up, status, clinical_completed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'completed', TRUE)
       RETURNING *`,
      [
        patientId,
        req.user.id,
        value.chiefComplaint,
        value.symptoms,
        value.temperature,
        value.bloodPressure,
        value.pulseRate,
        value.respiratoryRate,
        value.weight,
        value.diagnosis,
        value.treatmentNotes,
        value.followUp
      ]
    );

    await recordAudit(client, {
      actorId: req.user.id,
      action: 'consultation.created',
      resourceType: 'visit',
      resourceId: result.rows[0].id,
      module: 'consultation',
      description: 'New consultation recorded for patient.'
    });

    return result.rows[0];
  });

  if (visit && visit.error) return res.status(404).json({ error: visit.error });
  return res.status(201).json({ visit });
});

router.patch('/:id/start', requireAuth, requirePermission('consultation.start'), async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid visit identifier.' });
  const visit = await withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE visits SET status = 'in_consultation', clinician_id = $2
       WHERE id = $1 AND status = 'waiting_clinician' AND visit_date::date = CURRENT_DATE
       RETURNING *`,
      [req.params.id, req.user.id]
    );
    if (!result.rowCount) return null;
    await client.query(
      `INSERT INTO patient_care_team (patient_id, clinician_id, assigned_by)
       VALUES ($1, $2, $2) ON CONFLICT (patient_id, clinician_id) DO NOTHING`,
      [result.rows[0].patient_id, req.user.id]
    );
    await recordAudit(client, {
      actorId: req.user.id, action: 'consultation.started', resourceType: 'visit',
      resourceId: req.params.id, module: 'clinical', description: 'Clinician started consultation.'
    });
    return result.rows[0];
  });
  if (!visit) return res.status(409).json({ error: 'Visit is not waiting for clinician.' });
  return res.json({ visit });
});

router.patch('/:id/complete', requireAuth, requirePermission('consultation.complete'), async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid visit identifier.' });
  const diagnosis = cleanText(req.body && req.body.diagnosis || '', 5000, { required: true });
  const treatmentNotes = cleanText(req.body && req.body.treatmentNotes || '', 20000);
  const followUp = cleanText(req.body && req.body.followUp || '', 2000);
  const symptoms = cleanText(req.body && req.body.symptoms || '', 4000);
  const clinicalExamination = cleanText(req.body && req.body.clinicalExamination || '', 12000);
  if (!diagnosis || treatmentNotes === null || followUp === null || symptoms === null || clinicalExamination === null) {
    return res.status(400).json({ error: 'Enter valid examination, diagnosis, symptoms, treatment, and follow-up notes.' });
  }

  const visit = await withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE visits v SET diagnosis = $2, treatment_notes = $3, follow_up = $4,
         symptoms = $5, clinical_examination = $6, clinical_completed = TRUE,
         status = CASE
           WHEN EXISTS (SELECT 1 FROM lab_requests lr WHERE lr.visit_id = v.id
             AND lr.status IN ('pending', 'collected', 'received', 'processing', 'result_entered', 'verified', 'correction_pending', 'in_progress')) THEN 'lab_requested'
           WHEN EXISTS (SELECT 1 FROM prescriptions p WHERE p.consultation_id = v.id AND p.status IN ('active', 'pending', 'partially_dispensed')) THEN 'pharmacy_pending'
           ELSE 'completed' END
       WHERE v.id = $1 AND v.clinician_id = $7 AND v.status = 'in_consultation'
       RETURNING *`,
      [req.params.id, diagnosis, treatmentNotes || null, followUp || null, symptoms || null, clinicalExamination || null, req.user.id]
    );
    if (!result.rowCount) return null;
    if (result.rows[0].status === 'completed' && result.rows[0].appointment_id) {
      await client.query(
        `UPDATE appointments SET status = 'completed', updated_at = NOW() WHERE id = $1`,
        [result.rows[0].appointment_id]
      );
    }
    await recordAudit(client, {
      actorId: req.user.id, action: 'consultation.completed', resourceType: 'visit',
      resourceId: req.params.id, module: 'clinical', description: 'Consultation completed.'
    });
    return result.rows[0];
  });
  if (!visit) return res.status(409).json({ error: 'Consultation is not open for this clinician.' });
  return res.json({ visit });
});

router.get('/:patientId', requireAuth, requirePermission('patients.view'), async (req, res) => {
  if (!isUuid(req.params.patientId)) {
    return res.status(400).json({ error: 'Invalid patient identifier.' });
  }

  const patient = await withTransaction(async (client) => {
    if (req.user.role === 'clinician') {
      const access = await client.query(
        'SELECT 1 FROM patient_care_team WHERE patient_id = $1 AND clinician_id = $2',
        [req.params.patientId, req.user.id]
      );
      if (!access.rowCount) {
        return { error: 'Patient not assigned to your care.' };
      }
    } else if (req.user.role === 'nurse') {
      const access = await client.query(
        `SELECT 1 FROM visits WHERE patient_id = $1
         AND (triaged_by = $2 OR (visit_date::date = CURRENT_DATE AND status NOT IN ('completed', 'cancelled')))
         LIMIT 1`,
        [req.params.patientId, req.user.id]
      );
      if (!access.rowCount) return { error: 'Patient is not in your current nursing workflow.' };
    }

    const result = await client.query(
      ['triage.create', 'diagnosis.create'].some((permission) => req.user.permissions.includes(permission))
        ? `SELECT * FROM visits WHERE patient_id = $1 ORDER BY visit_date DESC, created_at DESC`
        : `SELECT id, patient_id, visit_date, status, queue_number FROM visits WHERE patient_id = $1 ORDER BY visit_date DESC, created_at DESC`,
      [req.params.patientId]
    );

    return result.rows;
  });

  if (patient && patient.error) return res.status(404).json({ error: patient.error });
  return res.json({ visits: patient });
});

module.exports = router;
