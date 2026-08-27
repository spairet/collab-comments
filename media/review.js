(() => {
  'use strict';

  const vscode = acquireVsCodeApi();
  let state = { file: null, showResolved: false, comments: [] };
  let activeCommentId = null;
  let lastFraction = 0;

  const palette = ['#0f6cbd', '#5c2e91', '#038387', '#c239b3', '#ca5010', '#107c10', '#8a6116', '#744da9'];

  const el = (tag, className, value) => {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (value !== undefined) item.textContent = value;
    return item;
  };

  const initials = name => (name || '?').trim().split(/\s+/).slice(0, 2)
    .map(part => part[0] || '').join('').toUpperCase() || '?';

  const avatar = name => {
    const seed = [...(name || '?')].reduce((sum, char) => sum + char.charCodeAt(0), 0);
    const item = el('span', 'collab-comments-avatar', initials(name));
    item.setAttribute('aria-hidden', 'true');
    item.style.background = palette[seed % palette.length];
    return item;
  };

  const formatTime = value => {
    const date = value ? new Date(value) : null;
    return date && !Number.isNaN(date.getTime())
      ? date.toLocaleString(undefined, {
        day: 'numeric', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      })
      : 'unknown time';
  };

  const meta = (name, timestamp) => {
    const box = el('div', 'collab-comments-meta');
    box.append(
      el('span', 'collab-comments-author', name || 'Unknown'),
      el('span', 'collab-comments-time', formatTime(timestamp))
    );
    return box;
  };

  const head = (name, timestamp) => {
    const header = el('header', 'collab-comments-head');
    header.append(avatar(name), meta(name, timestamp));
    return header;
  };

  const actionButton = (label, handler, className) => {
    const item = el('button', className, label);
    item.type = 'button';
    item.addEventListener('click', handler);
    return item;
  };

  const post = message => vscode.postMessage(message);

  const diffBlock = change => {
    const pre = el('pre', 'collab-comments-change');
    pre.append(
      el('span', 'del', `− ${change.previousText || '(empty)'}`),
      '\n',
      el('span', 'add', `+ ${change.newText || '(empty)'}`)
    );
    return pre;
  };

  const replyEntry = (reply, commentId) => {
    const entry = el('div', 'collab-comments-reply');
    entry.append(avatar(reply.author));
    const bodyBox = el('div', 'collab-comments-reply-body');
    bodyBox.append(meta(reply.author, reply.timestamp), el('p', null, reply.text || ''));
    bodyBox.append(actionButton('Delete',
      () => post({ type: 'delete-reply', commentId, replyId: reply.id }),
      'collab-comments-link danger'));
    entry.append(bodyBox);
    return entry;
  };

  const activity = comment => {
    const items = [
      ...comment.replies.map(reply => ({
        timestamp: reply.timestamp,
        render: () => replyEntry(reply, comment.id)
      })),
      ...comment.trackedChanges.map(change => ({
        timestamp: change.timestamp,
        render: () => diffBlock(change)
      }))
    ].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    return items.map(item => item.render());
  };

  const buildCard = comment => {
    const card = el('section', `collab-comments-card${comment.resolved ? ' resolved' : ''}`);
    card.dataset.commentId = comment.id;
    card.append(head(comment.author, comment.timestamp), el('p', 'collab-comments-body', comment.text));

    const repliesBox = el('div', 'collab-comments-replies');
    for (const item of activity(comment)) {
      repliesBox.append(item);
    }
    if (repliesBox.children.length) {
      card.append(repliesBox);
    }

    const actions = el('div', 'collab-comments-actions');
    actions.append(actionButton(comment.resolved ? 'Reopen' : 'Resolve',
      () => post({ type: 'resolve', commentId: comment.id, resolved: !comment.resolved })));
    actions.append(actionButton('Go to source', () => post({ type: 'navigate', commentId: comment.id })));
    if (comment.trackedChanges.length > 1) {
      actions.append(actionButton('Merge changes', () => post({ type: 'merge-tracked-changes', commentId: comment.id })));
    }
    actions.append(actionButton('Delete thread', () => post({ type: 'delete-thread', commentId: comment.id }), 'danger'));
    card.append(actions);

    const replyRow = el('div', 'collab-comments-reply-row');
    const reply = el('input');
    reply.placeholder = 'Reply…';
    const send = actionButton('Reply', () => {
      const text = reply.value.trim();
      if (text) {
        post({ type: 'reply', commentId: comment.id, text });
      }
    });
    reply.addEventListener('keydown', event => {
      if (event.key === 'Enter') send.click();
    });
    replyRow.append(reply, send);
    card.append(replyRow);

    card.addEventListener('click', event => {
      if (event.target.closest('button, input, textarea')) {
        return;
      }
      post({ type: 'navigate', commentId: comment.id });
    });

    return card;
  };

  const scrollContainer = () =>
    document.scrollingElement || document.documentElement;

  const maxScroll = () => {
    const scroller = scrollContainer();
    return Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  };

  const applyScroll = () => {
    scrollContainer().scrollTop = Math.min(1, Math.max(0, lastFraction)) * maxScroll();
  };

  const render = () => {
    const app = document.getElementById('app');
    app.replaceChildren();

    const header = el('div', 'panel-header');
    header.append(el('div', 'panel-title', state.file || 'No tracked file open'));
    const controls = el('div', 'panel-controls');
    const label = el('label');
    const checkbox = el('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.showResolved;
    checkbox.addEventListener('change', () => {
      post({ type: 'show-resolved', visible: checkbox.checked });
    });
    label.append(checkbox, document.createTextNode('Show resolved'));
    controls.append(label);
    header.append(controls);
    app.append(header);

    if (!state.file) {
      app.append(el('div', 'panel-empty', 'Open a tracked file to see its comments here.'));
      return;
    }

    const comments = state.comments
      .filter(comment => state.showResolved || !comment.resolved)
      .sort((left, right) =>
        left.range.start.line - right.range.start.line);

    const host = el('div', 'panel-cards');
    host.id = 'cards';
    if (!comments.length) {
      host.append(el('div', 'panel-empty', 'No comments in this file yet.'));
      app.append(host);
      return;
    }

    for (const comment of comments) {
      const card = buildCard(comment);
      if (comment.id === activeCommentId) {
        card.classList.add('active');
      }
      host.append(card);
    }
    app.append(host);
    applyScroll();
  };

  window.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'state') {
      state = {
        file: message.file,
        showResolved: message.showResolved,
        comments: message.comments
      };
      render();
    } else if (message.type === 'anchor') {
      lastFraction = message.fraction;
      applyScroll();
    } else if (message.type === 'highlight') {
      activeCommentId = message.commentId;
      for (const card of document.querySelectorAll('.collab-comments-card.active')) {
        card.classList.remove('active');
      }
      if (activeCommentId) {
        const card = document.querySelector(`[data-comment-id="${CSS.escape(activeCommentId)}"]`);
        if (card) {
          card.classList.add('active');
          if (message.scroll !== false) {
            card.scrollIntoView({ block: 'nearest' });
          }
        }
      }
    }
  });

  window.addEventListener('resize', applyScroll);

  render();
})();
