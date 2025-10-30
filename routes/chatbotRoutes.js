//routes/chatbotRoutes.js

const express = require("express");
const router = express.Router();
const { getAIResponse } = require("../utils/aiChatService");

router.post("/", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Message is required" });

  const reply = await getAIResponse(message);
  res.json({ reply });
});

module.exports = router;
