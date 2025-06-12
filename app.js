// Cleaned-up and completed version of app.js
require('dotenv').config();

const express = require('express');
const expressLayouts = require('express-ejs-layouts');

const app = express(); // ✅ move this up BEFORE any app.use()

app.use(expressLayouts); // ✅ now it works

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
app.set('layout', 'partials/layout');
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

app.get('/', (req, res) => res.render('home', { isHome: true }));

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

app.get('/admin', requireAdmin, (req, res) => {
  res.render('admin', {
    title: 'Add Agent',
    layout: 'partials/layout'
  });
});


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
        blackoutDates,
        title: 'Book Your Course',
        layout: 'partials/layout'
        });
      });
    });
  });
});


app.post('/preview-booking', (req, res) => {
  const bookingData = req.body;
  const hiddenFields = Object.entries(bookingData).map(([k, v]) => `<input type="hidden" name="${k}" value="${v}">`).join('\n');

  res.render('confirm_booking', {
    ...bookingData,
    hiddenFields,
    title: 'Confirm Your Booking',
    layout: 'partials/layout'
  });
});


app.post('/submit-booking', async (req, res) => {
  const data = req.body;

  const {
    user_name, surname, user_email, phone_prefix, contact_number,
    course, accommodation, taxi_required, arrival_date, departure_date,
    agentId, location_code, restaurant, payment_method
  } = data;

  console.log("📥 Payment Method:", payment_method);
  const fullPhone = `${phone_prefix}${contact_number}`;

  if (payment_method === 'cash') {
    db.run(`
      INSERT INTO bookings (
        agent_id, user_name, surname, contact_number, user_email,
        restaurant, course, accommodation, taxi_required,
        arrival_date, departure_date, location_code,
        payment_method, payment_status, confirmed_by_agent
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      agentId, user_name.trim(), surname.trim(), fullPhone.trim(), user_email.trim(),
      restaurant?.trim(), course?.trim(), accommodation?.trim(), taxi_required?.trim(),
      arrival_date.trim(), departure_date.trim(), location_code?.trim() || null,
      'cash', 'pending', 0
    ], (err) => {
      if (err) {
        console.error('❌ DB insert error for cash booking:', err.message);
        return res.send('Failed to save your booking. Please try again.');
      }

      return res.render('thank_you', {
        ...data,
        payment_method: 'cash',
        title: 'Booking Pending',
        layout: 'partials/layout'
      });
    });

  } else {
    try {
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'payment',
        success_url: `${req.protocol}://${req.get('host')}/thank_you?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${req.protocol}://${req.get('host')}/booking-cancelled`,
        line_items: [{
          price_data: {
            currency: 'eur',
            product_data: {
              name: 'English Language Booking'
            },
            unit_amount: 5000 // €50.00 in cents — adjust if needed
          },
          quantity: 1
        }],
        metadata: {
          agentId,
          user_name: user_name.trim(),
          surname: surname.trim(),
          user_email: user_email.trim(),
          contact_number: fullPhone.trim(),
          restaurant: restaurant?.trim() || '',
          course: course?.trim() || '',
          accommodation: accommodation?.trim() || '',
          taxi_required: taxi_required?.trim() || '',
          arrival_date: arrival_date.trim(),
          departure_date: departure_date.trim(),
          location_code: location_code?.trim() || ''
        }
      });

      res.redirect(303, session.url);
    } catch (err) {
      console.error("❌ Stripe session error:", err.message);
      res.send("Failed to redirect to Stripe.");
    }
  }
});



app.post('/webhook', (req, res) => {
      
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
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
                    m.departure_date?.trim(),
                    m.location_code?.trim() || null
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

const bcrypt = require('bcrypt');

// GET: Show login form
app.get('/agent/login', (req, res) => {
  res.render('agent_login', { title: 'Agent Login', error: null });
});

// POST: Handle login
app.post('/agent/login', (req, res) => {
  const { email, password } = req.body;

  db.get('SELECT * FROM agents WHERE email = ?', [email], (err, agent) => {
    if (err) {
      console.error('❌ DB error:', err.message);
      return res.render('agent_login', { title: 'Agent Login', error: 'Something went wrong' });
    }

    if (!agent) {
      return res.render('agent_login', { title: 'Agent Login', error: 'Email not found' });
    }

    bcrypt.compare(password, agent.password, (err, isMatch) => {
      if (err || !isMatch) {
        return res.render('agent_login', { title: 'Agent Login', error: 'Incorrect password' });
      }

      // Set agent session
      req.session.user = {
        id: agent.id,
        role: 'agent',
        name: agent.name,
        email: agent.email
      };

      res.redirect('/agent/dashboard');
    });
  });
});

// ✅ Real Agent Dashboard
app.get('/agent/dashboard', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'agent') {
    return res.redirect('/agent/login');
  }

  const agentId = req.session.user.id;

  db.all(`
    SELECT * FROM bookings
    WHERE agent_id = ? AND payment_method = 'cash'
    ORDER BY id DESC
  `, [agentId], (err, rows) => {
    if (err) {
      console.error("❌ Failed to load agent bookings:", err.message);
      return res.send("Error loading bookings");
    }

    res.render('agent_dashboard', {
      bookings: rows,
      agentName: req.session.user.name,
      title: 'Agent Dashboard',
      layout: 'partials/layout'
    });
  });
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

       res.render('bookings', {
        bookings: rows,
        user: req.session.user || { id: 0, role: 'admin' }, // fallback for now
        title: 'All Bookings',
          layout: 'partials/layout'
        });

    });
});

