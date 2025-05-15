require('dotenv').config();
app.use('/webhook', require('body-parser').raw({ type: 'application/json' }));

const stripe = require('./stripe');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const app = express();
app.set('view engine', 'ejs');
const PORT = 3000;
const BASE_URL = 'https://agentqr.maltalanguagehub.com';
const session = require('express-session');
const ADMIN_USERNAME = 'stv_admin';
const ADMIN_PASSWORD = 'Todayisafuckinggoodday!!!'; // Change to something strong

const nodemailer = require('nodemailer');
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'maltalanguagehub@gmail.com',          // Replace with your Gmail address
        pass: 'bgvw zrri gfrd wixr'        // Use App Password, not your real password
    }
});

const bodyParser = require('body-parser');
app.use('/webhook', bodyParser.raw({ type: 'application/json' }));

app.post('/webhook', async (req, res) => {
    const sig = req.headers['stripe-signature'];
  
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('❌ Webhook signature verification failed:', err.message);
      return res.sendStatus(400);
    }
  
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const meta = session.metadata;
  
      // Save booking to DB
      db.run(
        `INSERT INTO bookings (
          agent_id, user_name, surname, contact_number, user_email,
          restaurant, course, accommodation, taxi_required,
          arrival_date, departure_date
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          meta.agentId, meta.user_name, meta.surname, meta.contact_number, meta.user_email,
          meta.restaurant, meta.course, meta.accommodation, meta.taxi_required,
          meta.arrival_date, meta.departure_date
        ],
        function (err) {
          if (err) {
            console.error('❌ Error saving booking from webhook:', err);
          } else {
            console.log(`✅ Booking saved for ${meta.user_name} (${meta.user_email})`);
          }
        }
      );
    }
  
    res.status(200).end();
  });
  

// Ensure qrcodes folder exists
const qrDir = path.join(__dirname, 'qrcodes');
if (!fs.existsSync(qrDir)) {
    fs.mkdirSync(qrDir);
}


app.use(session({
    secret: 'your_super_secret_key_here', // Change this to something random!
    resave: false,
    saveUninitialized: true
}));

app.use('/qrcodes', express.static(path.join(__dirname, 'qrcodes')));

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// Database setup
const db = new sqlite3.Database('./database.sqlite');

// Create tables if not exist
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS agents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        qr_code TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS bookings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id INTEGER,
        user_name TEXT,
        user_email TEXT,
        course TEXT,
        start_date TEXT,
        FOREIGN KEY(agent_id) REFERENCES agents(id)
    )`);
});

// Home page for testing

app.get('/', (req, res) => {
    res.render('home');
});




// Login page
app.get('/login', (req, res) => {
    res.render('login');
});


// Handle login
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        req.session.isAdmin = true;
        res.redirect('/admin');
    } else {
        res.send('Invalid credentials. <a href="/login">Try again</a>.');
    }
});

// Logout
app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/login');
    });
});

function requireAdmin(req, res, next) {
    if (req.session.isAdmin) {
        next();
    } else {
        res.redirect('/login');
    }
}



// Route to show Admin form
app.get('/admin', requireAdmin, (req, res) => {
    res.render('admin');
});

// Route to handle new agent submission
app.post('/add-agent', (req, res) => {
    const agentName = req.body.name.trim();
    const commissionRate = parseFloat(req.body.commission_rate) || 10; // Default to 10% if empty

    const safeName = agentName.replace(/[^a-z0-9]/gi, '_').toLowerCase(); // Sanitize for filename

    // Insert the new agent into the database
    db.run(`INSERT INTO agents (name, commission_rate) VALUES (?, ?)`, [agentName, commissionRate], function (err) {
        if (err) {
            return res.send('Error saving agent to database.');
        }

        const agentId = this.lastID; // Get the ID of the inserted agent
        const qrData = `${BASE_URL}/booking/${agentId}`;// QR will lead to this URL
        const qrPath = path.join('qrcodes', `agent_${safeName}_${agentId}.png`);

        // Generate QR code
        QRCode.toFile(qrPath, qrData, function (err) {
            if (err) {
                return res.send('Error generating QR code.');
            }

            // Update agent with QR code path
            db.run(`UPDATE agents SET qr_code = ? WHERE id = ?`, [qrPath, agentId], function (err) {
                if (err) {
                    return res.send('Error saving QR code path to database.');
                }
                res.render('agent_success', {
                    agentName,
                    commissionRate,
                    qrCodeUrl: `/qrcodes/agent_${safeName}_${agentId}.png`
                });                
                
            });
        });
    });
});


