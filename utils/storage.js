import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import fs from 'fs'

const r2 = process.env.R2_ENDPOINT ? new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  }
}) : null

const BUCKET = process.env.R2_BUCKET_NAME || 'ai-study-assistant-uploads'

export async function uploadFile(localPath, userId, originalFilename, mimeType) {
  if (!r2) {
    console.warn('[storage] R2 not configured — using local /tmp (files will not persist on restart)')
    // In fallback mode, we return the local path as the key so we can find it later
    // However, since /tmp is ephemeral, this is just for dev/testing without R2
    return { key: localPath, url: null }
  }

  const key = `uploads/${userId}/${Date.now()}-${originalFilename}`
  const fileBuffer = fs.readFileSync(localPath)
  
  try {
    await r2.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: fileBuffer,
        ContentType: mimeType,
    }))
    return { key, url: `${process.env.R2_ENDPOINT}/${BUCKET}/${key}` }
  } catch (error) {
      console.error('[storage] Failed to upload to R2:', error)
      throw error
  }
}

export async function deleteFile(key) {
  if (!r2 || !key) return
  // If key is a local path (fallback mode), skip
  if (key.startsWith('/') || key.startsWith('C:\\') || key.includes('/tmp/')) return

  try {
    await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }))
  } catch (error) {
    console.error('[storage] Failed to delete from R2:', error)
    // Don't throw, just log
  }
}
