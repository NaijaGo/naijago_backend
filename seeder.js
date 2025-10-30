// seeder.js
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const bcrypt = require("bcryptjs");
const User = require("./models/User");

dotenv.config();

const pharmacists = [
  {
    firstName: "Pharmacist",
    lastName: "Stanley",
    email: "pharmaciststanley@naijago@gmail.com",
    phoneNumber: "07039507424",
    password: bcrypt.hashSync("pharmacist@naijago", 10),
    role: "pharmacist",
    isAvailable: true,
  },
  {
    firstName: "Pharmacist",
    lastName: "Tobechi",
    email: "pharmacisttobechi@naijago@gmail.com",
    phoneNumber: "09031225275",
    password: bcrypt.hashSync("pharmacist@naijago", 10),
    role: "pharmacist",
    isAvailable: true,
  },
];

const seedPharmacists = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ MongoDB Connected");

    await User.deleteMany({ role: "pharmacist" });
    console.log("🧹 Removed existing pharmacists");

    await User.insertMany(pharmacists);
    console.log("🌱 Pharmacists seeded successfully");

    mongoose.connection.close();
    console.log("🔌 Connection closed");
  } catch (error) {
    console.error("❌ Seeding failed:", error);
    process.exit(1);
  }
};

seedPharmacists();
