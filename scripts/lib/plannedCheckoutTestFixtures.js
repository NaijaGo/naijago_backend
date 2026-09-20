'use strict';

// Synthetic, test-only identities. Use only with the isolated test models;
// these addresses/numbers must never be used for external notifications.
function plannedCheckoutUsers({ owner, seller }) {
    return [
        { _id: owner, firstName: 'Synthetic', lastName: 'Buyer',
            email: 'planned-checkout-buyer@example.invalid', phoneNumber: '08000000001',
            password: 'synthetic-test-only-not-a-live-credential' },
        { _id: seller, firstName: 'Synthetic', lastName: 'Seller',
            email: 'planned-checkout-seller@example.invalid', phoneNumber: '08000000002',
            password: 'synthetic-test-only-not-a-live-credential',
            isVendor: true, vendorStatus: 'approved', businessName: 'Synthetic shop',
            businessLocation: { latitude: 9, longitude: 7, formattedAddress: 'Synthetic shop only' } },
    ];
}

module.exports = { plannedCheckoutUsers };
