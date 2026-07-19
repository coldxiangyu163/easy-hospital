import { mkdir } from 'node:fs/promises';

import { createPumchDermatologyScheduleAdapter } from '../src/adapters/sources/pumch.js';
import {
  claimPumchLiveProbeCooldown,
  finishPumchLiveProbeCooldown,
} from '../src/adapters/sources/pumch-live-probe.js';
import { loadRuntimeConfig } from '../src/core/config.js';
import { runSourceAdapter } from '../src/core/source-adapter.js';
import { openDatabase } from '../src/storage/database.js';

const LIVE_FLAG = '--live';

if (!process.argv.includes(LIVE_FLAG)) {
  console.error(
    '此脚本会对协和官方公开排班页执行一次低频 live probe。确认后请显式运行：npx tsx scripts/live-probe-pumch.ts --live',
  );
  process.exitCode = 2;
} else {
  const attemptedAt = Date.now();
  const config = loadRuntimeConfig(process.env);
  await mkdir(config.dataDirectory, { recursive: true });
  const database = openDatabase(config.databasePath);

  try {
    const claim = claimPumchLiveProbeCooldown(database, attemptedAt);
    if (!claim.claimed) {
      console.error(
        JSON.stringify({
          status: 'COOLDOWN',
          retryAfterMs: claim.retryAfterMs,
          nextAllowedAt: new Date(attemptedAt + claim.retryAfterMs).toISOString(),
        }),
      );
      process.exitCode = 2;
    } else {
      const toBeijingDate = (date: Date): string =>
        new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Asia/Shanghai',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(date);

      const startedAt = new Date(attemptedAt);
      const dateTo = new Date(startedAt);
      dateTo.setUTCDate(dateTo.getUTCDate() + 7);

      const result = await runSourceAdapter(createPumchDermatologyScheduleAdapter(), {
        requestId: `live-pumch-${startedAt.toISOString()}`,
        sourceId: 'source-pumch-public-schedule',
        hospitalId: 'hospital-pumch',
        campusId: 'campus-pumch-dongdan',
        departmentId: 'department-pumch-dermatology',
        dateFrom: toBeijingDate(startedAt),
        dateTo: toBeijingDate(dateTo),
        doctorName: null,
        titles: [],
        session: 'ANY',
        deadlineAt: new Date(attemptedAt + 45_000).toISOString(),
      });
      finishPumchLiveProbeCooldown(database, result, attemptedAt);

      const dates = [...new Set(result.observations.map((item) => item.date))];
      const sessions = result.observations.reduce(
        (counts, item) => {
          counts[item.session] += 1;
          return counts;
        },
        { AM: 0, PM: 0 },
      );

      console.log(
        JSON.stringify(
          {
            adapterKey: 'pumch-public-dermatology-schedule',
            status: result.status,
            errorCode: result.errorCode ?? null,
            observedAt: result.observedAt,
            nextAllowedAt: result.nextAllowedAt,
            contentHash: result.contentHash,
            summary: {
              observationCount: result.observations.length,
              dates,
              sessions,
              availabilityValues: [
                ...new Set(result.observations.map((item) => item.availability)),
              ],
              scheduleStatusValues: [
                ...new Set(result.observations.map((item) => item.scheduleStatus)),
              ],
            },
          },
          null,
          2,
        ),
      );

      if (result.status !== 'OK' && result.status !== 'PARTIAL') {
        process.exitCode = 1;
      }
    }
  } finally {
    database.close();
  }
}
