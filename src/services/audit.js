async function recordAudit(dbClient, { actorId = null, action, resourceType, resourceId = null }) {
  await dbClient.query(
    `INSERT INTO audit_events (actor_id, action, resource_type, resource_id)
     VALUES ($1, $2, $3, $4)`,
    [actorId, action, resourceType, resourceId]
  );
}

module.exports = { recordAudit };
