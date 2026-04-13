function getRequiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for auth email delivery`);
  }
  return value;
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

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Resend email request failed (${response.status}): ${body || response.statusText}`);
  }

  return response.json();
}
