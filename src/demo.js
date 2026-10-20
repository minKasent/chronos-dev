const fs = require('fs');
const path = require('path');
const { ChronosEngine } = require('./engine');

/**
 * Generates a realistic live coding scenario in a sandbox folder
 * demonstrating how a working codebase gets broken across multiple un-committed edits,
 * and how chronos-dev captures every code state + terminal output.
 */
async function setupDemoScenario(sandboxDir) {
  if (fs.existsSync(sandboxDir)) {
    fs.rmSync(sandboxDir, { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(sandboxDir, 'src'), { recursive: true });

  const engine = new ChronosEngine(sandboxDir);
  engine.init();

  // Common test suite file
  const testFileContent = `const assert = require('assert');
const { calculateOrderTotal } = require('./src/pricing');
const { computeShippingFee } = require('./src/shipping');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log('  ✅ PASS:', name);
    passed++;
  } catch (err) {
    console.error('  ❌ FAIL:', name);
    console.error('     ↳ Expected:', err.expected, '| Actual:', err.actual || err.message);
    failed++;
  }
}

console.log('=== Running Order & Checkout Test Suite ===');

test('Standard order subtotal + 10% VAT + $25 standard shipping', () => {
  const res = calculateOrderTotal([{ price: 100, qty: 2 }], null);
  assert.strictEqual(res.subtotal, 200);
  assert.strictEqual(res.tax, 20);
  assert.strictEqual(res.shipping, 25);
  assert.strictEqual(res.total, 245);
});

test('Free shipping on orders >= $500', () => {
  assert.strictEqual(computeShippingFee(500, 'STANDARD'), 0);
  assert.strictEqual(computeShippingFee(200, 'STANDARD'), 25);
});

test('Promo code VIP20 applies 20% discount before tax', () => {
  const res = calculateOrderTotal([{ price: 250, qty: 2 }], 'VIP20');
  assert.strictEqual(res.discount, 100);
  assert.strictEqual(res.subtotalAfterDiscount, 400);
  assert.strictEqual(res.tax, 40);
  assert.strictEqual(res.total, 440);
});

console.log('-------------------------------------------');
console.log(\`Summary: \${passed} passed, \${failed} failed\`);
if (failed > 0) process.exit(1);
`;

  fs.writeFileSync(path.join(sandboxDir, 'test.js'), testFileContent, 'utf8');

  // STEP 1: Initial working implementation (v1)
  fs.writeFileSync(
    path.join(sandboxDir, 'src/shipping.js'),
    `function computeShippingFee(orderSubtotal, tier = 'STANDARD') {
  if (orderSubtotal >= 500) return 0;
  return tier === 'EXPRESS' ? 45 : 25;
}

module.exports = { computeShippingFee };
`,
    'utf8'
  );

  fs.writeFileSync(
    path.join(sandboxDir, 'src/pricing.js'),
    `const { computeShippingFee } = require('./shipping');

function calculateOrderTotal(items, promoCode = null) {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  let discount = 0;

  if (promoCode === 'VIP20') {
    discount = subtotal * 0.2;
  }

  const subtotalAfterDiscount = subtotal - discount;
  const tax = Math.round(subtotalAfterDiscount * 0.1 * 100) / 100;
  const shipping = computeShippingFee(subtotal, 'STANDARD');

  return {
    subtotal,
    discount,
    subtotalAfterDiscount,
    tax,
    shipping,
    total: subtotalAfterDiscount + tax + shipping
  };
}

module.exports = { calculateOrderTotal };
`,
    'utf8'
  );

  // Checkpoint #1: First test run (PASS)
  await engine.runCommandAndRecord('node test.js', {
    silent: true,
    label: 'node test.js (Initial checkout implementation)'
  });

  // STEP 2: Add FLASH50 promo support & bulk item validation (Still GREEN! 🌟)
  fs.writeFileSync(
    path.join(sandboxDir, 'src/pricing.js'),
    `const { computeShippingFee } = require('./shipping');

const PROMO_RATES = {
  VIP20: 0.20,
  FLASH30: 0.30
};

function calculateOrderTotal(items, promoCode = null) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Order must contain at least 1 item');
  }

  const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  const rate = promoCode && PROMO_RATES[promoCode] ? PROMO_RATES[promoCode] : 0;
  const discount = Math.round(subtotal * rate * 100) / 100;

  const subtotalAfterDiscount = subtotal - discount;
  const tax = Math.round(subtotalAfterDiscount * 0.1 * 100) / 100;
  const shipping = computeShippingFee(subtotal, 'STANDARD');

  return {
    subtotal,
    discount,
    subtotalAfterDiscount,
    tax,
    shipping,
    total: subtotalAfterDiscount + tax + shipping
  };
}

module.exports = { calculateOrderTotal };
`,
    'utf8'
  );

  // Checkpoint #2: Second test run (PASS - This will be --last-green 🌟)
  await engine.runCommandAndRecord('node test.js', {
    silent: true,
    label: 'node test.js (Refactored promo lookup table)'
  });

  // STEP 3: Developer tries to "optimize" shipping threshold & tax calculation -> Breaks shipping test! (FAIL ❌)
  fs.writeFileSync(
    path.join(sandboxDir, 'src/shipping.js'),
    `function computeShippingFee(orderSubtotal, tier = 'STANDARD') {
  // Oops: changed >= 500 to > 500 during refactor!
  if (orderSubtotal > 500) return 0;
  return tier === 'EXPRESS' ? 45 : 25;
}

module.exports = { computeShippingFee };
`,
    'utf8'
  );

  await engine.runCommandAndRecord('node test.js', {
    silent: true,
    label: 'node test.js (Tweak shipping tier boundary)'
  });

  // STEP 4: Developer panics, edits pricing.js too, introducing tax on pre-discount subtotal & shipping bug! (FAIL ❌)
  fs.writeFileSync(
    path.join(sandboxDir, 'src/pricing.js'),
    `const { computeShippingFee } = require('./shipping');

const PROMO_RATES = {
  VIP20: 0.20,
  FLASH30: 0.30
};

function calculateOrderTotal(items, promoCode = null) {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  const rate = promoCode && PROMO_RATES[promoCode] ? PROMO_RATES[promoCode] : 0;
  const discount = Math.round(subtotal * rate * 100) / 100;

  const subtotalAfterDiscount = subtotal - discount;
  // BUG introduced while rushing: calculating tax on raw subtotal instead of discounted subtotal
  // AND using discounted subtotal for free-shipping check!
  const tax = Math.round(subtotal * 0.1 * 100) / 100;
  const shipping = computeShippingFee(subtotalAfterDiscount, 'STANDARD');

  return {
    subtotal,
    discount,
    subtotalAfterDiscount,
    tax,
    shipping,
    total: subtotalAfterDiscount + tax + shipping
  };
}

module.exports = { calculateOrderTotal };
`,
    'utf8'
  );

  await engine.runCommandAndRecord('node test.js', {
    silent: true,
    label: 'node test.js (Experimental tax & shipping formula)'
  });

  return engine;
}

module.exports = { setupDemoScenario };
