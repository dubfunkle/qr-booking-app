// Cleaned-up and completed version of app.js
require('dotenv').config();

const express = require('express');
const app = express();
const PORT = 3000;
const BASE_URL = 'https://agentqr.maltalanguagehub.com';

const path = require('path');
const fs = require('fs');
const bodyParser = require('body-parser');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const QRCode = require('qrcode');
const nodemailer = require('nodemailer');
const stripe = require('./stripe');

const ADMIN_USERNAME = 'stv_admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Todayisafuckinggoodday!!!';
const platformCommissionRate = 5; // 5%

// Setup
app.set('view engine', 'ejs');
app.use('/qrcodes', express.static(path.join(__dirname, 'qrcodes')));
app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use('/webhook', bodyParser.raw({ type: 'application/json' }));
app.use(session({
    secret: process.env.SESSION_SECRET || 'supersecret',
    resave: false,
    saveUninitialized: true
}));

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD
    }
});

// Ensure qrcodes folder exists
const qrDir = path.join(__dirname, 'qrcodes');
if (!fs.existsSync(qrDir)) fs.mkdirSync(qrDir);

// DB setup
const db = new sqlite3.Database('./database.sqlite');
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS agents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        commission_rate REAL DEFAULT 10,
        qr_code TEXT,
        stripe_account_id TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS bookings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id INTEGER,
        user_name TEXT,
        surname TEXT,
        contact_number TEXT,
        user_email TEXT,
        restaurant TEXT,
        course TEXT,
        accommodation TEXT,
        taxi_required TEXT,
        arrival_date TEXT,
        departure_date TEXT,
        FOREIGN KEY(agent_id) REFERENCES agents(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS blackout_dates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT UNIQUE
    )`);
});

function requireAdmin(req, res, next) {
    if (req.session.isAdmin) return next();
    res.redirect('/login');
}

app.get('/', (req, res) => res.render('home'));
app.get('/login', (req, res) => res.render('login'));

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        req.session.isAdmin = true;
        res.redirect('/admin');
    } else {
        res.send('Invalid credentials. <a href="/login">Try again</a>.');
    }
});

app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

app.get('/admin', requireAdmin, (req, res) => res.render('admin'));

app.post('/add-agent', requireAdmin, (req, res) => {
    const agentName = req.body.name.trim();
    const commissionRate = parseFloat(req.body.commission_rate) || 10;
    const safeName = agentName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  
    db.run(`INSERT INTO agents (name, commission_rate) VALUES (?, ?)`, [agentName, commissionRate], function (err) {
      if (err) return res.send('Error saving agent to database.');
  
      const agentId = this.lastID;
      const qrData = `${BASE_URL}/booking/${agentId}`;
      const qrPath = path.join('qrcodes', `agent_${safeName}_${agentId}.png`);
  
      QRCode.toFile(qrPath, qrData, (err) => {
        if (err) return res.send('Error generating QR code.');
  
        db.run(`UPDATE agents SET qr_code = ? WHERE id = ?`, [qrPath, agentId], function (err) {
          if (err) return res.send('Error saving QR path to database.');
  
          res.render('agent_success', {
            agentName,
            commissionRate,
            qrCodeUrl: `/qrcodes/agent_${safeName}_${agentId}.png`
          });
        });
      });
    });
  });
  

app.get('/booking/:agentId/:locationCode', (req, res) => {
  const agentId = req.params.agentId;
  const locationCode = req.params.locationCode;

  db.get(`SELECT name FROM agents WHERE id = ?`, [agentId], (err, agent) => {
    if (err || !agent) return res.send('Agent not found.');

    db.get(`SELECT location_name FROM qr_locations WHERE location_code = ? AND agent_id = ?`, [locationCode, agentId], (err, location) => {
      if (err || !location) return res.send('Location not found or does not belong to this agent.');

      db.all(`SELECT date FROM blackout_dates`, [], (err, blackoutRows) => {
        const blackoutDates = blackoutRows.map(r => r.date);
        res.render('booking', {
          agentId,
          agentName: agent.name,
          locationName: location.location_name,
          locationCode,
          blackoutDates
        });
      });
    });
  });
});


app.post('/preview-booking', (req, res) => {
    const bookingData = req.body;
    const hiddenFields = Object.entries(bookingData).map(([k, v]) => `<input type="hidden" name="${k}" value="${v}">`).join('\n');
    res.render('confirm_booking', { ...bookingData, hiddenFields });
});

app.post('/submit-booking', (req, res) => {
    const data = req.body;
    res.render('thank_you', data);
});

app.post('/webhook', (req, res) => {
    console.log('✅ Stripe webhook hit');
  
    try {
      const event = req.body;
      console.log('📦 Event type:', event.type);
  
      if (event.type === 'checkout.session.completed') {
        const m = event.data.object.metadata;
        console.log('🎯 Received metadata:', m);
      
        // Make sure required fields exist
        if (!m || !m.user_email || !m.arrival_date) {
          console.log('⚠️ Metadata missing — skipping insert');
          return;
        }
      
        db.get(
          `SELECT COUNT(*) as count FROM bookings WHERE user_email = ? AND arrival_date = ?`,
          [m.user_email.trim(), m.arrival_date.trim()],
          (err, row) => {
            if (err) {
              console.error('❌ DB lookup error:', err.message);
              return;
            }
      
            if (row.count > 0) {
              console.log('⚠️ Duplicate booking detected — skipping insert');
              return;
            }
      
            db.run(
              `INSERT INTO bookings (
                agent_id, user_name, surname, contact_number, user_email,
                restaurant, course, accommodation, taxi_required,
                arrival_date, departure_date, location_code
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
              [
                m.agentId || 1,
                m.user_name?.trim(),
                m.surname?.trim(),
                m.contact_number?.trim(),
                m.user_email?.trim(),
                m.restaurant?.trim(),
                m.course?.trim(),
                m.accommodation?.trim(),
                m.taxi_required?.trim(),
                m.arrival_date?.trim(),
                m.departure_date?.trim()
              ],
              (err) => {
                if (err) {
                  console.error('❌ DB insert error:', err.message);
                } else {
                  console.log('✅ Booking saved to DB');
                  const emailHTML = `
                    <h2>Booking Confirmation</h2>
                    <p>Dear ${m.user_name?.trim()},</p>
                    <p>Thank you for booking through our agent platform.</p>
                    <ul>
                        <li><strong>Full Name:</strong> ${m.user_name?.trim()} ${m.surname?.trim()}</li>
                        <li><strong>Email:</strong> ${m.user_email?.trim()}</li>
                        <li><strong>Phone:</strong> ${m.contact_number?.trim()}</li>
                        <li><strong>Course:</strong> ${m.course?.trim()}</li>
                        <li><strong>Accommodation:</strong> ${m.accommodation?.trim()}</li>
                        <li><strong>Taxi Required:</strong> ${m.taxi_required?.trim()}</li>
                        <li><strong>Arrival Date:</strong> ${m.arrival_date?.trim()}</li>
                        <li><strong>Departure Date:</strong> ${m.departure_date?.trim()}</li>
                        <li><strong>Restaurant:</strong> ${m.restaurant?.trim()}</li>
                    </ul>
                    <p>We’ll be in touch soon with more details.</p>
                    `;

                    const schoolEmailHTML = `
                    <h2>New Booking Request</h2>
                    <p><strong>${m.user_name?.trim()} ${m.surname?.trim()}</strong> has just submitted a booking request.</p>
                    <ul>
                        <li><strong>Email:</strong> ${m.user_email?.trim()}</li>
                        <li><strong>Phone:</strong> ${m.contact_number?.trim()}</li>
                        <li><strong>Course:</strong> ${m.course?.trim()}</li>
                        <li><strong>Accommodation:</strong> ${m.accommodation?.trim()}</li>
                        <li><strong>Taxi Required:</strong> ${m.taxi_required?.trim()}</li>
                        <li><strong>Arrival Date:</strong> ${m.arrival_date?.trim()}</li>
                        <li><strong>Departure Date:</strong> ${m.departure_date?.trim()}</li>
                        <li><strong>Restaurant:</strong> ${m.restaurant?.trim()}</li>
                    </ul>
                    <p>Kindly follow up to arrange deposit and confirm the booking.</p>
                    `;

                    transporter.sendMail({
                    from: process.env.GMAIL_USER,
                    to: m.user_email?.trim(),
                    subject: 'Booking Confirmation – Malta Language Hub',
                    html: emailHTML
                    }, (err, info) => {
                    if (err) {
                        console.error('❌ Customer email error:', err.message);
                    } else {
                        console.log('✅ Confirmation email sent:', info.response);
                    }
                    });

                    transporter.sendMail({
                    from: process.env.GMAIL_USER,
                    to: 'maltalanguagehub@gmail.com',
                    subject: `New Booking Request – ${m.user_name?.trim()} ${m.surname?.trim()}`,
                    html: schoolEmailHTML
                    }, (err, info) => {
                    if (err) {
                        console.error('❌ School email error:', err.message);
                    } else {
                        console.log('✅ School notification sent:', info.response);
                    }
                    });
                }
                
              }
            );
          }
        );
      }    
      
      res.status(200).end();
    } catch (err) {
      console.error('❌ Webhook parsing error:', err.message);
      res.sendStatus(400);
    }
});
  
