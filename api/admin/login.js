const { createSessionCookie } = require('../../lib/adminAuth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (!process.env.ADMIN_SECRET) {
    res.status(503).json({ error: 'Admin panel not configured yet' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (err) {
      body = {};
    }
  }

  const password = body && body.password;
  if (!password || password !== process.env.ADMIN_SECRET) {
    res.status(401).json({ error: 'Invalid password' });
    return;
  }

  res.setHeader('Set-Cookie', createSessionCookie());
  res.status(200).json({ ok: true });
};
