const SUBSCRIPT_DIGITS = Object.freeze({
  0: "₀",
  1: "₁",
  2: "₂",
  3: "₃",
  4: "₄",
  5: "₅",
  6: "₆",
  7: "₇",
  8: "₈",
  9: "₉",
});

const SUPERSCRIPT_DIGITS = Object.freeze({
  0: "⁰",
  1: "¹",
  2: "²",
  3: "³",
  4: "⁴",
  5: "⁵",
  6: "⁶",
  7: "⁷",
  8: "⁸",
  9: "⁹",
});

const FORMULA_PATTERNS = [
  /\bH2O\b/g,
  /\bCO2\b/g,
  /\bO2\b/g,
  /\bH2\b/g,
  /\bN2\b/g,
  /\bCH4\b/g,
  /\bNH3\b/g,
  /\bH2SO4\b/g,
  /\bC6H12O6\b/g,
];

function replaceDigits(value, map) {
  return String(value).replace(/[0-9]/g, (digit) => map[digit] || digit);
}

function formatFormula(value) {
  return value.replace(/[0-9]+/g, (digits) => replaceDigits(digits, SUBSCRIPT_DIGITS));
}

export function formatStudyText(value) {
  if (typeof value !== "string" || !value) {
    return value;
  }

  let formatted = value.replace(/\^([0-9]+)/g, (_match, digits) => replaceDigits(digits, SUPERSCRIPT_DIGITS));

  for (const pattern of FORMULA_PATTERNS) {
    formatted = formatted.replace(pattern, (match) => formatFormula(match));
  }

  return formatted;
}

export const __studyTextFormatTestables = {
  formatFormula,
  replaceDigits,
};