app.post('/admin/delete-bookings', requireAdmin, (req, res) => {
  let ids = req.body.ids;
  console.log("🧾 Bookings to delete:", ids);

  if (!ids) return res.redirect('/admin/bookings');

  if (!Array.isArray(ids)) ids = [ids]; // handles single checkbox selection

  const placeholders = ids.map(() => '?').join(',');
  const sql = `DELETE FROM bookings WHERE id IN (${placeholders})`;

  db.run(sql, ids, (err) => {
    if (err) {
      console.error('❌ Failed to delete bookings:', err.message);
      return res.send('Error deleting bookings.');
    }

    res.redirect('/admin/bookings');
  });
});


app.get('/admin/agents', requireAdmin, (req, res) => {
    app.get('/admin/agent/:agentId', requireAdmin, (req, res) => {
    const agentId = req.params.agentId;

    db.get(`SELECT * FROM agents WHERE id = ?`, [agentId], (err, agent) => {
        if (err || !agent) return res.send('Agent not found.');

        db.all(`SELECT * FROM qr_locations WHERE agent_id = ?`, [agentId], (err, locations) => {
            if (err) return res.send('Error retrieving locations.');

            res.render('agent', {
                agent,
                locations
            });
        });
    });
});

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
    res.render('blackout_form', {
      blackoutDates: rows,
      title: 'Manage Blackout Dates',
      layout: 'partials/layout'
    });
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

app.post('/admin/add-location', requireAdmin, (req, res) => {
  const { agent_id, location_name, location_code } = req.body;

  if (!agent_id || !location_name || !location_code) {
    return res.send("Missing required fields.");
  }

  const safeCode = location_code.toLowerCase().replace(/[^a-z0-9_]/g, '');
  const filename = `agent_${agent_id}_${safeCode}.png`;
  const filepath = path.join('qrcodes', filename);
  const qrUrl = `${BASE_URL}/booking/${agent_id}/${safeCode}`;

  // Generate QR image
  QRCode.toFile(filepath, qrUrl, (err) => {
    if (err) {
      console.error("QR code generation failed:", err.message);
      return res.send("Failed to generate QR code.");
    }

    // Insert into DB
    db.run(
      `INSERT INTO qr_locations (agent_id, location_name, location_code, qr_path) VALUES (?, ?, ?, ?)`,
      [agent_id, location_name.trim(), safeCode, filepath],
      function (err) {
        if (err) {
          console.error("Failed to save location:", err.message);
          return res.send("Database error while saving location.");
        }

        // Redirect to the agent's detail page
        res.redirect(`/admin/agent/${agent_id}`);
      }
    );
  });
});

app.post('/admin/delete-location', requireAdmin, (req, res) => {
  const { location_id, agent_id } = req.body;

  if (!location_id || !agent_id) {
    return res.send("Missing required fields.");
  }

  db.get(`SELECT qr_path FROM qr_locations WHERE id = ?`, [location_id], (err, row) => {
    if (err) return res.send("Error locating QR path.");
    
    // Delete file if exists
    if (row && row.qr_path) {
      const fullPath = path.join(__dirname, row.qr_path);
      if (fs.existsSync(fullPath)) {
        fs.unlink(fullPath, err => {
          if (err) console.warn("Failed to delete QR file:", err.message);
        });
      }
    }

    db.run(`DELETE FROM qr_locations WHERE id = ?`, [location_id], (err) => {
      if (err) return res.send("Error deleting location from database.");
      res.redirect(`/admin/agent/${agent_id}`);
    });
  });
});

app.post('/admin/delete-agent', requireAdmin, (req, res) => {
  const agentId = req.body.agent_id;
  if (!agentId) return res.send('Missing agent ID.');

  // Step 1: Check if agent has bookings
  db.get(`SELECT COUNT(*) AS count FROM bookings WHERE agent_id = ?`, [agentId], (err, row) => {
    if (err) return res.send('Error checking for bookings.');

      if (row.count > 0) {
    db.get(`SELECT name FROM agents WHERE id = ?`, [agentId], (err, agent) => {
      const agentName = agent?.name || 'Unknown';
      return res.render('cannot_delete_agent', {
        agentName,
        bookingCount: row.count
      });
    });
    return;
  }


    // Step 2: Proceed to delete QR files + locations + agent
    db.all(`SELECT qr_path FROM qr_locations WHERE agent_id = ?`, [agentId], (err, locations) => {
      if (err) return res.send('Failed to find agent locations.');

      // Delete QR files
      locations.forEach(loc => {
        if (loc.qr_path) {
          const fullPath = path.join(__dirname, loc.qr_path);
          if (fs.existsSync(fullPath)) {
            fs.unlink(fullPath, err => {
              if (err) console.warn('Could not delete QR file:', err.message);
            });
          }
        }
      });

      // Delete locations
      db.run(`DELETE FROM qr_locations WHERE agent_id = ?`, [agentId], (err) => {
        if (err) return res.send('Failed to delete locations.');

        // Delete agent
        db.run(`DELETE FROM agents WHERE id = ?`, [agentId], (err) => {
          if (err) return res.send('Failed to delete agent.');
          res.redirect('/admin/agents');
        });
      });
    });
  });
});

app.post('/admin/confirm-cash', requireAdmin, (req, res) => {
  const { booking_id } = req.body;

  if (!booking_id) return res.send("Missing booking ID");

  const timestamp = new Date().toISOString();

  db.run(`
    UPDATE bookings
    SET payment_status = 'paid',
        confirmed_by_agent = 1,
        confirmed_at = ?
    WHERE id = ?
  `, [timestamp, booking_id], (err) => {
    if (err) {
      console.error("❌ Failed to confirm payment:", err.message);
      return res.send("Error confirming payment.");
    }

    res.redirect('/admin/bookings');
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


app.use((err, req, res, next) => {
  console.error('❌ Uncaught Error:', err.stack);
  res.status(500).send('Something broke!');
});

app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));