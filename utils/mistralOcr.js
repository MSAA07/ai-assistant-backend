import fs from "fs";

const MISTRAL_OCR_ENDPOINT = "https://api.mistral.ai/v1/ocr";

export async function extractWithMistralOcr(filePath) {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) {
    throw new Error("Mistral OCR failed: MISTRAL_API_KEY is not configured");
  }

  try {
    const base64Data = fs.readFileSync(filePath, "base64");
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
          document_url: `data:application/pdf;base64,${base64Data}`,
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
      .join("\n");
  } catch (error) {
    if (error?.message?.startsWith("Mistral OCR failed:")) {
      throw error;
    }

    throw new Error(`Mistral OCR failed: ${error.message}`);
  }
}
