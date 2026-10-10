const express = require('express');
const { requireAuth, requirePermission, requireAnyPermission } = require('../middleware/auth');
const { cleanText, isUuid } = require('../security/validation');
const { recordAudit } = require('../services/audit');
const { withTransaction } = require('../services/transaction');

const router = express.Router();
const openStatuses = ['pending', 'collected', 'received', 'processing', 'result_entered', 'verified', 'correction_pending'];
const priorities = ['routine', 'urgent', 'stat'];

function validCatalogueInput(body) {
  const code = cleanText(body && body.code, 40, { required: true });
  const name = cleanText(body && body.name, 200, { required: true });
  const specimenRequirements = cleanText(body && body.specimenRequirements, 1000, { required: true });
  const resultType = body && body.resultType;
  const unit = cleanText(body && body.unit || '', 80);
  const referenceRange = cleanText(body && body.referenceRange || '', 300);
  const allowedValues = body && body.allowedValues === undefined ? [] : body && body.allowedValues;
  if (!code || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(code) || !name || !specimenRequirements ||
      !['numeric', 'qualitative', 'text'].includes(resultType) || unit === null || referenceRange === null ||
      !Array.isArray(allowedValues) || resultType === 'qualitative' && (allowedValues.length < 1 || allowedValues.length > 50) ||
      resultType !== 'qualitative' && allowedValues.length !== 0) {
    return null;
  }
  const values = allowedValues.map((value) => cleanText(value, 100, { required: true }));
  if (values.some((value) => !value) || new Set(values).size !== values.length) return null;
  return {
    code: code.toUpperCase(),
    name,
    specimenRequirements,
    resultType,
    unit: unit || null,
    referenceRange: referenceRange || null,
    allowedValues: values
  };
}

function resultValue(value, type) {
  if (type === 'numeric') {
    const numericText = typeof value === 'number' ? String(value) : value;
    if (typeof numericText !== 'string' || !/^-?\d{1,12}(?:\.\d{1,6})?$/.test(numericText)) return null;
    const numericValue = Number(numericText);
    return Number.isFinite(numericValue) ? { numericValue, qualitativeValue: null, textValue: null } : null;
  }
  const text = cleanText(value, type === 'qualitative' ? 100 : 12000, { required: true });
  if (!text) return null;
  return type === 'qualitative'
    ? { numericValue: null, qualitativeValue: text, textValue: null }
    : { numericValue: null, qualitativeValue: null, textValue: text };
}

async function updateVisitWorkflow(client, visitId) {
  const visit = await client.query(
    `UPDATE visits v SET status = CASE
       WHEN NOT v.clinical_completed THEN v.status
       WHEN EXISTS (SELECT 1 FROM lab_requests lr WHERE lr.visit_id = v.id
         AND lr.status = ANY($2::text[])) THEN 'lab_requested'
       WHEN EXISTS (SELECT 1 FROM prescriptions p WHERE p.consultation_id = v.id
         AND p.status IN ('active', 'pending', 'partially_dispensed')) THEN 'pharmacy_pending'
       ELSE 'completed' END
     WHERE v.id = $1 RETURNING status, appointment_id`,
    [visitId, openStatuses]
  );
  if (visit.rows[0] && visit.rows[0].status === 'completed' && visit.rows[0].appointment_id) {
    await client.query(
      `UPDATE appointments SET status = 'completed', updated_at = NOW() WHERE id = $1`,
      [visit.rows[0].appointment_id]
    );
  }
}

