import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../airport-kiosk-prototype/index.html', import.meta.url), 'utf8');
const script = html.split('<script>')[1]?.split('</script>')[0];
assert.ok(script, 'The kiosk script should be inside index.html');

let now = 0;
let intervalTick;
class TestDate extends Date {
  static now() { return now; }
}
const browser = {
  Date: TestDate,
  setTimeout: callback => { callback(); return 1; },
  clearTimeout: () => {},
  setInterval: callback => { intervalTick = callback; return 1; },
  clearInterval: () => {}
};
vm.createContext(browser);
vm.runInContext(
  script.split('const ui=new KioskUI();')[0] +
  '\n globalThis.kiosk = { FlightSearchController, BookingController, SmartGateController, PassportScannerInterface, NLPAssistantController, KioskUI };',
  browser
);
browser.ui = { locale: 'en' };
const { FlightSearchController, BookingController, SmartGateController, PassportScannerInterface, NLPAssistantController, KioskUI } = browser.kiosk;

test('flight search accepts a spaced flight number and reports failures', async () => {
  const calls = [];
  const events = [];
  const search = new FlightSearchController({
    queryFlight: async (number, timeout) => {
      calls.push([number, timeout]);
      if (timeout) throw new Error('AFIS_TIMEOUT');
      return number === 'EK203' ? { no: number } : null;
    }
  }, code => events.push(code));

  assert.equal((await search.searchFlight(' ek 203 ', false)).no, 'EK203');
  assert.equal(calls[0][0], 'EK203');
  await assert.rejects(search.searchFlight('wrong', false), /INVALID_FLIGHT/);
  await assert.rejects(search.searchFlight('EK999', false), /FLIGHT_NOT_FOUND/);
  await assert.rejects(search.searchFlight('EK203', true), /AFIS_TIMEOUT/);
  assert.deepEqual(events, ['FLIGHT_FOUND', 'FLIGHT_INVALID', 'FLIGHT_NOT_FOUND', 'AFIS_TIMEOUT']);
});

test('booking lookup matches the demo passenger and clears scanned passport data', async () => {
  const events = [];
  let cleared = 0;
  const scanner = {
    scanMRZ: async () => ({ profile: 'eligible' }),
    scanNFC: async () => ({}),
    clearBuffer: () => { cleared++; }
  };
  const booking = new BookingController({
    lookupBooking: async input => input.pnr === 'DXB482' && input.last === 'FERAS' || input.passportPnr === 'DXB482'
      ? { passenger: 'Tawfiq Feras' } : null
  }, scanner, {}, code => events.push(code));

  assert.equal((await booking.lookupBooking(' dxb482 ', ' feras ')).passenger, 'Tawfiq Feras');
  assert.equal(await booking.lookupBooking('DXB482', 'HAMAD'), null);
  assert.equal((await booking.lookupFromPassport('eligible')).passenger, 'Tawfiq Feras');
  assert.equal(cleared, 1);
  assert.ok(events.includes('PASSPORT_PURGED'));
});

test('passport memory clears automatically after ten seconds', async () => {
  now = 0;
  let purges = 0;
  const scanner = new PassportScannerInterface(() => {}, () => { purges++; });
  await scanner.scanMRZ('eligible');
  assert.ok(scanner.buffer);
  now = 9999;
  intervalTick();
  assert.ok(scanner.buffer);
  now = 10000;
  intervalTick();
  assert.equal(scanner.buffer, null);
  assert.equal(purges, 1);
});

test('Smart Gate rejects an ineligible passport and stops after three read failures', async () => {
  let cleared = 0;
  const gate = new SmartGateController({
    scanMRZ: async () => ({ profile: 'expired' }),
    scanNFC: async () => ({}),
    clearBuffer: () => { cleared++; }
  }, { submitToSGRS: async () => ({ approved: false }) }, () => {});
  assert.equal((await gate.register('expired')).approved, false);
  assert.equal(cleared, 1);

  const state = {
    smartBusy: false, smartResult: null, smartAttempts: 0, smartMessage: '',
    smartProfile: 'unreadable', smartController: { register: async () => { throw new Error('SCAN_READ_FAILURE'); } },
    render: () => {}, announce: () => {}, log: () => {}
  };
  for (let attempt = 0; attempt < 3; attempt++) await KioskUI.prototype.smartScan.call(state);
  assert.equal(state.smartAttempts, 3);
  assert.equal(state.smartMessage, 'scanStop');
  await KioskUI.prototype.smartScan.call(state);
  assert.equal(state.smartAttempts, 3);
});

