const express = require('express');
const router = express.Router();
const { registerRider, loginRider } = require('../controllers/riderController');

router.post('/register', registerRider);
router.post('/login', loginRider);

module.exports = router;