const express = require('express');
const rateLimit = require('express-rate-limit');
const c = require('../controllers/auth.controller');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// per client address; the per-account lockout (5 failed logins in 15 minutes) is in the controller
const limiter = (max, minutes) =>
  rateLimit({
    windowMs: minutes * 60 * 1000,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests from this address. Wait a few minutes and try again.', code: 'RATE_LIMITED' },
  });

const signIn = limiter(20, 15); // login attempts
const accountMail = limiter(5, 60); // anything that sends an email
const signUp = limiter(10, 60);
const tokens = limiter(30, 15); // verify / reset submissions
const refreshes = limiter(120, 15);

router.get('/config', c.config);
router.post('/register', signUp, c.register);
router.post('/login', signIn, c.login);
router.post('/refresh', refreshes, c.refresh);
router.post('/logout', c.logout);
router.post('/logout-all', authenticate, c.logoutAll);
router.post('/verify-email', tokens, c.verifyEmail);
router.post('/resend-verification', accountMail, c.resendVerification);
router.post('/forgot-password', accountMail, c.forgotPassword);
router.post('/reset-password', tokens, c.resetPassword);
router.get('/me', authenticate, c.me);
router.get('/sessions', authenticate, c.sessions);

module.exports = router;
