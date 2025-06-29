// src/index.ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { html } from 'hono/html';
import { jwt } from 'hono/jwt';
import { timing } from 'hono/timing';
import { logger } from 'hono/logger';
import { D1Database, KVNamespace, DurableObjectNamespace } from '@cloudflare/workers-types';
import bcrypt from 'bcryptjs';
import { marked } from 'marked';
import crypto from 'crypto';

interface Env {
  COMMENTS_DB: D1Database;
  SESSIONS: KVNamespace;
  RATE_LIMITER: DurableObjectNamespace;
  EMAIL_QUEUE: Queue;
  JWT_SECRET: string;
  ADMIN_EMAIL: string;
  ADMIN_PASSWORD_HASH: string;
  RESEND_API_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  WEBHOOK_SECRET?: string;
}

interface User {
  id: number;
  email: string;
  name: string;
  password_hash: string;
  role: 'user' | 'moderator' | 'admin';
  avatar_url?: string;
  bio?: string;
  website?: string;
  email_notifications: boolean;
  created_at: string;
  last_login: string;
  is_banned: boolean;
  ban_reason?: string;
  reputation: number;
}

interface Comment {
  id: number;
  site_id: number;
  post_slug: string;
  post_title?: string;
  user_id: number;
  parent_id: number | null;
  content: string;
  content_html?: string;
  status: 'pending' | 'approved' | 'spam' | 'deleted';
  ip_address?: string;
  user_agent?: string;
  spam_score?: number;
  edited_at?: string;
  created_at: string;
  updated_at: string;
  likes: number;
  flags: number;
}

interface Site {
  id: number;
  domain: string;
  name: string;
  api_key: string;
  webhook_url?: string;
  moderation_enabled: boolean;
  auto_approve_threshold: number;
  spam_filter_enabled: boolean;
  require_auth: boolean;
  allowed_domains?: string;
  custom_css?: string;
  created_at: string;
  monthly_views: number;
  total_comments: number;
}

const app = new Hono<{ Bindings: Env }>();

// Add timing and logger middleware
app.use('*', timing());
app.use('*', logger());

// Enable CORS for API endpoints
app.use('/api/*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
  credentials: true
}));

// Rate limiting middleware
async function rateLimitMiddleware(c: any, next: any) {
  const clientIp = c.req.header('CF-Connecting-IP') || 'unknown';
  const rateLimiterId = c.env.RATE_LIMITER.idFromName(clientIp);
  const rateLimiter = c.env.RATE_LIMITER.get(rateLimiterId);
  
  const response = await rateLimiter.fetch(c.req.raw);
  if (response.status === 429) {
    return c.json({ error: 'Too many requests' }, 429);
  }
  
  await next();
}

