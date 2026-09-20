// Record the need for work with the product write itself. A worker scan recovers
// it after restarts; uploads do not wait for Photoroom or lose a fire-and-forget task.
function imageRefinementProductHooks(schema, env = process.env) {
    const remember = (doc) => {
        if (doc.$locals.refinementGuardApplied && doc.$where?.updatedAt === doc.$locals.refinementReadAt) delete doc.$where.updatedAt;
        doc.$locals.refinementGuardApplied = false;
        doc.$locals.refinementReadAt = doc.updatedAt;
    };
    schema.post('init', remember);
    schema.post('save', remember);
    schema.pre('save', function () {
        const changed = this.isModified('imageUrls') || this.isModified('images') ||
            this.modifiedPaths({ includeChildren: true }).some((path) => /^variants\.\d+\.imageUrls/.test(path));
        if (!changed) return;
        // A vendor edit loaded before an admin image publication must not silently
        // overwrite that approval. Mongoose combines $where with the document id.
        if (!this.isNew && this.$locals.refinementReadAt) {
            this.$where = { ...this.$where, updatedAt: this.$locals.refinementReadAt };
            this.$locals.refinementGuardApplied = true;
        }
        if (env.IMAGE_REFINEMENT_ENABLED === 'true' && (this.sellerId || this.vendor)) {
            this.refinementScanPending = true;
            this.refinementScanAfter = new Date(0);
            this.refinementScanCode = '';
            this.refinementScanProfile = 'standard';
            this.refinementRequestedBy = this.sellerId || this.vendor;
        }
    });
}
module.exports = { imageRefinementProductHooks };
