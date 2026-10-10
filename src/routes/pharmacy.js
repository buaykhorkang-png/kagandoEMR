const express = require('express');
const { requireAuth, requirePermission, requireAnyPermission } = require('../middleware/auth');
const { cleanText, isDateOnly, isUuid } = require('../security/validation');
const { recordAudit } = require('../services/audit');
const { withTransaction } = require('../services/transaction');

const router = express.Router();

function dateOnly(value) {
  return value instanceof Date
    ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
    : String(value).slice(0, 10);
}

router.get('/catalogue', requireAuth, requireAnyPermission('pharmacy.inventory', 'prescriptions.create'), async (req, res) => {
  const medicines = await withTransaction(async (client) => {
    const result = await client.query(
      `SELECT id, name, generic_name, strength, dosage_form, unit
       FROM medicines WHERE status = 'active'
       ORDER BY name, strength NULLS FIRST, dosage_form NULLS FIRST, id`
    );
    return result.rows;
  });
  return res.json({ medicines });
});

router.get('/medicines', requireAuth, requirePermission('pharmacy.inventory'), async (req, res) => {
  const search = cleanText(req.query.search || '', 100);
  const limit = Number(req.query.limit || 100);
  const offset = Number(req.query.offset || 0);
  if (search === null || !Number.isInteger(limit) || limit < 1 || limit > 100 ||
      !Number.isInteger(offset) || offset < 0) {
    return res.status(400).json({ error: 'Provide a valid medicine search and page.' });
  }
  const result = await withTransaction(async (client) => {
    const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
    const [medicines, count] = await Promise.all([
      client.query(
        `SELECT * FROM medicines
         WHERE status <> 'discontinued'
           AND ($1 = '%%' OR name ILIKE $1 ESCAPE '\\' OR generic_name ILIKE $1 ESCAPE '\\'
                OR strength ILIKE $1 ESCAPE '\\' OR dosage_form ILIKE $1 ESCAPE '\\')
         ORDER BY name, strength NULLS FIRST, dosage_form NULLS FIRST, id
         LIMIT $2 OFFSET $3`,
        [pattern, limit, offset]
      ),
      client.query(
        `SELECT COUNT(*)::int AS total FROM medicines
         WHERE status <> 'discontinued'
           AND ($1 = '%%' OR name ILIKE $1 ESCAPE '\\' OR generic_name ILIKE $1 ESCAPE '\\'
                OR strength ILIKE $1 ESCAPE '\\' OR dosage_form ILIKE $1 ESCAPE '\\')`,
        [pattern]
      )
    ]);
    return { medicines: medicines.rows, total: count.rows[0].total };
  });

  return res.json(result);
});

router.get('/batches', requireAuth, requirePermission('pharmacy.inventory'), async (req, res) => {
  const batches = await withTransaction(async (client) => {
    const result = await client.query(
      `SELECT b.id, b.medicine_id, b.batch_number, b.manufactured_at::text AS manufactured_at,
              b.expires_at::text AS expires_at,
              b.quantity_received, b.current_quantity, b.supplier, b.received_at,
              b.stock_location, b.status, m.name, m.generic_name, m.strength,
              m.dosage_form, m.unit, m.minimum_stock_level,
              CASE WHEN b.status IN ('quarantined', 'expired') THEN b.status
                   WHEN b.expires_at < CURRENT_DATE THEN 'expired'
                   WHEN b.current_quantity = 0 THEN 'out_of_stock'
                   WHEN m.current_quantity <= m.minimum_stock_level THEN 'low_stock'
                   ELSE 'available' END AS availability
       FROM medicine_batches b JOIN medicines m ON m.id = b.medicine_id
       WHERE m.status <> 'discontinued'
       ORDER BY b.expires_at NULLS LAST, b.received_at, b.batch_number, b.id`
    );
    return result.rows;
  });
  return res.json({ batches });
});

