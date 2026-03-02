import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

export async function enqueueJob(userId, jobType, payload) {
  return await prisma.job.create({
    data: { userId, jobType, payload, status: 'queued' }
  })
}

export async function updateJob(jobId, data) {
  return await prisma.job.update({ where: { id: jobId }, data })
}

export async function getNextQueuedJob() {
  // Use raw query for SELECT FOR UPDATE SKIP LOCKED — prevents two workers picking same job
  const result = await prisma.$queryRaw`
    SELECT * FROM "Job"
    WHERE status = 'queued'
    ORDER BY "queuedAt" ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  `
  return result[0] || null
}

export async function getJobById(jobId) {
  return await prisma.job.findUnique({ where: { id: jobId } })
}
