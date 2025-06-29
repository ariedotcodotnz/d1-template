// scripts/generate-password-hash.js
const bcrypt = require('bcryptjs');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log('CloudComments - Password Hash Generator');
console.log('======================================\n');

rl.question('Enter password for admin user: ', async (password) => {
  if (password.length < 8) {
    console.error('\n❌ Password must be at least 8 characters long');
    rl.close();
    process.exit(1);
  }
  
  try {
    const hash = await bcrypt.hash(password, 10);
    console.log('\n✅ Password hash generated successfully!');
    console.log('\nAdd this to your wrangler.jsonc vars:');
    console.log(`ADMIN_PASSWORD_HASH = "${hash}"`);
    console.log('\n⚠️  Keep your password safe! You cannot recover it from the hash.');
  } catch (error) {
    console.error('\n❌ Error generating hash:', error.message);
  }
  
  rl.close();
});
