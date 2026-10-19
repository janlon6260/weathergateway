import { readFileSync } from 'node:fs';
import { join } from 'node:path';
try {
  if (process.env.WG_ROLE === 'worker') {
    const heartbeat = JSON.parse(
      readFileSync(join(process.env.WG_DATA_ROOT, 'system/worker-heartbeat.json'), 'utf8'),
    );
    if (
      heartbeat.environment !== process.env.WG_ENVIRONMENT ||
      Date.now() - heartbeat.at > 15000 ||
      Date.now() < heartbeat.at
    )
      process.exitCode = 1;
  } else {
    const result = await fetch(`http://127.0.0.1:${process.env.PORT || 8080}/health/live`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!result.ok) process.exitCode = 1;
  }
} catch {
  process.exitCode = 1;
}
