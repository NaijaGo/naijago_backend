const paymentMatchesOrder = (flwData, order, txRef) => {
    const data = flwData?.data;
    return flwData?.status === 'success'
        && data?.status === 'successful'
        && data?.tx_ref === txRef
        && String(data?.currency || '').toUpperCase() === 'NGN'
        && Number(data?.amount) >= Number(order.totalPrice);
};

const buildPendingPaymentResult = (existingResult, flwData, txRef, checkedAt = new Date()) => ({
    ...(existingResult || {}),
    tx_ref: txRef,
    status: flwData?.data?.status || 'pending',
    lastCheckedAt: checkedAt,
});

module.exports = { buildPendingPaymentResult, paymentMatchesOrder };
