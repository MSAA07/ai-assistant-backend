import fs from "fs";
import path from "path";

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;

export async function extractWithMistralOcr(filePath) {
  const filename = path.basename(filePath);
  console.log("[MistralOCR] Starting OCR for:", filename);

  if (!MISTRAL_API_KEY) {
    throw new Error("[MistralOCR] MISTRAL_API_KEY is not set");
  }

  const fileBuffer = fs.readFileSync(filePath);
  console.log("[MistralOCR] File read, size:", fileBuffer.length, "bytes");

  // Build multipart/form-data manually
  const boundary = "----MistralBoundary" + Date.now();
  const CRLF = "\r\n";

  const partHeader = [
    "--" + boundary,
    'Content-Disposition: form-data; name="file"; filename="' + filename + '"',
    "Content-Type: application/pdf",
    "",
    "",
  ].join(CRLF);

  const purposePart = [
    "--" + boundary,
    'Content-Disposition: form-data; name="purpose"',
    "",
    "ocr",
    "",
  ].join(CRLF);

  const closing = "--" + boundary + "--" + CRLF;

  const body = Buffer.concat([
    Buffer.from(purposePart + CRLF),
    Buffer.from(partHeader),
    fileBuffer,
    Buffer.from(CRLF + closing),
  ]);

  console.log("[MistralOCR] Uploading file to Mistral...");

  // Step 1: Upload file
  let uploadResponse;
  try {
    uploadResponse = await fetch("https://api.mistral.ai/v1/files", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + MISTRAL_API_KEY,
        "Content-Type": "multipart/form-data; boundary=" + boundary,
        "Content-Length": body.length.toString(),
      },
      body,
    });
  } catch (err) {
    console.log("[MistralOCR] Upload fetch error:", err.message);
    throw new Error("Mistral file upload failed: " + err.message);
  }

  const uploadText = await uploadResponse.text();
  console.log("[MistralOCR] Upload response status:", uploadResponse.status);
  console.log("[MistralOCR] Upload response body:", uploadText.slice(0, 300));

  if (!uploadResponse.ok) {
    throw new Error("Mistral file upload failed: " + uploadText);
  }

  const uploadData = JSON.parse(uploadText);
  const fileId = uploadData.id;
  console.log("[MistralOCR] File uploaded, fileId:", fileId);

  // Step 2: Get signed URL for the file
  let signedUrl;
  try {
    const signedUrlResponse = await fetch(
      "https://api.mistral.ai/v1/files/" + fileId + "/url",
      {
        method: "GET",
        headers: {
          Authorization: "Bearer " + MISTRAL_API_KEY,
        },
      }
    );
    const signedUrlText = await signedUrlResponse.text();
    console.log("[MistralOCR] Signed URL response status:", signedUrlResponse.status);
    console.log("[MistralOCR] Signed URL response body:", signedUrlText.slice(0, 300));
    const signedUrlData = JSON.parse(signedUrlText);
    signedUrl = signedUrlData.url;
  } catch (err) {
    console.log("[MistralOCR] Signed URL error:", err.message);
    throw new Error("Mistral signed URL failed: " + err.message);
  }

  console.log("[MistralOCR] Got signed URL, running OCR...");

  // Step 3: Run OCR using signed URL
  let ocrText = "";
  try {
    const ocrResponse = await fetch("https://api.mistral.ai/v1/ocr", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + MISTRAL_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "mistral-ocr-latest",
        document: {
          type: "document_url",
          document_url: signedUrl,
        },
      }),
    });

    const ocrResponseText = await ocrResponse.text();
    console.log("[MistralOCR] OCR response status:", ocrResponse.status);
    console.log("[MistralOCR] OCR response body:", ocrResponseText.slice(0, 500));

    if (!ocrResponse.ok) {
      throw new Error("Mistral OCR failed: " + ocrResponseText);
    }

    const ocrData = JSON.parse(ocrResponseText);
    const pages = ocrData.pages || [];
    console.log("[MistralOCR] Pages returned:", pages.length);

    ocrText = pages
      .map((p) => p.markdown_content || "")
      .join("\n\n")
      .trim();

    console.log("[MistralOCR] Total chars extracted:", ocrText.length);
  } catch (err) {
    console.log("[MistralOCR] OCR step error:", err.message);
    throw err;
  } finally {
    // Step 4: Delete the uploaded file
    try {
      await fetch("https://api.mistral.ai/v1/files/" + fileId, {
        method: "DELETE",
        headers: {
          Authorization: "Bearer " + MISTRAL_API_KEY,
        },
      });
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
