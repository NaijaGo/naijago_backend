const isCatalogAdmin = user => user?.isAdmin === true;
const isApprovedVendor = user => user?.isVendor === true && user?.vendorStatus === 'approved';
const isApprovedPharmacistVendor = user => isApprovedVendor(user) && user.role === 'pharmacist' &&
    // Older approved pharmacist accounts may predate pharmacistStatus. An
    // explicit pending/rejected/suspended status cannot be overridden by role.
    (!user.pharmacistStatus || user.pharmacistStatus === 'none' || user.pharmacistStatus === 'approved');
module.exports = { isCatalogAdmin, isApprovedVendor, isApprovedPharmacistVendor };
