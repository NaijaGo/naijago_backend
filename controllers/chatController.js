// controllers/chatController.js
const ChatSession = require('../models/ChatSession');
const ChatMessage = require('../models/ChatMessage');
// NOTE: axios and getAIResponse removed as core logic moves to server.js socket handler

// Start a chat session
exports.startChat = async (req, res) => {
  try {
    // A user can only have one 'open' session.
    const existing = await ChatSession.findOne({ user: req.user._id, status: 'open' });
    if (existing) return res.json(existing);

    const chat = await ChatSession.create({ user: req.user._id });
    res.status(201).json(chat);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to start chat' });
  }
};

// Send message (kept for non-socket fallback/legacy, but client should prefer socket)
// NOTE: This route should ideally be disabled or handle only metadata updates,
// as the primary messaging logic is in server.js/send_chat_message.
exports.sendMessage = async (req, res) => {
  try {
    const { sessionId, message } = req.body;
    const session = await ChatSession.findById(sessionId);
    if (!session) return res.status(404).json({ message: 'Chat not found' });

    // Save user message but rely on the socket to handle real-time reply (AI/Pharmacist)
    const userMsg = await ChatMessage.create({
      session: sessionId,
      senderType: 'user',
      sender: req.user._id,
      message,
    });
    
    // Note: AI/Pharmacist reply logic is removed here to prevent duplication with socket.io
    // The client should send the message via socket.io's 'send_chat_message' event.

    res.json({ success: true, message: userMsg });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Message send failed' });
  }
};


// // controllers/chatController.js
// const ChatSession = require('../models/ChatSession');
// const ChatMessage = require('../models/ChatMessage');
// const axios = require('axios');

// // Start a chat session
// exports.startChat = async (req, res) => {
//   try {
//     const existing = await ChatSession.findOne({ user: req.user._id, status: 'open' });
//     if (existing) return res.json(existing);

//     const chat = await ChatSession.create({ user: req.user._id });
//     res.status(201).json(chat);
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ message: 'Failed to start chat' });
//   }
// };

// // Send message (user → AI or pharmacist)
// exports.sendMessage = async (req, res) => {
//   try {
//     const { sessionId, message } = req.body;
//     const session = await ChatSession.findById(sessionId);
//     if (!session) return res.status(404).json({ message: 'Chat not found' });

//     // Save user message
//     const userMsg = await ChatMessage.create({
//       session: sessionId,
//       senderType: 'user',
//       sender: req.user._id,
//       message,
//     });

//     // --- AI Auto Reply (placeholder) ---
//     const aiReply = await getAIResponse(message);

//     const aiMsg = await ChatMessage.create({
//       session: sessionId,
//       senderType: 'ai',
//       message: aiReply,
//     });

//     const messages = [userMsg, aiMsg];
//     res.json({ success: true, messages });
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ message: 'Message send failed' });
//   }
// };

// // Temporary AI Mock (real API coming soon)
// async function getAIResponse(userMessage) {
//   try {
//     // Use a free AI API or OpenRouter later
//     return `🤖 AI: I see you said "${userMessage}". A pharmacist will join shortly.`;
//   } catch (err) {
//     console.error('AI error:', err.message);
//     return "I'm sorry, I couldn’t process that right now.";
//   }
// }