router.post('/medicines', requireAuth, requirePermission('pharmacy.inventory'), async (req, res) => {
  const name = cleanText(req.body && req.body.name, 200, { required: true });
  const genericName = cleanText(req.body && req.body.genericName || '', 200);
  const category = cleanText(req.body && req.body.category || '', 100);
  const strength = cleanText(req.body && req.body.strength || '', 100);
  const dosageForm = cleanText(req.body && req.body.dosageForm || '', 100);
  const unit = cleanText(req.body && req.body.unit || '', 50);
  const minimumStockLevel = Number(req.body && req.body.minimumStockLevel || 0);

  if (!name || !unit || !Number.isInteger(minimumStockLevel) || minimumStockLevel < 0 ||
      [genericName, category, strength, dosageForm].includes(null) ||
      Number(req.body && req.body.quantity || 0) !== 0) {
    return res.status(400).json({ error: 'Provide a valid medicine name, stock unit, and reorder level. Receive physical stock separately.' });
  }

  const medicine = await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('medicine-catalogue-create'))");
    const duplicate = await client.query(
      `SELECT id FROM medicines
       WHERE status <> 'discontinued'
         AND lower(btrim(name)) = lower(btrim($1))
         AND lower(COALESCE(btrim(strength), '')) = lower(COALESCE(btrim($2), ''))
         AND lower(COALESCE(btrim(dosage_form), '')) = lower(COALESCE(btrim($3), ''))
       LIMIT 1`,
      [name, strength || null, dosageForm || null]
    );
    if (duplicate.rowCount) {
      const error = new Error('A medicine with the same name, strength, and dosage form already exists.');
      error.statusCode = 409;
      throw error;
    }
    const result = await client.query(
      `INSERT INTO medicines (name, generic_name, category, strength, dosage_form, unit, minimum_stock_level, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
       RETURNING *`,
      [name, genericName || null, category || null, strength || null, dosageForm || null, unit, minimumStockLevel]
    );

    await recordAudit(client, {
      actorId: req.user.id,
      action: 'medicine.added',
      resourceType: 'medicine',
      resourceId: result.rows[0].id,
      module: 'pharmacy',
      description: 'Medicine added to inventory.'
    });

    return result.rows[0];
  });

  return res.status(201).json({ medicine });
});

