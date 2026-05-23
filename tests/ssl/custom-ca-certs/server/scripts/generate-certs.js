#!/usr/bin/env node

const path = require('node:path');
const { createCertsDir, generateCertificates, addCAToTruststore, verifyCertificates } = require('../helpers/certs');

/**
 * Setup CA certificates for testing server
 */
async function setup() {
  console.log('🔧 Setting up CA certificates for test server');

  const certsDir = path.join(__dirname, '..', 'certs');

  try {
    console.log('📁 Creating certificates directory');
    createCertsDir(certsDir);

    console.log('🔐 Generating certificates');
    generateCertificates(certsDir);

    console.log('✅ Verifying certificates');
    verifyCertificates(certsDir);

    console.log('🛡️ Adding CA to truststore');
    addCAToTruststore(certsDir);

    console.log('🎉 CA certificate setup completed successfully');
    return true;
  } catch (error) {
    console.error('❌ Generate certs failed:', error.message);
    throw error;
  }
}

if (require.main === module) {
  setup()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = { setup };
