import { PrismaClient } from '@prisma/client'
import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'
import fsPromises from 'fs/promises'
import pdfParse from 'pdf-parse'
import mammoth from 'mammoth'
import { updateJob } from './jobQueue.js'
import { downloadFileToTmp, safeUnlink } from './storage.js'
import { generateStudyMaterialsFromExcerpts } from './studyMaterials.js'

const prisma = new PrismaClient()

export async function processExtraction(jobId, userId, payload) {
  const { documentId, filePath } = payload
  
  // Validate filePath - if not in payload, try to reconstruct or fail
  const document = await prisma.document.findUnique({ where: { id: documentId } })
  if (!document) throw new Error(`Document ${documentId} not found`)

  await updateJob(jobId, { progressPct: 10 })

  let workingPath = filePath && path.isAbsolute(filePath) ? filePath : null
  let downloadedPath

  if (!workingPath) {
    if (!document.storageKey) {
      throw new Error('No storage key available for document file')
    }

    const isLocalKey = path.isAbsolute(document.storageKey)
    if (isLocalKey) {
      workingPath = document.storageKey
    } else {
      downloadedPath = await downloadFileToTmp(document.storageKey)
      workingPath = downloadedPath
    }
  }

  try {
    // Check if excerpts already cached
    const existingExcerpts = await prisma.documentExcerpt.count({ where: { documentId } })
    if (existingExcerpts > 0) {
      await updateJob(jobId, { progressPct: 100 })
      return { documentId, cached: true }
    }

    const mimeType = document.fileType

    let excerpts = []

    if (mimeType.includes('pdf')) {
      excerpts = await extractPdf(workingPath)
    } else if (mimeType.includes('wordprocessingml') || mimeType.includes('docx')) {
      excerpts = await extractDocx(workingPath)
    } else if (mimeType.includes('presentationml') || mimeType.includes('pptx')) {
      excerpts = await extractPptx(workingPath)
    } else {
      throw new Error(`Unsupported file type: ${mimeType}`)
    }

    await updateJob(jobId, { progressPct: 60 })

    await prisma.documentExcerpt.createMany({
      data: excerpts.map(e => ({ ...e, documentId }))
    })

    const studyMaterials = await generateStudyMaterialsFromExcerpts(excerpts, document.language)

    await prisma.document.update({
      where: { id: documentId },
      data: {
        summary: studyMaterials.summary,
        flashcards: studyMaterials.flashcards,
        examQuestions: studyMaterials.examQuestions,
      },
    })

    await updateJob(jobId, { progressPct: 90 })

    return {
      documentId,
      excerptCount: excerpts.length,
      generated: Boolean(studyMaterials.summary || studyMaterials.flashcards?.length || studyMaterials.examQuestions?.length),
    }
  } finally {
    if (downloadedPath) {
      await safeUnlink(downloadedPath)
    }
  }
}

async function extractPdf(filePath) {
  const buffer = fs.readFileSync(filePath)
  const data = await pdfParse(buffer)
  const pages = data.text.split('\f')  // form feed splits pages

  return pages.map((pageText, i) => ({
    slideOrPage: i + 1,
    excerptType: 'slide_text',
    content: pageText.trim().slice(0, 3000),
    charOffset: 0,
  })).filter(e => e.content.length > 0)
}

async function extractDocx(filePath) {
  const result = await mammoth.extractRawText({ path: filePath })
  const paragraphs = result.value.split('\n').filter(p => p.trim().length > 0)
  // Group into chunks of ~500 chars as "pages"
  const chunks = []
  let current = ''
  let page = 1
  for (const para of paragraphs) {
    if (current.length + para.length > 500) {
      if (current) chunks.push({ slideOrPage: page++, content: current.trim() })
      current = para
    } else {
      current += '\n' + para
    }
  }
  if (current) chunks.push({ slideOrPage: page, content: current.trim() })

  return chunks.map(c => ({ ...c, excerptType: 'slide_text', charOffset: 0 }))
}

async function extractPptx(filePath) {
  return new Promise((resolve, reject) => {
    // Determine script path correctly relative to project root
    // Assuming this file is in ai-assistant-backend/utils/
    // and script is in ai-assistant-backend/scripts/
    const scriptPath = path.join(process.cwd(), 'scripts', 'extract_pptx.py')
    
    // Check if python3 is available, fallback to python if needed (usually python3 on unix, python on win)
    // For now stick to 'python3' as per instructions, but handle error gracefully?
    // Railway uses linux so python3 is likely correct.
    const child = spawn('python3', [scriptPath, filePath])
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', d => stdout += d)
    child.stderr.on('data', d => stderr += d)

    child.on('close', code => {
      if (code !== 0) return reject(new Error(`PPTX extraction failed: ${stderr || 'Unknown error'}`))
      try {
        const { slides, error } = JSON.parse(stdout)
        if (error) return reject(new Error(`PPTX extraction script error: ${error}`))
        
        const excerpts = []
        for (const slide of slides) {
          if (slide.text?.trim()) {
            excerpts.push({
              slideOrPage: slide.slideNumber,
              excerptType: 'slide_text',
              content: slide.text.trim(),
              charOffset: 0,
            })
          }
          if (slide.speakerNotes?.trim()) {
            excerpts.push({
              slideOrPage: slide.slideNumber,
              excerptType: 'speaker_note',
              content: slide.speakerNotes.trim(),
              charOffset: 0,
            })
          }
          if (slide.hasImages) {
            excerpts.push({
              slideOrPage: slide.slideNumber,
              excerptType: 'image_flag',
              content: 'true',
              charOffset: 0,
            })
          }
        }
        resolve(excerpts)
      } catch (e) {
        reject(new Error(`PPTX JSON parse error: ${e.message}. Stdout: ${stdout}`))
      }
    })

    child.on('error', (err) => {
        if (err.code === 'ENOENT') {
            reject(new Error("python3 not found. Ensure python is installed."));
        } else {
            reject(err);
        }
    });

    setTimeout(() => {
      child.kill()
      reject(new Error('PPTX extraction timed out after 60s'))
    }, 60000)
  })
}
