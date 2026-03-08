import express from 'express'
import { getJobById } from '../utils/jobQueue.js'
import { captureSentryException } from '../utils/sentry.js'

export const createJobsRouter = ({ prisma, requireAuth }) => {
  const router = express.Router()

  router.get('/:id', requireAuth, async (req, res) => {
    try {
      const job = await getJobById(prisma, req.params.id)
      if (!job) return res.status(404).json({ error: 'Job not found' })
      // Users can only see their own jobs
      if (job.userId !== req.session.user.id) return res.status(403).json({ error: 'Forbidden' })

      res.json({
        id: job.id,
        status: job.status,
        progressPct: job.progressPct,
        result: job.status === 'succeeded' ? job.result : null,
        errorMessage: job.status === 'failed' ? job.errorMessage : null,
      })
    } catch (err) {
      console.error("Error fetching job:", err)
      captureSentryException(err)
      res.status(500).json({ error: 'Failed to fetch job status' })
    }
  })

  return router
}
