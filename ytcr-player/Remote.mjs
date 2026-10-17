// IR remote: any spare TV/DVD remote, through a USB-UIRT receiver.
//
// uirt-read.py prints one code per button press; each code is looked up in
// the button assignments (DATA_DIR/remote.json) and run as a Control.mjs
// command, so the remote does exactly what the control page does. Buttons
// are taught from the control page: pick an action, press the button.
//
// Off unless YTCR_REMOTE_DEVICE names the USB-UIRT (e.g. /dev/usb-uirt).
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { control } from './Control.mjs';

// What a button can do: label for the page, and the Control.mjs command.
export const REMOTE_ACTIONS = {
  'play-pause': { label: 'Play / pause', action: 'play-pause' },
  next: { label: 'Next', action: 'next' },
  previous: { label: 'Previous', action: 'previous' },
  'volume-up': { label: 'Volume up', action: 'volume', query: 'step=5', repeat: true },
  'volume-down': { label: 'Volume down', action: 'volume', query: 'step=-5', repeat: true },
  mute: { label: 'Mute', action: 'mute' },
  loop: { label: 'Loop', action: 'loop' }
};

// A held button may resend its code. Volume follows the hold (at most this
// often); everything else needs a release (this much quiet) before it counts again.
const REPEAT_MS = 150;
const RELEASE_MS = 400;
const LEARN_MS = 15000;
const RESTART_MS = 5000;

export default class Remote {
  #player;
  #device;
  #file;
  #logger;
  #buttons = {}; // code -> action key
  #learning = null; // { key, until }
  #lastCode = null;
  #lastAt = 0;
  #lastRun = 0;
  #connected = false;

  constructor(player, { device, file, logger }) {
    this.#player = player;
    this.#device = device;
    this.#file = file;
    this.#logger = logger;
  }

  async start() {
    try {
      this.#buttons = JSON.parse(await readFile(this.#file, 'utf8'));
    }
    catch {
      this.#buttons = {};
    }
    this.#run();
  }

  #run() {
    const reader = spawn('python3', [ new URL('./uirt-read.py', import.meta.url).pathname, this.#device ],
      { stdio: [ 'ignore', 'pipe', 'pipe' ] });
    let errText = '';
    reader.stderr.on('data', (d) => { errText += String(d); });
    createInterface({ input: reader.stdout }).on('line', (line) => void this.#onCode(line.trim()));
    reader.on('spawn', () => {
      this.#connected = true;
      this.#logger.info(`[remote] listening on ${this.#device}`);
    });
    reader.on('exit', (code) => {
      this.#connected = false;
      const why = errText.trim().split('\n').pop() || `exit ${code}`;
      this.#logger.warn(`[remote] receiver stopped (${why}); retrying in ${RESTART_MS / 1000}s`);
      setTimeout(() => this.#run(), RESTART_MS);
    });
  }

  async #onCode(code) {
    if (!/^[0-9a-f]+$/.test(code)) return;
    const now = Date.now();
    const repeat = code === this.#lastCode && now - this.#lastAt < RELEASE_MS;
    this.#lastCode = code;
    this.#lastAt = now;

    if (this.#learning && now < this.#learning.until) {
      if (repeat) return;
      const key = this.#learning.key;
      this.#learning = null;
      // One button, one action: drop any other action this code had.
      this.#buttons[code] = key;
      await this.#save();
      this.#logger.info(`[remote] taught ${code} = ${key}`);
      return;
    }

    const key = this.#buttons[code];
    const def = key && REMOTE_ACTIONS[key];
    if (!def) {
      if (!repeat) this.#logger.info(`[remote] unassigned button ${code}`);
      return;
    }
    if (repeat && (!def.repeat || now - this.#lastRun < REPEAT_MS)) return;
    this.#lastRun = now;
    try {
      const ok = await control(this.#player, def.action, new URLSearchParams(def.query || ''));
      this.#logger.info(`[remote] ${key} -> ${ok ? 'ok' : 'no effect'}`);
    }
    catch (error) {
      this.#logger.warn(`[remote] ${key} failed: ${error?.message || error}`);
    }
  }

  async #save() {
    await writeFile(this.#file, JSON.stringify(this.#buttons, null, 2));
  }

  // --- For the control page (/api/remote) ----------------------------------

  state() {
    const assigned = {};
    for (const [ code, key ] of Object.entries(this.#buttons)) (assigned[key] ||= []).push(code);
    return {
      connected: this.#connected,
      learning: this.#learning && Date.now() < this.#learning.until ? this.#learning.key : null,
      actions: Object.entries(REMOTE_ACTIONS).map(([ key, def ]) => ({
        key, label: def.label, buttons: (assigned[key] || []).length
      }))
    };
  }

  // Next button pressed (within LEARN_MS) is assigned to `key`.
  learn(key) {
    if (!REMOTE_ACTIONS[key]) throw new Error(`unknown remote action "${key}"`);
    this.#learning = { key, until: Date.now() + LEARN_MS };
    this.#logger.info(`[remote] press a button for ${key}`);
  }

  cancelLearn() {
    this.#learning = null;
  }

  async clear(key) {
    for (const [ code, k ] of Object.entries(this.#buttons)) if (k === key) delete this.#buttons[code];
    await this.#save();
    this.#logger.info(`[remote] cleared ${key}`);
  }
}