// Route to show booking form based on agent QR code
app.get('/booking/:agentId', (req, res) => {
    const agentId = req.params.agentId;

    db.get(`SELECT name FROM agents WHERE id = ?`, [agentId], (err, row) => {
        if (err || !row) {
            return res.send('Agent not found.');
        }

        db.all(`SELECT date FROM blackout_dates`, [], (err, blackoutRows) => {
            const blackoutDates = blackoutRows.map(r => r.date); // array of strings: YYYY-MM-DD

            res.render('booking', {
                agentId,
                agentName: row.name,
                blackoutDates
            });
        });
    });
});



app.post('/preview-booking', (req, res) => {
    const bookingData = req.body;

    const hiddenFields = Object.keys(bookingData).map(key => {
        return `<input type="hidden" name="${key}" value="${bookingData[key]}">`;
    }).join('\n');
    
    res.render('confirm_booking', {
        ...bookingData,
        hiddenFields
    });
    
});

// Route to handle booking form submission
app.post('/submit-booking', (req, res) => {
    const {
      agentId, user_name, surname, contact_number, user_email,
      restaurant, course, accommodation, taxi_required,
      arrival_date, departure_date
    } = req.body;
  
    res.render('thank_you', {
      user_name, agentId, surname, contact_number, user_email,
      restaurant, course, accommodation, taxi_required,
      arrival_date, departure_date
    });
  });
  

// Email to the school
const schoolMail = {
    from: 'yourgmail@gmail.com',
    to: 'maltalanguagehub@gmail.com',
    subject: `New Booking Request – ${user_name} ${surname}`,
    html: `
      <h2>New Booking Request</h2>
      <p><strong>${user_name} ${surname}</strong> has just submitted a booking request through the QR app.</p>

      <ul>
        <li><strong>Email:</strong> ${user_email}</li>
        <li><strong>Phone:</strong> ${contact_number}</li>
        <li><strong>Restaurant:</strong> ${restaurant}</li>
        <li><strong>Course:</strong> ${course}</li>
        <li><strong>Accommodation:</strong> ${accommodation}</li>
        <li><strong>Taxi Required:</strong> ${taxi_required}</li>
        <li><strong>Arrival Date:</strong> ${arrival_date}</li>
        <li><strong>Departure Date:</strong> ${departure_date}</li>
      </ul>

      <p>Follow up with the customer to arrange deposit and confirm the booking.</p>
    `
};

// Send both
transporter.sendMail(customerMail, (err, info) => {
    if (err) console.error('Customer email error:', err);
    else console.log('Customer email sent:', info.response);
});

transporter.sendMail(schoolMail, (err, info) => {
    if (err) console.error('School email error:', err);
    else console.log('School email sent:', info.response);
});


            // ✅ Now show the thank you page
            res.render('thank_you', { user_name, agentId });
        });
});

function requireAdmin(req, res, next) {
    if (req.session.isAdmin) {
        next();
    } else {
        res.redirect('/login');
    }
}


// Define your platform (your) commission rate
const platformCommissionRate = 5; // 5%

app.get('/admin/bookings', requireAdmin, (req, res) => {

    const query = `
        SELECT bookings.id AS booking_id, agents.name AS agent_name, agents.commission_rate,
               user_name, surname, contact_number, user_email,
               restaurant, course, accommodation, taxi_required,
               arrival_date, departure_date
        FROM bookings
        LEFT JOIN agents ON bookings.agent_id = agents.id
    `;

    db.all(query, [], (err, rows) => {
        if (err) {
            return res.send('Error retrieving bookings.');
        }

        const bookingValue = 1000;
const bookings = rows.map(row => ({
    ...row,
    agent_commission: ((row.commission_rate || 10) / 100) * bookingValue,
    platform_commission: (platformCommissionRate / 100) * bookingValue
}));

res.render('bookings', { bookings });

    });
});