// Enhanced HTML Layout with better styling
const layout = (title: string, content: string, user?: any) => html`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - CloudComments</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>
    :root {
      --primary: #3b82f6;
      --primary-dark: #2563eb;
      --secondary: #10b981;
      --danger: #ef4444;
      --warning: #f59e0b;
      --dark: #1f2937;
      --gray: #6b7280;
      --light: #f3f4f6;
      --white: #ffffff;
      --shadow: 0 1px 3px rgba(0,0,0,0.1);
      --shadow-lg: 0 10px 15px -3px rgba(0,0,0,0.1);
    }
    
    * { box-sizing: border-box; margin: 0; padding: 0; }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      line-height: 1.6;
      color: var(--dark);
      background: var(--light);
    }
    
    .header {
      background: var(--white);
      box-shadow: var(--shadow);
      position: sticky;
      top: 0;
      z-index: 100;
    }
    
    .header-content {
      max-width: 1200px;
      margin: 0 auto;
      padding: 1rem 2rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    
    .logo {
      font-size: 1.5rem;
      font-weight: 700;
      color: var(--primary);
      text-decoration: none;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    
    .nav {
      display: flex;
      gap: 2rem;
      align-items: center;
    }
    
    .nav a {
      color: var(--gray);
      text-decoration: none;
      font-weight: 500;
      transition: color 0.2s;
    }
    
    .nav a:hover { color: var(--primary); }
    .nav a.active { color: var(--primary); }
    
    .container {
      max-width: 1200px;
      margin: 2rem auto;
      padding: 0 2rem;
    }
    
    .card {
      background: var(--white);
      border-radius: 0.5rem;
      padding: 1.5rem;
      margin-bottom: 1.5rem;
      box-shadow: var(--shadow);
    }
    
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid var(--light);
    }
    
    .card-title {
      font-size: 1.25rem;
      font-weight: 600;
      color: var(--dark);
    }
    
    .form-group {
      margin-bottom: 1rem;
    }
    
    label {
      display: block;
      margin-bottom: 0.375rem;
      font-weight: 500;
      color: var(--dark);
    }
    
    input, textarea, select {
      width: 100%;
      padding: 0.5rem 0.75rem;
      border: 1px solid #e5e7eb;
      border-radius: 0.375rem;
      font-size: 1rem;
      transition: border-color 0.2s;
    }
    
    input:focus, textarea:focus, select:focus {
      outline: none;
      border-color: var(--primary);
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
    }
    
    .btn {
      display: inline-block;
      padding: 0.5rem 1rem;
      border: none;
      border-radius: 0.375rem;
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
      text-decoration: none;
      transition: all 0.2s;
      text-align: center;
    }
    
    .btn-primary {
      background: var(--primary);
      color: white;
    }
    
    .btn-primary:hover {
      background: var(--primary-dark);
      transform: translateY(-1px);
      box-shadow: var(--shadow);
    }
    
    .btn-secondary {
      background: var(--gray);
      color: white;
    }
    
    .btn-danger {
      background: var(--danger);
      color: white;
    }
    
    .btn-success {
      background: var(--secondary);
      color: white;
    }
    
    .btn-outline {
      background: white;
      color: var(--primary);
      border: 1px solid var(--primary);
    }
    
    .btn-group {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
    }
    
    .table {
      width: 100%;
      border-collapse: collapse;
    }
    
    .table th,
    .table td {
      padding: 0.75rem;
      text-align: left;
      border-bottom: 1px solid var(--light);
    }
    
    .table th {
      background: var(--light);
      font-weight: 600;
      color: var(--dark);
    }
    
    .table tr:hover {
      background: #fafafa;
    }
    
    .badge {
      display: inline-block;
      padding: 0.25rem 0.5rem;
      border-radius: 0.25rem;
      font-size: 0.75rem;
      font-weight: 500;
    }
    
    .badge-success { background: #d1fae5; color: #065f46; }
    .badge-warning { background: #fed7aa; color: #92400e; }
    .badge-danger { background: #fee2e2; color: #991b1b; }
    .badge-info { background: #dbeafe; color: #1e40af; }
    
    .alert {
      padding: 1rem;
      margin-bottom: 1rem;
      border-radius: 0.375rem;
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    
    .alert-success {
      background: #d1fae5;
      color: #065f46;
      border: 1px solid #a7f3d0;
    }
    
    .alert-error {
      background: #fee2e2;
      color: #991b1b;
      border: 1px solid #fecaca;
    }
    
    .alert-info {
      background: #dbeafe;
      color: #1e40af;
      border: 1px solid #bfdbfe;
    }
    
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 1.5rem;
      margin-bottom: 2rem;
    }
    
    .stat-card {
      background: var(--white);
      padding: 1.5rem;
      border-radius: 0.5rem;
      box-shadow: var(--shadow);
      border-left: 4px solid var(--primary);
    }
    
    .stat-value {
      font-size: 2rem;
      font-weight: 700;
      color: var(--dark);
    }
    
    .stat-label {
      color: var(--gray);
      font-size: 0.875rem;
      margin-top: 0.25rem;
    }
    
    .comment {
      padding: 1rem;
      border-left: 3px solid var(--primary);
      margin-bottom: 1rem;
      background: #fafafa;
      border-radius: 0.375rem;
    }
    
    .comment-reply {
      margin-left: 2rem;
      border-left-color: var(--gray);
    }
    
    .comment-header {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 0.5rem;
    }
    
    .comment-avatar {
      width: 2rem;
      height: 2rem;
      border-radius: 50%;
      background: var(--gray);
    }
    
    .comment-meta {
      flex: 1;
    }
    
    .comment-author {
      font-weight: 600;
      color: var(--dark);
    }
    
    .comment-date {
      font-size: 0.875rem;
      color: var(--gray);
    }
    
    .comment-content {
      margin-top: 0.5rem;
      line-height: 1.5;
    }
    
    .comment-actions {
      display: flex;
      gap: 1rem;
      margin-top: 0.5rem;
      font-size: 0.875rem;
    }
    
    .comment-action {
      color: var(--gray);
      cursor: pointer;
      transition: color 0.2s;
    }
    
    .comment-action:hover {
      color: var(--primary);
    }
    
    .tabs {
      display: flex;
      gap: 1rem;
      margin-bottom: 1.5rem;
      border-bottom: 2px solid var(--light);
    }
    
    .tab {
      padding: 0.5rem 1rem;
      color: var(--gray);
      text-decoration: none;
      font-weight: 500;
      position: relative;
      transition: color 0.2s;
    }
    
    .tab:hover {
      color: var(--primary);
    }
    
    .tab.active {
      color: var(--primary);
    }
    
    .tab.active::after {
      content: '';
      position: absolute;
      bottom: -2px;
      left: 0;
      right: 0;
      height: 2px;
      background: var(--primary);
    }
    
    .modal {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.5);
      z-index: 1000;
      align-items: center;
      justify-content: center;
    }
    
    .modal.active {
      display: flex;
    }
    
    .modal-content {
      background: var(--white);
      padding: 2rem;
      border-radius: 0.5rem;
      max-width: 500px;
      width: 90%;
      max-height: 90vh;
      overflow-y: auto;
    }
    
    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1.5rem;
    }
    
    .modal-close {
      font-size: 1.5rem;
      color: var(--gray);
      cursor: pointer;
      line-height: 1;
    }
    
    .pagination {
      display: flex;
      gap: 0.5rem;
      justify-content: center;
      margin-top: 2rem;
    }
    
    .pagination a {
      padding: 0.5rem 0.75rem;
      background: var(--white);
      border: 1px solid var(--light);
      border-radius: 0.375rem;
      color: var(--gray);
      text-decoration: none;
      transition: all 0.2s;
    }
    
    .pagination a:hover {
      background: var(--light);
      color: var(--primary);
    }
    
    .pagination a.active {
      background: var(--primary);
      color: white;
      border-color: var(--primary);
    }
    
    .search-box {
      position: relative;
      margin-bottom: 1.5rem;
    }
    
    .search-box input {
      padding-left: 2.5rem;
    }
    
    .search-box i {
      position: absolute;
      left: 0.75rem;
      top: 50%;
      transform: translateY(-50%);
      color: var(--gray);
    }
    
    pre {
      background: #f8f9fa;
      padding: 1rem;
      border-radius: 0.375rem;
      overflow-x: auto;
      border: 1px solid var(--light);
    }
    
    code {
      background: #f8f9fa;
      padding: 0.125rem 0.25rem;
      border-radius: 0.25rem;
      font-size: 0.875em;
    }
    
    @media (max-width: 768px) {
      .header-content {
        flex-direction: column;
        gap: 1rem;
      }
      
      .nav {
        flex-wrap: wrap;
        justify-content: center;
      }
      
      .stats-grid {
        grid-template-columns: 1fr;
      }
      
      .container {
        padding: 0 1rem;
      }
    }
  </style>
</head>
<body>
  <header class="header">
    <div class="header-content">
      <a href="/" class="logo">
        <i class="fas fa-comments"></i>
        CloudComments
      </a>
      <nav class="nav">
        <a href="/" class="${c.req.path === '/' ? 'active' : ''}">Home</a>
        <a href="/docs" class="${c.req.path === '/docs' ? 'active' : ''}">Documentation</a>
        <a href="/pricing" class="${c.req.path === '/pricing' ? 'active' : ''}">Pricing</a>
        ${user ? html`
          ${user.role === 'admin' ? html`
            <a href="/admin" class="${c.req.path.startsWith('/admin') ? 'active' : ''}">Admin</a>
          ` : user.role === 'moderator' ? html`
            <a href="/moderate" class="${c.req.path.startsWith('/moderate') ? 'active' : ''}">Moderate</a>
          ` : ''}
          <a href="/dashboard" class="${c.req.path.startsWith('/dashboard') ? 'active' : ''}">Dashboard</a>
          <div class="dropdown">
            <a href="/profile" class="nav-user">
              <img src="${user.avatar_url || `https://www.gravatar.com/avatar/${crypto.createHash('md5').update(user.email.toLowerCase()).digest('hex')}?d=mp`}" 
                   alt="${user.name}" 
                   style="width: 2rem; height: 2rem; border-radius: 50%; vertical-align: middle; margin-right: 0.5rem;">
              ${user.name}
            </a>
          </div>
          <a href="/logout" class="btn btn-outline">Logout</a>
        ` : html`
          <a href="/login" class="btn btn-outline">Login</a>
          <a href="/register" class="btn btn-primary">Sign Up</a>
        `}
      </nav>
    </div>
  </header>
  
  <main class="container">
    ${content}
  </main>
  
  <footer style="background: var(--dark); color: white; padding: 3rem 0; margin-top: 4rem;">
    <div class="container">
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 2rem;">
        <div>
          <h3 style="margin-bottom: 1rem;">CloudComments</h3>
          <p style="color: #9ca3af;">Privacy-focused comment system built on Cloudflare Workers.</p>
        </div>
        <div>
          <h4 style="margin-bottom: 1rem;">Product</h4>
          <ul style="list-style: none;">
            <li><a href="/features" style="color: #9ca3af; text-decoration: none;">Features</a></li>
            <li><a href="/pricing" style="color: #9ca3af; text-decoration: none;">Pricing</a></li>
            <li><a href="/docs" style="color: #9ca3af; text-decoration: none;">Documentation</a></li>
            <li><a href="/api" style="color: #9ca3af; text-decoration: none;">API</a></li>
          </ul>
        </div>
        <div>
          <h4 style="margin-bottom: 1rem;">Company</h4>
          <ul style="list-style: none;">
            <li><a href="/about" style="color: #9ca3af; text-decoration: none;">About</a></li>
            <li><a href="/blog" style="color: #9ca3af; text-decoration: none;">Blog</a></li>
            <li><a href="/privacy" style="color: #9ca3af; text-decoration: none;">Privacy</a></li>
            <li><a href="/terms" style="color: #9ca3af; text-decoration: none;">Terms</a></li>
          </ul>
        </div>
        <div>
          <h4 style="margin-bottom: 1rem;">Connect</h4>
          <div style="display: flex; gap: 1rem;">
            <a href="#" style="color: #9ca3af;"><i class="fab fa-twitter"></i></a>
            <a href="#" style="color: #9ca3af;"><i class="fab fa-github"></i></a>
            <a href="#" style="color: #9ca3af;"><i class="fab fa-discord"></i></a>
          </div>
        </div>
      </div>
      <div style="margin-top: 2rem; padding-top: 2rem; border-top: 1px solid #374151; text-align: center; color: #9ca3af;">
        <p>&copy; 2024 CloudComments. All rights reserved.</p>
      </div>
    </div>
  </footer>
  
  <script>
    // Add interactivity
    document.addEventListener('DOMContentLoaded', function() {
      // Modal handling
      const modals = document.querySelectorAll('.modal');
      const modalTriggers = document.querySelectorAll('[data-modal]');
      const modalCloses = document.querySelectorAll('.modal-close');
      
      modalTriggers.forEach(trigger => {
        trigger.addEventListener('click', (e) => {
          e.preventDefault();
          const modalId = trigger.getAttribute('data-modal');
          const modal = document.getElementById(modalId);
          if (modal) modal.classList.add('active');
        });
      });
      
      modalCloses.forEach(close => {
        close.addEventListener('click', () => {
          close.closest('.modal').classList.remove('active');
        });
      });
      
      modals.forEach(modal => {
        modal.addEventListener('click', (e) => {
          if (e.target === modal) {
            modal.classList.remove('active');
          }
        });
      });
      
      // Form validation
      const forms = document.querySelectorAll('form[data-validate]');
      forms.forEach(form => {
        form.addEventListener('submit', (e) => {
          let isValid = true;
          const inputs = form.querySelectorAll('input[required], textarea[required]');
          
          inputs.forEach(input => {
            if (!input.value.trim()) {
              isValid = false;
              input.classList.add('error');
            } else {
              input.classList.remove('error');
            }
          });
          
          if (!isValid) {
            e.preventDefault();
            alert('Please fill in all required fields');
          }
        });
      });
    });
  </script>
</body>
</html>
`;

