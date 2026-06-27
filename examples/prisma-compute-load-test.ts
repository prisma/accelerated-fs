/**
 * Prisma Compute load-test example.
 *
 * This entrypoint runs the same HTTP benchmark app used for the published
 * object-store provider measurements. Deploy it with a Prisma Compute target
 * that points at this file, or use apps/load-test/server.ts directly.
 *
 * Required storage environment:
 *
 *   AFS_BUCKET
 *   AFS_REGION
 *   AFS_ACCESS_KEY_ID
 *   AFS_SECRET_ACCESS_KEY
 *
 * Optional storage environment:
 *
 *   AFS_ENDPOINT
 *   AFS_PREFIX_BASE
 *
 * To create a one-time Cloudflare R2 bucket for each benchmark job:
 *
 *   LOAD_TEST_STORAGE_PROVISIONER=r2-one-time-bucket
 *   R2_API_TOKEN
 *   R2_ACCOUNT_ID
 *   R2_BUCKET_PREFIX
 *
 * Benchmark defaults:
 *
 *   cache cap: 100 MiB
 *   file size: 10 KiB
 *   data sizes: 50 MiB, 500 MiB, 5 GiB
 *   mixed phase: 1000 random reads and 1000 random writes, serially awaited
 *   read latency: min, max, average, p50, p95, and p99 for the mixed phase
 *
 * Endpoints:
 *
 *   POST /run
 *   POST /run?profile=quick
 *   GET  /status
 *   GET  /results
 */
import "../apps/load-test/server";
