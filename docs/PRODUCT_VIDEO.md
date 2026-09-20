# Product video setup and verification

Feature flag: `PRODUCT_VIDEO_ENABLED=true`. Default is disabled. Existing Cloudinary credentials are reused: `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`. No new provider key is needed for the manual-review video workflow. Confirm account video storage/transcoding allowance before enabling.

Upload contract:

1. GET `/api/product-media/config` for availability, policy version, five warnings and limits.
2. Approved vendor accepts policy; POST `/api/product-media/uploads` with `{mimeType, bytes, policyVersion}` and bearer auth.
3. Upload the file directly to the returned Cloudinary `uploadUrl`, with exactly the returned signed fields. Never send NaijaGo's JWT to Cloudinary.
4. POST `/api/product-media/assets/:assetId/complete` with bearer auth. Backend reads Cloudinary metadata; no client-declared duration/URL is trusted. Status becomes `pending_review` only after validation.
5. Pass `videoAssetId` to existing product create/update multipart request. Missing means preserve; empty string explicitly removes. Existing product ownership and order-history editing restrictions apply. Keep the completed asset ID on form retry so a failed product save does not re-upload.
6. Admin GET `/api/product-media/review?status=pending_review&page=1`, then PUT `/api/product-media/assets/:assetId/review` with `{status, reason, revision}`. Rejection requires a reason. Review decisions use optimistic concurrency and audit history.
7. Customer GET `/api/product-media/products/:productId` returns approved video playback/poster only for a published product. Pending assets are never delivered by this endpoint. Uploaders/admin can preview their own pending assets using the authenticated asset endpoint.

Limits: 60 seconds, 50 MiB input, MP4/MOV/WebM, one optional video per listing in this initial product form. Media assets remain independent so Explore and image processing can extend the model. A unique sparse product video reference prevents one uploaded asset from attaching to several listings.

Cloudinary `authenticated` delivery protects originals and generated derivatives; backend generates signed delivery URLs only for authorized previews or approved public playback. MP4/H.264 playback and JPEG poster derivatives are generated eagerly. Original upload is retained separately. The public API excludes rejected/invalid uploads. Rejection now schedules a rename and CDN invalidation without deleting the original; reapproval is blocked until the worker records revocation completion. Provider propagation and previously downloaded copies cannot be treated as instantaneous takedown. Real-provider acceptance is still required. Expired invalid/uncompleted-upload cleanup is implemented in the disabled-by-default durable worker; see BACKGROUND_JOBS.md for its narrow scope and outstanding acceptance tests.

Provider references checked 2026-09-20:

- https://cloudinary.com/documentation/control_access_to_media
- https://cloudinary.com/documentation/upload_images
- https://cloudinary.com/documentation/image_upload_api_reference

Acceptance on real devices before release: valid upload/playback on Android and iOS; overlong/oversized/renamed audio rejected; vendor cannot attach someone else's asset; ordered products remain locked; pending/rejected video unavailable to customers; admin approval publishes; two admin reviews conflict safely; interrupted upload can be retried without losing product form; image-only products unchanged. Tests use mock provider metadata and must not contact paid services.
