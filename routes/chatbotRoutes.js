const express = require("express");
const router = express.Router();

router.post("/", async (req, res) => {
  res.status(410).json({
    message: "AI chatbot has been removed. Please use pharmacist consultation chat.",
  });
});

module.exports = router;
