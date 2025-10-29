//utils/aiChatService.js

const axios = require("axios");

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

async function getAIResponse(message) {
  try {
    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: "nvidia/nemotron-nano-12b-v2-vl:free", // you can replace with another model
        messages: [
          {
            role: "system",
            content: "You are a friendly and knowledgeable pharmacy assistant chatbot. Provide helpful health information, but never give prescriptions. Encourage users to wait for a real pharmacist when necessary."
          },
          { role: "user", content: message }
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const aiMessage = response.data.choices?.[0]?.message?.content || "I'm sorry, I didn't understand that.";
    return aiMessage;

  } catch (error) {
    console.error("AI response error:", error.response?.data || error.message);
    return "I'm having trouble responding right now. Please wait patiently while i connect you to a live certified pharmacist.";
  }
}

module.exports = { getAIResponse };
