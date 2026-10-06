import assert from 'node:assert/strict';
import test from 'node:test';
import { shippingFee } from '../shipping.mjs';

test('non-member below the free shipping threshold', () => {
  assert.equal(shippingFee(4999), 500);
});
test('non-member above the free shipping threshold', () => {
  assert.equal(shippingFee(5001), 0);
});
