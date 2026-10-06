const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { cleanText, isDateOnly, isUuid } = require('../security/validation');
const { recordAudit } = require('../services/audit');
const { withTransaction } = require('../services/transaction');

const router = express.Router();

router.get('/medicines', requireAuth, requirePermission('pharmacy.inventory'), async (req, res) => {
  const medicines = await withTransaction(async (client) => {
    const result = await client.query(
      `SELECT * FROM medicines WHERE status <> 'discontinued' ORDER BY name ASC`
    );
    return result.rows;
  });

  return res.json({ medicines });
});

router.post('/medicines', requireAuth, requirePermission('pharmacy.inventory'), async (req, res) => {
  const name = cleanText(req.body && req.body.name, 200, { required: true });
  const genericName = cleanText(req.body && req.body.genericName || '', 200);
  const category = cleanText(req.body && req.body.category || '', 100);
  const strength = cleanText(req.body && req.body.strength || '', 100);
  const dosageForm = cleanText(req.body && req.body.dosageForm || '', 100);
  const unit = cleanText(req.body && req.body.unit || '', 50);
  const quantity = Number(req.body && req.body.quantity || 0);
  const minimumStockLevel = Number(req.body && req.body.minimumStockLevel || 0);
  const expiryDate = req.body && req.body.expiryDate ? String(req.body.expiryDate) : null;
  const batchNumber = cleanText(req.body && req.body.batchNumber || '', 100);
  const supplier = cleanText(req.body && req.body.supplier || '', 200);

  if (!name || !Number.isInteger(quantity) || quantity < 0 || !Number.isInteger(minimumStockLevel) || minimumStockLevel < 0 ||
      (expiryDate && !isDateOnly(expiryDate)) || [genericName, category, strength, dosageForm, unit, batchNumber, supplier].includes(null)) {
    return res.status(400).json({ error: 'Provide a valid medicine name, quantity, and minimum stock level.' });
  }

  const medicine = await withTransaction(async (client) => {
    const result = await client.query(
      `INSERT INTO medicines (name, generic_name, category, strength, dosage_form, unit, current_quantity, minimum_stock_level, expiry_date, batch_number, supplier, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active')
       RETURNING *`,
      [name, genericName || null, category || null, strength || null, dosageForm || null, unit || null, quantity, minimumStockLevel, expiryDate || null, batchNumber || null, supplier || null]
    );
    if (quantity > 0) {
      await client.query(
        `INSERT INTO stock_movements (medicine_id, movement_type, quantity, quantity_before, quantity_after, reference_type, reference_id, created_by, notes)
         VALUES ($1, 'stock_received', $2, 0, $2, 'initial_stock', $1, $3, 'Initial stock at medicine creation')`,
        [result.rows[0].id, quantity, req.user.id]
      );
    }

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
    medicineId, medicineName, genericName, strength, dosageForm, unit, minimumStockLevel,
    expiryDate, batchNumber, supplier, quantity, notes
  } = req.body || {};
  const isNewMedicine = medicineId === 'new';
  const cleanName = isNewMedicine ? cleanText(medicineName, 200, { required: true }) : null;
  const cleanGenericName = cleanText(genericName || '', 200);
  const cleanStrength = cleanText(strength || '', 100);
  const cleanDosageForm = cleanText(dosageForm || '', 100);
  const cleanUnit = cleanText(unit || '', 50);
  const cleanBatchNumber = cleanText(batchNumber || '', 100);
  const cleanSupplier = cleanText(supplier || '', 200);
  const stockMinimum = minimumStockLevel === undefined || minimumStockLevel === '' ? 0 : Number(minimumStockLevel);
  const cleanNotes = cleanText(notes || '', 1000);
  if ((!isNewMedicine && !isUuid(medicineId)) ||
      (isNewMedicine && (!cleanName || !Number.isInteger(stockMinimum) || stockMinimum < 0 ||
        [cleanGenericName, cleanStrength, cleanDosageForm, cleanUnit, cleanBatchNumber, cleanSupplier].includes(null) ||
        (expiryDate && !isDateOnly(String(expiryDate))))) ||
      !Number.isInteger(Number(quantity)) || Number(quantity) <= 0 || cleanNotes === null) {
    return res.status(400).json({ error: 'Provide a medicine name and a positive stock amount, or select an existing medicine.' });
  }

  const movement = await withTransaction(async (client) => {
    let selectedMedicineId = medicineId;
    if (isNewMedicine) {
      const created = await client.query(
        `INSERT INTO medicines (name, generic_name, strength, dosage_form, unit, current_quantity,
                                minimum_stock_level, expiry_date, batch_number, supplier, status)
         VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8, $9, 'active')
         RETURNING id`,
        [cleanName, cleanGenericName || null, cleanStrength || null, cleanDosageForm || null, cleanUnit || null,
          stockMinimum, expiryDate || null, cleanBatchNumber || null, cleanSupplier || null]
      );
      selectedMedicineId = created.rows[0].id;
      await recordAudit(client, {
        actorId: req.user.id,
        action: 'medicine.added',
        resourceType: 'medicine',
        resourceId: selectedMedicineId,
        module: 'pharmacy',
        description: 'Medicine added while receiving stock.'
      });
    }

    const existing = await client.query('SELECT * FROM medicines WHERE id = $1 FOR UPDATE', [selectedMedicineId]);
    if (!existing.rowCount) return null;

    const before = Number(existing.rows[0].current_quantity || 0);
    const after = before + Number(quantity);
    const result = await client.query(
      `UPDATE medicines SET current_quantity = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [after, selectedMedicineId]
    );

    const movementResult = await client.query(
      `INSERT INTO stock_movements (medicine_id, movement_type, quantity, quantity_before, quantity_after, reference_type, reference_id, created_by, notes)
       VALUES ($1, 'stock_received', $2, $3, $4, 'stock_receive', $5, $6, $7)
       RETURNING *`,
      [selectedMedicineId, Number(quantity), before, after, selectedMedicineId, req.user.id, cleanNotes || 'Stock received']
    );

    await recordAudit(client, {
      actorId: req.user.id,
      action: 'stock.received',
      resourceType: 'medicine',
      resourceId: selectedMedicineId,
      module: 'pharmacy',
      description: `Stock received: ${quantity} ${result.rows[0].unit || 'units'} of ${result.rows[0].name}.`
    });

    return { movement: movementResult.rows[0], medicine: result.rows[0] };
  });

  if (!movement) return res.status(404).json({ error: 'Medicine not found.' });
  return res.status(201).json(movement);
});

router.post('/dispense', requireAuth, requirePermission('pharmacy.dispense'), async (req, res) => {
  const prescriptionId = req.body && req.body.prescriptionId;
  const medicineId = req.body && req.body.medicineId;
  const quantity = Number(req.body && req.body.quantity || 0);
  const notes = cleanText(req.body && req.body.notes || '', 1000);

  if (!isUuid(prescriptionId) || !isUuid(medicineId) || !Number.isInteger(quantity) || quantity <= 0) {
    return res.status(400).json({ error: 'Provide a valid prescription, medicine, and positive quantity.' });
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

    const medicine = await client.query('SELECT * FROM medicines WHERE id = $1 AND status = $2 FOR UPDATE', [medicineId, 'active']);
    if (!medicine.rowCount) {
      const error = new Error('Medicine not found or inactive.');
      error.statusCode = 404;
      throw error;
    }

    const prescribedMedicine = prescription.rows[0].medication.trim().toLocaleLowerCase();
    const inventoryNames = [medicine.rows[0].name, medicine.rows[0].generic_name].filter(Boolean).map((name) => name.trim().toLocaleLowerCase());
    if (!inventoryNames.includes(prescribedMedicine)) {
      const error = new Error('Selected inventory medicine does not match the prescribed medicine.');
      error.statusCode = 400;
      throw error;
    }
    const expiry = await client.query(
      'SELECT expiry_date IS NOT NULL AND expiry_date < CURRENT_DATE AS expired FROM medicines WHERE id = $1',
      [medicineId]
    );
    if (expiry.rows[0].expired) {
      const error = new Error('Medicine is expired and cannot be dispensed.');
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

    const before = available;
    const stockUpdate = await client.query(
      `UPDATE medicines SET current_quantity = current_quantity - $1, updated_at = NOW()
       WHERE id = $2 AND current_quantity >= $1 AND (expiry_date IS NULL OR expiry_date >= CURRENT_DATE)
       RETURNING current_quantity`,
      [quantity, medicineId]
    );
    if (!stockUpdate.rowCount) {
      const error = new Error('Medicine is expired or no longer has sufficient stock.');
      error.statusCode = 409;
      throw error;
    }
    const after = Number(stockUpdate.rows[0].current_quantity);

    const stockMovement = await client.query(
      `INSERT INTO stock_movements (medicine_id, movement_type, quantity, quantity_before, quantity_after, reference_type, reference_id, created_by, notes)
       VALUES ($1, 'stock_dispensed', $2, $3, $4, 'prescription', $5, $6, $7)
       RETURNING *`,
      [medicineId, -quantity, before, after, prescriptionId, req.user.id, notes || 'Dispensed against prescription']
    );

    const dispensing = await client.query(
      `INSERT INTO dispensing (prescription_id, medicine_id, dispensed_quantity, pharmacist_id, notes, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [prescriptionId, medicineId, quantity, req.user.id, notes || 'Prescription dispensed', alreadyDispensed + quantity >= prescribedQuantity ? 'dispensed' : 'partial']
    );

    const updatedStatus = alreadyDispensed + quantity >= prescribedQuantity ? 'dispensed' : 'partially_dispensed';
    const updatedPrescription = await client.query(
      `UPDATE prescriptions SET status = $1, prescription_date = NOW() WHERE id = $2 RETURNING *`,
      [updatedStatus, prescriptionId]
    );

    await recordAudit(client, {
      actorId: req.user.id,
      action: 'medicine.dispensed',
      resourceType: 'prescription',
      resourceId: prescriptionId,
      module: 'pharmacy',
      description: `Dispensed ${quantity} units of medicine against prescription.`
    });

    if (prescription.rows[0].consultation_id) {
      const visitUpdate = await client.query(
        `UPDATE visits v SET status = CASE
           WHEN NOT v.clinical_completed THEN v.status
           WHEN EXISTS (SELECT 1 FROM lab_requests lr WHERE lr.visit_id = v.id AND lr.status IN ('pending', 'in_progress')) THEN 'lab_requested'
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

    return { stockMovement: stockMovement.rows[0], dispensing: dispensing.rows[0], prescription: updatedPrescription.rows[0] };
  });

  return res.json({ outcome });
});

router.get('/alerts', requireAuth, requirePermission('pharmacy.inventory'), async (req, res) => {
  const alerts = await withTransaction(async (client) => {
    const lowStock = await client.query(
      `SELECT * FROM medicines WHERE current_quantity <= minimum_stock_level AND status = 'active' ORDER BY current_quantity ASC`
    );
    const expiring = await client.query(
      `SELECT * FROM medicines WHERE expiry_date IS NOT NULL AND expiry_date <= CURRENT_DATE + INTERVAL '30 days' AND status = 'active' ORDER BY expiry_date ASC`
    );
    const outOfStock = await client.query(
      `SELECT * FROM medicines WHERE current_quantity = 0 AND status = 'active' ORDER BY name`
    );
    return { lowStock: lowStock.rows, outOfStock: outOfStock.rows, expiring: expiring.rows };
  });

  return res.json(alerts);
});

module.exports = router;
