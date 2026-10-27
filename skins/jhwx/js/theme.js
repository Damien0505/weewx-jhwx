// Light / Dark / Auto.  Auto = no data-theme attribute, CSS follows
// prefers-color-scheme.  The choice is remembered per browser.

const KEY = 'jhwx.theme';

function read() {
  try { return localStorage.getItem(KEY) || 'auto'; } catch (e) { return 'auto'; }
}
function write(v) {
  try { localStorage.setItem(KEY, v); } catch (e) { /* private mode etc. */ }
}

export function applyTheme(choice) {
  if (choice === 'light' || choice === 'dark') document.documentElement.dataset.theme = choice;
  else delete document.documentElement.dataset.theme;
}

/** Wire a segmented control whose buttons carry data-theme-choice. */
export function initTheme(group) {
  let choice = read();
  const sync = () => {
    applyTheme(choice);
    for (const b of group.querySelectorAll('button[data-theme-choice]')) {
      b.setAttribute('aria-pressed', String(b.dataset.themeChoice === choice));
    }
  };
  group.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-theme-choice]');
    if (!b) return;
    choice = b.dataset.themeChoice;
    write(choice);
    sync();
  });
  sync();
}
