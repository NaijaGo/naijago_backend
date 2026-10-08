// Prevent a product form loaded before Admin publication from overwriting the
// newly reviewed images. This hook does not queue provider work on product edits.
function imageRefinementProductGuard(schema) {
  const remember = doc => {
    if (doc.$locals.refinementGuardApplied && doc.$where?.updatedAt === doc.$locals.refinementReadAt) delete doc.$where.updatedAt;
    doc.$locals.refinementGuardApplied = false;
    doc.$locals.refinementReadAt = doc.updatedAt;
  };
  schema.post('init', remember);
  schema.post('save', remember);
  schema.pre('save', function () {
    const changed = this.isModified('imageUrls') || this.isModified('images') ||
      this.modifiedPaths({ includeChildren: true }).some(path => /^variants\.\d+\.imageUrls/.test(path));
    if (changed && !this.isNew && this.$locals.refinementReadAt) {
      this.$where = { ...this.$where, updatedAt: this.$locals.refinementReadAt };
      this.$locals.refinementGuardApplied = true;
    }
  });
}
module.exports = { imageRefinementProductGuard };
