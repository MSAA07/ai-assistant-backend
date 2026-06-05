import fs from "fs";
import path from "path";

const MISTRAL_FILES_ENDPOINT = "https://api.mistral.ai/v1/files";
const MISTRAL_OCR_ENDPOINT = "https://api.mistral.ai/v1/ocr";

export async function extractWithMistralOcr(filePath) {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) {
    throw new Error("Mistral OCR failed: MISTRAL_API_KEY is not configured");
  }

  let fileId = null;

  try {
    const buffer = fs.readFileSync(filePath);
    const formData = new FormData();
    formData.append("purpose", "ocr");
    formData.append("file", new Blob([buffer], { type: "application/pdf" }), path.basename(filePath));

    const uploadResponse = await fetch(MISTRAL_FILES_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
    });

    if (!uploadResponse.ok) {
      const errorBody = await uploadResponse.text();
      console.log("[MistralOCR] File upload failed, status:", uploadResponse.status, "body:", errorBody);
      throw new Error(`Mistral file upload returned ${uploadResponse.status}: ${errorBody || uploadResponse.statusText}`);
    }

    const uploadResult = await uploadResponse.json();
    fileId = uploadResult?.id;
    if (!fileId) {
      throw new Error("Mistral file upload response did not include a file id");
    }
    console.log("[MistralOCR] File uploaded successfully, fileId:", fileId);

    const ocrResponse = await fetch(MISTRAL_OCR_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "mistral-ocr-latest",
        document: {
          type: "document_url",
          document_url: `https://dl.mistral.ai/files/${fileId}`,
        },
      }),
    });
    console.log("[MistralOCR] OCR raw response status:", ocrResponse.status);

    if (!ocrResponse.ok) {
      const errorBody = await ocrResponse.text();
      throw new Error(`Mistral OCR API returned ${ocrResponse.status}: ${errorBody || ocrResponse.statusText}`);
    }

    const ocrData = await ocrResponse.json();
    console.log("[MistralOCR] OCR raw response body:", JSON.stringify(ocrData).slice(0, 500));
    if (!Array.isArray(ocrData?.pages)) {
      throw new Error("Mistral OCR response did not include a pages array");
    }

    const pages = ocrData.pages;
    const text = pages
      .map((page) => (typeof page?.markdown_content === "string" ? page.markdown_content : ""))
      .join("\n\n");
    console.log("[MistralOCR] Pages returned:", ocrData.pages?.length, "Total chars:", text.length);
    return text;
  } catch (error) {
    console.log("[MistralOCR] Error:", error.message);
    if (error?.message?.startsWith("Mistral OCR failed:")) {
      throw error;
    }

    throw new Error(`Mistral OCR failed: ${error.message}`);
  } finally {
    if (fileId) {
      try {
        await fetch(`${MISTRAL_FILES_ENDPOINT}/${fileId}`, {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
        });
      } catch {
        // Do not mask the OCR result or OCR failure with cleanup failures.
      }
    }
  }
}
