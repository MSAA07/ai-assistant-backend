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
    "Thanks for signing up for Studymaxing. Click the button below to verify your email address and activate your account.",
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
    html: `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#000000;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#000000;padding:48px 24px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
          <tr>
            <td style="padding-bottom:40px;">
              <span style="color:#ffffff;font-size:15px;font-weight:700;letter-spacing:0.08em;">STUDYMAXING</span>
            </td>
          </tr>
          <tr>
            <td style="background-color:#111111;border:1px solid #222222;border-radius:12px;padding:48px 40px;">
              <h1 style="margin:0 0 12px 0;color:#ffffff;font-size:26px;font-weight:700;line-height:1.2;">Verify your email</h1>
              <p style="margin:0 0 8px 0;color:#aaaaaa;font-size:15px;line-height:1.6;">${escapeHtml(body[0])}</p>
              <p style="margin:0 0 32px 0;color:#aaaaaa;font-size:15px;line-height:1.6;">${escapeHtml(body[1])}</p>
              <a href="${escapeHtml(verificationUrl)}" style="display:inline-block;background-color:#ffffff;color:#000000;text-decoration:none;font-size:15px;font-weight:600;padding:14px 32px;border-radius:8px;margin-bottom:32px;">Verify email</a>
              <p style="margin:0;color:#555555;font-size:13px;line-height:1.6;">${escapeHtml(body[2])}</p>
            </td>
          </tr>
          <tr>
            <td style="padding-top:32px;">
              <p style="margin:0;color:#444444;font-size:13px;">Need help? Contact <a href="mailto:support@studymaxing.com" style="color:#777777;">support@studymaxing.com</a></p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
  };
}

export function buildExistingUserSignUpEmail({ supportEmail }) {
  const subject = "Studymaxing sign-up attempt";
  const body = [
    "Someone tried to create a Studymaxing account using this email address.",
    "If that was you, sign in instead and verify your email if prompted.",
    "If that was not you, you can safely ignore this email.",
  ];

  return {
    subject,
    text: [
      "Someone tried to create a Studymaxing account using this email address.",
      "If that was you, sign in instead and verify your email if prompted.",
      "If that was not you, you can safely ignore this email.",
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
    "We received a request to reset your Studymaxing password. Click the button below to choose a new password.",
    "If you did not request this, you can safely ignore this email. Your password will not change.",
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
    html: `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#000000;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#000000;padding:48px 24px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
          <tr>
            <td style="padding-bottom:40px;">
              <span style="color:#ffffff;font-size:15px;font-weight:700;letter-spacing:0.08em;">STUDYMAXING</span>
            </td>
          </tr>
          <tr>
            <td style="background-color:#111111;border:1px solid #222222;border-radius:12px;padding:48px 40px;">
              <h1 style="margin:0 0 12px 0;color:#ffffff;font-size:26px;font-weight:700;line-height:1.2;">Reset your password</h1>
              <p style="margin:0 0 8px 0;color:#aaaaaa;font-size:15px;line-height:1.6;">${escapeHtml(body[0])}</p>
              <p style="margin:0 0 32px 0;color:#aaaaaa;font-size:15px;line-height:1.6;">${escapeHtml(body[1])}</p>
              <a href="${escapeHtml(resetUrl)}" style="display:inline-block;background-color:#ffffff;color:#000000;text-decoration:none;font-size:15px;font-weight:600;padding:14px 32px;border-radius:8px;margin-bottom:32px;">Reset password</a>
              <p style="margin:0;color:#555555;font-size:13px;line-height:1.6;">${escapeHtml(body[2])}</p>
            </td>
          </tr>
          <tr>
            <td style="padding-top:32px;">
              <p style="margin:0;color:#444444;font-size:13px;">Need help? Contact <a href="mailto:support@studymaxing.com" style="color:#777777;">support@studymaxing.com</a></p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
  };
}
