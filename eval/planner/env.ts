// Imported first by the harness. The app's structured logger would otherwise print a line per
// registry lookup into the output (`LOG_LEVEL` from the caller still wins), and the geo-service
// operations (composite) are registered only while a service URL is configured: plan-only mode
// never calls it, so a placeholder makes the planner see the same tool set as a full deployment.
process.env.LOG_LEVEL ??= 'silent'
process.env.GEO_SERVICE_URL ??= 'http://127.0.0.1:1'
export {}
