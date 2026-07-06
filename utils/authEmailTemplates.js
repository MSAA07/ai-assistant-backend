function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function wrapEmail({ title, body, ctaLabel, ctaUrl, supportEmail }) {
  const safeTitle = escapeHtml(title);
  const safeBody = body.map((line) => `<p style="margin:0 0 16px;">${escapeHtml(line)}</p>`).join("");
  const safeCtaLabel = escapeHtml(ctaLabel);
  const safeCtaUrl = escapeHtml(ctaUrl);
  const safeSupportEmail = supportEmail ? escapeHtml(supportEmail) : "";

  return `
    <div style="background:#f6f4ee;padding:32px 16px;font-family:Arial,sans-serif;color:#1f1b16;">
      <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:20px;padding:32px;border:1px solid #e8dfd3;">
        <p style="margin:0 0 12px;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#7d5f3b;">Studymaxing</p>
        <h1 style="margin:0 0 16px;font-size:28px;line-height:1.2;">${safeTitle}</h1>
        <div style="font-size:16px;line-height:1.6;color:#3b332b;">${safeBody}</div>
        <p style="margin:24px 0 0;">
          <a href="${safeCtaUrl}" style="display:inline-block;background:#1f1b16;color:#ffffff;text-decoration:none;padding:14px 20px;border-radius:999px;font-weight:700;">
            ${safeCtaLabel}
          </a>
        </p>
        ${
          safeSupportEmail
            ? `<p style="margin:24px 0 0;font-size:13px;line-height:1.5;color:#6f655b;">Need help? Reply to this email or contact <a href="mailto:${safeSupportEmail}" style="color:#6f655b;">${safeSupportEmail}</a>.</p>`
            : ""
        }
      </div>
    </div>
  `;
}

export function buildVerificationEmail({ name, verificationUrl, supportEmail }) {
  const displayName = name?.trim() || "there";
  const subject = "Verify your Studymaxing email";
  const body = [
    `Hi ${displayName},`,
    "Thanks for signing up for Studymaxing. Verify your email address to activate your account and finish setup.",
    "If you did not create this account, you can safely ignore this email.",
  ];
  const text = [
    `Hi ${displayName},`,
    "",
    "Thanks for signing up for Studymaxing. Verify your email address to activate your account and finish setup.",
    "",
    verificationUrl,
    "",
    supportEmail ? `Need help? Contact ${supportEmail}.` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    subject,
    text,
    html: wrapEmail({
      title: "Verify your email",
      body,
      ctaLabel: "Verify email",
      ctaUrl: verificationUrl,
      supportEmail,
    }),
  };
}

export function buildExistingUserSignUpEmail({ supportEmail }) {
  const subject = "Studymaxing sign-up attempt";
  const body = [
    "Someone attempted to create a Studymaxing account using this email address.",
    "If this was not you, no action is needed.",
    "If you forgot you already have an account, use forgot password to regain access.",
  ];

  return {
    subject,
    text: [
      "Someone attempted to create a Studymaxing account using this email address.",
      "If this was not you, no action is needed.",
      "If you forgot you already have an account, use forgot password to regain access.",
      supportEmail ? `Need help? Contact ${supportEmail}.` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    html: wrapEmail({
      title: "Sign-up attempt detected",
      body,
      ctaLabel: "Open Studymaxing",
      ctaUrl: process.env.AUTH_EMAIL_APP_URL?.trim() || "https://studymaxing.com",
      supportEmail,
    }),
  };
}

export function buildResetPasswordEmail({ name, resetUrl, supportEmail }) {
  const displayName = name?.trim() || "there";
  const subject = "Reset your Studymaxing password";
  const body = [
    `Hi ${displayName},`,
    "We received a request to reset your Studymaxing password.",
    "Use the secure link below to choose a new password. If you did not request this, you can safely ignore this email.",
  ];

  return {
    subject,
    text: [
      `Hi ${displayName},`,
      "",
      "We received a request to reset your Studymaxing password.",
      "",
      resetUrl,
      "",
      "If you did not request this, you can safely ignore this email.",
      supportEmail ? `Need help? Contact ${supportEmail}.` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    html: wrapEmail({
      title: "Reset your password",
      body,
      ctaLabel: "Reset password",
      ctaUrl: resetUrl,
      supportEmail,
    }),
  };
}
