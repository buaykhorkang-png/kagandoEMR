const express = require('express');
const { requireAuth, requirePermission, requireAnyPermission } = require('../middleware/auth');
const { cleanText, isDateOnly, isUuid } = require('../security/validation');
const { recordAudit } = require('../services/audit');
const { withTransaction } = require('../services/transaction');

const router = express.Router();
function dateTime(value) {
  if (typeof value !== 'string' || value.length > 40 || Number.isNaN(Date.parse(value))) return null;
  return new Date(value);
}

router.get('/appointments', requireAuth, requireAnyPermission('appointments.view', 'appointments.relevant.view'), async (req, res) => {
  if (req.query.date && !isDateOnly(req.query.date)) return res.status(400).json({ error: 'Invalid appointment date.' });
  const appointments = await withTransaction(async (client) => {
    const result = await client.query(
      `SELECT a.id, a.patient_id, a.scheduled_at, a.reason, a.status, a.visit_id,
              p.medical_record_number, p.first_name, p.last_name
       FROM appointments a JOIN patients p ON p.id = a.patient_id
       WHERE a.scheduled_at::date = COALESCE($1::date, CURRENT_DATE) AND p.archived_at IS NULL
         AND ($2::boolean OR ($3 = 'nurse' AND a.status = 'checked_in')
              OR ($3 = 'clinician' AND EXISTS (
                SELECT 1 FROM patient_care_team pct
                WHERE pct.patient_id = a.patient_id AND pct.clinician_id = $4
              )))
       ORDER BY a.scheduled_at, p.last_name, p.first_name`,
      [req.query.date || null, req.user.permissions.includes('appointments.view'), req.user.role, req.user.id]
    );
    return result.rows;
  });
  return res.json({ appointments });
});

router.post('/appointments', requireAuth, requirePermission('appointments.create'), async (req, res) => {
  const patientId = req.body && req.body.patientId;
  const scheduledAt = dateTime(req.body && req.body.scheduledAt);
  const reason = cleanText(req.body && req.body.reason || '', 1000);
  if (!isUuid(patientId) || !scheduledAt || reason === null) {
    return res.status(400).json({ error: 'Provide a valid patient, appointment time, and reason.' });
  }

  const appointment = await withTransaction(async (client) => {
    const result = await client.query(
      `INSERT INTO appointments (patient_id, scheduled_at, reason, created_by, updated_by)
       SELECT id, $2, $3, $4, $4 FROM patients WHERE id = $1 AND archived_at IS NULL
       RETURNING *`,
      [patientId, scheduledAt, reason || null, req.user.id]
    );
    if (!result.rowCount) return null;
    await recordAudit(client, {
      actorId: req.user.id, action: 'appointment.booked', resourceType: 'appointment',
      resourceId: result.rows[0].id, module: 'front_desk', description: 'Patient appointment booked.'
    });
    return result.rows[0];
  });
  if (!appointment) return res.status(404).json({ error: 'Patient not found.' });
  return res.status(201).json({ appointment });
});

router.post('/appointments/follow-up', requireAuth, requirePermission('appointments.followup.create'), async (req, res) => {
  const patientId = req.body && req.body.patientId;
  const scheduledAt = dateTime(req.body && req.body.scheduledAt);
  const reason = cleanText(req.body && req.body.reason || '', 1000);
  if (!isUuid(patientId) || !scheduledAt || reason === null) {
    return res.status(400).json({ error: 'Provide a valid patient, follow-up time, and reason.' });
  }
  const appointment = await withTransaction(async (client) => {
    const result = await client.query(
      `INSERT INTO appointments (patient_id, scheduled_at, reason, created_by, updated_by)
       SELECT p.id, $2, $3, $4, $4 FROM patients p
       WHERE p.id = $1 AND p.archived_at IS NULL
         AND EXISTS (SELECT 1 FROM patient_care_team pct
                     WHERE pct.patient_id = p.id AND pct.clinician_id = $4)
       RETURNING *`,
      [patientId, scheduledAt, reason || 'Clinical follow-up', req.user.id]
    );
    if (!result.rowCount) return null;
    await recordAudit(client, {
      actorId: req.user.id,
      action: 'appointment.followup_requested',
      resourceType: 'appointment',
      resourceId: result.rows[0].id,
      module: 'clinical',
      description: 'Clinical follow-up appointment requested for assigned patient.'
    });
    return result.rows[0];
  });
  if (!appointment) return res.status(404).json({ error: 'Assigned patient not found.' });
  return res.status(201).json({ appointment });
});

