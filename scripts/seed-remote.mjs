#!/usr/bin/env node

// The production Worker lazily seeds the admin-owned Example packet on the
// first authenticated request.  Keeping this command explicit makes the
// deployment runbook discoverable without duplicating the seed logic (and its
// PBKDF2 secret handling) in a second script.
const base = process.env.QUABANKS_URL || process.env.PUBLIC_URL;
if (!base) {
  console.log("Remote seed is lazy: set QUABANKS_URL to the deployed Worker URL and call /api/health once, or open the app.");
  process.exit(0);
}

const response = await fetch(`${base.replace(/\/$/, "")}/api/health`);
if (!response.ok) {
  console.error(`Worker health check failed with HTTP ${response.status}`);
  process.exit(1);
}
console.log("Worker is healthy. The Example packet is seeded automatically after the first authenticated request.");