app.get('/admin/bookings', requireAdmin, (req, res) => {
    const query = `
        SELECT bookings.*, agents.name AS agent_name, agents.commission_rate
        FROM bookings
        LEFT JOIN agents ON bookings.agent_id = agents.id
    `;
    db.all(query, [], (err, rows) => {
        if (err) return res.send('Error retrieving bookings.');

        const bookingValue = 1000;
        const bookings = rows.map(row => ({
            ...row,
            agent_commission: ((row.commission_rate || 10) / 100) * bookingValue,
            platform_commission: (platformCommissionRate / 100) * bookingValue
        }));

        res.render('bookings', { bookings });
    });
});

app.get('/admin/agents', requireAdmin, (req, res) => {
    db.all(`SELECT id, name, commission_rate, qr_code FROM agents`, [], (err, rows) => {
        if (err) return res.send('Error retrieving agents.');
        res.render('agents', { agents: rows });
    });
});

app.post('/admin/review-blackout', requireAdmin, (req, res) => {
    const { start_date, end_date } = req.body;
    if (!start_date || !end_date) return res.send('Both dates required.');

    const start = new Date(start_date);
    const end = new Date(end_date);
    if (start > end) return res.send('Start date cannot be after end date.');

    const dates = [];
    let current = new Date(start);
    while (current <= end) {
        dates.push(current.toISOString().split('T')[0]);
        current.setDate(current.getDate() + 1);
    }

    res.render('review_blackout', { start_date, end_date, dates });
});


