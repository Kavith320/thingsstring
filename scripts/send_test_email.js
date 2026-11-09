// Send one test email straight through the configured SMTP provider (no queue).
// Usage: npm run email:test -- you@example.com
//        npm run email:test -- you@example.com --device <deviceId>   sample "device offline" email
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

  let mail = render("verifyEmail", { name: "Test", token: "this-is-only-a-test-link" });
  const at = process.argv.indexOf("--device");
  if (at > 0) {
    const deviceId = process.argv[at + 1];
    if (!deviceId) throw new Error("--device needs a device id");
    const { MongoClient } = require("mongoose").mongo;
    const { deviceDisplayName } = require("../src/email/notify");
    const client = await MongoClient.connect(process.env.MONGO_URI);
    try {
      const { name, device } = await deviceDisplayName(client.db(process.env.MONGO_DB || undefined), deviceId);
      console.log(`Device: ${name} (${deviceId})`);
      mail = render("deviceOffline", { name: "Test", deviceId, deviceName: name, device, lastSeen: new Date(Date.now() - 6 * 60e3), afterMin: 5, timezone: "UTC" });
    } finally {
      await client.close();
    }
  }
  const { subject, html, text } = mail;
  const id = await sendMail({ to, subject: `[TEST] ${subject}`, html, text });
  console.log(`✅ Sent (${id}). Check the inbox and the spam folder of ${to}.`);
  closeMailer();
})().catch((e) => {
  console.error("❌ Failed:", e.message);
  process.exit(1);
});
