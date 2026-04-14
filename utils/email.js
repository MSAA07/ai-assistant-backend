function getRequiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for auth email delivery`);
  }
  return value;
}

function maskEmailAddress(address = "") {
  const [localPart = "", domain = ""] = String(address).split("@");
  if (!domain) return "***";
  if (localPart.length <= 2) {
    return `${localPart[0] || "*"}***@${domain}`;
  }
  return `${localPart.slice(0, 2)}***@${domain}`;
}

function getSenderConfig() {
  const fromEmail = getRequiredEnv("AUTH_EMAIL_FROM_EMAIL");
  const fromName = process.env.AUTH_EMAIL_FROM_NAME?.trim() || "Studymaxing";
  const replyTo = process.env.AUTH_EMAIL_REPLY_TO?.trim() || "";

  return {
    from: `${fromName} <${fromEmail}>`,
    replyTo,
  };
}

export async function sendTransactionalEmail({
  to,
  subject,
  html,
  text,
}) {
  const provider = (process.env.AUTH_EMAIL_PROVIDER || "resend").trim().toLowerCase();

  if (provider !== "resend") {
    throw new Error(`Unsupported AUTH_EMAIL_PROVIDER: ${provider}`);
  }

  const apiKey = getRequiredEnv("RESEND_API_KEY");
  const { from, replyTo } = getSenderConfig();

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      text,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });

  const bodyText = await response.text();
  let body = null;
  if (bodyText) {
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = { raw: bodyText };
    }
  }

  if (!response.ok) {
    console.error("[auth-email] provider rejected send", {
      provider,
      status: response.status,
      subject,
      to: (Array.isArray(to) ? to : [to]).map(maskEmailAddress),
      error: body ?? response.statusText,
    });

    throw new Error(
      `Resend email request failed (${response.status}): ${JSON.stringify(body ?? response.statusText)}`,
    );
  }

  const providerMessageId = body?.id || body?.data?.id || "";

  console.info("[auth-email] provider accepted send", {
    provider,
    subject,
    to: (Array.isArray(to) ? to : [to]).map(maskEmailAddress),
    messageId: providerMessageId || "(missing)",
  });

  return {
    ...body,
    providerMessageId,
  };
}
