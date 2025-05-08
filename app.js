const express = require('express');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

const session = require('express-session');

app.use(session({
    secret: 'your_super_secret_key_here', // Change this to something random!
    resave: false,
    saveUninitialized: true
}));


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
    res.sendFile(path.join(__dirname, 'views', 'home.html'));
});

const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'yourpassword'; // Change to something strong

// Login page
app.get('/login', (req, res) => {
    res.send(`
        <h2>Admin Login</h2>
        <form method="POST" action="/login">
            <input type="text" name="username" placeholder="Username" required><br>
            <input type="password" name="password" placeholder="Password" required><br>
            <button type="submit">Login</button>
        </form>
    `);
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
    res.sendFile(path.join(__dirname, 'views', 'admin.html'));
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
        const qrData = `http://agentqr.maltalanguagehub.com:3000/booking/${agentId}`; // QR will lead to this URL

        const qrPath = `public/qr_codes/agent_${safeName}_${agentId}.png`;

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
                fs.readFile(path.join(__dirname, 'views', 'agent_success.html'), 'utf8', (err, data) => {
                    if (err) {
                        return res.send('Error loading success page.');
                    }
                
                    let page = data
                        .replace('Agent Name', agentName)
                        .replace('0', commissionRate)
                        .replace('src=""', `src="/qr_codes/agent_${safeName}_${agentId}.png"`);
                
                    res.send(page);
                });
                
            });
        });
    });
});


// Route to show booking form based on agent QR code
app.get('/booking/:agentId', (req, res) => {
    const agentId = req.params.agentId;

    // Get the agent's name from the database
    db.get(`SELECT name FROM agents WHERE id = ?`, [agentId], (err, row) => {
        if (err || !row) {
            return res.send('Agent not found.');
        }

        // Read the booking form HTML
        fs.readFile(path.join(__dirname, 'views', 'booking.html'), 'utf8', (err, data) => {
            if (err) {
                return res.send('Error loading booking form.');
            }

            // Replace placeholders with actual values
            let page = data.replace('{{AGENT_ID}}', agentId);
            page = page.replace('Agent', row.name);

            res.send(page);
        });
    });
});

// Route to handle booking form submission
app.post('/submit-booking', (req, res) => {
    const {
        agentId, user_name, surname, contact_number, user_email,
        restaurant, course, accommodation, taxi_required,
        arrival_date, departure_date
    } = req.body;

    db.run(`INSERT INTO bookings (
                agent_id, user_name, surname, contact_number, user_email,
                restaurant, course, accommodation, taxi_required,
                arrival_date, departure_date
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            agentId, user_name, surname, contact_number, user_email,
            restaurant, course, accommodation, taxi_required,
            arrival_date, departure_date
        ],
        function (err) {
            if (err) {
                return res.send('Error saving booking.');
            }

            res.send(`
                <h2>Thank you, ${user_name}!</h2>
                <p>Your booking has been received.</p>
                <a href="/">Return to Home</a>
            `);
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

        fs.readFile(path.join(__dirname, 'views', 'bookings.html'), 'utf8', (err, data) => {
            if (err) {
                return res.send('Error loading bookings page.');
            }

            let rowsHtml = '';

            rows.forEach(row => {
                const bookingValue = 1000; // Still assuming €1000 booking value for now
                const agentCommission = ((row.commission_rate || 10) / 100) * bookingValue;
                const platformCommission = (platformCommissionRate / 100) * bookingValue;

                rowsHtml += `
                    <tr>
                        <td>${row.booking_id}</td>
                        <td>${row.agent_name}</td>
                        <td>${row.user_name}</td>
                        <td>${row.surname || ''}</td>
                        <td>${row.contact_number || ''}</td>
                        <td>${row.user_email}</td>
                        <td>${row.restaurant || ''}</td>
                        <td>${row.course}</td>
                        <td>${row.accommodation || 'None'}</td>
                        <td>${row.taxi_required || 'No'}</td>
                        <td>${row.arrival_date || ''}</td>
                        <td>${row.departure_date || ''}</td>
                        <td>€${agentCommission.toFixed(2)}</td>
                        <td>€${platformCommission.toFixed(2)}</td>
                    </tr>
                `;
            });

            const page = data.replace('{{BOOKINGS}}', rowsHtml);
            res.send(page);
        });
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

        fs.readFile(path.join(__dirname, 'views', 'agents.html'), 'utf8', (err, data) => {
            if (err) {
                return res.send('Error loading agents page.');
            }

            let rowsHtml = '';

            rows.forEach(row => {
                rowsHtml += `
                    <tr>
                        <td>${row.id}</td>
                        <td>${row.name}</td>
                        <td>${row.commission_rate}%</td>
                        <td><img src="${row.qr_code}" alt="QR Code" width="100"></td>
                    </tr>
                `;
            });

            const page = data.replace('{{AGENTS}}', rowsHtml);

            res.send(page);
        });
    });
});


// Start server
app.listen(3000, '0.0.0.0', () => {
    console.log('Server running on port 3000');
});