router.patch('/medicines/:id', requireAuth, requirePermission('pharmacy.inventory'), async (req, res) => {
  if (!isUuid(req.params.id)) {
    return res.status(400).json({ error: 'Invalid medicine identifier.' });
  }

  const medicine = await withTransaction(async (client) => {
    const fields = [];
    const values = [req.params.id];
    let index = 2;

    const allowed = {
      name: cleanText(req.body && req.body.name || '', 200),
      genericName: cleanText(req.body && req.body.genericName || '', 200),
      category: cleanText(req.body && req.body.category || '', 100),
      strength: cleanText(req.body && req.body.strength || '', 100),
      dosageForm: cleanText(req.body && req.body.dosageForm || '', 100),
      unit: cleanText(req.body && req.body.unit || '', 50),
      minimumStockLevel: req.body && req.body.minimumStockLevel !== undefined ? Number(req.body.minimumStockLevel) : null,
      expiryDate: req.body && req.body.expiryDate ? String(req.body.expiryDate) : null,
      batchNumber: cleanText(req.body && req.body.batchNumber || '', 100),
      supplier: cleanText(req.body && req.body.supplier || '', 200),
      status: req.body && req.body.status ? String(req.body.status) : null
    };

    if ([allowed.name, allowed.genericName, allowed.category, allowed.strength, allowed.dosageForm, allowed.unit, allowed.batchNumber, allowed.supplier].includes(null) ||
        (allowed.minimumStockLevel !== null && (!Number.isInteger(allowed.minimumStockLevel) || allowed.minimumStockLevel < 0)) ||
        (allowed.expiryDate && !isDateOnly(allowed.expiryDate)) ||
        (allowed.status && !['active', 'inactive', 'expired', 'discontinued'].includes(allowed.status))) {
      return { invalid: true };
    }

    Object.entries(allowed).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return;
      fields.push(`${key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)} = $${index}`);
      values.push(value);
      index += 1;
    });

    if (!fields.length) {
      return { invalid: true };
    }

    const result = await client.query(
      `UPDATE medicines SET ${fields.join(', ')}, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      values
    );
    if (!result.rowCount) return null;

    await recordAudit(client, {
      actorId: req.user.id,
      action: 'medicine.updated',
      resourceType: 'medicine',
      resourceId: req.params.id,
      module: 'pharmacy',
      description: 'Inventory record updated.'
    });

    return result.rows[0];
  });

  if (!medicine) return res.status(404).json({ error: 'Medicine not found.' });
  if (medicine.invalid) return res.status(400).json({ error: 'Provide valid inventory fields to update.' });
  return res.json({ medicine });
});

router.post('/stock-receive', requireAuth, requirePermission('pharmacy.inventory'), async (req, res) => {
  const {
    medicineId, manufacturedAt, expiresAt, batchNumber, supplier, referenceCode,
    receivedAt, stockLocation, quantity, notes
  } = req.body || {};
  const cleanBatchNumber = cleanText(batchNumber, 100, { required: true });
  const cleanSupplier = cleanText(supplier || '', 200);
  const cleanReferenceCode = cleanText(referenceCode || '', 120);
  const cleanStockLocation = cleanText(stockLocation || '', 120);
  const cleanNotes = cleanText(notes || '', 1000);
  if (!isUuid(medicineId) || !cleanBatchNumber || !Number.isInteger(Number(quantity)) ||
      Number(quantity) <= 0 || [cleanSupplier, cleanReferenceCode, cleanStockLocation].includes(null) ||
      cleanNotes === null || (manufacturedAt && !isDateOnly(manufacturedAt)) ||
      (expiresAt && !isDateOnly(expiresAt)) || (receivedAt && !isDateOnly(receivedAt)) ||
      (manufacturedAt && expiresAt && manufacturedAt > expiresAt)) {
    return res.status(400).json({ error: 'Provide an active medicine, batch number, positive quantity, and valid receipt dates.' });
  }

  const movement = await withTransaction(async (client) => {
    const existing = await client.query(
      `SELECT * FROM medicines WHERE id = $1 AND status = 'active' FOR UPDATE`,
      [medicineId]
    );
    if (!existing.rowCount) return null;

    const expired = await client.query('SELECT $1::date < CURRENT_DATE AS expired', [expiresAt || null]);
    if (expired.rows[0].expired) {
      const error = new Error('Expired stock cannot be received into available inventory.');
      error.statusCode = 400;
      throw error;
    }

    const existingBatch = await client.query(
      `SELECT * FROM medicine_batches WHERE medicine_id = $1 AND batch_number = $2 FOR UPDATE`,
      [medicineId, cleanBatchNumber]
    );
    let batch;
    if (existingBatch.rowCount) {
      const row = existingBatch.rows[0];
      if (row.status !== 'active' ||
          (manufacturedAt && row.manufactured_at && manufacturedAt !== dateOnly(row.manufactured_at)) ||
          (expiresAt && row.expires_at && expiresAt !== dateOnly(row.expires_at))) {
        const error = new Error('This batch already exists with different dates or is not eligible for receiving.');
        error.statusCode = 409;
        throw error;
      }
      const updatedBatch = await client.query(
        `UPDATE medicine_batches
         SET quantity_received = quantity_received + $1, current_quantity = current_quantity + $1,
             manufactured_at = COALESCE(manufactured_at, $2::date),
             expires_at = COALESCE(expires_at, $3::date), supplier = COALESCE($4, supplier),
             stock_location = COALESCE($5, stock_location), updated_at = NOW()
         WHERE id = $6 RETURNING *`,
        [Number(quantity), manufacturedAt || null, expiresAt || null, cleanSupplier || null, cleanStockLocation || null, row.id]
      );
      batch = updatedBatch.rows[0];
    } else {
      const createdBatch = await client.query(
        `INSERT INTO medicine_batches
           (medicine_id, batch_number, manufactured_at, expires_at, quantity_received,
            current_quantity, supplier, received_at, received_by, stock_location)
         VALUES ($1, $2, $3, $4, $5, $5, $6, COALESCE($7::date::timestamptz, NOW()), $8, $9)
         RETURNING *`,
        [medicineId, cleanBatchNumber, manufacturedAt || null, expiresAt || null, Number(quantity),
          cleanSupplier || null, receivedAt || null, req.user.id, cleanStockLocation || null]
      );
      batch = createdBatch.rows[0];
    }

    const result = await client.query(
      `UPDATE medicines SET current_quantity = current_quantity + $1, updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [Number(quantity), medicineId]
    );

    const movementResult = await client.query(
      `INSERT INTO stock_movements
         (medicine_id, batch_id, movement_type, quantity, quantity_before, quantity_after,
          reference_type, reference_id, reference_code, created_by, notes, created_at)
       VALUES ($1, $2, 'stock_received', $3, $4, $5, 'stock_receive', $6, $7, $8, $9,
               COALESCE($10::date::timestamptz, NOW()))
       RETURNING *`,
      [medicineId, batch.id, Number(quantity), Number(existing.rows[0].current_quantity),
        Number(result.rows[0].current_quantity), medicineId, cleanReferenceCode || null, req.user.id,
        cleanNotes || 'Stock received', receivedAt || null]
    );

    await recordAudit(client, {
      actorId: req.user.id,
      action: 'stock.received',
      resourceType: 'medicine_batch',
      resourceId: batch.id,
      module: 'pharmacy',
      description: `Stock received: ${quantity} ${result.rows[0].unit || 'units'} of ${result.rows[0].name}, batch ${batch.batch_number}.`
    });

    return { movement: movementResult.rows[0], batch, medicine: result.rows[0] };
  });

  if (!movement) return res.status(404).json({ error: 'Medicine not found.' });
  return res.status(201).json(movement);
});

