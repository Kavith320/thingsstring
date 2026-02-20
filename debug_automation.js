const { connectMongo, getDb } = require("./src/db/mongo");
require("dotenv").config();

async function check() {
    await connectMongo();
    const db = getDb();

    console.log("--- Automation Flows ---");
    const flows = await db.collection("automation_flows").find({}).toArray();
    console.log(JSON.stringify(flows, null, 2));

    console.log("\n--- Device Control ---");
    const controls = await db.collection("device_control").find({}).toArray();
    console.log(JSON.stringify(controls, null, 2));

    console.log("\n--- Latest Telemetry (Last 3) ---");
    const tel = await db.collection("device_telemetry").find({}).sort({ _id: -1 }).limit(3).toArray();
    console.log(JSON.stringify(tel, null, 2));

    console.log("\n--- Automation Logs (Last 5) ---");
    const logs = await db.collection("automation_flow_logs").find({}).sort({ ts: -1 }).limit(5).toArray();
    console.log(JSON.stringify(logs, null, 2));

    process.exit(0);
}

check().catch(console.error);