// Spam detection utility
function calculateSpamScore(content: string, user: User): number {
  let score = 0;
  
  // Check for common spam patterns
  const spamPatterns = [
    /\b(viagra|cialis|casino|poker|loan|mortgage)\b/gi,
    /\b(click here|buy now|limited offer|act now)\b/gi,
    /https?:\/\/[^\s]+/g, // URLs
    /\b[A-Z]{5,}\b/g, // All caps words
  ];
  
  spamPatterns.forEach(pattern => {
    const matches = content.match(pattern);
    if (matches) score += matches.length * 10;
  });
  
  // New users get higher spam score
  const accountAge = Date.now() - new Date(user.created_at).getTime();
  if (accountAge < 24 * 60 * 60 * 1000) score += 20; // Less than 1 day
  
  // Low reputation users
  if (user.reputation < 10) score += 15;
  
  // Check for excessive links
  const linkCount = (content.match(/https?:\/\//g) || []).length;
  if (linkCount > 2) score += linkCount * 15;
  
  return Math.min(score, 100);
}

// Generate Gravatar URL
function getGravatarUrl(email: string, size: number = 80): string {
  const hash = crypto.createHash('md5').update(email.toLowerCase().trim()).digest('hex');
  return `https://www.gravatar.com/avatar/${hash}?d=mp&s=${size}`;
}

// Authentication middleware
async function authMiddleware(c: any, next: any) {
  const token = c.req.cookie('auth_token');
  if (!token) {
    return c.redirect(`/login?redirect=${encodeURIComponent(c.req.url)}`);
  }
  
  try {
    const payload = await jwt.verify(token, c.env.JWT_SECRET);
    const user = await c.env.COMMENTS_DB.prepare(
      'SELECT * FROM users WHERE id = ? AND is_banned = 0'
    ).bind(payload.sub).first();
    
    if (!user) {
      return c.redirect('/login');
    }
    
    // Update last login
    await c.env.COMMENTS_DB.prepare(
      'UPDATE users SET last_login = ? WHERE id = ?'
    ).bind(new Date().toISOString(), user.id).run();
    
    c.set('user', user);
    await next();
  } catch (error) {
    return c.redirect('/login');
  }
}

// Admin middleware
async function adminMiddleware(c: any, next: any) {
  const user = c.get('user');
  if (!user || user.role !== 'admin') {
    return c.text('Unauthorized', 403);
  }
  await next();
}

// Moderator middleware
async function moderatorMiddleware(c: any, next: any) {
  const user = c.get('user');
  if (!user || (user.role !== 'admin' && user.role !== 'moderator')) {
    return c.text('Unauthorized', 403);
  }
  await next();
}

// Home page
app.get('/', async (c) => {
  const stats = await c.env.COMMENTS_DB.prepare(`
    SELECT 
      (SELECT COUNT(*) FROM sites) as total_sites,
      (SELECT COUNT(*) FROM comments WHERE status = 'approved') as total_comments,
      (SELECT COUNT(*) FROM users) as total_users
  `).first();
  
  const content = html`
    <div style="text-align: center; padding: 4rem 0;">
      <h1 style="font-size: 3rem; font-weight: 800; margin-bottom: 1rem;">
        Privacy-First Comment System
      </h1>
      <p style="font-size: 1.25rem; color: var(--gray); max-width: 600px; margin: 0 auto 2rem;">
        Add a powerful, customizable comment system to your website in minutes. 
        Built on Cloudflare's edge network for blazing-fast performance.
      </p>
      <div class="btn-group" style="justify-content: center;">
        <a href="/register" class="btn btn-primary" style="font-size: 1.125rem; padding: 0.75rem 2rem;">
          Get Started Free
        </a>
        <a href="/demo" class="btn btn-outline" style="font-size: 1.125rem; padding: 0.75rem 2rem;">
          View Demo
        </a>
      </div>
    </div>
    
    <div class="stats-grid" style="margin: 4rem 0;">
      <div class="stat-card">
        <div class="stat-value">${stats.total_sites.toLocaleString()}</div>
        <div class="stat-label">Active Sites</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${stats.total_comments.toLocaleString()}</div>
        <div class="stat-label">Comments Served</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${stats.total_users.toLocaleString()}</div>
        <div class="stat-label">Registered Users</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">99.9%</div>
        <div class="stat-label">Uptime SLA</div>
      </div>
    </div>
    
    <div class="card">
      <h2 style="margin-bottom: 2rem; text-align: center;">Why Choose CloudComments?</h2>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 2rem;">
        <div>
          <h3><i class="fas fa-bolt" style="color: var(--primary);"></i> Lightning Fast</h3>
          <p>Powered by Cloudflare's global edge network with sub-50ms response times worldwide.</p>
        </div>
        <div>
          <h3><i class="fas fa-lock" style="color: var(--primary);"></i> Privacy Focused</h3>
          <p>GDPR compliant with minimal data collection. Your users' privacy is our priority.</p>
        </div>
        <div>
          <h3><i class="fas fa-shield-alt" style="color: var(--primary);"></i> Spam Protection</h3>
          <p>Advanced spam detection with machine learning and community-driven moderation.</p>
        </div>
        <div>
          <h3><i class="fas fa-code" style="color: var(--primary);"></i> Easy Integration</h3>
          <p>Add comments to any website with just two lines of code. No complex setup required.</p>
        </div>
        <div>
          <h3><i class="fas fa-palette" style="color: var(--primary);"></i> Fully Customizable</h3>
          <p>Match your brand with custom CSS, themes, and layout options.</p>
        </div>
        <div>
          <h3><i class="fas fa-chart-line" style="color: var(--primary);"></i> Real-time Analytics</h3>
          <p>Track engagement, sentiment analysis, and user behavior with detailed analytics.</p>
        </div>
      </div>
    </div>
    
    <div class="card" style="background: var(--primary); color: white;">
      <h2 style="text-align: center; margin-bottom: 1rem;">Ready to get started?</h2>
      <p style="text-align: center; margin-bottom: 2rem;">
        Join thousands of websites using CloudComments for better engagement.
      </p>
      <div style="text-align: center;">
        <a href="/register" class="btn" style="background: white; color: var(--primary); font-size: 1.125rem; padding: 0.75rem 2rem;">
          Start Free Trial
        </a>
      </div>
    </div>
  `;
  
  return c.html(layout('Privacy-First Comment System', content, c.get('user')));
});

// Documentation page
app.get('/docs', (c) => {
  const content = html`
    <div class="card">
      <h1>Documentation</h1>
      
      <div class="tabs">
        <a href="#quickstart" class="tab active">Quick Start</a>
        <a href="#api" class="tab">API Reference</a>
        <a href="#customization" class="tab">Customization</a>
        <a href="#moderation" class="tab">Moderation</a>
        <a href="#webhooks" class="tab">Webhooks</a>
      </div>
      
      <div id="quickstart">
        <h2>Quick Start Guide</h2>
        <p>Get CloudComments running on your website in under 5 minutes.</p>
        
        <h3>1. Create a Site</h3>
        <p>After registering, go to your dashboard and create a new site. You'll receive an API key.</p>
        
        <h3>2. Add the Embed Code</h3>
        <p>Add these two lines of code where you want comments to appear:</p>
        <pre><code>&lt;div id="cloudcomments"&gt;&lt;/div&gt;
&lt;script src="${c.req.url.origin}/embed.js" 
        data-site-key="YOUR_SITE_API_KEY"
        data-post-slug="unique-post-identifier"&gt;&lt;/script&gt;</code></pre>
        
        <h3>3. Optional Configuration</h3>
        <p>You can customize the behavior with additional data attributes:</p>
        <pre><code>&lt;script src="${c.req.url.origin}/embed.js" 
        data-site-key="YOUR_SITE_API_KEY"
        data-post-slug="unique-post-identifier"
        data-theme="dark"
        data-language="en"
        data-sort="newest"&gt;&lt;/script&gt;</code></pre>
        
        <h3>Available Options</h3>
        <ul>
          <li><code>data-theme</code>: "light" or "dark" (default: "light")</li>
          <li><code>data-language</code>: Language code (default: "en")</li>
          <li><code>data-sort</code>: "newest", "oldest", or "best" (default: "newest")</li>
          <li><code>data-max-depth</code>: Maximum nesting depth (default: 3)</li>
        </ul>
      </div>
    </div>
  `;
  
  return c.html(layout('Documentation', content, c.get('user')));
});

// User Registration
app.get('/register', (c) => {
  const content = html`
    <div class="card" style="max-width: 400px; margin: 0 auto;">
      <h2 style="text-align: center; margin-bottom: 2rem;">Create Your Account</h2>
      <form method="POST" action="/register" data-validate>
        <div class="form-group">
          <label>Full Name</label>
          <input type="text" name="name" required>
        </div>
        <div class="form-group">
          <label>Email Address</label>
          <input type="email" name="email" required>
        </div>
        <div class="form-group">
          <label>Password</label>
          <input type="password" name="password" required minlength="8">
          <small style="color: var(--gray);">Minimum 8 characters</small>
        </div>
        <div class="form-group">
          <label>
            <input type="checkbox" name="terms" required>
            I agree to the <a href="/terms">Terms of Service</a> and <a href="/privacy">Privacy Policy</a>
          </label>
        </div>
        <button type="submit" class="btn btn-primary" style="width: 100%;">Create Account</button>
      </form>
      <p style="text-align: center; margin-top: 1rem;">
        Already have an account? <a href="/login">Sign in</a>
      </p>
    </div>
  `;
  
  return c.html(layout('Create Account', content));
});

app.post('/register', rateLimitMiddleware, async (c) => {
  const formData = await c.req.formData();
  const name = formData.get('name') as string;
  const email = formData.get('email') as string;
  const password = formData.get('password') as string;
  
  // Validate password strength
  if (password.length < 8) {
    return c.html(layout('Create Account', html`
      <div class="alert alert-error">
        <i class="fas fa-exclamation-circle"></i>
        Password must be at least 8 characters long.
      </div>
    `));
  }
  
  // Hash password
  const passwordHash = await bcrypt.hash(password, 10);
  const avatarUrl = getGravatarUrl(email);
  
  try {
    await c.env.COMMENTS_DB.prepare(
      'INSERT INTO users (email, name, password_hash, avatar_url, role, reputation, email_notifications, created_at, last_login) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      email.toLowerCase(),
      name,
      passwordHash,
      avatarUrl,
      'user',
      0,
      1, // Enable email notifications by default
      new Date().toISOString(),
      new Date().toISOString()
    ).run();
    
    // Send welcome email
    if (c.env.EMAIL_QUEUE && c.env.RESEND_API_KEY) {
      await c.env.EMAIL_QUEUE.send({
        type: 'welcome',
        to: email,
        name: name
      });
    }
    
    return c.redirect('/login?registered=true');
  } catch (error) {
    return c.html(layout('Create Account', html`
      <div class="alert alert-error">
        <i class="fas fa-exclamation-circle"></i>
        An account with this email already exists. Please <a href="/login">sign in</a> instead.
      </div>
    `));
  }
});

// User Login
app.get('/login', (c) => {
  const registered = c.req.query('registered');
  const redirect = c.req.query('redirect');
  
  const content = html`
    ${registered ? html`
      <div class="alert alert-success">
        <i class="fas fa-check-circle"></i>
        Account created successfully! Please sign in.
      </div>
    ` : ''}
    
    <div class="card" style="max-width: 400px; margin: 0 auto;">
      <h2 style="text-align: center; margin-bottom: 2rem;">Welcome Back</h2>
      <form method="POST" action="/login" data-validate>
        ${redirect ? html`<input type="hidden" name="redirect" value="${redirect}">` : ''}
        <div class="form-group">
          <label>Email Address</label>
          <input type="email" name="email" required>
        </div>
        <div class="form-group">
          <label>Password</label>
          <input type="password" name="password" required>
        </div>
        <div class="form-group">
          <label>
            <input type="checkbox" name="remember" value="1">
            Remember me for 30 days
          </label>
        </div>
        <button type="submit" class="btn btn-primary" style="width: 100%;">Sign In</button>
      </form>
      <p style="text-align: center; margin-top: 1rem;">
        <a href="/forgot-password">Forgot your password?</a>
      </p>
      <hr style="margin: 1.5rem 0;">
      <p style="text-align: center;">
        Don't have an account? <a href="/register">Sign up free</a>
      </p>
    </div>
  `;
  
  return c.html(layout('Sign In', content));
});

app.post('/login', rateLimitMiddleware, async (c) => {
  const formData = await c.req.formData();
  const email = formData.get('email') as string;
  const password = formData.get('password') as string;
  const remember = formData.get('remember') === '1';
  const redirect = formData.get('redirect') as string;
  
  const user = await c.env.COMMENTS_DB.prepare(
    'SELECT * FROM users WHERE email = ?'
  ).bind(email.toLowerCase()).first() as User;
  
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return c.html(layout('Sign In', html`
      <div class="alert alert-error">
        <i class="fas fa-exclamation-circle"></i>
        Invalid email or password. Please try again.
      </div>
      <div class="card" style="max-width: 400px; margin: 0 auto;">
        <h2 style="text-align: center; margin-bottom: 2rem;">Welcome Back</h2>
        <form method="POST" action="/login" data-validate>
          <div class="form-group">
            <label>Email Address</label>
            <input type="email" name="email" value="${email}" required>
          </div>
          <div class="form-group">
            <label>Password</label>
            <input type="password" name="password" required>
          </div>
          <button type="submit" class="btn btn-primary" style="width: 100%;">Sign In</button>
        </form>
      </div>
    `));
  }
  
  if (user.is_banned) {
    return c.html(layout('Account Suspended', html`
      <div class="alert alert-error">
        <i class="fas fa-ban"></i>
        Your account has been suspended. Reason: ${user.ban_reason || 'Terms of service violation'}
      </div>
    `));
  }
  
  // Create JWT token
  const expiresIn = remember ? '30d' : '7d';
  const token = await jwt.sign(
    { 
      sub: user.id, 
      email: user.email, 
      role: user.role,
      name: user.name 
    },
    c.env.JWT_SECRET,
    { expiresIn }
  );
  
  // Set cookie
  c.cookie('auth_token', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    maxAge: remember ? 60 * 60 * 24 * 30 : 60 * 60 * 24 * 7
  });
  
  // Update last login
  await c.env.COMMENTS_DB.prepare(
    'UPDATE users SET last_login = ? WHERE id = ?'
  ).bind(new Date().toISOString(), user.id).run();
  
  return c.redirect(redirect || '/dashboard');
});

