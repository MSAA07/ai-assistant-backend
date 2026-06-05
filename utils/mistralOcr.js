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
      throw new Error(`Mistral file upload returned ${uploadResponse.status}: ${errorBody || uploadResponse.statusText}`);
    }

    const uploadResult = await uploadResponse.json();
    fileId = uploadResult?.id;
    if (!fileId) {
      throw new Error("Mistral file upload response did not include a file id");
    }

    const response = await fetch(MISTRAL_OCR_ENDPOINT, {
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

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Mistral OCR API returned ${response.status}: ${errorBody || response.statusText}`);
    }

    const result = await response.json();
    if (!Array.isArray(result?.pages)) {
      throw new Error("Mistral OCR response did not include a pages array");
    }

    const pages = result.pages;
    return pages
      .map((page) => (typeof page?.markdown_content === "string" ? page.markdown_content : ""))
      .join("\n\n");
  } catch (error) {
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
