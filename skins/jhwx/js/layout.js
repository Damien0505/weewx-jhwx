// Viewer layout: show/hide and reorder tiles, gauges and page sections.
// Edit mode adds a drag handle and an eye toggle to every item; the result is
// remembered in this browser (localStorage), like the theme.

const STORE = 'jhwx.layout';

const HANDLE_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><g fill="currentColor">'
  + '<circle cx="5.5" cy="3.5" r="1.4"/><circle cx="10.5" cy="3.5" r="1.4"/><circle cx="5.5" cy="8" r="1.4"/>'
  + '<circle cx="10.5" cy="8" r="1.4"/><circle cx="5.5" cy="12.5" r="1.4"/><circle cx="10.5" cy="12.5" r="1.4"/></g></svg>';
const EYE_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/>'
  + '<circle cx="12" cy="12" r="3"/><path class="eye-off" d="M4 4l16 16"/></svg>';

function load() {
  try { return JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch (e) { return {}; }
}

export class Layout extends EventTarget {
  constructor() {
    super();
    this.saved = load();
    this.groups = new Map();   // name -> { el, attr, label }
    this.editing = false;
  }

  /** A container whose children (with `attr`) can be hidden and reordered. */
  register(name, el, attr, label) {
    this.groups.set(name, { el, attr, label });
    this.apply(name);
  }

  items(name) {
    const g = this.groups.get(name);
    return [...g.el.children].filter((c) => c.hasAttribute(g.attr));
  }

  /** Re-apply the saved order and visibility (e.g. after gauges are rebuilt). */
  apply(name) {
    const g = this.groups.get(name);
    const s = this.saved[name];
    if (!g || !s) { if (this.editing) this._decorate(name); return; }
    const byKey = new Map(this.items(name).map((c) => [c.getAttribute(g.attr), c]));
    // saved order first, then anything new in its natural place at the end
    for (const k of s.order || []) {
      const c = byKey.get(k);
      if (c) { g.el.append(c); byKey.delete(k); }
    }
    for (const c of byKey.values()) g.el.append(c);
    const off = new Set(s.hidden || []);
    for (const c of this.items(name)) c.classList.toggle('user-off', off.has(c.getAttribute(g.attr)));
    if (this.editing) this._decorate(name);
  }

  save() {
    const out = {};
    for (const [name, g] of this.groups) {
      const items = this.items(name);
      out[name] = {
        order: items.map((c) => c.getAttribute(g.attr)),
        hidden: items.filter((c) => c.classList.contains('user-off')).map((c) => c.getAttribute(g.attr)),
      };
    }
    this.saved = out;
    try { localStorage.setItem(STORE, JSON.stringify(out)); } catch (e) { /* ignore */ }
    this.dispatchEvent(new Event('change'));
  }

  reset() {
    this.saved = {};
    try { localStorage.removeItem(STORE); } catch (e) { /* ignore */ }
    window.location.reload();
  }

  setEditing(on) {
    this.editing = on;
    document.body.classList.toggle('editing', on);
    for (const name of this.groups.keys()) {
      if (on) this._decorate(name);
      else for (const c of this.items(name)) c.querySelector(':scope > .edit-ctl')?.remove();
    }
    this.dispatchEvent(new Event('change'));
  }

  // --------------------------------------------------------------- editing
  _decorate(name) {
    const g = this.groups.get(name);
    for (const item of this.items(name)) {
      if (item.querySelector(':scope > .edit-ctl')) continue;
      const ctl = document.createElement('div');
      ctl.className = 'edit-ctl';
      const label = item.dataset.editLabel || item.getAttribute(g.attr);
      const handle = document.createElement('button');
      handle.type = 'button';
      handle.className = 'edit-handle';
      handle.innerHTML = HANDLE_SVG;
      handle.setAttribute('aria-label', `Move ${label} (drag, or use arrow keys)`);
      const eye = document.createElement('button');
      eye.type = 'button';
      eye.className = 'edit-eye';
      eye.innerHTML = EYE_SVG;
      const syncEye = () => {
        const off = item.classList.contains('user-off');
        eye.setAttribute('aria-pressed', String(!off));
        eye.setAttribute('aria-label', `${off ? 'Show' : 'Hide'} ${label}`);
      };
      syncEye();
      eye.addEventListener('click', (e) => {
        e.stopPropagation();
        item.classList.toggle('user-off');
        syncEye();
        this.save();
      });
      handle.addEventListener('pointerdown', (e) => this._drag(e, item, handle));
      handle.addEventListener('keydown', (e) => this._key(e, item, handle));
      handle.addEventListener('click', (e) => e.stopPropagation());
      ctl.append(handle, eye);
      item.append(ctl);
    }
  }

  _key(e, item, handle) {
    const prev = ['ArrowLeft', 'ArrowUp'].includes(e.key);
    const next = ['ArrowRight', 'ArrowDown'].includes(e.key);
    if (!prev && !next) return;
    e.preventDefault();
    const sib = prev ? item.previousElementSibling : item.nextElementSibling;
    if (!sib) return;
    if (prev) sib.before(item); else sib.after(item);
    handle.focus();
    this.save();
  }

  _drag(e, item, handle) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    try { handle.setPointerCapture(e.pointerId); } catch (err) { /* synthetic or lost pointer */ }
    item.classList.add('dragging');
    const parent = item.parentElement;
    let scroll = 0;
    const timer = setInterval(() => { if (scroll) window.scrollBy(0, scroll); }, 16);
    const move = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      const edge = 70;
      scroll = ev.clientY < edge ? -12 : ev.clientY > window.innerHeight - edge ? 12 : 0;
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const over = under && under.closest('.edit-target, [data-tile], [data-gauge], [data-section]');
      if (!over || over === item || over.parentElement !== parent) return;
      const kids = [...parent.children];
      if (kids.indexOf(item) < kids.indexOf(over)) over.after(item); else over.before(item);
      // moving the item re-inserts the handle, which drops its pointer capture
      try { handle.setPointerCapture(ev.pointerId); } catch (err) { /* pointer already gone */ }
    };
    // listen on the window: events still arrive while the capture is re-taken
    const up = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      clearInterval(timer);
      item.classList.remove('dragging');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      this.save();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }
}
