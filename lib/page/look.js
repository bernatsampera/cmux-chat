(() => {
  const answer = '.msg.assistant > .body.selectable';
  const saved = new WeakMap();
  const dirty = new Set();
  const turns = new Set();
  let timer;

  function element(tag, cls) {
    const node = document.createElement(tag);
    node.className = cls;
    return node;
  }

  // The color of a label chip: what went wrong, what should happen, what to do next.
  function toneOf(text) {
    const t = text.toLowerCase().replace(/[^a-z ]/g, '').trim();
    if (/^(did|got|owner got|actual|error|problem|failed|failure|wrong|broken|before)$/.test(t)) return 'bad';
    if (/^(expected|should|fix|fixed|result|works|after|now)$/.test(t)) return 'good';
    if (/^(try|next|todo|to do|action|test|run|lab|do)$/.test(t)) return 'next';
  }

  function labelOf(line) {
    const first = line.find(node => node.nodeType === 1 || node.textContent.trim());
    const text = first?.textContent.trim();
    if (first?.localName === 'strong' && text && text.length <= 24 && text.split(/\s+/).length <= 3) return first;
  }

  function paragraphs(view, firstBody) {
    const first = firstBody && view.querySelector('p');
    for (const p of view.querySelectorAll('p')) {
      const lines = [[]];
      for (const node of p.childNodes) {
        if (node.localName === 'br') lines.push([]);
        else lines.at(-1).push(node);
      }
      const lead = first === p && !labelOf(lines[0]) && p.textContent.trim().length <= 220;
      if (!lines.some(labelOf)) {
        if (lead) p.classList.add('cc-lead');
        continue;
      }

      let grid = p.previousElementSibling;
      if (!grid?.classList.contains('cc-grid')) grid = null;
      let plain;
      for (const [index, line] of lines.entries()) {
        const label = labelOf(line);
        if (!label) {
          grid = null;
          if (!plain) {
            plain = element('p', lead && !index ? 'cc-lead' : '');
            p.before(plain);
          } else plain.append(document.createElement('br'));
          plain.append(...line);
          continue;
        }
        plain = null;
        const value = line.slice(line.indexOf(label) + 1);
        if (value[0]?.nodeType === 3) value[0].data = value[0].data.replace(/^\s*(?:[·:]\s*|-\s+)/, '');
        if (lines.length === 1 && !value.some(n => n.nodeType === 1 || n.textContent.trim())) {
          const section = element('div', 'cc-section');
          section.append(label);
          p.before(section);
          break;
        }
        if (!grid) {
          grid = element('dl', 'cc-grid');
          p.before(grid);
        }
        const term = document.createElement('dt'), detail = document.createElement('dd');
        term.append(label);
        const tone = toneOf(label.textContent);
        if (tone) term.dataset.tone = tone;
        detail.append(...value);
        grid.append(term, detail);
      }
      p.remove();
    }
  }

  function build(body, first) {
    const view = element('div', 'cc-view selectable');
    for (const node of body.childNodes) view.append(node.cloneNode(true));
    for (const ui of view.querySelectorAll('.cc-ui')) ui.remove();
    paragraphs(view, first);
    for (const code of view.querySelectorAll('code')) {
      if (code.closest('pre')) continue;
      const path = code.textContent;
      const segments = path.split('/');
      if (path.startsWith('/')) segments.shift();
      else if (segments.length < 3) continue;
      if (!segments.every(part => part && part === part.trim() && /^[\p{L}\p{M}\p{N}_.@~+ -]+(?::\d+(?::\d+)?)?$/u.test(part))) continue;
      code.title = path;
      code.dataset.short = path.slice(path.lastIndexOf('/') + 1);
    }
    for (const button of view.querySelectorAll('.code-copy')) {
      const code = button.closest('.markdown-code')?.querySelector('pre code');
      if (code) button.addEventListener('click', () => navigator.clipboard.writeText(code.textContent).catch(() => {}));
    }
    return view;
  }

  function clear(msg) {
    const old = saved.get(msg);
    if (!old) return;
    saved.delete(msg);
    old.body.removeAttribute('data-cc-source');
    old.view.remove();
  }

  function sync(msg, body, first) {
    const old = saved.get(msg);
    if (!body) return clear(msg);
    try {
      if (old?.body === body && old.first === first && !dirty.has(body)) {
        if (old.view !== msg.lastChild) msg.append(old.view);
        return;
      }
      // Keep resource-loading content in its original node.
      if (body.querySelector('img,iframe,video,audio,object,embed,source,link')) return clear(msg);
      const view = build(body, first);
      clear(msg);
      msg.append(view);
      saved.set(msg, { body, view, first });
      body.setAttribute('data-cc-source', '');
    } catch {
      clear(msg);
      body.removeAttribute('data-cc-source');
    }
  }

  function flush() {
    timer = undefined;
    for (const turn of turns) {
      if (!turn.isConnected) continue;
      let first = true;
      for (const msg of turn.querySelectorAll('.msg.assistant')) {
        const body = [...msg.children].find(node => node.matches('.body.selectable') && !node.querySelector('.turn-activity'));
        sync(msg, body, first);
        if (body) first = false;
      }
    }
    turns.clear();
    dirty.clear();
  }

  function collect(node) {
    if (node.matches?.('.turn-group')) turns.add(node);
    for (const turn of node.querySelectorAll?.('.turn-group') || []) turns.add(turn);
  }

  function schedule() {
    if (turns.size && timer === undefined) timer = setTimeout(flush, 250);
  }

  new MutationObserver(records => {
    for (const record of records) {
      const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      if (target?.closest('.cc-view,.cc-ui')) continue;
      if (target?.closest('.turn-activity') && record.attributeName !== 'class') continue;
      const turn = target?.closest('.turn-group');
      if (!turn) {
        for (const node of record.addedNodes) collect(node);
        continue;
      }
      const body = target.closest(answer);
      if (body) {
        if (record.attributeName === 'data-cc-source' || record.attributeName === 'data-kind') continue;
        const changed = [...record.addedNodes, ...record.removedNodes];
        if (changed.length && changed.every(n => n.matches?.('.cc-ui'))) continue;
        dirty.add(body);
      } else {
        if (record.type !== 'childList' && record.attributeName !== 'class') continue;
        const changed = [...record.addedNodes, ...record.removedNodes];
        if (changed.length && changed.every(n => n.matches?.('.cc-view')) &&
            (!saved.has(target) || saved.get(target).view === target.lastChild)) continue;
      }
      turns.add(turn);
    }
    schedule();
  }).observe(document, { childList: true, characterData: true, attributes: true, subtree: true });
  collect(document);
  schedule();
})();
