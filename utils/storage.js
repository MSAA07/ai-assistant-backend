import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3'
import fs from 'fs'
import fsPromises from 'fs/promises'
import os from 'os'
import path from 'path'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import { captureSentryException } from './sentry.js'
import { buildStorageObjectKey } from './filenames.js'

function hasValue(value) {
  return typeof value === 'string' && value.trim().length > 0
}

export function isProductionLikeStorageEnvironment(env = process.env) {
  return env.NODE_ENV === 'production'
    || hasValue(env.RAILWAY_ENVIRONMENT)
    || hasValue(env.RAILWAY_PUBLIC_DOMAIN)
    || hasValue(env.RAILWAY_STATIC_URL)
    || hasValue(env.RAILWAY_SERVICE_ID)
    || hasValue(env.RAILWAY_PROJECT_ID)
    || hasValue(env.BACKEND_DEPLOYMENT_ENV)
}

export function getStorageConfigurationStatus(env = process.env) {
  const missing = [
    'R2_ENDPOINT',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_BUCKET_NAME',
  ].filter((name) => !hasValue(env[name]))

  return {
    configured: missing.length === 0,
    missing,
    productionLike: isProductionLikeStorageEnvironment(env),
  }
}

export function assertStorageConfiguredForRuntime(env = process.env) {
  const status = getStorageConfigurationStatus(env)
  if (!status.productionLike || status.configured) {
    return status
  }

  throw new Error(`R2 storage is required in production-like deployments; missing ${status.missing.join(', ')}`)
}

const storageStatus = getStorageConfigurationStatus()
const r2 = storageStatus.configured ? new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  }
}) : null

const BUCKET = process.env.R2_BUCKET_NAME

export async function uploadFile(localPath, userId, originalFilename, mimeType) {
  if (!r2) {
    assertStorageConfiguredForRuntime()
    console.warn('[storage] R2 not configured — using local /tmp (files will not persist on restart)')
    // In fallback mode, we return the local path as the key so we can find it later
    // However, since /tmp is ephemeral, this is just for dev/testing without R2
    return { key: localPath, url: null }
  }

  const key = buildStorageObjectKey(userId, originalFilename)
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
      console.error('[storage] Failed to upload to R2:', error instanceof Error ? error.message : String(error))
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
    console.error('[storage] Failed to delete from R2:', error instanceof Error ? error.message : String(error))
    captureSentryException(error, {
      tags: { storage_phase: 'delete_r2_file' },
      extra: { key },
    })
    // Don't throw, just log
  }
}

async function streamToFile(body, destination) {
  const writeStream = fs.createWriteStream(destination)
  const readable = body instanceof Readable ? body : Readable.fromWeb(body)
  await pipeline(readable, writeStream)
}

export async function downloadFileToTmp(key) {
  if (!r2) {
    throw new Error('R2 not configured but download requested')
  }
  const response = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
  const filename = key.split('/').pop() || `download-${Date.now()}`
  const tmpPath = path.join(os.tmpdir(), `${Date.now()}-${filename}`)
  await streamToFile(response.Body, tmpPath)
  return tmpPath
}

export async function listFiles(prefix = '', maxKeys = 1) {
  if (!r2) {
    assertStorageConfiguredForRuntime()
    throw new Error('R2 storage is not configured')
  }

  const response = await r2.send(new ListObjectsV2Command({
    Bucket: BUCKET,
    Prefix: prefix,
    MaxKeys: maxKeys,
  }))

  return response.Contents || []
}

export async function safeUnlink(filePath) {
  try {
    await fsPromises.unlink(filePath)
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[storage] Failed to clean up temp file:', error.message)
      captureSentryException(error, {
        tags: { storage_phase: 'cleanup_tmp_file' },
        extra: { filePath },
      })
    }
  }
}