router.post('/stock-adjustments', requireAuth, requirePermission('pharmacy.inventory'), async (req, res) => {
  const batchId = req.body && req.body.batchId;
  const quantity = Number(req.body && req.body.quantity);
  const reason = cleanText(req.body && req.body.reason, 1000, { required: true });
  if (!isUuid(batchId) || !Number.isInteger(quantity) || quantity === 0 || !reason) {
    return res.status(400).json({ error: 'Select a stock batch, enter a non-zero quantity adjustment, and provide a reason.' });
  }

  const adjustment = await withTransaction(async (client) => {
    const batchOwner = await client.query('SELECT medicine_id FROM medicine_batches WHERE id = $1', [batchId]);
    if (!batchOwner.rowCount) return null;
    const medicine = await client.query(
      `SELECT id, current_quantity FROM medicines WHERE id = $1 AND status = 'active' FOR UPDATE`,
      [batchOwner.rows[0].medicine_id]
    );
    if (!medicine.rowCount) return null;
    const batchResult = await client.query(
      `SELECT * FROM medicine_batches WHERE id = $1 FOR UPDATE`,
      [batchId]
    );
    if (!batchResult.rowCount) return null;
    const batch = batchResult.rows[0];
    if (quantity > 0 && (batch.status !== 'active' || batch.expires_at &&
        dateOnly(batch.expires_at) < new Date().toISOString().slice(0, 10))) {
      const error = new Error('Expired or quarantined stock cannot be increased.');
      error.statusCode = 400;
      throw error;
    }
    if (Number(batch.current_quantity) + quantity < 0) {
      const error = new Error('Adjustment cannot reduce a batch below zero stock.');
      error.statusCode = 400;
      throw error;
    }
    if (Number(medicine.rows[0].current_quantity) + quantity < 0) {
      const error = new Error('Adjustment cannot reduce total medicine stock below zero.');
      error.statusCode = 400;
      throw error;
    }
    const updatedBatch = await client.query(
      `UPDATE medicine_batches SET current_quantity = current_quantity + $1, updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [quantity, batchId]
    );
    const updatedMedicine = await client.query(
      `UPDATE medicines SET current_quantity = current_quantity + $1, updated_at = NOW()
       WHERE id = $2 RETURNING current_quantity`,
      [quantity, batch.medicine_id]
    );
    const movement = await client.query(
      `INSERT INTO stock_movements
         (medicine_id, batch_id, movement_type, quantity, quantity_before, quantity_after,
          reference_type, reference_id, created_by, notes)
       VALUES ($1, $2, 'stock_adjusted', $3, $4, $5, 'stock_adjustment', $2, $6, $7)
       RETURNING *`,
      [batch.medicine_id, batchId, quantity, Number(medicine.rows[0].current_quantity),
        Number(updatedMedicine.rows[0].current_quantity), req.user.id, reason]
    );
    await recordAudit(client, {
      actorId: req.user.id,
      action: 'stock.adjusted',
      resourceType: 'medicine_batch',
      resourceId: batchId,
      module: 'pharmacy',
      description: `Batch ${batch.batch_number} adjusted by ${quantity}: ${reason}`
    });
    return { batch: updatedBatch.rows[0], movement: movement.rows[0] };
  });
  if (!adjustment) return res.status(404).json({ error: 'Stock batch not found.' });
  return res.json(adjustment);
});

router.patch('/batches/:id/status', requireAuth, requirePermission('pharmacy.inventory'), async (req, res) => {
  const status = req.body && req.body.status;
  const reason = cleanText(req.body && req.body.reason, 1000, { required: true });
  if (!isUuid(req.params.id) || !['active', 'quarantined'].includes(status) || !reason) {
    return res.status(400).json({ error: 'Select active or quarantined and provide a reason.' });
  }
  const batch = await withTransaction(async (client) => {
    const owner = await client.query('SELECT medicine_id FROM medicine_batches WHERE id = $1', [req.params.id]);
    if (!owner.rowCount) return null;
    await client.query('SELECT id FROM medicines WHERE id = $1 FOR UPDATE', [owner.rows[0].medicine_id]);
    const current = await client.query('SELECT * FROM medicine_batches WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!current.rowCount) return null;
    if (status === 'active') {
      const expired = await client.query(
        'SELECT $1::date IS NOT NULL AND $1::date < CURRENT_DATE AS expired',
        [current.rows[0].expires_at]
      );
      if (expired.rows[0].expired) {
        const error = new Error('An expired batch cannot be returned to available stock.');
        error.statusCode = 400;
        throw error;
      }
    }
    const updated = await client.query(
      `UPDATE medicine_batches SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [status, req.params.id]
    );
    await recordAudit(client, {
      actorId: req.user.id,
      action: status === 'quarantined' ? 'stock.batch_quarantined' : 'stock.batch_released',
      resourceType: 'medicine_batch',
      resourceId: req.params.id,
      module: 'pharmacy',
      description: `Batch ${current.rows[0].batch_number} marked ${status}: ${reason}`
    });
    return updated.rows[0];
  });
  if (!batch) return res.status(404).json({ error: 'Stock batch not found.' });
  return res.json({ batch });
});

