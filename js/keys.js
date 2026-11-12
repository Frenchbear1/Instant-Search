// Keyboard combo helpers. A combo is a string like "Shift+]" or "Ctrl+K", built from the physical key
// so Shift doesn't turn "]" into "}" and layouts stay predictable.

const CODE_NAMES = {
  BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Slash: '/', Backslash: '\\',
  Comma: ',', Period: '.', Semicolon: ';', Quote: "'", Backquote: '`', Space: 'Space',
  NumpadAdd: '+', NumpadSubtract: '-', NumpadMultiply: '*', NumpadDivide: '/', NumpadEnter: 'Enter',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
};
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'OS', 'Fn', 'AltGraph']);

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function keyName(e) {
  const c = e.code || '';
  if (/^Key[A-Z]$/.test(c)) return c.slice(3);
  if (/^Digit\d$/.test(c)) return c.slice(5);
  if (/^Numpad\d$/.test(c)) return c.slice(6);
  if (CODE_NAMES[c]) return CODE_NAMES[c];
  if (/^F\d{1,2}$/.test(c)) return c;
  if (['Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'Insert'].includes(c)) return c;
  const k = e.key || '';
  return k.length === 1 ? k.toUpperCase() : k;
}

export function comboFromEvent(e) {
  if (MODIFIERS.has(e.key)) return null;
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push(isMac ? 'Cmd' : 'Meta');
  parts.push(keyName(e));
  return parts.join('+');
}

const LABEL = isMac
  ? { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Cmd: '⌘' }
  : { Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Meta: 'Win' };

export function comboLabel(combo) {
  const parts = combo.split('+');
  // "Shift++" style splits: last part may be empty when the key itself is "+"
  if (combo.endsWith('++')) { parts.pop(); parts[parts.length - 1] = '+'; }
  return parts.map((p) => LABEL[p] || (p === 'Escape' ? 'Esc' : p)).join(isMac ? '' : ' ');
}

// combos that use a modifier (other than Shift) or a function key still work while typing in a box
export function worksWhileTyping(combo) {
  return /(^|\+)(Ctrl|Alt|Cmd|Meta)\+/.test(combo) || /(^|\+)F\d{1,2}$/.test(combo);
}