async function getRequest(client, requestId) {
  const result = await client.query(
    `SELECT lr.*, p.medical_record_number, p.first_name, p.last_name, v.queue_number,
            tc.code AS test_code, COALESCE(lr.test_result_type, tc.result_type) AS catalogue_result_type,
            CASE WHEN lr.test_result_type IS NOT NULL THEN lr.test_unit ELSE tc.unit END AS catalogue_unit,
            CASE WHEN lr.test_result_type IS NOT NULL THEN lr.test_reference_range ELSE tc.reference_range END AS catalogue_reference_range,
            CASE WHEN lr.test_result_type IS NOT NULL THEN lr.test_allowed_values ELSE tc.allowed_values END AS allowed_values,
            latest.id AS result_id, latest.version_number AS result_version,
            latest.result_type, latest.numeric_value, latest.qualitative_value, latest.text_value,
            latest.unit AS result_unit, latest.reference_range AS result_reference_range,
            latest.comments AS result_comments, latest.status AS result_status,
            latest.entered_by AS result_entered_by, latest.verified_by AS result_verified_by,
            latest.supersedes_result_id, versions.history AS result_history
     FROM lab_requests lr
     JOIN patients p ON p.id = lr.patient_id
     JOIN visits v ON v.id = lr.visit_id AND v.patient_id = lr.patient_id
     LEFT JOIN lab_test_catalogue tc ON tc.id = lr.test_id
     LEFT JOIN LATERAL (
       SELECT rv.* FROM lab_result_versions rv
       WHERE rv.request_id = lr.id ORDER BY rv.version_number DESC LIMIT 1
     ) latest ON TRUE
     LEFT JOIN LATERAL (
       SELECT JSON_AGG(JSON_BUILD_OBJECT(
         'id', rv.id, 'versionNumber', rv.version_number, 'resultType', rv.result_type,
         'numericValue', rv.numeric_value::text, 'qualitativeValue', rv.qualitative_value,
         'textValue', rv.text_value, 'unit', rv.unit, 'referenceRange', rv.reference_range,
         'comments', rv.comments, 'status', rv.status, 'enteredAt', rv.entered_at,
         'verifiedAt', rv.verified_at, 'releasedAt', rv.released_at,
         'amendmentReason', rv.amendment_reason
       ) ORDER BY rv.version_number) AS history
       FROM lab_result_versions rv WHERE rv.request_id = lr.id
     ) versions ON TRUE
     WHERE lr.id = $1`,
    [requestId]
  );
  return result.rows[0] || null;
}

router.get('/catalogue', requireAuth,
  requireAnyPermission('laboratory.requests.create', 'laboratory.requests.view', 'laboratory.catalogue.manage'),
  async (req, res) => {
    const tests = await withTransaction(async (client) => {
      const result = await client.query(
        `SELECT id, code, name, result_type, unit, reference_range, allowed_values,
                specimen_requirements, is_active, created_at, updated_at
         FROM lab_test_catalogue
         WHERE is_active = TRUE OR $1::boolean
         ORDER BY name, code`,
        [req.user.permissions.includes('laboratory.catalogue.manage')]
      );
      return result.rows;
    });
    return res.json({ tests });
  });

router.post('/catalogue', requireAuth, requirePermission('laboratory.catalogue.manage'), async (req, res) => {
  const input = validCatalogueInput(req.body || {});
  if (!input) return res.status(400).json({ error: 'Provide a valid code, name, result type, specimen requirement, and type-appropriate values.' });
  const testDefinition = await withTransaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO lab_test_catalogue
         (code, name, result_type, unit, reference_range, allowed_values, specimen_requirements, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
       RETURNING *`,
      [input.code, input.name, input.resultType, input.unit, input.referenceRange,
        input.allowedValues, input.specimenRequirements, req.user.id]
    );
    await recordAudit(client, {
      actorId: req.user.id, action: 'laboratory.test_created', resourceType: 'lab_test',
      resourceId: inserted.rows[0].id, module: 'laboratory', description: 'Laboratory test definition created.'
    });
    return inserted.rows[0];
  });
  return res.status(201).json({ test: testDefinition });
});

router.patch('/catalogue/:id', requireAuth, requirePermission('laboratory.catalogue.manage'), async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid test identifier.' });
  const input = validCatalogueInput(req.body || {});
  if (!input || typeof (req.body && req.body.isActive) !== 'boolean') {
    return res.status(400).json({ error: 'Provide a complete valid test definition and active status.' });
  }
  const testDefinition = await withTransaction(async (client) => {
    const updated = await client.query(
      `UPDATE lab_test_catalogue
       SET code = $2, name = $3, result_type = $4, unit = $5, reference_range = $6,
           allowed_values = $7, specimen_requirements = $8, is_active = $9,
           updated_by = $10, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [req.params.id, input.code, input.name, input.resultType, input.unit, input.referenceRange,
        input.allowedValues, input.specimenRequirements, req.body.isActive, req.user.id]
    );
    if (!updated.rowCount) return null;
    await recordAudit(client, {
      actorId: req.user.id, action: 'laboratory.test_updated', resourceType: 'lab_test',
      resourceId: req.params.id, module: 'laboratory', description: 'Laboratory test definition updated.'
    });
    return updated.rows[0];
  });
  if (!testDefinition) return res.status(404).json({ error: 'Laboratory test not found.' });
  return res.json({ test: testDefinition });
});

