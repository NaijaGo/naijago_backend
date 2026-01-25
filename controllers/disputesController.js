const DisputeRequest = require('../models/DisputeRequest');

// @desc Create a new dispute
exports.createDispute = async (req, res) => {
  try {
    const { orderId, reason, attachments } = req.body;

    const dispute = await DisputeRequest.create({
      user: req.user._id,
      order: orderId,
      reason,
      attachments: attachments || [],
      status: 'pending'
    });

    res.status(201).json(dispute);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc Get disputes for the logged-in user
// exports.getUserDisputes = async (req, res) => {
//   try {
//     const disputes = await DisputeRequest.find({ user: req.user._id })
//       .populate('order', 'orderItems totalPrice')
//       .sort({ createdAt: -1 });

//     res.json(disputes);
//   } catch (error) {
//     res.status(500).json({ message: error.message });
//   }
// };

exports.getUserDisputes = async (req, res) => {
  try {
    const disputes = await DisputeRequest.find({ user: req.user._id })
      .populate('order', 'totalPrice mainOrderStatus createdAt')
      .sort({ createdAt: -1 });

    res.json(disputes);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};


// @desc Get a single dispute by ID
exports.getDisputeById = async (req, res) => {
  try {
    const dispute = await DisputeRequest.findById(req.params.id)
      .populate('user', 'firstName lastName email')
      .populate('order');

    if (!dispute) return res.status(404).json({ message: 'Dispute not found' });

    res.json(dispute);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
