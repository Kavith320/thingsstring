require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../src/models/User");
const { generateUniqueUserId8 } = require("../src/utils/userId");

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const users = await User.find({ $or: [{ userId8: { $exists: false } }, { userId8: null }, { userId8: "" }] });
  console.log("Users missing userId8:", users.length);

  for (const u of users) {
    u.userId8 = await generateUniqueUserId8();
    await u.save();
    console.log("Updated:", u.email, "->", u.userId8);
  }

  await mongoose.disconnect();
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