// Logout
app.get('/logout', (c) => {
  c.cookie('auth_token', '', { maxAge: 0 });
  return c.redirect('/');
});

// User Dashboard
app.get('/dashboard', authMiddleware, async (c) => {
  const user = c.get('user');
  
  // Get user's sites
  const sites = await c.env.COMMENTS_DB.prepare(
    'SELECT * FROM sites WHERE user_id = ? ORDER BY created_at DESC'
  ).bind(user.id).all();
  
  // Get recent comments on user's sites
  const recentComments = await c.env.COMMENTS_DB.prepare(`
    SELECT c.*, s.name as site_name, u.name as author_name
    FROM comments c
    JOIN sites s ON c.site_id = s.id
    JOIN users u ON c.user_id = u.id
    WHERE s.user_id = ? AND c.status = 'pending'
    ORDER BY c.created_at DESC
    LIMIT 10
  `).bind(user.id).all();
  
  const content = html`
    <h1>Dashboard</h1>
    
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-value">${sites.results.length}</div>
        <div class="stat-label">Active Sites</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${recentComments.results.length}</div>
        <div class="stat-label">Pending Comments</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${user.reputation}</div>
        <div class="stat-label">Reputation Score</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">Free</div>
        <div class="stat-label">Current Plan</div>
      </div>
    </div>
    
    <div class="card">
      <div class="card-header">
        <h2 class="card-title">Your Sites</h2>
        <button class="btn btn-primary" data-modal="add-site-modal">
          <i class="fas fa-plus"></i> Add Site
        </button>
      </div>
      
      ${sites.results.length > 0 ? html`
        <div class="table-wrapper">
          <table class="table">
            <thead>
              <tr>
                <th>Site Name</th>
                <th>Domain</th>
                <th>Comments</th>
                <th>Moderation</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${sites.results.map(site => html`
                <tr>
                  <td><strong>${site.name}</strong></td>
                  <td>${site.domain}</td>
                  <td>${site.total_comments}</td>
                  <td>
                    <span class="badge ${site.moderation_enabled ? 'badge-success' : 'badge-info'}">
                      ${site.moderation_enabled ? 'Enabled' : 'Disabled'}
                    </span>
                  </td>
                  <td>
                    <div class="btn-group">
                      <a href="/sites/${site.id}" class="btn btn-sm btn-outline">Manage</a>
                      <button class="btn btn-sm btn-secondary" onclick="showEmbedCode('${site.api_key}')">
                        <i class="fas fa-code"></i> Embed
                      </button>
                    </div>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : html`
        <p style="text-align: center; padding: 2rem;">
          You haven't added any sites yet. 
          <a href="#" data-modal="add-site-modal">Add your first site</a> to get started.
        </p>
      `}
    </div>
    
    ${recentComments.results.length > 0 ? html`
      <div class="card">
        <h2 class="card-title">Recent Comments Requiring Moderation</h2>
        <div class="comments-list">
          ${recentComments.results.map(comment => html`
            <div class="comment">
              <div class="comment-header">
                <img src="${getGravatarUrl(comment.author_email || 'unknown')}" 
                     alt="${comment.author_name}" 
                     class="comment-avatar">
                <div class="comment-meta">
                  <div class="comment-author">${comment.author_name}</div>
                  <div class="comment-date">
                    on ${comment.site_name} • ${new Date(comment.created_at).toLocaleDateString()}
                  </div>
                </div>
              </div>
              <div class="comment-content">${comment.content}</div>
              <div class="comment-actions">
                <button class="btn btn-sm btn-success" onclick="approveComment(${comment.id})">
                  <i class="fas fa-check"></i> Approve
                </button>
                <button class="btn btn-sm btn-danger" onclick="markAsSpam(${comment.id})">
                  <i class="fas fa-ban"></i> Spam
                </button>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    ` : ''}
    
    <!-- Add Site Modal -->
    <div id="add-site-modal" class="modal">
      <div class="modal-content">
        <div class="modal-header">
          <h3>Add New Site</h3>
          <span class="modal-close">&times;</span>
        </div>
        <form method="POST" action="/sites" data-validate>
          <div class="form-group">
            <label>Site Name</label>
            <input type="text" name="name" placeholder="My Awesome Blog" required>
          </div>
          <div class="form-group">
            <label>Domain</label>
            <input type="text" name="domain" placeholder="example.com" required>
            <small style="color: var(--gray);">Enter your domain without https://</small>
          </div>
          <div class="form-group">
            <label>Moderation Settings</label>
            <select name="moderation_enabled">
              <option value="1">Enable moderation (Recommended)</option>
              <option value="0">Auto-approve all comments</option>
            </select>
          </div>
          <div class="form-group">
            <label>
              <input type="checkbox" name="spam_filter_enabled" value="1" checked>
              Enable spam filtering
            </label>
          </div>
          <button type="submit" class="btn btn-primary">Create Site</button>
        </form>
      </div>
    </div>
    
    <script>
      function showEmbedCode(apiKey) {
        alert(\`Add this code to your site:\\n\\n<div id="cloudcomments"></div>\\n<script src="${c.req.url.origin}/embed.js" data-site-key="\${apiKey}" data-post-slug="unique-post-id"></script>\`);
      }
      
      async function approveComment(commentId) {
        if (confirm('Approve this comment?')) {
          await fetch(\`/api/comments/\${commentId}/approve\`, { method: 'POST' });
          location.reload();
        }
      }
      
      async function markAsSpam(commentId) {
        if (confirm('Mark this comment as spam?')) {
          await fetch(\`/api/comments/\${commentId}/spam\`, { method: 'POST' });
          location.reload();
        }
      }
    </script>
  `;
  
  return c.html(layout('Dashboard', content, user));
});

// Create new site
app.post('/sites', authMiddleware, async (c) => {
  const user = c.get('user');
  const formData = await c.req.formData();
  
  const name = formData.get('name') as string;
  const domain = formData.get('domain') as string;
  const moderation = formData.get('moderation_enabled') === '1';
  const spamFilter = formData.get('spam_filter_enabled') === '1';
  
  // Generate API key
  const apiKey = `cc_${crypto.randomUUID().replace(/-/g, '')}`;
  
  await c.env.COMMENTS_DB.prepare(`
    INSERT INTO sites (
      user_id, name, domain, api_key, moderation_enabled, 
      spam_filter_enabled, auto_approve_threshold, require_auth, 
      created_at, monthly_views, total_comments
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    user.id,
    name,
    domain.toLowerCase().replace(/^https?:\/\//, ''),
    apiKey,
    moderation ? 1 : 0,
    spamFilter ? 1 : 0,
    30, // Default spam threshold
    0, // Don't require auth by default
    new Date().toISOString(),
    0,
    0
  ).run();
  
  return c.redirect('/dashboard');
});

// Admin Panel
app.get('/admin', authMiddleware, adminMiddleware, async (c) => {
  const user = c.get('user');
  
  // Get comprehensive stats
  const stats = await c.env.COMMENTS_DB.prepare(`
    SELECT 
      (SELECT COUNT(*) FROM users) as total_users,
      (SELECT COUNT(*) FROM users WHERE created_at > datetime('now', '-7 days')) as new_users_week,
      (SELECT COUNT(*) FROM comments) as total_comments,
      (SELECT COUNT(*) FROM comments WHERE status = 'pending') as pending_comments,
      (SELECT COUNT(*) FROM comments WHERE status = 'spam') as spam_comments,
      (SELECT COUNT(*) FROM sites) as total_sites,
      (SELECT COUNT(*) FROM sites WHERE created_at > datetime('now', '-7 days')) as new_sites_week,
      (SELECT COUNT(*) FROM users WHERE is_banned = 1) as banned_users
  `).first();
  
  // Get recent activity
  const recentActivity = await c.env.COMMENTS_DB.prepare(`
    SELECT 
      'comment' as type,
      c.created_at,
      u.name as user_name,
      s.name as site_name,
      c.content as details
    FROM comments c
    JOIN users u ON c.user_id = u.id
    JOIN sites s ON c.site_id = s.id
    WHERE c.created_at > datetime('now', '-24 hours')
    UNION ALL
    SELECT 
      'user' as type,
      created_at,
      name as user_name,
      email as site_name,
      'New user registration' as details
    FROM users
    WHERE created_at > datetime('now', '-24 hours')
    ORDER BY created_at DESC
    LIMIT 20
  `).all();
  
  const content = html`
    <h1>Admin Dashboard</h1>
    
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-value">${stats.total_users.toLocaleString()}</div>
        <div class="stat-label">Total Users</div>
        <small style="color: var(--secondary);">+${stats.new_users_week} this week</small>
      </div>
      <div class="stat-card">
        <div class="stat-value">${stats.total_comments.toLocaleString()}</div>
        <div class="stat-label">Total Comments</div>
        <small style="color: var(--warning);">${stats.pending_comments} pending</small>
      </div>
      <div class="stat-card">
        <div class="stat-value">${stats.total_sites.toLocaleString()}</div>
        <div class="stat-label">Total Sites</div>
        <small style="color: var(--secondary);">+${stats.new_sites_week} this week</small>
      </div>
      <div class="stat-card" style="border-left-color: var(--danger);">
        <div class="stat-value">${stats.spam_comments.toLocaleString()}</div>
        <div class="stat-label">Spam Blocked</div>
        <small style="color: var(--danger);">${stats.banned_users} users banned</small>
      </div>
    </div>
    
    <div class="tabs">
      <a href="/admin" class="tab active">Overview</a>
      <a href="/admin/users" class="tab">Users</a>
      <a href="/admin/sites" class="tab">Sites</a>
      <a href="/admin/comments" class="tab">Comments</a>
      <a href="/admin/settings" class="tab">Settings</a>
    </div>
    
    <div class="card">
      <h2 class="card-title">Recent Activity</h2>
      <div class="activity-feed">
        ${recentActivity.results.map(activity => html`
          <div class="activity-item" style="padding: 1rem; border-bottom: 1px solid var(--light);">
            <div style="display: flex; align-items: start; gap: 1rem;">
              <i class="fas ${activity.type === 'comment' ? 'fa-comment' : 'fa-user'}" 
                 style="color: var(--primary); margin-top: 0.25rem;"></i>
              <div style="flex: 1;">
                <div>
                  <strong>${activity.user_name}</strong>
                  ${activity.type === 'comment' ? html`
                    commented on <strong>${activity.site_name}</strong>
                  ` : html`
                    joined CloudComments
                  `}
                </div>
                <div style="color: var(--gray); font-size: 0.875rem;">
                  ${new Date(activity.created_at).toLocaleString()}
                </div>
                ${activity.type === 'comment' ? html`
                  <div style="margin-top: 0.5rem; padding: 0.5rem; background: var(--light); border-radius: 0.25rem;">
                    ${activity.details.substring(0, 100)}${activity.details.length > 100 ? '...' : ''}
                  </div>
                ` : ''}
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
  
  return c.html(layout('Admin Dashboard', content, user));
});

// API Routes
app.get('/api/comments/:siteKey/:postSlug', async (c) => {
  const siteKey = c.req.param('siteKey');
  const postSlug = decodeURIComponent(c.req.param('postSlug'));
  const page = parseInt(c.req.query('page') || '1');
  const limit = 50;
  const offset = (page - 1) * limit;
  
  // Get site
  const site = await c.env.COMMENTS_DB.prepare(
    'SELECT * FROM sites WHERE api_key = ?'
  ).bind(siteKey).first() as Site;
  
  if (!site) {
    return c.json({ error: 'Invalid site key' }, 404);
  }
  
  // Increment view counter
  await c.env.COMMENTS_DB.prepare(
    'UPDATE sites SET monthly_views = monthly_views + 1 WHERE id = ?'
  ).bind(site.id).run();
  
  // Get approved comments with user info
  const comments = await c.env.COMMENTS_DB.prepare(`
    SELECT 
      c.*,
      u.name as author_name,
      u.avatar_url as author_avatar,
      u.reputation as author_reputation,
      (SELECT COUNT(*) FROM comment_likes WHERE comment_id = c.id) as like_count,
      (SELECT COUNT(*) FROM comments WHERE parent_id = c.id AND status = 'approved') as reply_count
    FROM comments c
    JOIN users u ON c.user_id = u.id
    WHERE c.site_id = ? AND c.post_slug = ? AND c.status = 'approved'
    ORDER BY c.created_at DESC
    LIMIT ? OFFSET ?
  `).bind(site.id, postSlug, limit, offset).all();
  
  // Get total count
  const countResult = await c.env.COMMENTS_DB.prepare(`
    SELECT COUNT(*) as total
    FROM comments
    WHERE site_id = ? AND post_slug = ? AND status = 'approved'
  `).bind(site.id, postSlug).first();
  
  // Check if user is logged in
  const token = c.req.cookie('auth_token');
  let user = null;
  
  if (token) {
    try {
      const payload = await jwt.verify(token, c.env.JWT_SECRET);
      user = await c.env.COMMENTS_DB.prepare(
        'SELECT id, name, email, avatar_url FROM users WHERE id = ? AND is_banned = 0'
      ).bind(payload.sub).first();
    } catch (error) {
      // Invalid token
    }
  }
  
  // Convert markdown to HTML for each comment
  const processedComments = comments.results.map(comment => ({
    ...comment,
    content_html: marked(comment.content)
  }));
  
  return c.json({
    comments: processedComments,
    total: countResult.total,
    page: page,
    pages: Math.ceil(countResult.total / limit),
    user: user,
    site: {
      name: site.name,
      require_auth: site.require_auth,
      custom_css: site.custom_css
    }
  });
});

// Post new comment
app.post('/api/comments/:siteKey/:postSlug', rateLimitMiddleware, async (c) => {
  const siteKey = c.req.param('siteKey');
  const postSlug = decodeURIComponent(c.req.param('postSlug'));
  const { content, parent_id, post_title } = await c.req.json();
  
  // Verify user is logged in
  const token = c.req.cookie('auth_token');
  if (!token) {
    return c.json({ error: 'Authentication required' }, 401);
  }
  
  let user;
  try {
    const payload = await jwt.verify(token, c.env.JWT_SECRET);
    user = await c.env.COMMENTS_DB.prepare(
      'SELECT * FROM users WHERE id = ? AND is_banned = 0'
    ).bind(payload.sub).first() as User;
  } catch (error) {
    return c.json({ error: 'Invalid token' }, 401);
  }
  
  if (!user) {
    return c.json({ error: 'User not found or banned' }, 403);
  }
  
  // Get site
  const site = await c.env.COMMENTS_DB.prepare(
    'SELECT * FROM sites WHERE api_key = ?'
  ).bind(siteKey).first() as Site;
  
  if (!site) {
    return c.json({ error: 'Invalid site key' }, 404);
  }
  
  // Check if authentication is required
  if (site.require_auth && !user) {
    return c.json({ error: 'Authentication required for this site' }, 401);
  }
  
  // Calculate spam score
  const spamScore = site.spam_filter_enabled ? calculateSpamScore(content, user) : 0;
  
  // Determine comment status
  let status = 'approved';
  if (site.moderation_enabled) {
    if (spamScore >= site.auto_approve_threshold) {
      status = 'spam';
    } else if (user.reputation < 10) {
      status = 'pending';
    }
  }
  
  // Get client info
  const ipAddress = c.req.header('CF-Connecting-IP') || 'unknown';
  const userAgent = c.req.header('User-Agent') || 'unknown';
  
  // Insert comment
  const result = await c.env.COMMENTS_DB.prepare(`
    INSERT INTO comments (
      site_id, post_slug, post_title, user_id, parent_id, 
      content, status, spam_score, ip_address, user_agent,
      created_at, updated_at, likes, flags
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    site.id,
    postSlug,
    post_title || null,
    user.id,
    parent_id || null,
    content,
    status,
    spamScore,
    ipAddress,
    userAgent,
    new Date().toISOString(),
    new Date().toISOString(),
    0,
    0
  ).run();
  
  // Update site comment count
  await c.env.COMMENTS_DB.prepare(
    'UPDATE sites SET total_comments = total_comments + 1 WHERE id = ?'
  ).bind(site.id).run();
  
  // Update user reputation for approved comments
  if (status === 'approved') {
    await c.env.COMMENTS_DB.prepare(
      'UPDATE users SET reputation = reputation + 1 WHERE id = ?'
    ).bind(user.id).run();
  }
  
  // Send webhook if configured
  if (site.webhook_url && c.env.WEBHOOK_SECRET) {
    const webhookData = {
      event: 'comment.created',
      comment: {
        id: result.meta.last_row_id,
        content: content,
        status: status,
        author: {
          name: user.name,
          email: user.email
        },
        post: {
          slug: postSlug,
          title: post_title
        }
      },
      timestamp: new Date().toISOString()
    };
    
    const signature = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify(webhookData) + c.env.WEBHOOK_SECRET)
    );
    
    // Queue webhook delivery
    c.env.EMAIL_QUEUE.send({
      type: 'webhook',
      url: site.webhook_url,
      data: webhookData,
      signature: btoa(String.fromCharCode(...new Uint8Array(signature)))
    });
  }
  
  // Send email notification to site owner
  if (c.env.EMAIL_QUEUE && c.env.RESEND_API_KEY) {
    const siteOwner = await c.env.COMMENTS_DB.prepare(
      'SELECT u.* FROM users u JOIN sites s ON u.id = s.user_id WHERE s.id = ?'
    ).bind(site.id).first() as User;
    
    if (siteOwner && siteOwner.email_notifications) {
      await c.env.EMAIL_QUEUE.send({
        type: 'new_comment',
        to: siteOwner.email,
        site_name: site.name,
        post_slug: postSlug,
        comment_author: user.name,
        comment_content: content.substring(0, 200)
      });
    }
  }
  
  return c.json({ 
    success: true, 
    status: status,
    message: status === 'pending' ? 'Your comment is awaiting moderation.' : 
             status === 'spam' ? 'Your comment was flagged as spam.' : 
             'Comment posted successfully!'
  });
});

// Like a comment
app.post('/api/comments/:id/like', authMiddleware, async (c) => {
  const commentId = c.req.param('id');
  const user = c.get('user');
  
  // Check if already liked
  const existing = await c.env.COMMENTS_DB.prepare(
    'SELECT id FROM comment_likes WHERE comment_id = ? AND user_id = ?'
  ).bind(commentId, user.id).first();
  
  if (existing) {
    // Unlike
    await c.env.COMMENTS_DB.prepare(
      'DELETE FROM comment_likes WHERE comment_id = ? AND user_id = ?'
    ).bind(commentId, user.id).run();
    
    await c.env.COMMENTS_DB.prepare(
      'UPDATE comments SET likes = likes - 1 WHERE id = ?'
    ).bind(commentId).run();
    
    return c.json({ liked: false });
  } else {
    // Like
    await c.env.COMMENTS_DB.prepare(
      'INSERT INTO comment_likes (comment_id, user_id, created_at) VALUES (?, ?, ?)'
    ).bind(commentId, user.id, new Date().toISOString()).run();
    
    await c.env.COMMENTS_DB.prepare(
      'UPDATE comments SET likes = likes + 1 WHERE id = ?'
    ).bind(commentId).run();
    
    // Give reputation to comment author
    const comment = await c.env.COMMENTS_DB.prepare(
      'SELECT user_id FROM comments WHERE id = ?'
    ).bind(commentId).first();
    
    if (comment) {
      await c.env.COMMENTS_DB.prepare(
        'UPDATE users SET reputation = reputation + 1 WHERE id = ?'
      ).bind(comment.user_id).run();
    }
    
    return c.json({ liked: true });
  }
});

// Flag a comment
app.post('/api/comments/:id/flag', authMiddleware, async (c) => {
  const commentId = c.req.param('id');
  const user = c.get('user');
  const { reason } = await c.req.json();
  
  // Check if already flagged by this user
  const existing = await c.env.COMMENTS_DB.prepare(
    'SELECT id FROM comment_flags WHERE comment_id = ? AND user_id = ?'
  ).bind(commentId, user.id).first();
  
  if (existing) {
    return c.json({ error: 'You have already flagged this comment' }, 400);
  }
  
  // Add flag
  await c.env.COMMENTS_DB.prepare(
    'INSERT INTO comment_flags (comment_id, user_id, reason, created_at) VALUES (?, ?, ?, ?)'
  ).bind(commentId, user.id, reason, new Date().toISOString()).run();
  
  await c.env.COMMENTS_DB.prepare(
    'UPDATE comments SET flags = flags + 1 WHERE id = ?'
  ).bind(commentId).run();
  
  // Auto-moderate if too many flags
  const comment = await c.env.COMMENTS_DB.prepare(
    'SELECT flags FROM comments WHERE id = ?'
  ).bind(commentId).first();
  
  if (comment && comment.flags >= 3) {
    await c.env.COMMENTS_DB.prepare(
      'UPDATE comments SET status = ? WHERE id = ?'
    ).bind('pending', commentId).run();
  }
  
  return c.json({ success: true });
});

// Embed script with real-time updates
app.get('/embed.js', (c) => {
  c.header('Content-Type', 'application/javascript');
  
  const embedScript = `
(function() {
  const script = document.currentScript;
  const siteKey = script.getAttribute('data-site-key');
  const postSlug = script.getAttribute('data-post-slug') || window.location.pathname;
  const theme = script.getAttribute('data-theme') || 'light';
  const language = script.getAttribute('data-language') || 'en';
  const sort = script.getAttribute('data-sort') || 'newest';
  const maxDepth = parseInt(script.getAttribute('data-max-depth') || '3');
  const apiUrl = '${c.req.url.origin}';
  
  // Create container
  const container = document.getElementById('cloudcomments');
  if (!container) {
    console.error('CloudComments: Container element not found');
    return;
  }
  
  // Add styles
  const style = document.createElement('style');
  style.textContent = \`
    #cloudcomments {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: #333;
      line-height: 1.6;
    }
    
    #cloudcomments * {
      box-sizing: border-box;
    }
    
    .cc-comments {
      margin-bottom: 2rem;
    }
    
    .cc-comment {
      margin-bottom: 1.5rem;
      padding: 1rem;
      background: #f8f9fa;
      border-radius: 0.5rem;
      position: relative;
    }
    
    .cc-comment-reply {
      margin-left: 2rem;
      margin-top: 1rem;
    }
    
    .cc-comment-header {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 0.5rem;
    }
    
    .cc-comment-avatar {
      width: 2.5rem;
      height: 2.5rem;
      border-radius: 50%;
      background: #e9ecef;
    }
    
    .cc-comment-meta {
      flex: 1;
    }
    
    .cc-comment-author {
      font-weight: 600;
      color: #2c3e50;
    }
    
    .cc-comment-date {
      font-size: 0.875rem;
      color: #6c757d;
    }
    
    .cc-comment-content {
      margin-top: 0.5rem;
    }
    
    .cc-comment-content p {
      margin: 0 0 0.5rem 0;
    }
    
    .cc-comment-content p:last-child {
      margin-bottom: 0;
    }
    
    .cc-comment-actions {
      display: flex;
      gap: 1rem;
      margin-top: 0.75rem;
      font-size: 0.875rem;
    }
    
    .cc-comment-action {
      color: #6c757d;
      cursor: pointer;
      border: none;
      background: none;
      padding: 0;
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      transition: color 0.2s;
    }
    
    .cc-comment-action:hover {
      color: #3b82f6;
    }
    
    .cc-comment-action.liked {
      color: #3b82f6;
    }
    
    .cc-form {
      background: #f8f9fa;
      padding: 1.5rem;
      border-radius: 0.5rem;
      margin-top: 2rem;
    }
    
    .cc-form h3 {
      margin: 0 0 1rem 0;
      color: #2c3e50;
    }
    
    .cc-form-group {
      margin-bottom: 1rem;
    }
    
    .cc-form label {
      display: block;
      margin-bottom: 0.375rem;
      font-weight: 500;
      color: #495057;
    }
    
    .cc-form textarea {
      width: 100%;
      padding: 0.5rem 0.75rem;
      border: 1px solid #dee2e6;
      border-radius: 0.375rem;
      font-size: 1rem;
      font-family: inherit;
      resize: vertical;
      min-height: 100px;
    }
    
    .cc-form textarea:focus {
      outline: none;
      border-color: #3b82f6;
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
    }
    
    .cc-form button {
      background: #3b82f6;
      color: white;
      border: none;
      padding: 0.5rem 1.5rem;
      border-radius: 0.375rem;
      font-size: 1rem;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.2s;
    }
    
    .cc-form button:hover {
      background: #2563eb;
    }
    
    .cc-form button:disabled {
      background: #9ca3af;
      cursor: not-allowed;
    }
    
    .cc-login-prompt {
      text-align: center;
      padding: 2rem;
      background: #f8f9fa;
      border-radius: 0.5rem;
      margin-top: 2rem;
    }
    
    .cc-login-prompt a {
      color: #3b82f6;
      text-decoration: none;
      font-weight: 500;
    }
    
    .cc-login-prompt a:hover {
      text-decoration: underline;
    }
    
    .cc-loading {
      text-align: center;
      padding: 2rem;
      color: #6c757d;
    }
    
    .cc-error {
      text-align: center;
      padding: 2rem;
      color: #dc3545;
    }
    
    .cc-pagination {
      display: flex;
      gap: 0.5rem;
      justify-content: center;
      margin-top: 2rem;
    }
    
    .cc-pagination button {
      padding: 0.5rem 0.75rem;
      background: white;
      border: 1px solid #dee2e6;
      border-radius: 0.375rem;
      color: #6c757d;
      cursor: pointer;
      transition: all 0.2s;
    }
    
    .cc-pagination button:hover:not(:disabled) {
      background: #f8f9fa;
      color: #3b82f6;
    }
    
    .cc-pagination button:disabled {
      cursor: not-allowed;
      opacity: 0.5;
    }
    
    .cc-pagination button.active {
      background: #3b82f6;
      color: white;
      border-color: #3b82f6;
    }
    
    @media (max-width: 768px) {
      .cc-comment-reply {
        margin-left: 1rem;
      }
    }
    
    /* Dark theme */
    #cloudcomments.dark {
      color: #e5e7eb;
    }
    
    #cloudcomments.dark .cc-comment {
      background: #1f2937;
    }
    
    #cloudcomments.dark .cc-comment-author {
      color: #f3f4f6;
    }
    
    #cloudcomments.dark .cc-form {
      background: #1f2937;
    }
    
    #cloudcomments.dark .cc-form h3 {
      color: #f3f4f6;
    }
    
    #cloudcomments.dark .cc-form textarea {
      background: #111827;
      border-color: #374151;
      color: #e5e7eb;
    }
    
    #cloudcomments.dark .cc-login-prompt {
      background: #1f2937;
    }
  \`;
  document.head.appendChild(style);
  
  // Add theme class
  if (theme === 'dark') {
    container.classList.add('dark');
  }
  
  let currentPage = 1;
  let currentUser = null;
  let ws = null;
  
  // Initialize
  async function init() {
    container.innerHTML = '<div class="cc-loading">Loading comments...</div>';
    await loadComments();
    
    // Set up WebSocket for real-time updates
    setupWebSocket();
  }
  
  // Load comments
  async function loadComments(page = 1) {
    try {
      const response = await fetch(\`\${apiUrl}/api/comments/\${siteKey}/\${encodeURIComponent(postSlug)}?page=\${page}\`, {
        credentials: 'include'
      });
      
      if (!response.ok) {
        throw new Error('Failed to load comments');
      }
      
      const data = await response.json();
      currentUser = data.user;
      currentPage = page;
      
      // Apply custom CSS if provided
      if (data.site && data.site.custom_css) {
        const customStyle = document.createElement('style');
        customStyle.textContent = data.site.custom_css;
        document.head.appendChild(customStyle);
      }
      
      renderComments(data);
    } catch (error) {
      container.innerHTML = '<div class="cc-error">Failed to load comments. Please try again later.</div>';
      console.error('CloudComments Error:', error);
    }
  }
  
  // Render comments
  function renderComments(data) {
    let html = '<div class="cc-comments">';
    
    if (data.comments && data.comments.length > 0) {
      // Sort comments
      const sorted = sortComments(data.comments, sort);
      html += renderCommentTree(sorted, null, 0);
    } else {
      html += '<p style="text-align: center; color: #6c757d;">No comments yet. Be the first to comment!</p>';
    }
    
    html += '</div>';
    
    // Add pagination if needed
    if (data.pages > 1) {
      html += renderPagination(data.page, data.pages);
    }
    
    // Add comment form or login prompt
    if (data.user) {
      html += renderCommentForm(data.user);
    } else if (!data.site || !data.site.require_auth) {
      html += \`<div class="cc-login-prompt">
        <p>Please <a href="\${apiUrl}/login?redirect=\${encodeURIComponent(window.location.href)}">sign in</a> to leave a comment.</p>
      </div>\`;
    }
    
    container.innerHTML = html;
    attachEventHandlers();
  }
  
  // Sort comments
  function sortComments(comments, sortBy) {
    const sorted = [...comments];
    
    switch (sortBy) {
      case 'oldest':
        sorted.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        break;
      case 'best':
        sorted.sort((a, b) => b.like_count - a.like_count);
        break;
      default: // newest
        sorted.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }
    
    return sorted;
  }
  
  // Render comment tree
  function renderCommentTree(comments, parentId, depth) {
    if (depth >= maxDepth) return '';
    
    const filtered = comments.filter(c => c.parent_id === parentId);
    let html = '';
    
    filtered.forEach(comment => {
      html += renderComment(comment, depth);
      html += renderCommentTree(comments, comment.id, depth + 1);
    });
    
    return html;
  }
  
  // Render single comment
  function renderComment(comment, depth) {
    const isReply = depth > 0;
    const canReply = depth < maxDepth - 1;
    
    return \`
      <div class="cc-comment \${isReply ? 'cc-comment-reply' : ''}" data-comment-id="\${comment.id}">
        <div class="cc-comment-header">
          <img src="\${comment.author_avatar || \`https://www.gravatar.com/avatar/\${md5(comment.author_email || '')}?d=mp&s=80\`}" 
               alt="\${escapeHtml(comment.author_name)}" 
               class="cc-comment-avatar">
          <div class="cc-comment-meta">
            <div class="cc-comment-author">\${escapeHtml(comment.author_name)}</div>
            <div class="cc-comment-date">\${formatDate(comment.created_at)}</div>
          </div>
        </div>
        <div class="cc-comment-content">
          \${comment.content_html || escapeHtml(comment.content)}
        </div>
        <div class="cc-comment-actions">
          <button class="cc-comment-action \${comment.user_liked ? 'liked' : ''}" 
                  onclick="likeComment(\${comment.id})">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 1.314C12.438-3.248 23.534 4.735 8 15-7.534 4.736 3.562-3.248 8 1.314z"/>
            </svg>
            <span>\${comment.like_count || 0}</span>
          </button>
          \${canReply && currentUser ? \`
            <button class="cc-comment-action" onclick="replyToComment(\${comment.id})">
              Reply
            </button>
          \` : ''}
          \${currentUser ? \`
            <button class="cc-comment-action" onclick="flagComment(\${comment.id})">
              Flag
            </button>
          \` : ''}
        </div>
      </div>
    \`;
  }
  
  // Render pagination
  function renderPagination(current, total) {
    let html = '<div class="cc-pagination">';
    
    // Previous button
    html += \`<button onclick="loadComments(\${current - 1})" \${current === 1 ? 'disabled' : ''}>Previous</button>\`;
    
    // Page numbers
    for (let i = 1; i <= Math.min(total, 5); i++) {
      html += \`<button onclick="loadComments(\${i})" class="\${i === current ? 'active' : ''}">\${i}</button>\`;
    }
    
    if (total > 5) {
      html += '<span>...</span>';
      html += \`<button onclick="loadComments(\${total})">\${total}</button>\`;
    }
    
    // Next button
    html += \`<button onclick="loadComments(\${current + 1})" \${current === total ? 'disabled' : ''}>Next</button>\`;
    
    html += '</div>';
    return html;
  }
  
  // Render comment form
  function renderCommentForm(user) {
    return \`
      <div class="cc-form">
        <h3>Leave a Comment</h3>
        <form onsubmit="postComment(event)">
          <div class="cc-form-group">
            <label>Commenting as: \${escapeHtml(user.name)}</label>
          </div>
          <div class="cc-form-group">
            <textarea name="content" placeholder="Write your comment..." required></textarea>
          </div>
          <button type="submit">Post Comment</button>
        </form>
      </div>
    \`;
  }
  
  // Post comment
  window.postComment = async function(event) {
    event.preventDefault();
    const form = event.target;
    const content = form.content.value.trim();
    
    if (!content) return;
    
    const button = form.querySelector('button');
    button.disabled = true;
    button.textContent = 'Posting...';
    
    try {
      const response = await fetch(\`\${apiUrl}/api/comments/\${siteKey}/\${encodeURIComponent(postSlug)}\`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify({
          content: content,
          post_title: document.title
        })
      });
      
      const result = await response.json();
      
      if (response.ok) {
        form.reset();
        loadComments(currentPage);
        
        // Show status message
        const message = document.createElement('div');
        message.style.cssText = 'position: fixed; top: 20px; right: 20px; background: #10b981; color: white; padding: 1rem; border-radius: 0.5rem; z-index: 1000;';
        message.textContent = result.message || 'Comment posted successfully!';
        document.body.appendChild(message);
        
        setTimeout(() => message.remove(), 3000);
      } else {
        alert(result.error || 'Failed to post comment');
      }
    } catch (error) {
      alert('Failed to post comment. Please try again.');
    } finally {
      button.disabled = false;
      button.textContent = 'Post Comment';
    }
  };
  
  // Like comment
  window.likeComment = async function(commentId) {
    if (!currentUser) {
      window.location.href = \`\${apiUrl}/login?redirect=\${encodeURIComponent(window.location.href)}\`;
      return;
    }
    
    try {
      const response = await fetch(\`\${apiUrl}/api/comments/\${commentId}/like\`, {
        method: 'POST',
        credentials: 'include'
      });
      
      if (response.ok) {
        loadComments(currentPage);
      }
    } catch (error) {
      console.error('Failed to like comment:', error);
    }
  };
  
  // Flag comment
  window.flagComment = async function(commentId) {
    const reason = prompt('Please provide a reason for flagging this comment:');
    if (!reason) return;
    
    try {
      const response = await fetch(\`\${apiUrl}/api/comments/\${commentId}/flag\`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify({ reason })
      });
      
      if (response.ok) {
        alert('Comment flagged for review. Thank you!');
      }
    } catch (error) {
      console.error('Failed to flag comment:', error);
    }
  };
  
  // Setup WebSocket for real-time updates
  function setupWebSocket() {
    if (!window.WebSocket) return;
    
    const wsUrl = apiUrl.replace(/^http/, 'ws') + '/ws/' + siteKey + '/' + encodeURIComponent(postSlug);
    
    ws = new WebSocket(wsUrl);
    
    ws.onmessage = function(event) {
      const data = JSON.parse(event.data);
      
      if (data.type === 'new_comment' || data.type === 'comment_update') {
        loadComments(currentPage);
      }
    };
    
    ws.onerror = function(error) {
      console.error('WebSocket error:', error);
    };
    
    ws.onclose = function() {
      // Reconnect after 5 seconds
      setTimeout(setupWebSocket, 5000);
    };
  }
  
  // Utility functions
  function escapeHtml(unsafe) {
    return unsafe
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
  
  function formatDate(dateStr) {
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now - date;
    
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' minutes ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' hours ago';
    if (diff < 604800000) return Math.floor(diff / 86400000) + ' days ago';
    
    return date.toLocaleDateString();
  }
  
  function md5(string) {
    // Simple MD5 implementation for Gravatar
    // In production, use a proper MD5 library
    return '00000000000000000000000000000000';
  }
  
  // Initialize on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
  `;
  
  return c.body(embedScript);
});

// WebSocket endpoint for real-time updates
app.get('/ws/:siteKey/:postSlug', async (c) => {
  const siteKey = c.req.param('siteKey');
  const postSlug = decodeURIComponent(c.req.param('postSlug'));
  
  // Verify site exists
  const site = await c.env.COMMENTS_DB.prepare(
    'SELECT id FROM sites WHERE api_key = ?'
  ).bind(siteKey).first();
  
  if (!site) {
    return c.text('Invalid site key', 404);
  }
  
  // Upgrade to WebSocket
  const upgradeHeader = c.req.header('Upgrade');
  if (!upgradeHeader || upgradeHeader !== 'websocket') {
    return c.text('Expected WebSocket', 426);
  }
  
  // Create WebSocket pair
  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair);
  
  // Accept WebSocket
  server.accept();
  
  // Handle messages
  server.addEventListener('message', async (event) => {
    // Handle ping/pong
    if (event.data === 'ping') {
      server.send('pong');
    }
  });
  
  // Return WebSocket response
  return new Response(null, {
    status: 101,
    webSocket: client
  });
});

// Rate Limiter Durable Object
export class RateLimiter {
  private state: DurableObjectState;
  private env: Env;
  private requests: Map<string, number[]> = new Map();
  
  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }
  
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const key = url.pathname;
    
    // Clean old entries
    this.cleanOldEntries();
    
    // Get current requests for this key
    const now = Date.now();
    const requests = this.requests.get(key) || [];
    
    // Filter requests within the last minute
    const recentRequests = requests.filter(timestamp => now - timestamp < 60000);
    
    // Check rate limit (60 requests per minute)
    if (recentRequests.length >= 60) {
      return new Response('Too many requests', { status: 429 });
    }
    
    // Add current request
    recentRequests.push(now);
    this.requests.set(key, recentRequests);
    
    return new Response('OK', { status: 200 });
  }
  
  private cleanOldEntries() {
    const now = Date.now();
    for (const [key, requests] of this.requests.entries()) {
      const filtered = requests.filter(timestamp => now - timestamp < 60000);
      if (filtered.length === 0) {
        this.requests.delete(key);
      } else {
        this.requests.set(key, filtered);
      }
    }
  }
}

// Email Queue Consumer
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return app.fetch(request, env);
  },
  
  async queue(batch: MessageBatch<any>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const { type, ...data } = message.body;
      
      try {
        switch (type) {
          case 'welcome':
            await sendWelcomeEmail(data, env);
            break;
          case 'new_comment':
            await sendNewCommentEmail(data, env);
            break;
          case 'webhook':
            await deliverWebhook(data, env);
            break;
        }
        
        message.ack();
      } catch (error) {
        console.error(`Failed to process ${type} message:`, error);
        message.retry();
      }
    }
  }
};

