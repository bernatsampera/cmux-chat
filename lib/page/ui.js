(() => {
  const cache = new WeakMap();
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const string = value => typeof value === 'string';
  const pairs = rows => Array.isArray(rows) ? rows.filter(row => Array.isArray(row) && row.length === 2 && row.every(string)) : [];

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function inline(tag, text, cls) {
    const node = el(tag, cls);
    let start = 0;
    for (const match of text.matchAll(/`([^`\n]+)`|\*\*([^*\n]+)\*\*/g)) {
      node.append(text.slice(start, match.index), match[1] === undefined ? el('strong', '', match[2]) : el('code', '', match[1]));
      start = match.index + match[0].length;
    }
    node.append(text.slice(start));
    return node;
  }

  function copyButton(text, label) {
    const button = el('button', 'cc-copy', 'Copy');
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = 'Copied';
      } catch {
        button.textContent = 'Copy failed';
      }
      setTimeout(() => { button.textContent = 'Copy'; }, 1500);
    });
    return button;
  }

  function link(value) {
    if (!object(value) || !string(value.text)) return;
    try {
      const url = new URL(value.href);
      if (string(value.href) && ['http:', 'https:'].includes(url.protocol)) {
        const anchor = inline('a', value.text, 'cc-link');
        anchor.href = url.href;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        return anchor;
      }
    } catch {}
    return inline('span', value.text);
  }

  function steps(value) {
    const section = el('section', 'cc-steps'), head = el('div', 'cc-head');
    if (string(value.title)) head.append(inline('h3', value.title));
    const action = link(value.link);
    if (action) head.append(action);
    if (head.childElementCount) section.append(head);
    const list = el('ol');
    for (const item of value.items) {
      const text = string(item) ? item : item?.text;
      if (!string(text)) continue;
      const row = el('li');
      row.append(inline('div', text));
      if (string(item.copy)) {
        const box = el('div', 'cc-snippet');
        box.append(inline('div', item.copy, 'cc-copy-text'), copyButton(item.copy, 'Copy step text'));
        row.append(box);
      }
      for (const [expectation, question] of pairs(item.checks)) {
        const check = el('div', 'cc-check');
        check.append(inline('span', expectation, 'cc-tag'), inline('q', question), copyButton(question, 'Copy question'));
        row.append(check);
      }
      list.append(row);
    }
    section.append(list);
    return section;
  }

  function equal(a, b) {
    if (a === b) return true;
    if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => equal(v, b[i]));
    if (!object(a) || !object(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && equal(a[k], b[k]));
  }

  function compare({ left, right, a, b }) {
    const table = el('table', 'cc-compare'), header = el('tr');
    header.append(el('th'), inline('th', string(left) ? left : 'before'), inline('th', string(right) ? right : 'after'));
    const head = el('thead'), body = el('tbody');
    head.append(header);
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const changed = !(Object.hasOwn(a, key) && Object.hasOwn(b, key) && equal(a[key], b[key]));
      const row = el('tr', changed ? 'cc-changed' : 'cc-equal');
      const name = el('td');
      name.append(inline('span', key, 'cc-key'));
      row.append(name);
      for (const [side, sign] of [[a, '-'], [b, '+']]) {
        const cell = el('td');
        if (changed) cell.append(el('span', 'cc-sign', sign + ' '));
        cell.append(Object.hasOwn(side, key) ? el('samp', '', JSON.stringify(side[key])) : el('span', 'cc-missing', '(none)'));
        row.append(cell);
      }
      body.append(row);
    }
    table.append(head, body);
    return table;
  }

  function part(value) {
    if (!object(value)) return;
    if (string(value.card)) {
      const icons = { fail: '×', ok: '✓', warn: '!', info: 'i' };
      const status = string(value.status) && Object.hasOwn(icons, value.status) ? value.status : 'info';
      const card = el('section', 'cc-card cc-' + status), icon = el('span', 'cc-icon', icons[status]);
      icon.setAttribute('role', 'img');
      icon.setAttribute('aria-label', status);
      card.append(icon, inline('h3', value.card));
      if (string(value.sub)) card.append(inline('div', value.sub, 'cc-sub'));
      return card;
    }
    if (Array.isArray(value.story)) {
      const story = el('dl', 'cc-story');
      for (const [label, text] of pairs(value.story)) story.append(inline('dt', label), inline('dd', text));
      return story.childElementCount ? story : undefined;
    }
    if (object(value.compare?.a) && object(value.compare?.b)) return compare(value.compare);
    if (string(value.note)) {
      const note = el('aside', 'cc-note');
      if (string(value.label)) note.append(inline('b', value.label, 'cc-label'));
      note.append(inline('div', value.note));
      return note;
    }
    if (Array.isArray(value.steps?.items)) return steps(value.steps);
  }

  function sync(block) {
    const lang = block.querySelector('.code-lang')?.textContent.trim().toLowerCase();
    const source = lang === 'json' ? block.querySelector('pre code')?.textContent : undefined;
    let saved = cache.get(block);
    if (!saved || saved.source !== source) {
      saved?.view?.remove();
      saved = { source };
      cache.set(block, saved);
      if (source) {
        try {
          const data = JSON.parse(source);
          if (Array.isArray(data?.ui)) {
            const view = el('div', 'cc-ui');
            for (const value of data.ui) {
              const node = part(value);
              if (node) view.append(node);
            }
            if (view.childElementCount) saved.view = view;
          }
        } catch {} // The next chunk can complete a JSON fence.
      }
    }
    if (saved.view) {
      if (saved.view.parentNode !== block) block.append(saved.view);
      if (block.dataset.kind !== 'ui') block.dataset.kind = 'ui';
    } else if (block.dataset.kind === 'ui') block.dataset.kind = lang === 'text' ? 'quote' : 'code';
  }

  const dirty = new Set();
  let pending = false;
  function collect(node) {
    if (node.matches?.('.markdown-code')) dirty.add(node);
    for (const block of node.querySelectorAll?.('.markdown-code') || []) dirty.add(block);
  }
  function schedule() {
    if (pending || !dirty.size) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      for (const block of dirty) if (block.isConnected) sync(block);
      dirty.clear();
    });
  }
  if (typeof MutationObserver === 'function') new MutationObserver(records => {
    for (const record of records) {
      const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      if (target?.closest('.cc-ui')) continue;
      const block = target?.closest('.markdown-code');
      if (block) {
        if (record.addedNodes.length === 1 && record.addedNodes[0] === cache.get(block)?.view && !record.removedNodes.length) continue;
        dirty.add(block);
      } else for (const node of record.addedNodes) collect(node);
    }
    schedule();
  }).observe(document, { subtree: true, childList: true, characterData: true });
  collect(document);
  schedule();
})();
