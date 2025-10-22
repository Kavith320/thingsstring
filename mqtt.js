// mqtt.js
import mqtt from "mqtt";
import dotenv from "dotenv";
import Telemetry from "./models/Telemetry.js";
dotenv.config();

let url = (process.env.MQTT_URL || "").trim();
if (url && !/^mqtts?:\/\//i.test(url)) url = `mqtt://${url}`;

const { MQTT_USER, MQTT_PASS } = process.env;

export function startMqtt() {
  if (!url) {
    console.warn("⚠️  MQTT_URL not set; MQTT consumer is disabled");
    return { client: null };
  }

  const client = mqtt.connect(url, {
    username: MQTT_USER || undefined,
    password: MQTT_PASS || undefined,
    reconnectPeriod: 2000,
    keepalive: 60,
  });

  client.on("connect", () => {
    console.log(`✅ MQTT connected → ${url}`);
    client.subscribe("tsdevices/+/telemetry", (err) => {
      if (err) console.error("Subscribe error:", err.message);
      else console.log("📡 Subscribed: tsdevices/+/telemetry");
    });
  });

  client.on("message", async (topic, buf) => {
    try {
      // Topic format: tsdevices/<deviceId>/telemetry
      const parts = topic.split("/");
      const deviceId = parts[1];
      if (!deviceId) return console.warn("⚠️ Missing deviceId in topic:", topic);

      // Parse payload JSON
      let payload;
      try { payload = JSON.parse(buf.toString()); }
      catch { console.error("❌ Bad JSON payload, skipping:", buf.toString()); return; }

      // Use payload.ts if present, otherwise current time
      const ts = payload.ts ? new Date(payload.ts) : new Date();
      const isoTs = ts.toISOString();
      const safeTs = isoTs.replace(/\./g, "_"); // <-- FIXED HERE

      const userId = payload.userId || null;
      const { ts: _t, deviceId: _d, userId: _u, ...data } = payload;

      // Save in Mongo
      await Telemetry.updateOne(
        { deviceId },
        {
          $setOnInsert: { deviceId, userId, createdAt: new Date() },
          $set: { [`data.${safeTs}`]: data },
        },
        { upsert: true }
      );

      console.log(`💾 [${deviceId}] + ${safeTs} (${Object.keys(data).join(", ") || "no fields"})`);
    } catch (e) {
      console.error("MQTT handler error:", e);
    }
  });

  client.on("error", (e) => console.error("MQTT error:", e.message));
  client.on("reconnect", () => console.log("↻ MQTT reconnecting..."));
  return { client };
}
