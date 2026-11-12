Here is a complete setup and operation guide in Markdown format. This covers how the system works, how to configure and run it on Linux as a persistent background service (or manually), and how to use the web interface.

---

# Room Booking Automation System — Setup & User Guide

This system provides a secure web interface to manage multiple university accounts, automatically splits large booking schedules across those accounts to bypass the 4-hour daily quota limit per account, and executes the exact reservation script via Headless Chromium (Playwright) at the precise millisecond required by your booking window.

---

## Part 1: Project Setup on Linux

### 1. Prerequisites

Ensure you have **Node.js** and **npm** installed on your Linux system.

```bash
sudo apt update
sudo apt install -y nodejs npm

```

### 2. Create Project Directory & Files

Create following additional files:
* **accounts.json**
´{}´
* **bookings.json**
´{}´

### 3. Install Dependencies

Navigate to your project directory and install all required modules (including Express, Playwright, Sessions, etc.):

```bash
cd /path/to/your/room-booking-system
npm install

```

### 4. Install Playwright Headless Browser Dependencies

Playwright requires system-level browser libraries to run headless Chromium smoothly:

```bash
npx playwright install-deps
npx playwright install chromium

```

---

## Part 2: Starting and Stopping the Service

### Option A: Running Manually (For Testing & Debugging)

To start the server directly in your terminal so you can view live execution logs:

```bash
npm start

```

* **Access URL:** Open your browser at `http://localhost:3000`
* **To Stop:** Press **`Ctrl + C`** in your terminal.

### Option B: Running as a Background Systemd Service (Recommended for Energy Efficiency & 24/7 Reliability)

To keep the scheduler running in the background even if you close your terminal or restart your Linux machine:

1. Create a systemd service file:
```bash
sudo nano /etc/systemd/system/room-booking.service

```


2. Paste the following configuration (adjust your username and absolute project path):
```ini
[Unit]
Description=Room Booking Automation Daemon
After=network.target

[Service]
Type=simple
User=your_linux_username
WorkingDirectory=/home/your_linux_username/dev/projects/slub_raumbuchung
ExecStart=/usr/bin/node server.js
Restart=always
Environment=NODE_ENV=production
Environment=DASHBOARD_PASSWORD="your_secure_dashboard_password"

[Install]
WantedBy=multi-user.target

```


3. Enable and start the service:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now room-booking

```



* **How to Check Status:** `sudo systemctl status room-booking`
* **How to Stop the Service:** `sudo systemctl stop room-booking`
* **How to Restart:** `sudo systemctl restart room-booking`

---

## Part 3: How to Use the System

### Step 1: Log Into the Dashboard

1. Open your browser and go to `http://localhost:3000`.
2. Enter your dashboard password (default is `admin123`, unless you set the `DASHBOARD_PASSWORD` environment variable).
3. Click **Unlock Dashboard**.

### Step 2: Add Your University Accounts

Because a single university account has a **4-hour booking limit per day**, this system uses a pool of accounts.

1. Under **1. Manage University Accounts**, input your university usernames/emails and passwords one by one.
2. Click **Add / Update Account**. They will appear in the table above. You can add as many accounts as you have to accommodate longer booking blocks.

### Step 3: Upload Your Booking JSON File

Prepare your standard JSON file matching your structure:

```json
{
  "11/24/2026": ["19:45", "11/24/2026", "21:00", "Gruppenraum 0.46", "Nachbereitung Vorlesung"]
}

```

*(Key: `mm/dd/yyyy` -> Value array: `[beginning time, ending date, ending time, roomname, title]`)*

1. Under **2. Upload Booking JSON File**, select your `.json` file.
2. Click **Upload & Auto-Schedule**.
3. **What happens behind the scenes:**
* The system reads your JSON and automatically calculates daily hours assigned to each account.
* If Account 1 hits its 4-hour maximum for that calendar day, it seamlessly shifts the next booking slot to Account 2.
* It creates active cron/timeout background timers in Node.js for every entry, calculating the exact target unlock timestamp (`end_time - 2 weeks - 4 hours`).



### Step 4: The Automated Execution Flow

When the timer hits the precise pre-flight window (1 minute before your booking window opens):

1. **Headless Login:** Playwright spins up a background browser instance, navigates to your booking site, and logs in using the assigned account credentials.
2. **Pre-fill Form:** It navigates to the target room and fills out the initial 15-minute slot form (`start_time` to `start_time + 15m`) using your custom DOM injection scripts.
3. **Exact-Time Trigger:** It sleeps until the exact millisecond the booking window opens, then fires the click. If server drift causes a block, it retries automatically up to 5 times.
4. **Rolling Extension:** Once the initial 15 minutes are secured, it enters an automated loop, waiting 15 minutes and pushing the rolling extension updates until your full desired end time is reached.
