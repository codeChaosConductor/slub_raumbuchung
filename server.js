const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { scheduleJobsFromFile, assignAndValidateBookings } = require('./scheduler');

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'room-booking-secure-key',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, httpOnly: true, maxAge: 24 * 60 * 60 * 1000 }
}));

const BOOKINGS_FILE = path.join(__dirname, 'bookings.json');
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');

// Simple master password for the dashboard control panel
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'admin123';

function isAuthenticated(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.status(401).json({ error: 'Unauthorized. Please log in.' });
}

// Dashboard login
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === DASHBOARD_PASSWORD) {
    req.session.authenticated = true;
    return res.json({ success: true });
  }
  res.status(401).json({ error: 'Invalid password.' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/session', (req, res) => {
  res.json({ loggedIn: !!(req.session && req.session.authenticated) });
});

// Get Accounts List (masks passwords for security)
app.get('/api/accounts', isAuthenticated, (req, res) => {
  if (!fs.existsSync(ACCOUNTS_FILE)) return res.json({});
  const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
  const safeAccounts = {};
  Object.keys(accounts).forEach(user => {
    safeAccounts[user] = '********';
  });
  res.json(safeAccounts);
});

// Add/Update a University Booking Account
app.post('/api/accounts', isAuthenticated, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });

  let accounts = fs.existsSync(ACCOUNTS_FILE) ? JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')) : {};
  accounts[username] = password;
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
  
  res.json({ success: true, message: `Account ${username} added successfully.` });
});

// Get Active Bookings
app.get('/api/bookings', isAuthenticated, (req, res) => {
  if (fs.existsSync(BOOKINGS_FILE)) {
    res.json(JSON.parse(fs.readFileSync(BOOKINGS_FILE, 'utf-8')));
  } else {
    res.json({});
  }
});

// Upload and Schedule Booking JSON with Multi-Account Distribution
app.post('/api/upload', isAuthenticated, upload.single('bookingFile'), (req, res) => {
  if (!req.file) return res.status(400).send('No file uploaded.');

  try {
    const rawBookings = JSON.parse(fs.readFileSync(req.file.path, 'utf8'));
    
    // Assign accounts automatically based on 4-hour daily quotas
    const processedBookings = assignAndValidateBookings(rawBookings);

    // Save combined bookings queue
    let existingBookings = fs.existsSync(BOOKINGS_FILE) ? JSON.parse(fs.readFileSync(BOOKINGS_FILE, 'utf8')) : {};
    const merged = { ...existingBookings, ...processedBookings };
    fs.writeFileSync(BOOKINGS_FILE, JSON.stringify(merged, null, 2));
    
    fs.unlinkSync(req.file.path);
    scheduleJobsFromFile(BOOKINGS_FILE);

    res.send({ status: 'Success', message: 'Booking file successfully processed and distributed across accounts.' });
  } catch (err) {
    fs.unlinkSync(req.file.path);
    res.status(400).json({ error: err.message || 'Invalid JSON format or quota exceeded across all accounts.' });
  }
});

app.use(express.static('public'));

if (fs.existsSync(BOOKINGS_FILE)) {
  scheduleJobsFromFile(BOOKINGS_FILE);
}

app.listen(3000, () => console.log('Multi-account booking system running on http://localhost:3000'));