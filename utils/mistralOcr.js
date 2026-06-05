import path from "path";

export async function extractWithMistralOcr(filePath) {
  const filename = path.basename(filePath);
  console.log("[MistralOCR] Step 1 - function called for:", filename);

  try {
    console.log("[MistralOCR] Step 2 - importing SDK...");
    const { Mistral } = await import("@mistralai/mistralai");
    console.log("[MistralOCR] Step 3 - SDK imported successfully");

    const apiKey = process.env.MISTRAL_API_KEY;
    console.log("[MistralOCR] Step 4 - API key present:", !!apiKey, "length:", apiKey?.length);

    const client = new Mistral({ apiKey });
    console.log("[MistralOCR] Step 5 - client created successfully");

    const models = await client.models.list();
    console.log("[MistralOCR] Step 6 - API connection works, models count:", models?.data?.length);

  } catch (err) {
    console.log("[MistralOCR] CRASH at step above. Error name:", err.name);
    console.log("[MistralOCR] CRASH message:", err.message);
    console.log("[MistralOCR] CRASH stack:", err.stack?.slice(0, 300));
  }

  throw new Error("Diagnostic mode - OCR not attempted yet");
}
