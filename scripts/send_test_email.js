// Send one test email straight through the configured SMTP provider (no queue).
// Usage: npm run email:test -- you@example.com
require("dotenv").config({ quiet: true });
const { sendMail, verifyMailer, closeMailer, mailMode } = require("../src/email/mailer");
const { render } = require("../src/email/templates");

(async () => {
  const to = process.argv[2];
  if (!to || !to.includes("@")) {
    console.error("Usage: npm run email:test -- you@example.com");
    process.exit(1);
  }
  console.log(`Mode: ${mailMode()}  From: ${process.env.MAIL_FROM || "(default)"}`);
  if (mailMode() === "smtp" && !(await verifyMailer())) process.exit(1);

  const { subject, html, text } = render("verifyEmail", { name: "Test", token: "this-is-only-a-test-link" });
  const id = await sendMail({ to, subject: `[TEST] ${subject}`, html, text });
  console.log(`✅ Sent (${id}). Check the inbox and the spam folder of ${to}.`);
  closeMailer();
})().catch((e) => {
  console.error("❌ Failed:", e.message);
  process.exit(1);
});