function requireAdmin(req, res, next) {
    if (req.session.isAdmin) {
        next();
    } else {
        res.redirect('/login');
    }
}

// Route to view all agents
app.get('/admin/agents', requireAdmin, (req, res) => {
    db.all(`SELECT id, name, commission_rate, qr_code FROM agents`, [], (err, rows) => {
        if (err) {
            return res.send('Error retrieving agents.');
        }

        res.render('agents', { agents: rows });

    });
});


// Start server
app.listen(3000, '0.0.0.0', () => {
    console.log('Server running on port 3000');
});

app.post('/webhook', async (req, res) => {
    const sig = req.headers['stripe-signature'];
  
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('❌ Webhook signature error:', err.message);
      return res.sendStatus(400);
    }
  
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const m = session.metadata;
  
      db.run(`INSERT INTO bookings (
        agent_id, user_name, surname, contact_number, user_email,
        restaurant, course, accommodation, taxi_required,
        arrival_date, departure_date
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        m.agentId, m.user_name, m.surname, m.contact_number, m.user_email,
        m.restaurant, m.course, m.accommodation, m.taxi_required,
        m.arrival_date, m.departure_date
      ], (err) => {
        if (err) {
          console.error('❌ Failed to save booking:', err.message);
          return;
        }
  
        // Send confirmation emails
        const emailHTML = `
          <h2>Booking Confirmation</h2>
          <p>Dear ${m.user_name},</p>
          <p>Thank you for your booking with AM Language. Here are your details:</p>
          <ul>
            <li><strong>Name:</strong> ${m.user_name} ${m.surname}</li>
            <li><strong>Email:</strong> ${m.user_email}</li>
            <li><strong>Phone:</strong> ${m.contact_number}</li>
            <li><strong>Restaurant:</strong> ${m.restaurant}</li>
            <li><strong>Course:</strong> ${m.course}</li>
            <li><strong>Accommodation:</strong> ${m.accommodation}</li>
            <li><strong>Taxi Required:</strong> ${m.taxi_required}</li>
            <li><strong>Arrival:</strong> ${m.arrival_date}</li>
            <li><strong>Departure:</strong> ${m.departure_date}</li>
          </ul>
          <p><strong>Note:</strong> Your deposit has been received.</p>
        `;
  
        transporter.sendMail({
          from: 'yourgmail@gmail.com',
          to: [m.user_email, 'maltalanguagehub@gmail.com'],
          subject: 'Booking Confirmed – AM Language',
          html: emailHTML
        }, (err, info) => {
          if (err) {
            console.error('❌ Email error:', err);
          } else {
            console.log('✅ Confirmation email sent:', info.response);
          }
        });
      });
    }
  
    res.status(200).end();
  });
  

// Show blackout date form

app.get('/admin/blackout', requireAdmin, (req, res) => {
    db.all(`SELECT id, date FROM blackout_dates ORDER BY date ASC`, [], (err, rows) => {
        if (err) {
            return res.send('Error loading blackout dates.');
        }

        res.render('blackout_form', {
            blackoutDates: rows
        });
    });
});


app.post('/admin/add-blackout', requireAdmin, (req, res) => {
    const { start_date, end_date } = req.body;

    if (!start_date || !end_date) {
        return res.send('Both start and end dates are required.');
    }

    const start = new Date(start_date);
    const end = new Date(end_date);

    if (start > end) {
        return res.send('Start date cannot be after end date.');
    }

    const stmt = db.prepare('INSERT OR IGNORE INTO blackout_dates (date) VALUES (?)');

    let current = new Date(start);
    while (current <= end) {
        const isoDate = current.toISOString().split('T')[0];
        stmt.run(isoDate);
        current.setDate(current.getDate() + 1);
    }

    stmt.finalize(() => {
        res.redirect('/admin/blackout');
    });
});

app.post('/admin/review-blackout', requireAdmin, (req, res) => {
    const { start_date, end_date } = req.body;

    if (!start_date || !end_date) {
        return res.send('Start and end date are required.');
    }

    const start = new Date(start_date);
    const end = new Date(end_date);

    if (start > end) {
        return res.send('Start date cannot be after end date.');
    }

    const dates = [];
    let current = new Date(start);
    while (current <= end) {
        dates.push(current.toISOString().split('T')[0]);
        current.setDate(current.getDate() + 1);
    }

    res.render('review_blackout', {
        start_date,
        end_date,
        dates
    });
});


app.post('/admin/remove-blackout', requireAdmin, (req, res) => {
    let ids = req.body.ids;

    if (!ids) return res.redirect('/admin/blackout');

    // Ensure it's always an array
    if (!Array.isArray(ids)) {
        ids = [ids];
    }

    const placeholders = ids.map(() => '?').join(',');
    db.run(`DELETE FROM blackout_dates WHERE id IN (${placeholders})`, ids, (err) => {
        if (err) {
            return res.send('Error removing dates.');
        }

        res.redirect('/admin/blackout');
    });
});

app.get('/admin/connect-agent/:agentId', requireAdmin, (req, res) => {
    const agentId = req.params.agentId;

    // Get the agent's name (optional, for redirect URL)
    db.get(`SELECT name FROM agents WHERE id = ?`, [agentId], async (err, agent) => {
        if (err || !agent) {
            return res.send('Agent not found.');
        }

        try {
            // Step 1: Create a connected Stripe account
            const account = await stripe.accounts.create({
                type: 'standard',
                country: 'MT',
            });

            // Step 2: Save account.id (Stripe account ID) to your DB
            db.run(`UPDATE agents SET stripe_account_id = ? WHERE id = ?`, [account.id, agentId], (err) => {
                if (err) return res.send('Error saving Stripe account ID.');
            });

            // Step 3: Create an onboarding link
            const accountLink = await stripe.accountLinks.create({
                account: account.id,
                refresh_url: `https://${req.headers.host}/admin/connect-agent/${agentId}`,
                return_url: `https://${req.headers.host}/admin/agents`,
                type: 'account_onboarding',
            });

            // Redirect to onboarding
            res.redirect(accountLink.url);
        } catch (error) {
            console.error('❌ Stripe error:', error.message);
            res.send(`Stripe connection error: ${error.message}`);
        }
        
    });
});

