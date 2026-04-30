// Vercel serverless function: /api/signup.js
// Receives a demo signup, writes to MongoDB, adds to Mailchimp, sends a welcome via SendGrid.

import { MongoClient } from 'mongodb';
import sgMail from '@sendgrid/mail';
import crypto from 'node:crypto';

// Cached Mongo client — keeps the connection warm across invocations.
let cachedClient = null;
async function getMongo() {
  if (cachedClient && cachedClient.topology?.isConnected()) return cachedClient;
  cachedClient = new MongoClient(process.env.MONGODB_URI);
  await cachedClient.connect();
  return cachedClient;
}

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

export default async function handler(req, res) {
  // Permissive CORS so the demo can call this from any origin (subdomain, custom domain).
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    email,
    pathway = 'unknown',           // 'apply' | 'counting' | 'freeze' | 'speed'
    studentName = '',
    source = 'teacher',            // 'teacher' | 'leader'
    sendUpdates = true,            // mailchimp opt-in
  } = req.body || {};

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  const result = { mongo: false, mailchimp: false, sendgrid: false };

  // 1. MongoDB — source of truth
  try {
    const client = await getMongo();
    const db = client.db('numberhive');
    await db.collection('demoSignups').insertOne({
      email: email.toLowerCase().trim(),
      pathway,
      studentName,
      source,
      sendUpdates,
      createdAt: new Date(),
      userAgent: req.headers['user-agent'] || '',
      ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || null,
    });
    result.mongo = true;
  } catch (e) {
    console.error('[mongo]', e.message);
  }

  // 2. Mailchimp — upsert member, then add tags so they accumulate across visits.
  if (sendUpdates) {
    try {
      const dc = process.env.MAILCHIMP_DC;
      const listId = process.env.MAILCHIMP_LIST_ID;
      const auth = Buffer.from('any:' + process.env.MAILCHIMP_API_KEY).toString('base64');
      const subscriberHash = crypto
        .createHash('md5')
        .update(email.toLowerCase().trim())
        .digest('hex');
      const headers = { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` };

      // Upsert member (creates if new, updates if exists; doesn't touch tags here)
      const upsertBody = {
        email_address: email,
        status_if_new: 'subscribed',
      };
      if (studentName) upsertBody.merge_fields = { FNAME: studentName };
      const upsert = await fetch(
        `https://${dc}.api.mailchimp.com/3.0/lists/${listId}/members/${subscriberHash}`,
        { method: 'PUT', headers, body: JSON.stringify(upsertBody) }
      );
      if (!upsert.ok) {
        console.error('[mailchimp upsert]', upsert.status, await upsert.text());
        throw new Error('upsert failed');
      }

      // Apply tags additively (Mailchimp merges with existing tags on this endpoint)
      const tagBody = {
        tags: [
          { name: `demo-${source}`, status: 'active' },
          { name: `demo-pathway-${pathway}`, status: 'active' },
        ],
      };
      const tagRes = await fetch(
        `https://${dc}.api.mailchimp.com/3.0/lists/${listId}/members/${subscriberHash}/tags`,
        { method: 'POST', headers, body: JSON.stringify(tagBody) }
      );
      if (!tagRes.ok && tagRes.status !== 204) {
        console.error('[mailchimp tags]', tagRes.status, await tagRes.text());
      }
      result.mailchimp = true;
    } catch (e) {
      console.error('[mailchimp]', e.message);
    }
  } else {
    result.mailchimp = 'skipped';
  }

  // 3. SendGrid — instant welcome email
  try {
    const isLeader = source === 'leader';
    const greeting = studentName ? `Hi there,` : `Hi there,`;
    const subject = isLeader
      ? 'Your Number Hive leadership overview'
      : 'Welcome to Number Hive — let’s get your class playing';
    const body = isLeader
      ? [
          `${greeting}`,
          ``,
          `Thanks for requesting the Number Hive leadership overview. We’ll follow up shortly with a short pack you can share with your team.`,
          ``,
          `In the meantime, the demo you just walked through is at:`,
          `https://nh-demo3.vercel.app`,
          ``,
          `Reply to this email if you’d like to chat.`,
          ``,
          `— The Number Hive team`,
        ].join('\n')
      : [
          `${greeting}`,
          ``,
          `Thanks for signing up to try Number Hive with your class. We’ll be in touch shortly with everything you need to get your students playing in under 10 minutes.`,
          ``,
          `If you have any questions in the meantime, just reply to this email.`,
          ``,
          `— The Number Hive team`,
        ].join('\n');

    // Markdown-style links: [text](https://url) → "text (https://url)" in plain text,
    //                                              <a href="...">text</a> in HTML.
    // Bare URLs also auto-link in HTML.
    const mdLink = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
    const textBody = body.replace(mdLink, '$1 ($2)');
    const htmlBody = body
      .replace(mdLink, '<a href="$2">$1</a>')
      .replace(/(?<!href=")(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
      .replace(/\n/g, '<br>');

    await sgMail.send({
      to: email,
      from: { email: process.env.SENDGRID_FROM_EMAIL, name: 'Number Hive' },
      replyTo: process.env.SENDGRID_FROM_EMAIL,
      subject,
      text: textBody,
      html: htmlBody,
    });
    result.sendgrid = true;
  } catch (e) {
    console.error('[sendgrid]', e.message, e.response?.body);
  }

  // Always return 200 if we got the email — services can be retried server-side later if any failed.
  return res.status(200).json({ ok: true, result });
}
