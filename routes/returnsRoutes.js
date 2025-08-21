const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { getReturns, createReturn } = require('../controllers/returnsController');

router.get('/', protect, getReturns);
router.post('/', protect, createReturn);

module.exports = router;
