const { id, sourceIdentity, imageBytes, MAX_BYTES, RefinementError } = require('../utils/imageRefinementPolicy');

// Dependency-injected: importing this module cannot call a provider or load keys.
function createImageRefinementAdapter({ cloudinary, http, env = process.env, now = () => new Date() }) {
    function path(row, kind) {
        id(String(row._id));
        if (!Number.isInteger(row.generation) || row.generation < 1 || row.generation > 3 || !['original', 'candidate', 'published'].includes(kind)) throw new RefinementError('Invalid refinement identity.');
        return `naijago/refinements/${row._id}/${kind === 'original' ? 'original' : `${kind}-${row.generation}`}`;
    }
    function receipt(asset, publicId, type) {
        if (asset?.public_id !== publicId || asset?.resource_type !== 'image' || asset?.type !== type ||
            !['jpg', 'jpeg', 'png', 'webp'].includes(asset.format) || !Number.isSafeInteger(asset.version) ||
            !(asset.bytes > 0 && asset.bytes <= MAX_BYTES) || !(asset.width > 0 && asset.height > 0 && asset.width * asset.height <= 20000000)) throw new Error('Invalid refinement storage receipt.');
        return { publicId, format: asset.format, version: asset.version };
    }
    async function recover(row, kind) {
        const publicId = path(row, kind), type = kind === 'published' ? 'upload' : 'authenticated';
        try { return receipt(await cloudinary.api.resource(publicId, { type, resource_type: 'image', timeout: 20000 }), publicId, type); }
        catch (error) { if (error.http_code === 404 || error.error?.http_code === 404) return null; throw error; }
    }
    function url(asset) {
        if (!/^naijago\/refinements\/[a-f0-9]{24}\/(original|candidate-[123])$/i.test(asset?.publicId || '') || !['jpg', 'jpeg', 'png', 'webp'].includes(asset.format)) return null;
        return cloudinary.utils.private_download_url(asset.publicId, asset.format, { type: 'authenticated', resource_type: 'image',
            expires_at: Math.floor(now().getTime() / 1000) + 300, attachment: false });
    }
    async function upload(row, kind, bytes, mime, signal) {
        signal.throwIfAborted(); imageBytes(bytes, mime);
        const publicId = path(row, kind), type = kind === 'published' ? 'upload' : 'authenticated';
        const result = await cloudinary.uploader.upload(`data:${mime};base64,${bytes.toString('base64')}`, {
            public_id: publicId, type, resource_type: 'image', overwrite: false, timeout: 30000,
        });
        signal.throwIfAborted();
        return receipt(result, publicId, type);
    }
    async function download(address, signal) {
        const response = await http.get(address, { signal, timeout: 30000, maxRedirects: 0, responseType: 'arraybuffer', maxContentLength: MAX_BYTES });
        const mime = String(response.headers?.['content-type'] || '').split(';')[0];
        return { bytes: imageBytes(Buffer.from(response.data), mime), mime };
    }
    async function preserve(row, signal) {
        signal.throwIfAborted();
        const existing = await recover(row, 'original'); if (existing) return existing;
        const source = sourceIdentity(row.sourceUrl, env.CLOUDINARY_CLOUD_NAME);
        const metadata = await cloudinary.api.resource(source.publicId, { resource_type: 'image', type: 'upload', timeout: 20000 });
        receipt(metadata, source.publicId, 'upload');
        if (metadata.version !== source.version) throw new Error('The source image version changed.');
        const { bytes, mime } = await download(row.sourceUrl, signal);
        return upload(row, 'original', bytes, mime, signal);
    }
    async function refine(row, signal) {
        signal.throwIfAborted();
        const imageUrl = url(row.original);
        let key = env.PHOTOROOM_API_KEY;
        if (!key || !imageUrl || row.original?.publicId !== path(row, 'original') || (key.startsWith('sandbox_') && !row.sandbox)) throw new Error('Refinement configuration unavailable.');
        if (row.sandbox && !key.startsWith('sandbox_')) key = `sandbox_${key}`;
        // Fixed endpoint/edits only. No generative product replacement, text removal,
        // beautifier or upscaling. Relight is opt-in and always human reviewed.
        const response = await http.get('https://image-api.photoroom.com/v2/edit', {
            headers: { 'x-api-key': key }, params: { imageUrl, removeBackground: true, 'background.color': 'FFFFFF',
                outputSize: '1000x1000', padding: 0.15, 'shadow.mode': 'ai.soft', 'export.format': 'png',
                ...(row.profile === 'relight' ? { 'lighting.mode': 'ai.preserve-hue-and-saturation' } : {}) },
            signal, timeout: 180000, maxRedirects: 0, responseType: 'arraybuffer', maxContentLength: MAX_BYTES,
        });
        const mime = String(response.headers?.['content-type'] || '').split(';')[0];
        return upload(row, 'candidate', Buffer.from(response.data), mime, signal);
    }
    async function publish(row, signal) {
        if (row.state !== 'publishing' || row.sandbox || !row.history?.some((event) => event.action === 'approve' && event.generation === row.generation)) throw new Error('Human approval is required.');
        const existing = await recover(row, 'published'); if (existing) return existing;
        if (row.candidate?.publicId !== path(row, 'candidate')) throw new Error('Candidate identity changed.');
        const { bytes, mime } = await download(url(row.candidate), signal);
        return upload(row, 'published', bytes, mime, signal);
    }
    function publicUrl(row, asset) {
        if (asset.publicId !== path(row, 'published')) throw new Error('Invalid publication identity.');
        return cloudinary.url(asset.publicId, { secure: true, resource_type: 'image', type: 'upload', version: asset.version, format: asset.format });
    }
    return { preserve, refine, publish, recover, url, publicUrl };
}
module.exports = { createImageRefinementAdapter };
