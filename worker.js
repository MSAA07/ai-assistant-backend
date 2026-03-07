// import * as Sentry from '@sentry/node'  // added in P1-S08 — import safely
import { PrismaClient } from '@prisma/client'
import { getNextQueuedJob, updateJob } from './utils/jobQueue.js'
import { processExtraction } from './utils/extractionPipeline.js'  // created in P1-S03
import { checkAnomaly } from './utils/costGuard.js'

const prisma = new PrismaClient()

const POLL_INTERVAL_MS = 2000
const JOB_TIMEOUTS = {
  extract_document: 60000,
  generate_exam: 90000,
  generate_flashcards: 90000,
  export_pdf: 30000,
}

async function runWorker() {
  console.log('[worker] started, polling every 2s')

  setInterval(async () => {
    try {
      const recentUsers = await prisma.usageEvent.findMany({
        where: {
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
        },
        select: { userId: true },
        distinct: ['userId']
      })

      for (const { userId } of recentUsers) {
        await checkAnomaly(userId).catch(error => {
          console.error('[anomaly]', error)
        })
      }
    } catch (error) {
      console.error('[anomaly] sweep failed:', error)
    }
  }, 15 * 60 * 1000)

  while (true) {
    try {
      const job = await getNextQueuedJob()

      if (!job) {
        await sleep(POLL_INTERVAL_MS)
        continue
      }

      await updateJob(job.id, { status: 'running', startedAt: new Date() })
      console.log(`[worker] processing job ${job.id} type=${job.jobType}`)

      const timeout = JOB_TIMEOUTS[job.jobType] || 60000

      try {
        const result = await withTimeout(executeJob(job), timeout)
        await updateJob(job.id, {
          status: 'succeeded',
          progressPct: 100,
          result,
          completedAt: new Date()
        })
        console.log(`[worker] job ${job.id} succeeded`)
      } catch (err) {
        const newRetryCount = (job.retryCount || 0) + 1
        const shouldRetry = !isNonRetryableJobError(err) && newRetryCount < job.maxRetries

        if (shouldRetry) {
          await updateJob(job.id, { status: 'queued', retryCount: newRetryCount })
          console.log(`[worker] job ${job.id} failed, retrying (${newRetryCount}/${job.maxRetries})`)
        } else {
          await updateJob(job.id, {
            status: 'failed',
            errorMessage: err.message,
            completedAt: new Date()
          })
          console.error(`[worker] job ${job.id} permanently failed:`, err.message)
          // Sentry capture added in P1-S08
        }
      }
    } catch (err) {
      console.error('[worker] poll error:', err)
      await sleep(POLL_INTERVAL_MS)
    }
  }
}

async function executeJob(job) {
  if (job.jobType === 'extract_document') {
    return await processExtraction(job.id, job.userId, job.payload)
  }
  throw new Error(`Unknown job type: ${job.jobType}`)
  // generate_exam, generate_flashcards, export_pdf added in later phases
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Job timed out after ${ms}ms`)), ms))
  ])
}

function isNonRetryableJobError(error) {
  return error?.code === 'doc_cap_hit' || error?.code === 'token_cap_hit'
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

runWorker().catch(err => {
  console.error('[worker] fatal error:', err)
  process.exit(1)
})