// Email sending functions
async function sendWelcomeEmail(data: any, env: Env) {
  if (!env.RESEND_API_KEY) return;
  
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'CloudComments <noreply@cloudcomments.io>',
      to: data.to,
      subject: 'Welcome to CloudComments!',
      html: `
        <h2>Welcome to CloudComments, ${data.name}!</h2>
        <p>Thank you for joining CloudComments. We're excited to have you on board!</p>
        <p>Get started by:</p>
        <ul>
          <li>Creating your first site</li>
          <li>Adding the embed code to your website</li>
          <li>Customizing your comment settings</li>
        </ul>
        <p>If you have any questions, feel free to reach out to our support team.</p>
        <p>Best regards,<br>The CloudComments Team</p>
      `
    })
  });
  
  if (!response.ok) {
    throw new Error('Failed to send welcome email');
  }
}

async function sendNewCommentEmail(data: any, env: Env) {
  if (!env.RESEND_API_KEY) return;
  
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'CloudComments <notifications@cloudcomments.io>',
      to: data.to,
      subject: `New comment on ${data.site_name}`,
      html: `
        <h3>New comment on ${data.site_name}</h3>
        <p><strong>${data.comment_author}</strong> commented on <em>${data.post_slug}</em>:</p>
        <blockquote style="border-left: 3px solid #3b82f6; padding-left: 1rem; margin: 1rem 0;">
          ${data.comment_content}
        </blockquote>
        <p><a href="https://cloudcomments.io/dashboard" style="background: #3b82f6; color: white; padding: 0.5rem 1rem; text-decoration: none; border-radius: 0.25rem; display: inline-block;">View in Dashboard</a></p>
        <p style="font-size: 0.875rem; color: #6c757d;">
          You received this email because you have comment notifications enabled. 
          <a href="https://cloudcomments.io/settings/notifications">Manage your preferences</a>
        </p>
      `
    })
  });
  
  if (!response.ok) {
    throw new Error('Failed to send comment notification email');
  }
}

async function deliverWebhook(data: any, env: Env) {
  const response = await fetch(data.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CloudComments-Signature': data.signature
    },
    body: JSON.stringify(data.data)
  });
  
  if (!response.ok) {
    throw new Error(`Webhook delivery failed: ${response.status}`);
  }
}

export { RateLimiter };
