require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const User = require("../src/models/User");
const { generateUniqueUserId8 } = require("../src/utils/userId");

async function main() {
    const email = process.argv[2];
    const password = process.argv[3];

    if (!email || !password) {
        console.error("Usage: node scripts/create-admin.js <email> <password>");
        process.exit(1);
    }

    // Connect to MongoDB
    if (!process.env.MONGO_URI) {
        console.error("❌ MONGO_URI missing in .env");
        process.exit(1);
    }

    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ Custom Admin Script: Connected to MongoDB");

    const existingUser = await User.findOne({ email });

    if (existingUser) {
        // Update existing user
        existingUser.role = "admin";
        // Also update password if provided
        const salt = await bcrypt.genSalt(10);
        existingUser.passwordHash = await bcrypt.hash(password, salt);
        await existingUser.save();
        console.log(`✅ Updated existing user ${email} to 'admin' role with new password.`);
    } else {
        // Create new admin user
        const userId8 = await generateUniqueUserId8();
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        await User.create({
            userId8,
            name: "Admin User",
            email,
            passwordHash,
            role: "admin",
            authProvider: "local",
            emailVerified: true
        });
        console.log(`✅ Created new admin user ${email}.`);
    }

    await mongoose.disconnect();
    console.log("Done.");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