async function requestList(req, res) {
  const requests = await withTransaction(async (client) => {
    const result = await client.query(
      `SELECT lr.*, p.medical_record_number, p.first_name, p.last_name, v.queue_number,
              tc.code AS test_code, COALESCE(lr.test_result_type, tc.result_type) AS catalogue_result_type,
              CASE WHEN lr.test_result_type IS NOT NULL THEN lr.test_unit ELSE tc.unit END AS catalogue_unit,
              CASE WHEN lr.test_result_type IS NOT NULL THEN lr.test_reference_range ELSE tc.reference_range END AS catalogue_reference_range,
              CASE WHEN lr.test_result_type IS NOT NULL THEN lr.test_allowed_values ELSE tc.allowed_values END AS allowed_values,
              latest.id AS result_id, latest.version_number AS result_version,
              latest.result_type, latest.numeric_value, latest.qualitative_value, latest.text_value,
              latest.unit AS result_unit, latest.reference_range AS result_reference_range,
              latest.comments AS result_comments, latest.status AS result_status,
              latest.entered_by AS result_entered_by, latest.verified_by AS result_verified_by,
              versions.history AS result_history
       FROM lab_requests lr
       JOIN patients p ON p.id = lr.patient_id
       JOIN visits v ON v.id = lr.visit_id AND v.patient_id = lr.patient_id
       LEFT JOIN lab_test_catalogue tc ON tc.id = lr.test_id
       LEFT JOIN LATERAL (
         SELECT rv.* FROM lab_result_versions rv
         WHERE rv.request_id = lr.id ORDER BY rv.version_number DESC LIMIT 1
       ) latest ON TRUE
       LEFT JOIN LATERAL (
         SELECT JSON_AGG(JSON_BUILD_OBJECT(
           'id', rv.id, 'versionNumber', rv.version_number, 'resultType', rv.result_type,
           'numericValue', rv.numeric_value::text, 'qualitativeValue', rv.qualitative_value,
           'textValue', rv.text_value, 'unit', rv.unit, 'referenceRange', rv.reference_range,
           'comments', rv.comments, 'status', rv.status, 'enteredAt', rv.entered_at,
           'verifiedAt', rv.verified_at, 'releasedAt', rv.released_at,
           'amendmentReason', rv.amendment_reason
         ) ORDER BY rv.version_number) AS history
         FROM lab_result_versions rv WHERE rv.request_id = lr.id
       ) versions ON TRUE
       WHERE lr.status = ANY($1::text[]) OR lr.id IN (
         SELECT closed.id FROM lab_requests closed
         WHERE closed.status IN ('released', 'corrected', 'completed', 'rejected', 'cancelled')
         ORDER BY COALESCE(closed.completed_at, closed.rejected_at, closed.cancelled_at, closed.requested_at) DESC
         LIMIT 200
       )
       ORDER BY CASE WHEN lr.status = ANY($1::text[]) THEN 0 ELSE 1 END,
         lr.requested_at ASC
       `,
      [openStatuses]
    );
    return result.rows;
  });
  return res.json({ requests });
}

router.get('/requests', requireAuth, requirePermission('laboratory.requests.view'), requestList);
router.get('/laboratory', requireAuth, requirePermission('laboratory.requests.view'), requestList);

