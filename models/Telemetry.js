// models/Telemetry.js
import mongoose from "mongoose";

const TelemetrySchema = new mongoose.Schema(
  {
    deviceId: { type: String, required: true, unique: true, index: true },
    userId:   { type: String, index: true },     // optional (fill in later if you add auth)
    createdAt:{ type: Date, default: Date.now },
    // Map<ISO timestamp string, payload object>
    data:     { type: Map, of: mongoose.Schema.Types.Mixed, default: new Map() }
  },
  { versionKey: false }
);

// One document per deviceId
TelemetrySchema.index({ deviceId: 1 }, { unique: true });

export default mongoose.model("Telemetry", TelemetrySchema);
