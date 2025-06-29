// scripts/test-endpoints.js
// Test script for CloudComments API endpoints

const API_URL = process.env.API_URL || 'http://localhost:8787';
const SITE_KEY = process.env.SITE_KEY || 'test-site-key';

async function testEndpoints() {
  console.log('Testing CloudComments API Endpoints');
  console.log('===================================\n');
  
  // Test 1: Load comments
  console.log('1. Testing comment loading...');
  try {
    const response = await fetch(`${API_URL}/api/comments/${SITE_KEY}/test-post`);
    const data = await response.json();
    console.log('✅ Comments loaded:', data.comments.length, 'comments');
  } catch (error) {
    console.error('❌ Failed to load comments:', error.message);
  }
  
  // Test 2: Check authentication
  console.log('\n2. Testing authentication check...');
  try {
    const response = await fetch(`${API_URL}/api/auth/check`, {
      credentials: 'include'
    });
    const data = await response.json();
    console.log(data.authenticated ? '✅ Authenticated' : '❌ Not authenticated');
  } catch (error) {
    console.error('❌ Failed to check auth:', error.message);
  }
  
  // Test 3: Test rate limiting
  console.log('\n3. Testing rate limiting...');
  const requests = [];
  for (let i = 0; i < 10; i++) {
    requests.push(fetch(`${API_URL}/api/comments/${SITE_KEY}/test-post`));
  }
  
  try {
    const responses = await Promise.all(requests);
    const rateLimited = responses.some(r => r.status === 429);
    console.log(rateLimited ? '✅ Rate limiting working' : '⚠️  Rate limiting might not be configured');
  } catch (error) {
    console.error('❌ Failed to test rate limiting:', error.message);
  }
}

testEndpoints();
