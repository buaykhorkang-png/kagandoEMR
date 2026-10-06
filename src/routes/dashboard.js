const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { withTransaction } = require('../services/transaction');

const router = express.Router();

const roleDashboards = {
  clerk: 'clerk',
  nurse: 'nursing',
  clinician: 'clinical',
  pharmacist: 'pharmacy',
  laboratory: 'laboratory',
  management: 'management',
  administrator: 'administration'
};

const dashboardPermissions = {
  clerk: 'dashboard.clerk',
  nursing: 'dashboard.nursing',
  clinical: 'dashboard.clinical',
  pharmacy: 'dashboard.pharmacy',
  laboratory: 'dashboard.laboratory',
  management: 'dashboard.management',
  administration: 'dashboard.administration'
};

async function getDashboard(req, res) {
  const dashboard = req.params.dashboard || roleDashboards[req.user.role];
  const requiredPermission = dashboardPermissions[dashboard];
  if (!requiredPermission || !req.user.permissions.includes('dashboard.view') ||
      !req.user.permissions.includes(requiredPermission) ||
      dashboard === 'administration' && !req.user.permissions.includes('system.monitor')) {
    return res.status(403).json({ error: 'Access denied.' });
  }

  const stats = await withTransaction(async (client) => {
    if (dashboard === 'clerk') {
      const result = await client.query(
        `SELECT
           (SELECT COUNT(*)::int FROM patients WHERE archived_at IS NULL) AS "totalPatients",
           (SELECT COUNT(*)::int FROM patients WHERE registration_date::date = CURRENT_DATE AND archived_at IS NULL) AS "patientsToday",
           (SELECT COUNT(*)::int FROM appointments WHERE scheduled_at::date = CURRENT_DATE AND status <> 'cancelled') AS "appointmentsToday",
           (SELECT COUNT(*)::int FROM visits WHERE visit_date::date = CURRENT_DATE AND status NOT IN ('completed', 'cancelled')) AS "checkedInPatients",
           (SELECT COUNT(*)::int FROM visits WHERE visit_date::date = CURRENT_DATE AND status IN ('waiting_triage', 'waiting_clinician')) AS "waitingPatients",
           (SELECT COUNT(*)::int FROM visits WHERE visit_date::date = CURRENT_DATE AND status = 'completed') AS "completedVisits"`
      );
      return result.rows[0];
    }

    if (dashboard === 'nursing') {
      const result = await client.query(
        `SELECT
           (SELECT COUNT(*)::int FROM visits WHERE visit_date::date = CURRENT_DATE AND status = 'waiting_triage') AS "waitingForTriage",
           (SELECT COUNT(*)::int FROM visits WHERE visit_date::date = CURRENT_DATE AND status = 'in_triage') AS "inTriage",
           (SELECT COUNT(*)::int FROM visits WHERE triaged_at::date = CURRENT_DATE AND status <> 'cancelled') AS "completedTriage",
           (SELECT COUNT(*)::int FROM visits WHERE visit_date::date = CURRENT_DATE
             AND triage_priority IN ('urgent', 'critical') AND status NOT IN ('completed', 'cancelled')) AS "urgentPatients"`
      );
      return result.rows[0];
    }

    if (dashboard === 'clinical') {
      const result = await client.query(
        `SELECT
           (SELECT COUNT(*)::int FROM visits WHERE visit_date::date = CURRENT_DATE AND status = 'waiting_clinician') AS "waitingPatients",
           (SELECT COUNT(*)::int FROM visits WHERE visit_date::date = CURRENT_DATE AND status = 'in_consultation') AS "patientsInConsultation",
           (SELECT COUNT(*)::int FROM visits WHERE visit_date::date = CURRENT_DATE AND status = 'completed') AS "completedVisits",
           (SELECT COUNT(*)::int FROM appointments WHERE scheduled_at::date = CURRENT_DATE AND status = 'checked_in') AS "appointmentsToday",
           (SELECT COUNT(*)::int FROM visits WHERE visit_date::date = CURRENT_DATE AND triage_priority IN ('urgent', 'critical') AND status NOT IN ('completed', 'cancelled')) AS "urgentPatients",
           (SELECT COUNT(*)::int FROM visits WHERE visit_date::date = CURRENT_DATE AND follow_up IS NOT NULL AND BTRIM(follow_up) <> '') AS "followUpPatients"`
      );
      return result.rows[0];
    }

    if (dashboard === 'pharmacy') {
      const result = await client.query(
        `SELECT
           (SELECT COUNT(*)::int FROM prescriptions WHERE status IN ('active', 'pending', 'partially_dispensed')) AS "pendingPrescriptions",
           (SELECT COUNT(DISTINCT prescription_id)::int FROM dispensing WHERE status <> 'cancelled' AND dispensed_at::date = CURRENT_DATE) AS "prescriptionsDispensedToday",
           (SELECT COUNT(DISTINCT patient_id)::int FROM prescriptions WHERE status IN ('active', 'pending', 'partially_dispensed')) AS "pharmacyPendingPatients",
           (SELECT COUNT(*)::int FROM medicines WHERE current_quantity <= minimum_stock_level AND status = 'active') AS "lowStockMedicines",
           (SELECT COUNT(*)::int FROM medicines WHERE current_quantity = 0 AND status = 'active') AS "outOfStockMedicines"`
      );
      return result.rows[0];
    }

    if (dashboard === 'laboratory') {
      const result = await client.query(
        `SELECT
           (SELECT COUNT(*)::int FROM lab_requests WHERE status = 'pending') AS "pendingLabRequests",
           (SELECT COUNT(*)::int FROM lab_requests WHERE status = 'in_progress') AS "inProgressLabRequests",
           (SELECT COUNT(*)::int FROM lab_requests WHERE status = 'completed' AND completed_at::date = CURRENT_DATE) AS "completedLabRequests",
           (SELECT COUNT(*)::int FROM lab_requests lr JOIN visits v ON v.id = lr.visit_id
             WHERE lr.status IN ('pending', 'in_progress') AND v.triage_priority IN ('urgent', 'critical')) AS "urgentLabRequests"`
      );
      return result.rows[0];
    }

    if (dashboard === 'management') {
      const result = await client.query(
        `SELECT
           (SELECT COUNT(*)::int FROM patients WHERE archived_at IS NULL) AS "totalPatients",
           (SELECT COUNT(*)::int FROM patients WHERE registration_date::date = CURRENT_DATE AND archived_at IS NULL) AS "patientsToday",
           (SELECT COUNT(*)::int FROM visits WHERE visit_date::date = CURRENT_DATE) AS "consultationsToday",
           (SELECT COUNT(*)::int FROM appointments WHERE scheduled_at::date = CURRENT_DATE AND status <> 'cancelled') AS "appointmentsToday",
           (SELECT COUNT(*)::int FROM prescriptions WHERE status IN ('pending', 'active', 'partially_dispensed')) AS "pendingPrescriptions",
           (SELECT COUNT(*)::int FROM lab_requests WHERE status IN ('pending', 'in_progress')) AS "pendingLabRequests"`
      );
      return result.rows[0];
    }

    const result = await client.query(
      `SELECT
         (SELECT COUNT(*)::int FROM users) AS "totalUsers",
         (SELECT COUNT(*)::int FROM users WHERE is_active = TRUE) AS "activeStaff",
         (SELECT COUNT(*)::int FROM patients WHERE archived_at IS NULL) AS "totalPatients",
         (SELECT COUNT(*)::int FROM visits WHERE visit_date::date = CURRENT_DATE) AS "visitsToday",
         (SELECT COUNT(*)::int FROM audit_events WHERE occurred_at::date = CURRENT_DATE) AS "auditEventsToday",
         (SELECT COUNT(*)::int FROM users WHERE approval_status = 'pending') AS "pendingAdministrativeTasks"`
    );
    const recentActivity = await client.query(
      'SELECT actor_id, action, resource_type, resource_id, occurred_at FROM audit_events ORDER BY occurred_at DESC LIMIT 10'
    );
    return { ...result.rows[0], recentActivity: recentActivity.rows };
  });

  return res.json({ role: dashboard, stats });
}

router.get('/', requireAuth, getDashboard);
router.get('/:dashboard', requireAuth, getDashboard);

module.exports = router;
