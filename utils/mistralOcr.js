import fs from "fs";
import path from "path";

export async function extractWithMistralOcr(filePath) {
  const filename = path.basename(filePath);
  console.log("[MistralOCR] Starting OCR for:", filename);

  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) {
    throw new Error("[MistralOCR] MISTRAL_API_KEY is not set");
  }

  const { Mistral } = await import("@mistralai/mistralai");
  const client = new Mistral({ apiKey });

  // Step 1: Upload file
  console.log("[MistralOCR] Uploading file...");
  let uploadedFile;
  try {
    const fileBuffer = fs.readFileSync(filePath);
    uploadedFile = await client.files.upload({
      file: {
        fileName: filename,
        content: fileBuffer,
      },
      purpose: "ocr",
    });
    console.log("[MistralOCR] File uploaded, id:", uploadedFile.id);
  } catch (err) {
    console.log("[MistralOCR] Upload error:", err.message);
    throw new Error("Mistral file upload failed: " + err.message);
  }

  // Step 2: Get signed URL
  let signedUrl;
  try {
    const signedUrlResponse = await client.files.getSignedUrl({
      fileId: uploadedFile.id,
    });
    signedUrl = signedUrlResponse.url;
    console.log("[MistralOCR] Got signed URL");
  } catch (err) {
    console.log("[MistralOCR] Signed URL error:", err.message);
    // Clean up uploaded file before throwing
    try { await client.files.delete({ fileId: uploadedFile.id }); } catch {}
    throw new Error("Mistral signed URL failed: " + err.message);
  }

  // Step 3: Run OCR + Step 4: Delete file
  let ocrText = "";
  try {
    console.log("[MistralOCR] Running OCR...");
    const ocrResponse = await client.ocr.process({
      model: "mistral-ocr-latest",
      document: {
        type: "document_url",
        documentUrl: signedUrl,
      },
    });

    const pages = ocrResponse.pages || [];
    console.log("[MistralOCR] Pages returned:", pages.length);

    ocrText = pages
      .map((p) => p.markdown || p.markdownContent || p.markdown_content || "")
      .join("\n\n")
      .trim();

    console.log("[MistralOCR] Total chars extracted:", ocrText.length);
  } catch (err) {
    console.log("[MistralOCR] OCR error:", err.message);
    throw new Error("Mistral OCR processing failed: " + err.message);
  } finally {
    try {
      await client.files.delete({ fileId: uploadedFile.id });
      console.log("[MistralOCR] File deleted from Mistral storage");
    } catch (err) {
      console.log("[MistralOCR] File delete error (non-fatal):", err.message);
    }
  }

  if (!ocrText) {
    throw new Error(
      "This document appears to be a scanned image and could not be processed. Please upload a PDF with selectable text, or a DOCX/PPTX file."
    );
  }

  return ocrText;
}