async function createRequest(req, res) {
  const visitId = req.params.visitId || req.params.id;
  if (!isUuid(visitId)) return res.status(400).json({ error: 'Invalid encounter identifier.' });
  const testId = req.body && req.body.testId;
  const indication = cleanText(req.body && req.body.clinicalIndication || '', 2000, { required: true });
  const priority = req.body && req.body.priority || 'routine';
  if (!isUuid(testId) || !indication || !priorities.includes(priority)) {
    return res.status(400).json({ error: 'Select an active test and provide a clinical indication and valid priority.' });
  }
  const created = await withTransaction(async (client) => {
    const visit = await client.query(
      `SELECT v.id, v.patient_id FROM visits v
       JOIN patients p ON p.id = v.patient_id
       WHERE v.id = $1 AND v.status = 'in_consultation' AND p.archived_at IS NULL
         AND EXISTS (SELECT 1 FROM patient_care_team pct
           WHERE pct.patient_id = v.patient_id AND pct.clinician_id = $2)
       FOR UPDATE OF v`,
      [visitId, req.user.id]
    );
    if (!visit.rowCount) return { notFound: true };
    const test = await client.query(
      `SELECT id, code, name, result_type, unit, reference_range, allowed_values, specimen_requirements FROM lab_test_catalogue
       WHERE id = $1 AND is_active = TRUE FOR SHARE`,
      [testId]
    );
    if (!test.rowCount) return { invalidTest: true };
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [visitId, testId]);
    const duplicate = await client.query(
      `SELECT id FROM lab_requests WHERE visit_id = $1 AND test_id = $2
       AND status = ANY($3::text[]) LIMIT 1`,
      [visitId, testId, openStatuses]
    );
    if (duplicate.rowCount) return { duplicate: true };
    const inserted = await client.query(
      `INSERT INTO lab_requests
         (visit_id, patient_id, requested_by, test_id, test_result_type, test_unit,
          test_reference_range, test_allowed_values, test_name, clinical_notes,
          clinical_indication, specimen_requirements, request_number, priority)
       SELECT $1, $2, $3, t.id, t.result_type, t.unit, t.reference_range, t.allowed_values,
              t.name, $4, $4, t.specimen_requirements,
              'LAB-' || TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYYMMDD') || '-' ||
                LPAD(NEXTVAL('lab_request_number_seq')::text, 8, '0'), $5
       FROM lab_test_catalogue t WHERE t.id = $6 AND t.is_active = TRUE
       RETURNING *`,
      [visitId, visit.rows[0].patient_id, req.user.id, indication, priority, testId]
    );
    await recordAudit(client, {
      actorId: req.user.id, action: 'laboratory.requested', resourceType: 'lab_request',
      resourceId: inserted.rows[0].id, module: 'clinical', description: `Laboratory request created (${test.rows[0].code}).`
    });
    return { request: inserted.rows[0] };
  });
  if (created.notFound) return res.status(404).json({ error: 'Active encounter not found or not assigned to you.' });
  if (created.invalidTest) return res.status(400).json({ error: 'Select an active laboratory test.' });
  if (created.duplicate) return res.status(409).json({ error: 'An open request for this test already exists in this encounter.' });
  return res.status(201).json({ request: created.request });
}

router.post('/visits/:visitId/requests', requireAuth, requirePermission('laboratory.requests.create'), createRequest);
router.post('/visits/:id/lab-requests', requireAuth, requirePermission('laboratory.requests.create'), createRequest);