app.get('/admin/blackout', requireAdmin, (req, res) => {
    db.all(`SELECT id, date FROM blackout_dates ORDER BY date ASC`, [], (err, rows) => {
        if (err) return res.send('Error loading blackout dates.');
        res.render('blackout_form', { blackoutDates: rows });
    });
});

app.post('/admin/add-blackout', requireAdmin, (req, res) => {
    const { start_date, end_date } = req.body;
    if (!start_date || !end_date) return res.send('Both dates required.');

    const start = new Date(start_date);
    const end = new Date(end_date);
    if (start > end) return res.send('Start date cannot be after end date.');

    const stmt = db.prepare('INSERT OR IGNORE INTO blackout_dates (date) VALUES (?)');
    let current = new Date(start);
    while (current <= end) {
        stmt.run(current.toISOString().split('T')[0]);
        current.setDate(current.getDate() + 1);
    }
    stmt.finalize(() => res.redirect('/admin/blackout'));
});

app.post('/admin/remove-blackout', requireAdmin, (req, res) => {
    let ids = req.body.ids;
    if (!ids) return res.redirect('/admin/blackout');
    if (!Array.isArray(ids)) ids = [ids];

    const placeholders = ids.map(() => '?').join(',');
    db.run(`DELETE FROM blackout_dates WHERE id IN (${placeholders})`, ids, (err) => {
        if (err) return res.send('Error removing dates.');
        res.redirect('/admin/blackout');
    });
});

app.get('/admin/connect-agent/:agentId', requireAdmin, (req, res) => {
    const agentId = req.params.agentId;
    db.get(`SELECT name FROM agents WHERE id = ?`, [agentId], async (err, agent) => {
        if (err || !agent) return res.send('Agent not found.');

        try {
            const account = await stripe.accounts.create({ type: 'standard', country: 'MT' });
            db.run(`UPDATE agents SET stripe_account_id = ? WHERE id = ?`, [account.id, agentId]);
            const accountLink = await stripe.accountLinks.create({
                account: account.id,
                refresh_url: `${BASE_URL}/admin/connect-agent/${agentId}`,
                return_url: `${BASE_URL}/admin/agents`,
                type: 'account_onboarding'
            });
            res.redirect(accountLink.url);
        } catch (error) {
            console.error('Stripe error:', error.message);
            res.send(`Stripe error: ${error.message}`);
        }
    });
});

app.get('/pay/:agentId', async (req, res) => {
    const agentId = req.params.agentId;
    db.get(`SELECT name, stripe_account_id FROM agents WHERE id = ?`, [agentId], async (err, agent) => {
        if (err || !agent) return res.send('Agent not found.');

        try {
            const session = await stripe.checkout.sessions.create({
                payment_method_types: ['card'],
                line_items: [{
                    price_data: {
                        currency: 'eur',
                        product_data: { name: `Booking deposit – referred by ${agent.name}` },
                        unit_amount: 10000
                    },
                    quantity: 1
                }],
                mode: 'payment',
                success_url: `${BASE_URL}/success`,
                cancel_url: `${BASE_URL}/cancel`,
                metadata: {
                    ...req.query,
                    agentId
                  }                  
            }, {
                stripeAccount: agent.stripe_account_id
            });
            res.redirect(session.url);
        } catch (err) {
            console.error('❌ Stripe session creation error:', err.message);
            res.send('Failed to create Stripe Checkout session.');
        }
    });
});

app.get('/success', (req, res) => res.send('✅ Payment complete! Thank you.'));
app.get('/cancel', (req, res) => res.send('❌ Payment cancelled.'));

app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));