const fs = require('node:fs/promises');
const path = require('node:path');

async function cleanupUploadedFiles(files, { tempRoot = '/tmp/', unlink = fs.unlink } = {}) {
    const root = path.resolve(tempRoot) + path.sep;
    for (const file of Object.values(files || {}).flat()) {
        if (!file || typeof file.tempFilePath !== 'string' || !path.isAbsolute(file.tempFilePath)) continue;
        const resolved = path.resolve(file.tempFilePath);
        if (!resolved.startsWith(root)) continue;
        try { await unlink(resolved); } catch (_) { /* Never mask the upload result or expose local paths. */ }
    }
}
module.exports = { cleanupUploadedFiles };