app.get('/pay/:agentId', async (req, res) => {
    const agentId = req.params.agentId;
  
    db.get(`SELECT name, stripe_account_id FROM agents WHERE id = ?`, [agentId], async (err, agent) => {
      if (err || !agent) {
        return res.send('Agent not found.');
      }
  
      try {
        const session = await stripe.checkout.sessions.create({
          payment_method_types: ['card'],
          line_items: [{
            price_data: {
              currency: 'eur',
              product_data: {
                name: `Booking deposit – referred by ${agent.name}`,
              },
              unit_amount: 10000,
            },
            quantity: 1,
          }],
          mode: 'payment',
          success_url: `https://${req.headers.host}/success`,
          cancel_url: `https://${req.headers.host}/cancel`,
          metadata: {
            agentId,
            user_name: req.query.user_name,
            surname: req.query.surname,
            contact_number: req.query.contact_number,
            user_email: req.query.user_email,
            restaurant: req.query.restaurant,
            course: req.query.course,
            accommodation: req.query.accommodation,
            taxi_required: req.query.taxi_required,
            arrival_date: req.query.arrival_date,
            departure_date: req.query.departure_date
          }
        }, {
          stripeAccount: agent.stripe_account_id
        });
  
        res.redirect(session.url);
      } catch (err) {
        console.error('Stripe error:', err);
        res.send('Failed to create Stripe Checkout session.');
      }
    });
  });
  


app.get('/success', (req, res) => {
    res.send('✅ Payment complete! Thank you.');
});

app.get('/cancel', (req, res) => {
    res.send('❌ Payment cancelled.');
});
