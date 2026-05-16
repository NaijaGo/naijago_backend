const normalizeStatus = (value, fallback = 'none') =>
  String(value || fallback).trim().toLowerCase();

const pharmacistApprovalStatus = (user) => {
  const role = normalizeStatus(user?.role, 'user');
  const pharmacistStatus = normalizeStatus(user?.pharmacistStatus);

  if (pharmacistStatus === 'approved' || role === 'pharmacist') {
    return 'approved';
  }
  return pharmacistStatus;
};

const isApprovedPharmacistUser = (user) => {
  const vendorStatus = normalizeStatus(user?.vendorStatus);
  const pharmacistStatus = pharmacistApprovalStatus(user);

  return Boolean(
    user &&
      user.isVendor === true &&
      vendorStatus === 'approved' &&
      pharmacistStatus === 'approved',
  );
};

const pharmacistAccessPayload = (user) => {
  const vendorStatus = normalizeStatus(user?.vendorStatus);
  const pharmacistStatus = pharmacistApprovalStatus(user);
  const canUsePharmacistTools = isApprovedPharmacistUser(user);

  let reason = null;
  if (!user) {
    reason = 'User not found.';
  } else if (user.isVendor !== true || vendorStatus !== 'approved') {
    reason = 'Vendor approval is required before pharmacist tools can be used.';
  } else if (pharmacistStatus !== 'approved') {
    reason = 'Pharmacist approval is required before consultations can be claimed.';
  }

  return {
    isPharmacist: canUsePharmacistTools,
    canUsePharmacistTools,
    pharmacistStatus,
    vendorStatus,
    isVendor: user?.isVendor === true,
    reason,
  };
};

module.exports = {
  isApprovedPharmacistUser,
  pharmacistAccessPayload,
};
