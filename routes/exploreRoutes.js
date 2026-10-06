const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const explore = require('../controllers/exploreController');

const router = express.Router();

router.post('/videos', protect, explore.requirePublisher, explore.parseVideo, explore.createVideo);
router.get('/videos/mine', protect, explore.getMyVideos);
router.get('/', protect, explore.getFeed);
router.put('/:videoId/like', protect, explore.likeVideo);
router.delete('/:videoId/like', protect, explore.unlikeVideo);
router.get('/:videoId/comments', protect, explore.getComments);
router.post('/:videoId/comments', protect, explore.addComment);
router.delete('/:videoId/comments/:commentId', protect, explore.deleteComment);
router.patch('/videos/:videoId/unpublish', protect, explore.unpublishVideo);
router.delete('/:videoId', protect, explore.deleteVideo);

// Keep database and provider details out of Explore API responses while
// preserving validation and authorization status codes.
router.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);
  const status = Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode < 500
    ? error.statusCode
    : 500;
  if (status === 500) console.error('Explore request failed.');
  res.status(status).json({
    message: status === 500 ? 'Explore request failed. Please try again.' : error.message,
  });
});

module.exports = router;