router.patch('/requests/:id/configure', requireAuth, requirePermission('laboratory.catalogue.manage'), async (req, res) => {
  if (!isUuid(req.params.id) || !isUuid(req.body && req.body.testId)) {
    return res.status(400).json({ error: 'Provide valid request and test identifiers.' });
  }
  const reason = cleanText(req.body && req.body.reason, 1000, { required: true });
  if (!reason) return res.status(400).json({ error: 'A mapping reason is required.' });
  const configured = await withTransaction(async (client) => {
    const request = await client.query('SELECT * FROM lab_requests WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!request.rowCount) return { missing: true };
    if (request.rows[0].status !== 'pending' || request.rows[0].test_id) return { conflict: true };
    const test = await client.query(
      `SELECT * FROM lab_test_catalogue WHERE id = $1 AND is_active = TRUE`,
      [req.body.testId]
    );
    if (!test.rowCount) return { invalidTest: true };
    const duplicate = await client.query(
      `SELECT id FROM lab_requests WHERE visit_id = $1 AND test_id = $2
       AND status = ANY($3::text[]) LIMIT 1`,
      [request.rows[0].visit_id, req.body.testId, openStatuses]
    );
    if (duplicate.rowCount) return { duplicate: true };
    const updated = await client.query(
      `UPDATE lab_requests SET test_id = $2, test_result_type = $3, test_unit = $4,
         test_reference_range = $5, test_allowed_values = $6, test_name = $7,
         specimen_requirements = $8
       WHERE id = $1 RETURNING *`,
      [req.params.id, test.rows[0].id, test.rows[0].result_type, test.rows[0].unit,
        test.rows[0].reference_range, test.rows[0].allowed_values, test.rows[0].name,
        test.rows[0].specimen_requirements]
    );
    await recordAudit(client, {
      actorId: req.user.id, action: 'laboratory.legacy_request_configured',
      resourceType: 'lab_request', resourceId: req.params.id, module: 'laboratory',
      description: `Legacy laboratory request mapped to configured test ${test.rows[0].code}: ${reason}`
    });
    return { request: updated.rows[0] };
  });
  if (configured.missing) return res.status(404).json({ error: 'Laboratory request not found.' });
  if (configured.invalidTest) return res.status(400).json({ error: 'Select an active laboratory test.' });
  if (configured.duplicate) return res.status(409).json({ error: 'An open request for this test already exists in the encounter.' });
  if (configured.conflict) return res.status(409).json({ error: 'Only an unconfigured pending legacy request can be mapped.' });
  return res.json({ request: configured.request });
});

router.patch('/requests/:id/specimen', requireAuth, requirePermission('laboratory.specimens.manage'), async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid laboratory request identifier.' });
  const action = req.body && req.body.action;
  const specimenIdentifier = cleanText(req.body && req.body.specimenIdentifier || '', 120);
  const rejectionReason = cleanText(req.body && req.body.reason || '', 1000);
  if (!['collect', 'receive', 'reject'].includes(action) ||
      action === 'reject' && !rejectionReason ||
      ['collect', 'receive'].includes(action) && !specimenIdentifier) {
    return res.status(400).json({ error: 'Provide a specimen identifier for collection or receipt, or a rejection reason.' });
  }
  const updated = await withTransaction(async (client) => {
    const request = await client.query('SELECT * FROM lab_requests WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!request.rowCount) return { missing: true };
    const current = request.rows[0];
    let result;
    if (action === 'collect' && current.status === 'pending') {
      result = await client.query(
        `UPDATE lab_requests SET status = 'collected', specimen_identifier = $2,
           collected_by = $3, collected_at = NOW() WHERE id = $1 RETURNING *`,
        [req.params.id, specimenIdentifier, req.user.id]
      );
    } else if (action === 'receive' && ['pending', 'collected'].includes(current.status)) {
      result = await client.query(
        `UPDATE lab_requests SET status = 'received', specimen_identifier = $2,
           received_by = $3, received_at = NOW() WHERE id = $1 RETURNING *`,
        [req.params.id, specimenIdentifier, req.user.id]
      );
    } else if (action === 'reject' && ['pending', 'collected', 'received', 'processing'].includes(current.status)) {
      result = await client.query(
        `UPDATE lab_requests SET status = 'rejected', rejection_reason = $2,
           rejected_by = $3, rejected_at = NOW() WHERE id = $1 RETURNING *`,
        [req.params.id, rejectionReason, req.user.id]
      );
    } else {
      return { conflict: true };
    }
    if (action === 'reject') await updateVisitWorkflow(client, current.visit_id);
    const actionName = action === 'collect' ? 'collected' : action === 'receive' ? 'received' : 'rejected';
    await recordAudit(client, {
      actorId: req.user.id,
      action: `laboratory.specimen_${actionName}`,
      resourceType: 'lab_request', resourceId: req.params.id, module: 'laboratory',
      description: action === 'reject' ? 'Laboratory specimen rejected with reason.' : `Laboratory specimen ${actionName}.`
    });
    return { request: result.rows[0] };
  });
  if (updated.missing) return res.status(404).json({ error: 'Laboratory request not found.' });
  if (updated.conflict) return res.status(409).json({ error: 'Specimen action is not valid for the current request status.' });
  return res.json({ request: updated.request });
});

router.post('/requests/:id/process', requireAuth, requirePermission('laboratory.specimens.manage'), async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid laboratory request identifier.' });
  const request = await withTransaction(async (client) => {
    const updated = await client.query(
      `UPDATE lab_requests SET status = 'processing', processing_started_at = NOW()
       WHERE id = $1 AND status = 'received' RETURNING *`,
      [req.params.id]
    );
    if (!updated.rowCount) return null;
    await recordAudit(client, {
      actorId: req.user.id, action: 'laboratory.processing_started', resourceType: 'lab_request',
      resourceId: req.params.id, module: 'laboratory', description: 'Laboratory processing started.'
    });
    return updated.rows[0];
  });
  if (!request) return res.status(409).json({ error: 'Only a received specimen can enter processing.' });
  return res.json({ request });
});