router.get('/stock-movements', requireAuth, requirePermission('pharmacy.inventory'), async (req, res) => {
  const limit = Number(req.query.limit || 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    return res.status(400).json({ error: 'Provide a valid stock history page size.' });
  }
  const movements = await withTransaction(async (client) => {
    const result = await client.query(
      `SELECT sm.id, sm.movement_type, sm.quantity, sm.quantity_before, sm.quantity_after,
              sm.reference_type, sm.reference_code, sm.notes, sm.created_at,
              m.id AS medicine_id, m.name, m.strength, m.dosage_form, m.unit,
              b.id AS batch_id, b.batch_number, b.expires_at, u.username AS received_or_dispensed_by
       FROM stock_movements sm
       JOIN medicines m ON m.id = sm.medicine_id
       LEFT JOIN medicine_batches b ON b.id = sm.batch_id
       LEFT JOIN users u ON u.id = sm.created_by
       ORDER BY sm.created_at DESC, sm.id DESC LIMIT $1`,
      [limit]
    );
    return result.rows;
  });
  return res.json({ movements });
});

router.post('/dispense', requireAuth, requirePermission('pharmacy.dispense'), async (req, res) => {
  const prescriptionId = req.body && req.body.prescriptionId;
  const batchId = req.body && req.body.batchId;
  const medicineId = req.body && req.body.medicineId;
  const quantity = Number(req.body && req.body.quantity || 0);
  const notes = cleanText(req.body && req.body.notes || '', 1000);

  if (!isUuid(prescriptionId) || (!isUuid(batchId) && !isUuid(medicineId)) ||
      !Number.isInteger(quantity) || quantity <= 0 || notes === null) {
    return res.status(400).json({ error: 'Provide a valid prescription, stock batch, and positive quantity.' });
  }

  const outcome = await withTransaction(async (client) => {
    const prescription = await client.query(
      `SELECT rx.*, p.archived_at FROM prescriptions rx
       JOIN patients p ON p.id = rx.patient_id
       WHERE rx.id = $1 AND p.archived_at IS NULL
         AND rx.status IN ('active', 'pending', 'partially_dispensed')
       FOR UPDATE OF rx`,
      [prescriptionId]
    );
    if (!prescription.rowCount) {
      const error = new Error('Prescription not found or already dispensed.');
      error.statusCode = 404;
      throw error;
    }

    let selectedMedicineId = medicineId;
    if (batchId) {
      const batchOwner = await client.query('SELECT medicine_id FROM medicine_batches WHERE id = $1', [batchId]);
      if (!batchOwner.rowCount) {
        const error = new Error('Stock batch not found.');
        error.statusCode = 404;
        throw error;
      }
      selectedMedicineId = batchOwner.rows[0].medicine_id;
    }
    const medicine = await client.query(
      `SELECT * FROM medicines WHERE id = $1 AND status = 'active' FOR UPDATE`,
      [selectedMedicineId]
    );
    if (!medicine.rowCount) {
      const error = new Error('Medicine not found or inactive.');
      error.statusCode = 404;
      throw error;
    }

    let batch;
    if (batchId) {
      const selectedBatch = await client.query(
        `SELECT b.*, m.name, m.generic_name, m.strength, m.dosage_form, m.unit
         FROM medicine_batches b JOIN medicines m ON m.id = b.medicine_id
         WHERE b.id = $1 AND b.medicine_id = $2 FOR UPDATE OF b`,
        [batchId, selectedMedicineId]
      );
      batch = selectedBatch.rows[0];
    } else {
      const selectedBatch = await client.query(
        `SELECT b.*, m.name, m.generic_name, m.strength, m.dosage_form, m.unit
         FROM medicine_batches b JOIN medicines m ON m.id = b.medicine_id
         WHERE b.medicine_id = $1 AND b.status = 'active'
           AND b.current_quantity > 0 AND (b.expires_at IS NULL OR b.expires_at >= CURRENT_DATE)
         ORDER BY b.expires_at NULLS LAST, b.received_at, b.id
         LIMIT 1 FOR UPDATE OF b SKIP LOCKED`,
        [selectedMedicineId]
      );
      batch = selectedBatch.rows[0];
      if (!batch) {
        const expiredBatch = await client.query(
          `SELECT b.id FROM medicine_batches b
           WHERE b.medicine_id = $1 AND b.status = 'active' AND b.current_quantity > 0
             AND b.expires_at < CURRENT_DATE LIMIT 1`,
          [selectedMedicineId]
        );
        if (expiredBatch.rowCount) {
          const error = new Error('Medicine is expired and cannot be dispensed.');
          error.statusCode = 400;
          throw error;
        }
      }
    }
    if (!batch) {
      const error = new Error('Stock batch not found or medicine is inactive.');
      error.statusCode = 404;
      throw error;
    }
    const prescribedMedicine = prescription.rows[0].medication.trim().toLocaleLowerCase();
    const inventoryNames = [batch.name, batch.generic_name].filter(Boolean).map((name) => name.trim().toLocaleLowerCase());
    if (prescription.rows[0].medicine_id
        ? prescription.rows[0].medicine_id !== batch.medicine_id
        : !inventoryNames.includes(prescribedMedicine)) {
      const error = new Error('Selected inventory medicine does not match the prescribed medicine.');
      error.statusCode = 400;
      throw error;
    }
    const batchState = await client.query(
      `SELECT $1::text <> 'active' OR ($2::date IS NOT NULL AND $2::date < CURRENT_DATE) AS unavailable`,
      [batch.status, batch.expires_at]
    );
    if (batchState.rows[0].unavailable) {
      const error = new Error('Stock is expired or quarantined and cannot be dispensed.');
      error.statusCode = 400;
      throw error;
    }
    if (Number(batch.current_quantity) < quantity) {
      const error = new Error('Dispense quantity exceeds available batch stock.');
      error.statusCode = 400;
      throw error;
    }
    const alreadyDispensedResult = await client.query(
      `SELECT COALESCE(SUM(dispensed_quantity), 0)::int AS total
       FROM dispensing WHERE prescription_id = $1 AND status <> 'cancelled'`,
      [prescriptionId]
    );
    const alreadyDispensed = alreadyDispensedResult.rows[0].total;
    const prescribedQuantity = prescription.rows[0].quantity;
    if (!Number.isInteger(prescribedQuantity) || prescribedQuantity < 1 || quantity > prescribedQuantity - alreadyDispensed) {
      const error = new Error('Dispense quantity exceeds the remaining prescribed quantity.');
      error.statusCode = 400;
      throw error;
    }
    const available = Number(medicine.rows[0].current_quantity || 0);
    if (quantity > available) {
      const error = new Error('Dispense quantity exceeds available stock.');
      error.statusCode = 400;
      throw error;
    }

    const batchUpdate = await client.query(
      `UPDATE medicine_batches SET current_quantity = current_quantity - $1, updated_at = NOW()
       WHERE id = $2 AND current_quantity >= $1 AND status = 'active'
         AND (expires_at IS NULL OR expires_at >= CURRENT_DATE)
       RETURNING current_quantity`,
      [quantity, batch.id]
    );
    if (!batchUpdate.rowCount) {
      const error = new Error('Stock batch is expired or no longer has sufficient stock.');
      error.statusCode = 409;
      throw error;
    }
    const stockUpdate = await client.query(
      `UPDATE medicines SET current_quantity = current_quantity - $1, updated_at = NOW()
       WHERE id = $2 AND current_quantity >= $1
       RETURNING current_quantity`,
      [quantity, batch.medicine_id]
    );
    if (!stockUpdate.rowCount) {
      const error = new Error('Medicine is expired or no longer has sufficient stock.');
      error.statusCode = 409;
      throw error;
    }
    const after = Number(stockUpdate.rows[0].current_quantity);

    const before = available;
    const stockMovement = await client.query(
      `INSERT INTO stock_movements
         (medicine_id, batch_id, movement_type, quantity, quantity_before, quantity_after, reference_type, reference_id, created_by, notes)
       VALUES ($1, $2, 'stock_dispensed', $3, $4, $5, 'prescription', $6, $7, $8)
       RETURNING *`,
      [batch.medicine_id, batch.id, -quantity, before, after, prescriptionId, req.user.id, notes || 'Dispensed against prescription']
    );

    const dispensing = await client.query(
      `INSERT INTO dispensing (prescription_id, medicine_id, batch_id, dispensed_quantity, pharmacist_id, notes, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [prescriptionId, batch.medicine_id, batch.id, quantity, req.user.id, notes || 'Prescription dispensed', alreadyDispensed + quantity >= prescribedQuantity ? 'dispensed' : 'partial']
    );

    const updatedStatus = alreadyDispensed + quantity >= prescribedQuantity ? 'dispensed' : 'partially_dispensed';
    const updatedPrescription = await client.query(
      `UPDATE prescriptions SET status = $1 WHERE id = $2 RETURNING *`,
      [updatedStatus, prescriptionId]
    );

    await recordAudit(client, {
      actorId: req.user.id,
      action: 'medicine.dispensed',
      resourceType: 'prescription',
      resourceId: prescriptionId,
      module: 'pharmacy',
      description: `Dispensed ${quantity} ${batch.unit || 'units'} from batch ${batch.batch_number} against prescription.`
    });

    if (prescription.rows[0].consultation_id) {
      const visitUpdate = await client.query(
        `UPDATE visits v SET status = CASE
           WHEN NOT v.clinical_completed THEN v.status
           WHEN EXISTS (SELECT 1 FROM lab_requests lr WHERE lr.visit_id = v.id
             AND lr.status IN ('pending', 'collected', 'received', 'processing', 'result_entered', 'verified', 'correction_pending', 'in_progress')) THEN 'lab_requested'
           WHEN v.clinical_completed AND NOT EXISTS (SELECT 1 FROM prescriptions p WHERE p.consultation_id = v.id AND p.status IN ('active', 'pending', 'partially_dispensed')) THEN 'completed'
           ELSE v.status END
         WHERE v.id = $1 RETURNING status, appointment_id`,
        [prescription.rows[0].consultation_id]
      );
      if (visitUpdate.rows[0] && visitUpdate.rows[0].status === 'completed' && visitUpdate.rows[0].appointment_id) {
        await client.query(
          `UPDATE appointments SET status = 'completed', updated_at = NOW() WHERE id = $1`,
          [visitUpdate.rows[0].appointment_id]
        );
      }
    }

    return { stockMovement: stockMovement.rows[0], dispensing: dispensing.rows[0], batch: batchUpdate.rows[0], prescription: updatedPrescription.rows[0] };
  });

  return res.json({ outcome });
});

router.get('/alerts', requireAuth, requirePermission('pharmacy.inventory'), async (req, res) => {
  const alerts = await withTransaction(async (client) => {
    const lowStock = await client.query(
      `SELECT * FROM medicines WHERE current_quantity <= minimum_stock_level AND status = 'active' ORDER BY current_quantity ASC`
    );
    const expiring = await client.query(
      `SELECT b.*, b.expires_at::text AS expires_at, m.name, m.strength, m.dosage_form, m.unit
       FROM medicine_batches b JOIN medicines m ON m.id = b.medicine_id
       WHERE b.status = 'active' AND b.current_quantity > 0
         AND b.expires_at IS NOT NULL AND b.expires_at <= CURRENT_DATE + INTERVAL '30 days'
       ORDER BY b.expires_at, m.name`
    );
    const outOfStock = await client.query(
      `SELECT * FROM medicines WHERE current_quantity = 0 AND status = 'active' ORDER BY name`
    );
    const expired = await client.query(
      `SELECT b.*, b.expires_at::text AS expires_at, m.name, m.strength, m.dosage_form, m.unit
       FROM medicine_batches b JOIN medicines m ON m.id = b.medicine_id
       WHERE b.current_quantity > 0 AND b.expires_at < CURRENT_DATE
       ORDER BY b.expires_at, m.name`
    );
    return { lowStock: lowStock.rows, outOfStock: outOfStock.rows, expiring: expiring.rows, expired: expired.rows };
  });

  return res.json(alerts);
});

module.exports = router;
