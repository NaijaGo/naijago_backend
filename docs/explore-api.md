# Explore API

All Explore routes are mounted at `/api/explore` and require the existing `Authorization: Bearer <JWT>` session.

| Method and path | Purpose |
| --- | --- |
| `GET /api/explore?page=1&limit=10` | Paginated public published feed with `items`, `total`, and `hasMore`. `limit` is capped at 50. |
| `POST /api/explore/videos` | Approved vendor/admin multipart publish. Required file field `video`; text fields `caption` and optional `productId`. |
| `GET /api/explore/videos/mine` | Up to 50 non-deleted videos created by the current user. |
| `PUT /api/explore/:videoId/like` | Idempotently like a video. |
| `DELETE /api/explore/:videoId/like` | Idempotently unlike a video. |
| `GET /api/explore/:videoId/comments?page=1&limit=20` | Paginated comments and commenter details. |
| `POST /api/explore/:videoId/comments` | Add `{ "text": "..." }`. Text is trimmed and limited to 1,000 characters. |
| `DELETE /api/explore/:videoId/comments/:commentId` | Delete own comment; admins may remove any comment. |
| `PATCH /api/explore/videos/:videoId/unpublish` | Unpublish own content; admins may unpublish any content. |
| `DELETE /api/explore/:videoId` | Soft-delete own content; admins may remove any content. |

Video uploads accept MP4, MOV, WebM, M4V, 3GP/3G2, AVI, MKV, MPEG/MPG, WMV and FLV, at most 90 MB. There is no application duration cap. Mobile `application/octet-stream` uploads are accepted with a supported filename and verified container signature. Cloudinary must report a real video track; uploads are converted to MP4/H.264/AAC for playback. Provider/account processing limits still apply. Product IDs must refer to an active, approved product; vendors may only associate their own products. Creator and vendor identity always come from the verified backend User document.

### Publishing workspaces

Admins use **Explore Videos** (`explore-videos.html`) in the Admin Panel. Approved vendors use the **Explore** tab or **Account → Publish Explore Videos** in the vendor app. Both submit multipart `video`, `caption` and optional `productId` to `POST /api/explore/videos`, with the existing account JWT. Successful posts appear in the customer Explore feed; these forms do not use the separate product-media upload lifecycle.

`GET /api/explore/videos/mine?page=1&limit=20` returns the signed-in creator's videos, their `status` and `moderationStatus`, and `page`, `limit`, `total`, `hasMore`. The limit is 1–50; the default remains 50 for existing consumers. Both workspaces use the existing unpublish and soft-delete endpoints. They never supply creator/vendor roles or storage credentials.

Like and comment records are separate collections. A unique `(video,user)` like index prevents duplicates. Like/comment writes and denormalized counter changes run in MongoDB transactions. The deployed MongoDB must therefore support transactions (replica set or sharded cluster); otherwise those writes return HTTP 503 rather than applying partial counts.

Feed queries filter to published, public, moderation-approved videos whose `deletedAt` is null. Error responses use a JSON `message`; unexpected errors are handled by the existing production error middleware.