async function enterResult(req, res, legacy = false) {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid laboratory request identifier.' });
  const comments = cleanText(req.body && req.body.comments || '', 2000);
  const amendmentReason = cleanText(req.body && req.body.amendmentReason || '', 1000);
  if (comments === null || amendmentReason === null) {
    return res.status(400).json({ error: 'Enter valid result comments and amendment reason.' });
  }
  const saved = await withTransaction(async (client) => {
    const requestResult = await client.query(
      `SELECT lr.*, COALESCE(lr.test_result_type, tc.result_type) AS catalogue_result_type,
             CASE WHEN lr.test_result_type IS NOT NULL THEN lr.test_unit ELSE tc.unit END AS catalogue_unit,
             CASE WHEN lr.test_result_type IS NOT NULL THEN lr.test_reference_range ELSE tc.reference_range END AS catalogue_reference_range,
              CASE WHEN lr.test_result_type IS NOT NULL THEN lr.test_allowed_values ELSE tc.allowed_values END AS allowed_values
       FROM lab_requests lr LEFT JOIN lab_test_catalogue tc ON tc.id = lr.test_id
       WHERE lr.id = $1 FOR UPDATE OF lr`,
      [req.params.id]
    );
    if (!requestResult.rowCount) return { missing: true };
    const request = requestResult.rows[0];
    const amendment = ['released', 'corrected', 'completed'].includes(request.status);
    const legacyOpen = legacy && request.status === 'in_progress' && !request.test_id;
    if (request.status === 'correction_pending') return { conflict: true };
    if (amendment && !req.user.permissions.includes('laboratory.results.amend')) return { denied: true };
    if (!amendment && request.status !== 'processing' && !legacyOpen) return { conflict: true };
    if (amendment && !amendmentReason) return { invalid: true };
    const previous = await client.query(
      `SELECT id, version_number, result_type, unit, reference_range
       FROM lab_result_versions WHERE request_id = $1 AND released_at IS NOT NULL
       ORDER BY version_number DESC LIMIT 1`,
      [req.params.id]
    );
    if (amendment && !previous.rowCount) return { conflict: true };
    const resultType = amendment
      ? previous.rows[0] && previous.rows[0].result_type || request.catalogue_result_type || 'text'
      : request.catalogue_result_type || (legacyOpen ? 'text' : null);
    if (!resultType) return { missingDefinition: true };
    if (!amendment && legacy && resultType !== 'text') return { invalid: true };
    const value = resultValue(legacy ? req.body.result : req.body.value, resultType);
    const allowedValues = request.allowed_values || [];
    if (!value || resultType === 'qualitative' &&
        !(allowedValues || []).includes(value.qualitativeValue)) return { invalid: true };
    const nextVersion = await client.query(
      `SELECT COALESCE(MAX(version_number), 0)::int + 1 AS version
       FROM lab_result_versions WHERE request_id = $1`,
      [req.params.id]
    );
    const inserted = await client.query(
      `INSERT INTO lab_result_versions
         (request_id, version_number, result_type, numeric_value, qualitative_value, text_value,
          unit, reference_range, comments, entered_by, amendment_reason, supersedes_result_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [req.params.id, nextVersion.rows[0].version, resultType, value.numericValue, value.qualitativeValue,
        value.textValue, amendment ? previous.rows[0].unit : request.catalogue_unit,
        amendment ? previous.rows[0].reference_range : request.catalogue_reference_range,
        comments || null, req.user.id, amendment ? amendmentReason : null,
        amendment && previous.rows[0] ? previous.rows[0].id : null]
    );
    const status = amendment ? 'correction_pending' : 'result_entered';
    await client.query('UPDATE lab_requests SET status = $2 WHERE id = $1', [req.params.id, status]);
    await recordAudit(client, {
      actorId: req.user.id, action: amendment ? 'laboratory.result_amendment_entered' : 'laboratory.result_entered',
      resourceType: 'lab_result', resourceId: inserted.rows[0].id, module: 'laboratory',
      description: amendment ? `Laboratory result correction entered (version ${nextVersion.rows[0].version}).` : 'Laboratory result entered.'
    });
    return { requestId: req.params.id, result: inserted.rows[0], amendment };
  });
  if (saved.missing) return res.status(404).json({ error: 'Laboratory request not found.' });
  if (saved.denied) return res.status(403).json({ error: 'Access denied.' });
  if (saved.conflict) return res.status(409).json({ error: 'The request is not in a state that accepts a result.' });
  if (saved.missingDefinition) return res.status(409).json({ error: 'A test definition is required before entering the initial result.' });
  if (saved.invalid) return res.status(400).json({ error: 'Result does not match the configured test result type or allowed values.' });
  const request = await withTransaction((client) => getRequest(client, saved.requestId));
  return res.status(201).json({ request, result: saved.result });
}

router.post('/requests/:id/results', requireAuth, requirePermission('laboratory.results.enter'), (req, res) => enterResult(req, res));
router.patch('/laboratory/:id', requireAuth, requirePermission('laboratory.results.enter'), (req, res) => enterResult(req, res, true));

router.post('/requests/:id/results/:resultId/verify', requireAuth, requirePermission('laboratory.results.verify'), async (req, res) => {
  if (!isUuid(req.params.id) || !isUuid(req.params.resultId)) return res.status(400).json({ error: 'Invalid laboratory result identifier.' });
  const result = await withTransaction(async (client) => {
    const request = await client.query('SELECT status FROM lab_requests WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!request.rowCount) return { missing: true };
    if (!['result_entered', 'correction_pending'].includes(request.rows[0].status)) return { conflict: true };
    const verified = await client.query(
      `UPDATE lab_result_versions SET status = 'verified', verified_by = $3, verified_at = NOW()
       WHERE id = $1 AND request_id = $2 AND status = 'entered' AND entered_by IS DISTINCT FROM $3
       RETURNING *`,
      [req.params.resultId, req.params.id, req.user.id]
    );
    if (!verified.rowCount) return { conflict: true };
    if (request.rows[0].status !== 'correction_pending') {
      await client.query(`UPDATE lab_requests SET status = 'verified' WHERE id = $1`, [req.params.id]);
    }
    await recordAudit(client, {
      actorId: req.user.id, action: 'laboratory.result_verified', resourceType: 'lab_result',
      resourceId: req.params.resultId, module: 'laboratory', description: 'Laboratory result independently verified.'
    });
    return { result: verified.rows[0] };
  });
  if (result.missing) return res.status(404).json({ error: 'Laboratory request not found.' });
  if (result.conflict) return res.status(409).json({ error: 'Result cannot be verified by its entering user or is not awaiting verification.' });
  return res.json({ result: result.result });
});

router.post('/requests/:id/results/:resultId/release', requireAuth, requirePermission('laboratory.results.release'), async (req, res) => {
  if (!isUuid(req.params.id) || !isUuid(req.params.resultId)) return res.status(400).json({ error: 'Invalid laboratory result identifier.' });
  const released = await withTransaction(async (client) => {
    const request = await client.query('SELECT * FROM lab_requests WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!request.rowCount) return { missing: true };
    if (!['verified', 'correction_pending'].includes(request.rows[0].status)) return { conflict: true };
    const current = await client.query(
      `SELECT * FROM lab_result_versions WHERE id = $1 AND request_id = $2 FOR UPDATE`,
      [req.params.resultId, req.params.id]
    );
    if (!current.rowCount) return { missing: true };
    const version = current.rows[0];
    if (version.status !== 'verified' || version.verified_by === req.user.id ||
        version.entered_by === req.user.id) {
      return { conflict: true };
    }
    await client.query(
      `UPDATE lab_result_versions SET status = 'superseded'
       WHERE request_id = $1 AND released_at IS NOT NULL AND id <> $2 AND status = 'released'`,
      [req.params.id, req.params.resultId]
    );
    const updated = await client.query(
      `UPDATE lab_result_versions SET status = 'released', released_by = $2, released_at = NOW()
       WHERE id = $1 RETURNING *`,
      [req.params.resultId, req.user.id]
    );
    const isCorrection = Number(version.version_number) > 1;
    const requestStatus = isCorrection ? 'corrected' : 'released';
    const printable = version.result_type === 'numeric' ? version.numeric_value
      : version.result_type === 'qualitative' ? version.qualitative_value : version.text_value;
    await client.query(
      `UPDATE lab_requests SET status = $2, result = $3, completed_by = $4, completed_at = NOW()
       WHERE id = $1`,
      [req.params.id, requestStatus, String(printable), req.user.id]
    );
    await updateVisitWorkflow(client, request.rows[0].visit_id);
    await recordAudit(client, {
      actorId: req.user.id, action: isCorrection ? 'laboratory.result_correction_released' : 'laboratory.result_released',
      resourceType: 'lab_result', resourceId: req.params.resultId, module: 'laboratory',
      description: isCorrection ? `Corrected laboratory result version ${version.version_number} released.` : 'Verified laboratory result released.'
    });
    return { requestId: req.params.id, result: updated.rows[0] };
  });
  if (released.missing) return res.status(404).json({ error: 'Laboratory result not found.' });
  if (released.conflict) return res.status(409).json({ error: 'Only a different authorized reviewer can release a verified result.' });
  const request = await withTransaction((client) => getRequest(client, released.requestId));
  return res.json({ request, result: released.result });
});

router.patch('/requests/:id/cancel', requireAuth, requirePermission('laboratory.requests.cancel'), async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid laboratory request identifier.' });
  const reason = cleanText(req.body && req.body.reason, 1000, { required: true });
  if (!reason) return res.status(400).json({ error: 'A cancellation reason is required.' });
  const cancelled = await withTransaction(async (client) => {
    const request = await client.query(
      `SELECT lr.* FROM lab_requests lr WHERE lr.id = $1 FOR UPDATE`,
      [req.params.id]
    );
    if (!request.rowCount) return { missing: true };
    if (!openStatuses.includes(request.rows[0].status) ||
        req.user.role === 'clinician' && request.rows[0].requested_by !== req.user.id) return { conflict: true };
    const updated = await client.query(
      `UPDATE lab_requests SET status = 'cancelled', cancelled_by = $2,
         cancelled_at = NOW(), cancellation_reason = $3 WHERE id = $1 RETURNING *`,
      [req.params.id, req.user.id, reason]
    );
    await updateVisitWorkflow(client, updated.rows[0].visit_id);
    await recordAudit(client, {
      actorId: req.user.id, action: 'laboratory.request_cancelled', resourceType: 'lab_request',
      resourceId: req.params.id, module: 'laboratory', description: 'Laboratory request cancelled with reason.'
    });
    return { request: updated.rows[0] };
  });
  if (cancelled.missing) return res.status(404).json({ error: 'Laboratory request not found.' });
  if (cancelled.conflict) return res.status(409).json({ error: 'Only an open request ordered by you can be cancelled.' });
  return res.json({ request: cancelled.request });
});

router.get('/requests/:id/history', requireAuth, requirePermission('laboratory.requests.view'), async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid laboratory request identifier.' });
  const versions = await withTransaction(async (client) => {
    const exists = await client.query('SELECT 1 FROM lab_requests WHERE id = $1', [req.params.id]);
    if (!exists.rowCount) return null;
    const result = await client.query(
      `SELECT id, request_id, version_number, result_type, numeric_value, qualitative_value,
              text_value, unit, reference_range, comments, status, entered_by, entered_at,
              verified_by, verified_at, released_by, released_at, amendment_reason, supersedes_result_id
       FROM lab_result_versions WHERE request_id = $1 ORDER BY version_number`,
      [req.params.id]
    );
    return result.rows;
  });
  if (!versions) return res.status(404).json({ error: 'Laboratory request not found.' });
  return res.json({ versions });
});

router.get('/reports', requireAuth, requirePermission('reports.view'), async (req, res) => {
  const report = await withTransaction(async (client) => {
    const summary = await client.query(
      `SELECT status, priority, COUNT(*)::int AS total
       FROM lab_requests GROUP BY status, priority ORDER BY status, priority`
    );
    const activity = await client.query(
      `WITH daily AS (
         SELECT requested_at::date AS request_day, COUNT(*)::int AS requested,
           COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected,
           COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled
         FROM lab_requests GROUP BY requested_at::date
         ORDER BY request_day DESC LIMIT 90
       )
       SELECT daily.request_day::text AS request_day, daily.requested,
         (SELECT COUNT(*)::int FROM lab_result_versions rv
          JOIN lab_requests lr ON lr.id = rv.request_id
          WHERE lr.requested_at::date = daily.request_day AND rv.released_at IS NOT NULL) AS released,
         daily.rejected, daily.cancelled
       FROM daily ORDER BY daily.request_day DESC`
    );
    return { summary: summary.rows, activity: activity.rows };
  });
  return res.json(report);
});

module.exports = router;
