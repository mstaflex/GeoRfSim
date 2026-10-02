/* Small DOM helpers shared by the UI modules. Text always goes in via textContent. */

export const $ = (id) => document.getElementById(id);

export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function button(label, title, onClick, cls = 'btn') {
  const b = el('button', cls, label);
  b.type = 'button';
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

/** Number input; commits a clamped value on change (and Enter). An emptied field gets its value back. */
export function numberInput({ value, min, max, step, onChange, title, cls = 'num-in' }) {
  const i = el('input', cls);
  i.type = 'number';
  i.min = String(min);
  i.max = String(max);
  i.step = String(step);
  i.value = String(value);
  if (title) i.title = title;
  let last = value;
  i.addEventListener('change', () => {
    const v = i.value.trim() === '' ? NaN : Number(i.value);
    if (!Number.isFinite(v)) {
      i.value = String(last);
      return;
    }
    last = Math.min(Math.max(v, min), max);
    onChange(last);
  });
  return i;
}

/** Lets the user save text as a file (blob URL, revoked right after). */
export function download(filename, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Opens a file picker and resolves with the chosen file's text (max 2 MB). */
export function pickFile(accept = '.json,application/json') {
  return new Promise((resolve, reject) => {
    const i = el('input');
    i.type = 'file';
    i.accept = accept;
    i.addEventListener('change', () => {
      const f = i.files && i.files[0];
      if (!f) return reject(new Error('no file chosen'));
      if (f.size > 2e6) return reject(new Error('file too large'));
      f.text().then(resolve, reject);
    });
    i.click();
  });
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Copies a link; where the clipboard is not available (plain http) the link is shown to copy by hand. */
export async function shareLink(url, toast) {
  if (await copyText(url)) toast('Link copied');
  else window.prompt('Copy this link:', url);
}

export function fmtDuration(s) {
  if (!Number.isFinite(s)) return '–';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s % 60)).padStart(2, '0')}`;
}
