const colors = require('colors');

const notFound = (req, res, next) => {
  res.status(404).json({ message: 'Route not found' });
};

const errorHandler = (err, req, res, next) => {
  const status = err.statusCode || res.statusCode || 500;
  if (status >= 500) {
    console.error(colors.red.bold('Server Error:'), err.stack || err);
  }
  res.status(status).json({
    message: err.message || 'Something went wrong on the server.',
    stack: process.env.NODE_ENV === 'production' ? null : err.stack,
  });
};

module.exports = { notFound, errorHandler };
