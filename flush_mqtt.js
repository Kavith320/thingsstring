const mqtt = require("mqtt");
require("dotenv").config();

/**
 * UTILITY: Flush MQTT session and/or retained messages
 * Usage: node flush_mqtt.js <deviceId>
 */

const deviceId = process.argv[2];
if (!deviceId) {
    console.error("Please provide a deviceId. Example: node flush_mqtt.js 123498765");
    process.exit(1);
}

const url = process.env.MQTT_URL;
const options = {
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
    clientId: `relay_${deviceId}`, // Replicate the device's clientId
    clean: true,                  // This is the "Magic": it clears the session queue on the broker
};

console.log(`Connecting to ${url} as ${options.clientId} with clean: true...`);

const client = mqtt.connect(url, options);

client.on("connect", () => {
    console.log("✅ Connected. Session queue for this ID should now be cleared on the broker.");

    // Also clear the RETAINED message on the control topic
    const topic = `ts/${deviceId}/control`;
    console.log(`Clearing retained message on: ${topic}`);

    // Sending an empty payload with retain: true clears the retained state
    client.publish(topic, "", { retain: true, qos: 0 }, (err) => {
        if (err) {
            console.error("❌ Error clearing retained:", err.message);
        } else {
            console.log("✅ Retained message cleared.");
        }

        console.log("Disconnecting in 2s...");
        setTimeout(() => {
            client.end();
            process.exit(0);
        }, 2000);
    });
});

client.on("error", (err) => {
    console.error("❌ Connection error:", err.message);
    process.exit(1);
});
