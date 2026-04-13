function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeCompactSourceRef(ref) {
  if (!ref || typeof ref !== "object") {
    return null;
  }

  const excerptId = normalizeString(ref.excerptId ?? ref.id);
  const page = normalizeInteger(ref.page ?? ref.slideOrPage);
  const start = normalizeInteger(ref.start ?? ref.charOffset);
  const end = normalizeInteger(ref.end);

  if (!excerptId && page === null) {
    return null;
  }

  const normalizedRef = {};

  if (excerptId) {
    normalizedRef.excerptId = excerptId;
  }

  if (page !== null) {
    normalizedRef.page = page;
  }

  if (start !== null) {
    normalizedRef.start = start;
  }

  if (end !== null) {
    normalizedRef.end = end;
  }

  return normalizedRef;
}

export function normalizeCompactSourceRefs(sourceRefs) {
  if (!Array.isArray(sourceRefs)) {
    return [];
  }

  return sourceRefs
    .map(normalizeCompactSourceRef)
    .filter(Boolean);
}

