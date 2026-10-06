export function shippingFee(total) {
  return total > 5000 ? 0 : 500;
}
