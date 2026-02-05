const jwt = require('jsonwebtoken');
const Company = require('../models/Company');

const companyAuth = async (req, res, next) => {
  try {
    // Get token from header
    const authHeader = req.header('Authorization');
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'No authentication token provided'
      });
    }

    const token = authHeader.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'No authentication token provided'
      });
    }

    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Check if this is a company token
    if (decoded.role !== 'company' && !decoded.companyId) {
      return res.status(401).json({
        success: false,
        message: 'Invalid token type. Company token required.'
      });
    }

    // Find company
    const company = await Company.findById(decoded.id || decoded.companyId)
      .select('-password -verificationCode -verificationExpires');
    
    if (!company) {
      return res.status(401).json({
        success: false,
        message: 'Company not found'
      });
    }

    // Check if company is verified
    if (!company.isVerified) {
      return res.status(403).json({
        success: false,
        message: 'Please verify your email address first'
      });
    }

    // Check if company is active
    if (company.status !== 'active') {
      return res.status(403).json({
        success: false,
        message: 'Company account is not active'
      });
    }

    // Attach company to request
    req.company = company;
    req.token = token;
    next();
    
  } catch (error) {
    console.error('Auth middleware error:', error.message);
    
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'Invalid token'
      });
    }
    
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Token expired'
      });
    }
    
    res.status(401).json({
      success: false,
      message: 'Please authenticate'
    });
  }
};

module.exports = { companyAuth };