async function recordAudit(dbClient, { actorId = null, action, resourceType, resourceId = null, module = null, description = null }) {
  await dbClient.query(
    `INSERT INTO audit_events (actor_id, action, resource_type, resource_id, module, description)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [actorId, action, resourceType, resourceId, module, description]
  );
}

module.exports = { recordAudit };
