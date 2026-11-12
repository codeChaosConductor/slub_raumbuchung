const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BOOKINGS_FILE = path.join(__dirname, 'bookings.json');
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');

// ==========================================
// TESTING CONFIGURATION
// Set to 'false' when running live in production!
const TEST_MODE = false; 
const TEST_EXTENSION_WAIT_MS = 5000; // 5 seconds instead of 15 minutes during testing
// ==========================================

// Helper to calculate target unlock time based on the FIRST 15-minute block
function parseBookingEntry(dateStartStr, timeStartStr, dateEndStr, timeEndStr, room, title, assignedUser) {
  const start = new Date(`${dateStartStr} ${timeStartStr}`);
  const end = new Date(`${dateEndStr} ${timeEndStr}`);
  
  const firstSegmentEnd = new Date(start.getTime() + (15 * 60 * 1000));
  const targetUnlockTime = new Date(firstSegmentEnd.getTime() - (14 * 24 * 60 * 60 * 1000) - (4 * 60 * 60 * 1000));
  
  return { start, end, room, title, assignedUser, targetUnlockTime };
}

// Distributes bookings across available accounts to respect the 4-hour daily limit per account
function assignAndValidateBookings(rawBookings) {
  if (!fs.existsSync(ACCOUNTS_FILE)) {
    throw new Error('No university accounts configured. Please add at least one account first.');
  }
  const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
  const accountUsernames = Object.keys(accounts);
  if (accountUsernames.length === 0) throw new Error('Account pool is empty.');

  const accountDailyMinutes = {}; 

  if (fs.existsSync(BOOKINGS_FILE)) {
    const existing = JSON.parse(fs.readFileSync(BOOKINGS_FILE, 'utf8'));
    Object.entries(existing).forEach(([dateStr, details]) => {
      const [startTime, , endTime, , , assignedUser] = details;
      if (assignedUser && accounts[assignedUser]) {
        const start = new Date(`${dateStr} ${startTime}`);
        const end = new Date(`${dateStr} ${endTime}`);
        const dayKey = start.toDateString();
        const duration = (end.getTime() - start.getTime()) / 60000;

        if (!accountDailyMinutes[assignedUser]) accountDailyMinutes[assignedUser] = {};
        accountDailyMinutes[assignedUser][dayKey] = (accountDailyMinutes[assignedUser][dayKey] || 0) + duration;
      }
    });
  }

  const assignedBookings = {};

  Object.entries(rawBookings).forEach(([startDateStr, details]) => {
    const [startTimeStr, endDateStr, endTimeStr, room, title] = details;
    const start = new Date(`${startDateStr} ${startTimeStr}`);
    const end = new Date(`${endDateStr} ${endTimeStr}`);
    const dayKey = start.toDateString();
    const durationMinutes = (end.getTime() - start.getTime()) / 60000;

    let selectedAccount = null;
    for (const username of accountUsernames) {
      if (!accountDailyMinutes[username]) accountDailyMinutes[username] = {};
      const currentDayMinutes = accountDailyMinutes[username][dayKey] || 0;

      if (currentDayMinutes + durationMinutes <= 240) {
        selectedAccount = username;
        accountDailyMinutes[username][dayKey] = currentDayMinutes + durationMinutes;
        break;
      }
    }

    if (!selectedAccount) {
      throw new Error(`Daily quota limit (4 hours per account) reached across all available accounts for date ${startDateStr}. Add more accounts to book more.`);
    }

    assignedBookings[startDateStr] = [startTimeStr, endDateStr, endTimeStr, room, title, selectedAccount];
  });

  return assignedBookings;
}

