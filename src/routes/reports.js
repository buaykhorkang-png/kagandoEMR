const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { isDateOnly } = require('../security/validation');
const { withTransaction } = require('../services/transaction');

const router = express.Router();

function getDateWindow(req) {
  const startDate = req.query.startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const endDate = req.query.endDate || new Date().toISOString().slice(0, 10);
  if (!isDateOnly(startDate) || !isDateOnly(endDate) || startDate > endDate) {
    return null;
  }
  return { startDate, endDate };
}

router.get('/daily', requireAuth, requirePermission('reports.view'), async (req, res) => {
  const dateWindow = getDateWindow(req);
  if (!dateWindow) return res.status(400).json({ error: 'Provide a valid date range.' });
  const { startDate, endDate } = dateWindow;

  const summary = await withTransaction(async (client) => {
    const patients = await client.query(
      `SELECT COUNT(*)::int AS total FROM patients WHERE registration_date::date BETWEEN $1::date AND $2::date AND archived_at IS NULL`,
      [startDate, endDate]
    );
    const consultations = await client.query(
      `SELECT COUNT(*)::int AS total FROM visits WHERE visit_date::date BETWEEN $1::date AND $2::date`,
      [startDate, endDate]
    );
    const diagnoses = await client.query(
      `SELECT COUNT(*)::int AS total FROM visits WHERE diagnosis IS NOT NULL AND visit_date::date BETWEEN $1::date AND $2::date`,
      [startDate, endDate]
    );
    const prescriptions = await client.query(
      `SELECT COUNT(*)::int AS total FROM prescriptions WHERE prescription_date::date BETWEEN $1::date AND $2::date`,
      [startDate, endDate]
    );
    const medicinesDispensed = await client.query(
      `SELECT COALESCE(SUM(dispensed_quantity), 0)::int AS total FROM dispensing WHERE dispensed_at::date BETWEEN $1::date AND $2::date`,
      [startDate, endDate]
    );
    const stockActivity = await client.query(
      `SELECT COALESCE(SUM(CASE WHEN movement_type IN ('stock_received', 'stock_dispensed', 'stock_adjusted', 'damaged_stock', 'expired_stock') THEN ABS(quantity) ELSE 0 END), 0)::int AS total
       FROM stock_movements
       WHERE created_at::date BETWEEN $1::date AND $2::date`,
      [startDate, endDate]
    );
    const laboratory = await client.query(
      `SELECT
         COUNT(*) FILTER (WHERE requested_at::date BETWEEN $1::date AND $2::date)::int AS requested,
         (SELECT COUNT(*)::int FROM lab_result_versions WHERE released_at::date BETWEEN $1::date AND $2::date) AS released,
         COUNT(*) FILTER (WHERE rejected_at::date BETWEEN $1::date AND $2::date AND status = 'rejected')::int AS rejected,
         COUNT(*) FILTER (WHERE cancelled_at::date BETWEEN $1::date AND $2::date AND status = 'cancelled')::int AS cancelled
       FROM lab_requests`,
      [startDate, endDate]
    );

    return {
      dateRange: { startDate, endDate },
      patients: patients.rows[0].total,
      consultations: consultations.rows[0].total,
      diagnoses: diagnoses.rows[0].total,
      prescriptions: prescriptions.rows[0].total,
      medicinesDispensed: medicinesDispensed.rows[0].total,
      stockActivity: stockActivity.rows[0].total,
      laboratory: laboratory.rows[0]
    };
  });

  return res.json({ summary });
});

router.get('/monthly', requireAuth, requirePermission('reports.view'), async (req, res) => {
  const dateWindow = getDateWindow(req);
  if (!dateWindow) return res.status(400).json({ error: 'Provide a valid date range.' });
  const { startDate, endDate } = dateWindow;

  const summary = await withTransaction(async (client) => {
    const totalPatients = await client.query(
      `SELECT COUNT(*)::int AS total FROM patients WHERE archived_at IS NULL AND registration_date::date BETWEEN $1::date AND $2::date`,
      [startDate, endDate]
    );
    const maleStats = await client.query(
      `SELECT COUNT(*)::int AS total FROM patients WHERE gender = 'male' AND registration_date::date BETWEEN $1::date AND $2::date AND archived_at IS NULL`,
      [startDate, endDate]
    );
    const femaleStats = await client.query(
      `SELECT COUNT(*)::int AS total FROM patients WHERE gender = 'female' AND registration_date::date BETWEEN $1::date AND $2::date AND archived_at IS NULL`,
      [startDate, endDate]
    );
    const consultations = await client.query(
      `SELECT COUNT(*)::int AS total FROM visits WHERE visit_date::date BETWEEN $1::date AND $2::date`,
      [startDate, endDate]
    );
    const diagnoses = await client.query(
      `SELECT diagnosis, COUNT(*)::int AS total FROM visits WHERE diagnosis IS NOT NULL AND visit_date::date BETWEEN $1::date AND $2::date GROUP BY diagnosis ORDER BY total DESC LIMIT 10`,
      [startDate, endDate]
    );
    const dispensed = await client.query(
      `SELECT COALESCE(SUM(dispensed_quantity), 0)::int AS total FROM dispensing WHERE dispensed_at::date BETWEEN $1::date AND $2::date`,
      [startDate, endDate]
    );
    const stockReceived = await client.query(
      `SELECT COALESCE(SUM(quantity), 0)::int AS total FROM stock_movements WHERE movement_type = 'stock_received' AND created_at::date BETWEEN $1::date AND $2::date`,
      [startDate, endDate]
    );
    const stockIssued = await client.query(
      `SELECT COALESCE(SUM(ABS(quantity)), 0)::int AS total FROM stock_movements WHERE movement_type = 'stock_dispensed' AND created_at::date BETWEEN $1::date AND $2::date`,
      [startDate, endDate]
    );
    const currentStock = await client.query('SELECT COALESCE(SUM(current_quantity), 0)::int AS total FROM medicines WHERE status = $1', ['active']);
    const laboratory = await client.query(
      `SELECT
         COUNT(*) FILTER (WHERE requested_at::date BETWEEN $1::date AND $2::date)::int AS requested,
         (SELECT COUNT(*)::int FROM lab_result_versions WHERE released_at::date BETWEEN $1::date AND $2::date) AS released,
         COUNT(*) FILTER (WHERE rejected_at::date BETWEEN $1::date AND $2::date AND status = 'rejected')::int AS rejected,
         COUNT(*) FILTER (WHERE cancelled_at::date BETWEEN $1::date AND $2::date AND status = 'cancelled')::int AS cancelled
       FROM lab_requests`,
      [startDate, endDate]
    );

    return {
      dateRange: { startDate, endDate },
      totalPatients: totalPatients.rows[0].total,
      malePatients: maleStats.rows[0].total,
      femalePatients: femaleStats.rows[0].total,
      consultations: consultations.rows[0].total,
      commonDiagnoses: diagnoses.rows,
      medicinesDispensed: dispensed.rows[0].total,
      stockReceived: stockReceived.rows[0].total,
      stockIssued: stockIssued.rows[0].total,
      currentStock: currentStock.rows[0].total,
      laboratory: laboratory.rows[0]
    };
  });

  return res.json({ summary });
});

module.exports = router;
