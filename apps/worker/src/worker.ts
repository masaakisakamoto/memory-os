/**
 * Worker — CLI entrypoint for background jobs.
 * Usage: node dist/worker.js <job> [options]
 */

import { argv } from 'process';
import { Pool } from 'pg';

const db = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/memory_os',
});

const job = argv[2];
const args = argv.slice(3);

async function main() {
  switch (job) {
    case 'ingest-raw': {
      const { ingestRaw } = await import('./jobs/ingest-raw.js');
      const fileArg = args.find(a => a.startsWith('--file='))?.replace('--file=', '')
        ?? args[args.indexOf('--file') + 1];
      if (!fileArg) {
        console.error('Usage: worker ingest-raw --file=<path>');
        process.exit(1);
      }
      await ingestRaw(db, fileArg);
      break;
    }
    case 'extract-proposals': {
      const { extractProposalsJob } = await import('./jobs/extract-proposals.js');
      const sessionId = args.find(a => a.startsWith('--session='))?.replace('--session=', '')
        ?? args[args.indexOf('--session') + 1];
      await extractProposalsJob(db, sessionId);
      break;
    }
    case 'validate-proposals': {
      const { validateProposalsJob } = await import('./jobs/validate-proposals.js');
      await validateProposalsJob(db);
      break;
    }
    case 'commit-approved': {
      const { commitApprovedJob } = await import('./jobs/commit-approved.js');
      await commitApprovedJob(db);
      break;
    }
    case 'approve-proposal': {
      const { approveProposalJob } = await import('./jobs/approve-proposal.js');
      const proposalId = args.find(a => a.startsWith('--proposal='))?.replace('--proposal=', '')
        ?? args[args.indexOf('--proposal') + 1];
      if (!proposalId) {
        console.error('Usage: worker approve-proposal --proposal=<PROPOSAL_ID>');
        process.exit(1);
      }
      await approveProposalJob(db, proposalId);
      break;
    }
    case 'rebuild-context-cache': {
      const { rebuildContextCacheJob, repairContextCacheJob } = await import('./jobs/rebuild-context-cache.js');
      const isRepair = args.includes('--repair');
      if (isRepair) {
        // --repair [--run=<RUN_ID>]
        const runId = args.find(a => a.startsWith('--run='))?.replace('--run=', '');
        await repairContextCacheJob(db, runId);
      } else {
        // [--project=<PROJECT_ID>]
        const projectId = args.find(a => a.startsWith('--project='))?.replace('--project=', '');
        await rebuildContextCacheJob(db, projectId);
      }
      break;
    }
    default:
      console.error(`Unknown job: ${job}`);
      console.error('Available jobs: ingest-raw, extract-proposals, validate-proposals, approve-proposal, commit-approved, rebuild-context-cache');
      console.error('  rebuild-context-cache flags: [--project=<id>] | [--repair [--run=<RUN_ID>]]');
      process.exit(1);
  }

  await db.end();
  process.exit(0);
}

main().catch(err => {
  console.error('Worker error:', err);
  process.exit(1);
});