router.patch('/appointments/:id', requireAuth, requireAnyPermission('appointments.edit', 'appointments.cancel'), async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid appointment identifier.' });
  const action = req.body && req.body.action;
  const scheduledAt = action === 'reschedule' ? dateTime(req.body && req.body.scheduledAt) : null;
  if (!['reschedule', 'cancel'].includes(action) || (action === 'reschedule' && !scheduledAt)) {
    return res.status(400).json({ error: 'Choose cancel or provide a valid rescheduled time.' });
  }
  if (action === 'cancel' && !req.user.permissions.includes('appointments.cancel') ||
      action === 'reschedule' && !req.user.permissions.includes('appointments.edit')) {
    return res.status(403).json({ error: 'Access denied.' });
  }

  const appointment = await withTransaction(async (client) => {
    const result = action === 'cancel'
      ? await client.query(
        `UPDATE appointments SET status = 'cancelled', updated_by = $2, updated_at = NOW()
         WHERE id = $1 AND status IN ('booked', 'rescheduled') RETURNING *`,
        [req.params.id, req.user.id])
      : await client.query(
        `UPDATE appointments SET scheduled_at = $2, status = 'rescheduled', updated_by = $3, updated_at = NOW()
         WHERE id = $1 AND status IN ('booked', 'rescheduled') RETURNING *`,
        [req.params.id, scheduledAt, req.user.id]);
    if (!result.rowCount) return null;
    await recordAudit(client, {
      actorId: req.user.id, action: action === 'cancel' ? 'appointment.cancelled' : 'appointment.rescheduled', resourceType: 'appointment',
      resourceId: req.params.id, module: 'front_desk', description: action === 'cancel' ? 'Appointment cancelled.' : 'Appointment rescheduled.'
    });
    return result.rows[0];
  });
  if (!appointment) return res.status(404).json({ error: 'Bookable appointment not found.' });
  return res.json({ appointment });
});

router.post('/check-in', requireAuth, requirePermission('patients.checkin'), async (req, res) => {
  const patientId = req.body && req.body.patientId;
  const appointmentId = req.body && req.body.appointmentId || null;
  if (!isUuid(patientId) || (appointmentId && !isUuid(appointmentId))) {
    return res.status(400).json({ error: 'Provide a valid patient and appointment.' });
  }

  const visit = await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext(CURRENT_DATE::text))');
    if (appointmentId) {
      const appointment = await client.query(
        `SELECT id FROM appointments WHERE id = $1 AND patient_id = $2 AND status IN ('booked', 'rescheduled') FOR UPDATE`,
        [appointmentId, patientId]
      );
      if (!appointment.rowCount) return null;
    }
    const patient = await client.query('SELECT id FROM patients WHERE id = $1 AND archived_at IS NULL', [patientId]);
    if (!patient.rowCount) return null;
    const alreadyInQueue = await client.query(
      `SELECT id, queue_number, status FROM visits
       WHERE patient_id = $1 AND visit_date::date = CURRENT_DATE AND status NOT IN ('completed', 'cancelled')
       ORDER BY visit_date DESC LIMIT 1 FOR UPDATE`,
      [patientId]
    );
    if (alreadyInQueue.rowCount) return { existingVisit: alreadyInQueue.rows[0] };

    const queue = await client.query(
      `SELECT COALESCE(MAX(queue_number), 0)::int + 1 AS number
       FROM visits WHERE queue_date = CURRENT_DATE`
    );
    const inserted = await client.query(
      `INSERT INTO visits (patient_id, appointment_id, visit_date, queue_date, queue_number, status)
       VALUES ($1, $2, NOW(), CURRENT_DATE, $3, 'waiting_triage') RETURNING *`,
      [patientId, appointmentId, queue.rows[0].number]
    );
    if (appointmentId) {
      await client.query(
        `UPDATE appointments SET status = 'checked_in', visit_id = $1, updated_by = $2, updated_at = NOW() WHERE id = $3`,
        [inserted.rows[0].id, req.user.id, appointmentId]
      );
    }
    await recordAudit(client, {
      actorId: req.user.id, action: 'patient.checked_in', resourceType: 'visit',
      resourceId: inserted.rows[0].id, module: 'front_desk',
      description: `Patient checked in with queue number ${inserted.rows[0].queue_number}.`
    });
    return inserted.rows[0];
  });
  if (!visit) return res.status(404).json({ error: 'Patient or bookable appointment not found.' });
  if (visit.existingVisit) return res.status(409).json({ error: 'Patient already has an active visit today.', visit: visit.existingVisit });
  return res.status(201).json({ visit });
});

router.get('/front-desk-queue', requireAuth, requirePermission('queue.frontdesk.view'), async (req, res) => {
  const visits = await withTransaction(async (client) => {
    const result = await client.query(
      `SELECT v.id, v.patient_id, v.queue_number, v.status, v.visit_date,
              p.medical_record_number, p.first_name, p.last_name, p.gender,
              EXTRACT(YEAR FROM age(CURRENT_DATE, p.date_of_birth))::int AS patient_age
       FROM visits v JOIN patients p ON p.id = v.patient_id
       WHERE v.visit_date::date = CURRENT_DATE
         AND v.status NOT IN ('completed', 'cancelled')
         AND p.archived_at IS NULL
       ORDER BY v.queue_number`,
      []
    );
    return result.rows;
  });
  return res.json({ visits });
});