async function runBookingAttempt(job) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
  const password = accounts[job.assignedUser];

  try {
    console.log(`[${new Date().toISOString()}] Logging in with account ${job.assignedUser} for room ${job.room}...`);
    await page.goto('https://raumbuchung.slub-dresden.de/Web/index.php', { waitUntil: 'domcontentloaded' });

    // 1. Wait for initial login button and safely navigate to SSO using Promise.all
    await page.waitForSelector('button.btn.btn-large.btn-primary.btn-block', { timeout: 15000 });
    await Promise.all([
      page.waitForURL(/sso|login|tu-dresden|shibboleth/i, { timeout: 20000 }),
      page.click('button.btn.btn-large.btn-primary.btn-block')
    ]);

    // 2. Wait for the SSO username/password fields to render
    await page.waitForSelector('#txtUsername', { timeout: 20000 });
    await page.fill('#txtUsername', job.assignedUser);
    await page.fill('#txtPassword', password);

    // 3. Submit credentials and wait for navigation back to SLUB domain
    await Promise.all([
      page.waitForURL(/raumbuchung\.slub-dresden\.de/i, { timeout: 25000 }),
      page.click('#btnLogin')
    ]);

    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('#schedules', { timeout: 20000 });

    // Switch view options using native Playwright locators to properly trigger event handlers
    console.log("Adjusting schedule view settings...");

    // 1. Select the schedule dropdown option
    await page.locator('#schedules').selectOption('1');
    await page.waitForTimeout(1000);

    // 2. Make visible-days container visible via JS, then select value '1'
    await page.evaluate(() => {
      const selectionDiv = document.getElementById('visible-days-selection');
      if (selectionDiv) selectionDiv.classList.remove('no-show');
    });
    await page.locator('#visible-days-select').selectOption('1');
    await page.waitForTimeout(1000);

    // 3. Click the schedule style dropdown toggle button
    await page.locator('#schedule-display-toggle').click();
    await page.waitForTimeout(500);

    // 4. Click the 'Week View' (data-schedule-display="3") option from the menu
    await page.locator('button.dropdown-item.schedule-style[data-schedule-display="3"]').click();
    
    // Final settling pause to let the calendar grid fully render
    await page.waitForTimeout(2000);

    await page.waitForSelector('tr.slots', { timeout: 15000 });

    const roomFound = await page.evaluate((roomName) => {
      const rows = document.querySelectorAll('tr.slots');
      for (const row of rows) {
        const resEl = row.querySelector('.resourcename');
        if (resEl && resEl.textContent.trim().includes(roomName)) {
          const btn = row.querySelector('.reservable');
          if (btn) { btn.click(); return true; }
        }
      }
      return false;
    }, job.room);

    if (!roomFound) throw new Error(`Room ${job.room} not available.`);

    await page.waitForSelector('#reservation-title', { timeout: 15000 });

    const initialEndTime = new Date(job.start.getTime() + 15 * 60000);
    const formatDate = (d) => `${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getDate().toString().padStart(2, '0')}/${d.getFullYear()}`;
    const formatTime = (d) => `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;

    // Fill out reservation form using the robust tested JavaScript helper
    await page.evaluate(async (jobTitle) => {
      const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

      async function forceSetInputValue(selectorOrId, value, options = {}) {
        const el = document.getElementById(selectorOrId) || 
                   document.getElementById(selectorOrId.replace('#', '')) || 
                   document.querySelector(selectorOrId);
        
        if (!el) {
          console.warn(`Element "${selectorOrId}" not found.`);
          return false;
        }

        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await wait(50);
        
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        el.focus();
        await wait(50);

        const tagName = el.tagName.toLowerCase();
        let proto = window.HTMLInputElement.prototype;
        if (tagName === 'textarea') {
          proto = window.HTMLTextAreaElement.prototype;
        } else if (tagName === 'select') {
          proto = window.HTMLSelectElement.prototype;
        }

        const tracker = el._valueTracker;
        if (tracker) {
          tracker.setValue(''); 
        }

        const nativeValueSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (nativeValueSetter) {
          nativeValueSetter.call(el, value);
        } else {
          el.value = value;
        }

        el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: value }));
        el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: value }));
        el.dispatchEvent(new Event('change', { bubbles: true }));

        const isCombobox = el.getAttribute('role') === 'combobox' || options.combobox || tagName === 'select';
        
        if (isCombobox) {
          el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true }));
          await wait(50);
          el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
        } else {
          el.blur();
          el.dispatchEvent(new FocusEvent('focusout', { bubbles: true, cancelable: true }));
        }

        console.log(`Successfully forced value on "${selectorOrId}" to: "${value}"`);
        return true;
      }

      const titleElementId = 'reservation-title';
      const verwendungszweckElementId = Array.from(document.querySelectorAll('label')).find(l => l.textContent.includes('Verwendungszweck'))?.getAttribute('for');
      const personenanzahlElementId = Array.from(document.querySelectorAll('label')).find(l => l.textContent.includes('Personenanzahl'))?.getAttribute('for');

      // 1. Set Title
      await forceSetInputValue(titleElementId, jobTitle);
      await wait(300);

      // 2. Set Verwendungszweck (Textarea)
      if (verwendungszweckElementId) {
        await forceSetInputValue(verwendungszweckElementId, jobTitle);
        await wait(300);
      } else {
        console.warn('Verwendungszweck element not found.');
      }

      // 3. Set Personenanzahl
      if (personenanzahlElementId) {
        await forceSetInputValue(personenanzahlElementId, '6', { combobox: true });
        await wait(300);
      }

      // 4. Set Description
      const descEl = document.getElementById('reservation-description');
      if (descEl) {
        await forceSetInputValue('reservation-description', jobTitle);
        await wait(300);
      }

      // 5. Click Terms Checkbox last
      const termsCheckbox = document.getElementById('reservation-terms-checkbox');
      if (termsCheckbox) {
        termsCheckbox.click();
        await wait(300);
      } else {
        console.warn('Terms checkbox not found.');
      }

      console.log('Form filling sequence completed.');
    }, job.title);

    // Set Start and End schedule dates and times using the tested helper
    await page.evaluate(async ({ startDate, startTime, endDate, endTime }) => {
      const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

      async function forceSetInputValue(selectorOrId, value, options = {}) {
        const el = document.getElementById(selectorOrId) || 
                   document.getElementById(selectorOrId.replace('#', '')) || 
                   document.querySelector(selectorOrId);
        
        if (!el) {
          console.warn(`Element "${selectorOrId}" not found.`);
          return false;
        }

        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await wait(50);
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        el.focus();
        await wait(50);

        const tagName = el.tagName.toLowerCase();
        let proto = window.HTMLInputElement.prototype;
        if (tagName === 'textarea') {
          proto = window.HTMLTextAreaElement.prototype;
        } else if (tagName === 'select') {
          proto = window.HTMLSelectElement.prototype;
        }

        const tracker = el._valueTracker;
        if (tracker) {
          tracker.setValue(''); 
        }

        const nativeValueSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (nativeValueSetter) {
          nativeValueSetter.call(el, value);
        } else {
          el.value = value;
        }

        el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: value }));
        el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: value }));
        el.dispatchEvent(new Event('change', { bubbles: true }));

        const isCombobox = el.getAttribute('role') === 'combobox' || options.combobox || tagName === 'select';
        
        if (isCombobox) {
          el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true }));
          await wait(50);
          el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
        } else {
          el.blur();
          el.dispatchEvent(new FocusEvent('focusout', { bubbles: true, cancelable: true }));
        }

        console.log(`Successfully forced value on "${selectorOrId}" to: "${value}"`);
        return true;
      }

      if (startDate) {
        await forceSetInputValue('reservation-start-date', startDate);
        await wait(300);
      }
      if (startTime) {
        await forceSetInputValue('reservation-start-time', startTime, { combobox: true });
        await wait(300);
      }
      if (endDate) {
        await forceSetInputValue('reservation-end-date', endDate);
        await wait(300);
      }
      if (endTime) {
        await forceSetInputValue('reservation-end-time', endTime, { combobox: true });
        await wait(300);
      }

      console.log('Schedule filling sequence completed.');
    }, {
      startDate: formatDate(job.start),
      startTime: formatTime(job.start),
      endDate: formatDate(initialEndTime),
      endTime: formatTime(initialEndTime)
    });

    // Handle unlock window timing
    if (TEST_MODE) {
      console.log(`[TEST_MODE] Bypassing target unlock time. Proceeding to book immediately...`);
    } else {
      const delay = job.targetUnlockTime.getTime() - Date.now();
      if (delay > 0) await page.waitForTimeout(delay);
    }

    let success = false, attempts = 0;
    while (!success && attempts < 5) {
      attempts++;
      await page.evaluate(() => {
        const btn = document.getElementsByClassName('btn btn-primary')[0];
        if (btn) btn.click();
      });
      await page.waitForTimeout(1200);

      const hasWarning = await page.evaluate(() => {
        const warnBtn = document.getElementsByClassName('btn btn-warning')[0];
        if (warnBtn) { warnBtn.click(); return true; }
        return false;
      });

      if (!hasWarning) success = true;
      else await page.waitForTimeout(1000);
    }

    if (!success) throw new Error(`Failed to secure initial slot.`);
    console.log(`[Success] Initial 15-min slot secured!`);

    // Rolling extension loop
    let currentEndTime = initialEndTime;
    while (currentEndTime < job.end) {
      const waitTime = TEST_MODE ? TEST_EXTENSION_WAIT_MS : 15 * 60 * 1000;
      console.log(`Waiting ${waitTime / 1000}s before extending next 15-min block...`);
      await page.waitForTimeout(waitTime);

      currentEndTime = new Date(currentEndTime.getTime() + 15 * 60000);
      const nextEndTimeStr = formatTime(currentEndTime);

      await page.evaluate(({ endTime }) => {
        const el = document.getElementById('reservation-end-time');
        if (el) { el.value = endTime; el.dispatchEvent(new Event('change', { bubbles: true })); }
        const btn = document.getElementsByClassName('btn btn-primary')[0];
        if (btn) btn.click();
      }, { endTime: nextEndTimeStr });

      console.log(`Extended booking to ${nextEndTimeStr}`);
      await page.waitForTimeout(2000);
    }
    console.log(`[Complete] Entire booking slot successfully booked and extended!`);
  } catch (err) {
    console.error(`[Error] Booking failed for ${job.assignedUser}: ${err.message}`);
  } finally {
    if (TEST_MODE) await page.waitForTimeout(10000);
    await browser.close();
  }
}

function scheduleJobsFromFile(jsonPath) {
  if (!fs.existsSync(jsonPath)) return;
  const rawData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

  Object.entries(rawData).forEach(([startDateStr, details]) => {
    const [startTimeStr, endDateStr, endTimeStr, room, title, assignedUser] = details;
    const job = parseBookingEntry(startDateStr, startTimeStr, endDateStr, endTimeStr, room, title, assignedUser);
    
    if (TEST_MODE) {
      console.log(`[TEST_MODE] Triggering job immediately without pre-flight timer.`);
      runBookingAttempt(job);
    } else {
      const preFlightTime = job.targetUnlockTime.getTime() - (60 * 1000);
      const msUntilPreFlight = preFlightTime - Date.now();
      if (msUntilPreFlight > 0) {
        setTimeout(() => runBookingAttempt(job), msUntilPreFlight);
      }
    }
  });
}

module.exports = { scheduleJobsFromFile, assignAndValidateBookings };
