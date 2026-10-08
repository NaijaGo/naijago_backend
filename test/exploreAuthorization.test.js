const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const User = require('../models/User');
const ExploreLike = require('../models/ExploreLike');
const ExploreVideo = require('../models/ExploreVideo');
const ExploreComment = require('../models/ExploreComment');
const explore = require('../controllers/exploreController');

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function publisherResult(t, user) {
  const original = User.findById;
  User.findById = () => ({ select: async () => user });
  t.after(() => { User.findById = original; });
  const req = { user: { _id: 'test-user' } };
  const res = responseRecorder();
  let continued = false;
  await explore.requirePublisher(req, res, () => { continued = true; });
  return { req, res, continued };
}

test('Explore publisher authorization follows database User role and approval fields', async (t) => {
  await t.test('customer cannot publish', async (t) => {
    const { res, continued } = await publisherResult(t, { _id: 'customer', isVendor: false, vendorStatus: 'none' });
    assert.equal(res.statusCode, 403);
    assert.equal(continued, false);
  });
  await t.test('unapproved vendor cannot publish', async (t) => {
    const { res, continued } = await publisherResult(t, { _id: 'vendor', isVendor: true, vendorStatus: 'reviewing' });
    assert.equal(res.statusCode, 403);
    assert.equal(continued, false);
  });
  await t.test('approved vendor is admitted as vendor', async (t) => {
    const { req, continued } = await publisherResult(t, { _id: 'vendor', isVendor: true, vendorStatus: 'approved' });
    assert.equal(continued, true);
    assert.equal(req.explorePublisherType, 'vendor');
  });
  await t.test('admin is admitted from the database admin flag', async (t) => {
    const { req, continued } = await publisherResult(t, { _id: 'admin', isAdmin: true });
    assert.equal(continued, true);
    assert.equal(req.explorePublisherType, 'admin');
  });
});

test('Explore models define unique likes and indexed feed/comment relationships', () => {
  const likeIndexes = ExploreLike.schema.indexes();
  assert.ok(likeIndexes.some(([keys, options]) => keys.video === 1 && keys.user === 1 && options.unique === true));
  const videoIndexes = ExploreVideo.schema.indexes();
  assert.ok(videoIndexes.some(([keys]) => keys.status === 1 && keys.createdAt === -1));
  assert.ok(videoIndexes.some(([keys]) => keys.creator === 1));
  assert.ok(videoIndexes.some(([keys]) => keys.vendor === 1));
  assert.ok(videoIndexes.some(([keys]) => keys.product === 1));
  assert.ok(ExploreComment.schema.indexes().some(([keys]) => keys.video === 1 && keys.createdAt === -1));
});

test('invalid Explore video IDs and empty comments produce client errors', async () => {
  const likeResponse = responseRecorder();
  let likeError;
  await explore.likeVideo({ params: { videoId: 'not-an-object-id' }, user: { _id: 'customer' } }, likeResponse, (error) => { likeError = error; });
  assert.equal(likeError.statusCode, 400);

  const commentResponse = responseRecorder();
  let commentError;
  await explore.addComment({ params: { videoId: 'not-an-object-id' }, user: { _id: 'customer' }, body: { text: '   ' } }, commentResponse, (error) => { commentError = error; });
  assert.equal(commentError.statusCode, 400);
});

test('Explore routes require authentication on reads and writes and protect publishing before multipart parsing', () => {
  const routes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'exploreRoutes.js'), 'utf8');
  assert.match(routes, /router\.post\('\/videos', protect, explore\.requirePublisher, explore\.parseVideo/);
  assert.match(routes, /router\.get\('\/', protect, explore\.getFeed/);
  assert.match(routes, /router\.put\('\/:videoId\/like', protect/);
  assert.match(routes, /router\.delete\('\/:videoId\/like', protect/);
  assert.match(routes, /router\.post\('\/:videoId\/comments', protect/);
});

test('malformed Explore writes reject before opening a MongoDB session', async t => {
 const mongoose=require('mongoose');const original=mongoose.startSession;let calls=0;
 mongoose.startSession=async()=>{calls++;throw new Error('A malformed request must not open a session');};
 t.after(()=>{mongoose.startSession=original;});
 for(const handler of ['likeVideo','unlikeVideo','addComment','deleteComment']) {
  const req={params:{videoId:'invalid',commentId:'507f1f77bcf86cd799439011'},user:{_id:'customer'},body:{text:'Valid comment'}};
  let failure;await explore[handler](req,responseRecorder(),error=>{failure=error;});assert.equal(failure?.statusCode,400,handler);
 }
 assert.equal(calls,0);
});
