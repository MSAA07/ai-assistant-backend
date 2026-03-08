import OpenAI from "openai";
import { captureSentryException } from "./sentry.js";

let client;
const MODEL_NAME = "gpt-4o-mini";

function getClient() {
  if (!process.env.OPENAI_API_KEY) {
    console.warn("[ai] OPENAI_API_KEY not set; skipping study material generation");
    return null;
  }

  if (!client) {
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return client;
}

const FALLBACK_RESPONSE = {
  summary: "",
  flashcards: [],
  examQuestions: [],
  modelUsed: null,
  usage: null,
};

function withResponseMetadata(payload, response) {
  return {
    ...payload,
    modelUsed: response?.model || MODEL_NAME,
    usage: response?.usage || null,
  };
}

function normalizeOutput(output = {}) {
  const summary = typeof output.summary === "string" ? output.summary.trim() : "";
  const flashcards = Array.isArray(output.flashcards) ? output.flashcards : [];
  const examQuestions = Array.isArray(output.examQuestions) ? output.examQuestions : [];
  return { summary, flashcards, examQuestions };
}

function buildPrompt(text, language) {
  const languageName = language === "arabic" ? "Arabic" : "English";
  return `You are an expert educational content creator. Analyze the following study material and return concise JSON in ${languageName}.

Rules:
- Output must be valid JSON with keys: summary (string), flashcards (array of {question, answer}), examQuestions (array of {type, question, options?, correctAnswer, explanation}).
- Flashcards should contain 8-15 cards depending on length.
- Exam questions should include a mix of multiple choice (with 4 options), true/false, and short answer. Use field "type" to denote "mcq", "true_false", or "short".
- Keep explanations to 1-2 sentences. Do not prefix answers with letters.
- If context is weak, return the best concise materials you can. Do not return empty arrays.

Study Material:
"""
${text}
"""`;
}

export async function generateStudyMaterialsFromExcerpts(excerpts, language = "english") {
  try {
    const openai = getClient();
    if (!openai) return FALLBACK_RESPONSE;

    const combined = excerpts
      .filter((excerpt) => excerpt.excerptType !== "image_flag")
      .map((excerpt) => excerpt.content?.trim())
      .filter(Boolean)
      .join("\n\n");

    if (!combined) {
      console.warn("[ai] No text extracted for study material generation");
      return FALLBACK_RESPONSE;
    }

    const truncated = combined.slice(0, 12000);
    const prompt = buildPrompt(truncated, language);

    const response = await openai.chat.completions.create({
      model: MODEL_NAME,
      messages: [
        { role: "system", content: "You convert study material into JSON outputs." },
        { role: "user", content: prompt },
      ],
      temperature: 0.4,
    });

    const raw = response.choices?.[0]?.message?.content;
    if (!raw) {
      console.warn("[ai] Empty response from OpenAI");
      return withResponseMetadata(FALLBACK_RESPONSE, response);
    }

    try {
      const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
      const parsed = JSON.parse(cleaned);
      const normalized = normalizeOutput(parsed);
      console.info(
        "[ai] Generated study materials",
        `summary=${normalized.summary.length}`,
        `flashcards=${normalized.flashcards.length}`,
        `examQuestions=${normalized.examQuestions.length}`,
      );
      return withResponseMetadata(normalized, response);
    } catch (error) {
      console.error("[ai] Failed to parse study materials response:", error);
      captureSentryException(error, {
        tags: { ai_phase: "parse_study_materials_response" },
      });
      return withResponseMetadata(FALLBACK_RESPONSE, response);
    }
  } catch (error) {
    console.error("[ai] Failed to generate study materials:", error);
    captureSentryException(error, {
      tags: { ai_phase: "generate_study_materials" },
    });
    return FALLBACK_RESPONSE;
  }
}