router.get('/queue', requireAuth, requirePermission('queue.clinical.view'), async (req, res) => {
  const visits = await withTransaction(async (client) => {
    const result = await client.query(
      `SELECT v.id, v.patient_id, v.queue_date, v.queue_number, v.status, v.visit_date,
              v.triaged_at, v.triage_started_at,
              v.chief_complaint, v.triage_priority, v.temperature, v.blood_pressure,
              v.pulse_rate, v.respiratory_rate, v.oxygen_saturation, v.weight, v.height,
              v.pain_level, v.nursing_notes, v.symptoms, v.clinical_examination,
              v.diagnosis, v.treatment_notes, v.follow_up, v.clinical_completed,
              p.medical_record_number, p.first_name, p.last_name, p.date_of_birth, p.gender, p.allergies,
              EXTRACT(YEAR FROM age(CURRENT_DATE, p.date_of_birth))::int AS patient_age
       FROM visits v JOIN patients p ON p.id = v.patient_id
       WHERE v.visit_date::date = CURRENT_DATE AND v.status NOT IN ('completed', 'cancelled')
         AND ($1 <> 'nurse' OR v.status IN ('waiting_triage', 'in_triage', 'waiting_clinician', 'in_consultation'))
         AND ($1 <> 'clinician' OR v.status = 'waiting_clinician'
              OR EXISTS (SELECT 1 FROM patient_care_team pct WHERE pct.patient_id = p.id AND pct.clinician_id = $2))
       ORDER BY CASE v.triage_priority WHEN 'critical' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END,
                v.queue_number`,
      [req.user.role, req.user.id]
    );
    return result.rows;
  });
  return res.json({ visits });
});

router.post('/visits/:id/triage/start', requireAuth, requirePermission('triage.create'), async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid visit identifier.' });
  const visit = await withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE visits SET status = 'in_triage', triage_started_by = $2, triage_started_at = NOW()
       WHERE id = $1 AND status = 'waiting_triage' AND visit_date::date = CURRENT_DATE
       RETURNING id, patient_id, queue_number, status, triage_started_at`,
      [req.params.id, req.user.id]
    );
    if (!result.rowCount) return null;
    await recordAudit(client, {
      actorId: req.user.id, action: 'visit.triage_started', resourceType: 'visit',
      resourceId: req.params.id, module: 'clinical', description: 'Nurse started triage.'
    });
    return result.rows[0];
  });
  if (!visit) return res.status(409).json({ error: 'Visit is no longer waiting for triage.' });
  return res.json({ visit });
});

router.post('/visits/:id/triage', requireAuth, requirePermission('triage.create'), async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid visit identifier.' });
  const body = req.body || {};
  const numeric = (key, max) => {
    if (body[key] === undefined || body[key] === null || body[key] === '') return null;
    const value = Number(body[key]);
    return Number.isFinite(value) && value > 0 && value <= max ? value : NaN;
  };
  const temperature = numeric('temperature', 50);
  const pulse = numeric('pulseRate', 300);
  const respiratory = numeric('respiratoryRate', 100);
  const oxygen = numeric('oxygenSaturation', 100);
  const weight = numeric('weight', 500);
  const height = numeric('height', 300);
  const painLevel = body.painLevel === undefined || body.painLevel === null || body.painLevel === ''
    ? null
    : Number(body.painLevel);
  const bloodPressure = cleanText(body.bloodPressure || '', 30);
  const nursingNotes = cleanText(body.nursingNotes || '', 5000);
  const priority = body.triagePriority || 'routine';
  if ([temperature, pulse, respiratory, oxygen, weight, height].some(Number.isNaN) ||
      [temperature, pulse, respiratory, oxygen, weight, height].some((value) => value === null) ||
      (painLevel !== null && (!Number.isInteger(painLevel) || painLevel < 0 || painLevel > 10)) ||
      !bloodPressure || nursingNotes === null || !['routine', 'urgent', 'critical'].includes(priority)) {
    return res.status(400).json({ error: 'Enter valid triage observations and a valid priority.' });
  }

  const sendToClinician = body.sendToClinician === true;
  const visit = await withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE visits SET temperature = $2, blood_pressure = $3, pulse_rate = $4,
         respiratory_rate = $5, oxygen_saturation = $6, weight = $7, height = $8,
         pain_level = $9, nursing_notes = $10, triage_priority = $11,
         triaged_by = $12, triaged_at = NOW(), status = $13
       WHERE id = $1 AND status = 'in_triage' AND visit_date::date = CURRENT_DATE
       RETURNING *`,
      [req.params.id, temperature, bloodPressure, pulse, respiratory, oxygen, weight, height, painLevel, nursingNotes || null,
        priority, req.user.id, sendToClinician ? 'waiting_clinician' : 'in_triage']
    );
    if (!result.rowCount) return null;
    await recordAudit(client, {
      actorId: req.user.id,
      action: sendToClinician ? 'visit.triaged' : 'visit.triage_saved',
      resourceType: 'visit',
      resourceId: req.params.id,
      module: 'clinical',
      description: sendToClinician ? `Triage completed and sent to clinician (${priority}).` : `Triage observations saved (${priority}).`
    });
    return result.rows[0];
  });
  if (!visit) return res.status(409).json({ error: 'Start triage before saving observations.' });
  return res.json({ visit });
});

module.exports = router;