test('Travel help answers sample flight and booking questions offline', () => {
  const help = new NLPAssistantController(() => [], () => {});
  const flight = help.classify('What is the status of EK203?');
  assert.equal(flight.kind, 'flight');
  assert.match(help.response(flight), /Gate A7/);
  assert.match(help.response(help.classify('How do I find my booking?')), /FERAS/);
  assert.equal(help.classify('Write a poem').kind, 'fallback');
});

test('home guide links to the demo screens in both languages', () => {
  const home = { flightTable: () => '' };
  browser.ui.locale = 'en';
  const english = KioskUI.prototype.home.call(home);
  assert.match(english, /Try the main steps/);
  assert.match(english, /DXB482 and FERAS/);
  assert.match(english, /data-nav="booking"/);

  browser.ui.locale = 'ar';
  const arabic = KioskUI.prototype.home.call(home);
  assert.match(arabic, /جرّب الخطوات الأساسية/);
  assert.match(arabic, /data-nav="smart"/);
  browser.ui.locale = 'en';
});

test('dialog keeps keyboard focus inside and returns it when closed', () => {
  let focused = '';
  const opener = { isConnected: true, focus: () => { focused = 'opener'; } };
  const first = { focus: () => { focused = 'first'; } };
  const last = { focus: () => { focused = 'last'; } };
  browser.document = {
    activeElement: opener,
    querySelectorAll: () => [first, last]
  };
  const dialog = { modal: null, returnFocus: null, renderModal: () => {} };
  KioskUI.prototype.openModal.call(dialog, 'login');
  assert.equal(dialog.modal, 'login');
  assert.equal(dialog.returnFocus, opener);

  browser.document.activeElement = first;
  let prevented = false;
  KioskUI.prototype.trapModalFocus.call(dialog, { shiftKey: true, preventDefault: () => { prevented = true; } });
  assert.ok(prevented);
  assert.equal(focused, 'last');

  browser.document.activeElement = last;
  KioskUI.prototype.trapModalFocus.call(dialog, { shiftKey: false, preventDefault: () => {} });
  assert.equal(focused, 'first');

  KioskUI.prototype.closeModal.call(dialog);
  assert.equal(dialog.modal, null);
  assert.equal(focused, 'opener');
});

test('map marks the selected gate and keeps it focused after selection', async () => {
  const map = {
    mapSelection: 'A7', locale: 'en',
    mapPoints: KioskUI.prototype.mapPoints,
    mapRoute: KioskUI.prototype.mapRoute,
    heading: () => ''
  };
  assert.match(KioskUI.prototype.mapPage.call(map), /data-map-select="A7"[^>]*aria-pressed="true"/);

  let focused = false;
  browser.document = { querySelector: () => ({ focus: () => { focused = true; } }) };
  const click = {
    target: {
      matches: () => false,
      closest: () => ({ dataset: { mapSelect: 'B4' }, tagName: 'g' })
    }
  };
  const state = { mapSelection: 'A7', render: () => {} };
  await KioskUI.prototype.handleClick.call(state, click);
  assert.equal(state.mapSelection, 'B4');
  assert.ok(focused);
});

test('reset demo clears the session but keeps saved FAQs and language', () => {
  let cleared = 0;
  let page = '';
  const savedFaq = [{ questionEn: 'Where is the desk?' }];
  const state = {
    scanner: { clearBuffer: () => { cleared++; } },
    locale: 'ar', faq: savedFaq, admin: true,
    flightResult: { no: 'EK203' }, booking: { passenger: 'Tawfiq Feras' },
    smartAttempts: 3, chatMessages: [{ text: 'hello' }],
    logs: [{ code: 'TEST' }], latencies: [400],
    navigate: next => { page = next; }, announce: () => {}
  };
  KioskUI.prototype.resetDemo.call(state);
  assert.equal(cleared, 1);
  assert.equal(page, 'home');
  assert.equal(state.flightResult, null);
  assert.equal(state.booking, null);
  assert.equal(state.smartAttempts, 0);
  assert.equal(state.chatMessages.length, 0);
  assert.equal(state.logs.length, 0);
  assert.equal(state.admin, false);
  assert.equal(state.locale, 'ar');
  assert.equal(state.faq, savedFaq);
});
