// @wc-ignore-file
import css from './styles.css?raw';
import {
  acceptsClass,
  matches,
  partition,
  read,
  readResource,
  register,
  setDone,
  sources,
  type Note,
  type Snapshot,
  type Source,
} from './data.js';
import type { Store } from './store.js';

export async function view({
  root,
  store,
}: {
  root: HTMLElement;
  store: Store;
}): Promise<void> {
  const doc = root.ownerDocument;

  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    text = '',
    className = '',
  ) => {
    const node = doc.createElement(tag);
    node.textContent = text;
    node.className = className;

    return node;
  };

  const button = (label: string, action: () => void) => {
    const node = el('button', label);
    node.type = 'button';
    node.addEventListener('click', action);

    return node;
  };

  root.classList.add('keep');

  const theme = (value?: { colorScheme?: 'light' | 'dark' }) => {
    root.style.colorScheme = value?.colorScheme ?? 'light dark';
  };

  theme(store.getTheme?.());
  const stopTheme = store.onThemeChange?.(theme);
  const style = el('style', css);
  const header = el('header', '', 'keep-header');
  const logo = el('span', '☑', 'keep-logo');
  logo.setAttribute('aria-hidden', 'true');
  const heading = el('h1', 'Google Keep');
  const back = button('Back to notes', () => {
    if (snapshot.container) open(snapshot.container);
  });
  back.hidden = true;
  header.append(back, logo, heading);
  const search = el('input');
  search.type = 'search';
  search.placeholder = 'Search notes';
  search.setAttribute('aria-label', 'Search notes');
  const layout = button('List view', () => {
    const list = grid.classList.toggle('keep-list');
    layout.textContent = list ? 'Grid view' : 'List view';
    layout.setAttribute('aria-pressed', String(list));
  });
  layout.setAttribute('aria-pressed', 'false');
  const refresh = button('Refresh', () => void load());
  header.append(search, layout, refresh);
  const pickerLabel = el('label', 'Notes or checklist table ', 'keep-picker');
  const picker = el('select');
  picker.setAttribute('aria-label', 'Notes or checklist table');
  pickerLabel.append(picker);
  pickerLabel.hidden = true;
  const notice = el('p', '', 'keep-notice');
  notice.hidden = true;
  const allow = button(
    'Allow editing',
    () =>
      void (async () => {
        try {
          const result = await store.requestRowAccess?.();
          if (result?.status !== 'granted')
            throw new Error(result?.reason || 'Editing was not allowed.');
          await load();
        } catch (error) {
          showError(error);
        }
      })(),
  );
  allow.hidden = true;
  const status = el('p', 'Loading notes…', 'keep-status');
  status.setAttribute('role', 'status');
  const grid = el('section', '', 'keep-grid');
  grid.setAttribute('aria-label', 'Notes');
  root.replaceChildren(style, header, pickerLabel, notice, allow, status, grid);

  let snapshot: Snapshot = { notes: [], watches: [] };
  let source: Source | undefined;
  let available: Source[] = [];
  let canEdit = false;
  let pending = false;
  let reloadAgain = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const subscriptions = new Map<string, () => void>();
  const expanded = new Set<string>();

  const showError = (error: unknown) => {
    status.hidden = false;
    status.textContent = error instanceof Error ? error.message : String(error);
    status.classList.add('keep-error');
  };

  const open = (subject: string) => {
    void store.openResource?.(subject).catch(showError);
  };

  const card = (note: Note) => {
    const article = el('article', '', 'keep-card');
    article.dataset.subject = note.subject;
    const title = note.title || 'Untitled note';
    article.setAttribute('aria-label', title);
    if (!snapshot.single) article.append(el('h2', title));

    if (!snapshot.single && store.openResource) {
      article.tabIndex = 0;
      article.addEventListener('click', event => {
        const target = event.target as Element;
        if (!target.closest('button,input,label,details,a')) open(note.subject);
      });
      article.addEventListener('keydown', event => {
        if (
          event.target === article &&
          (event.key === 'Enter' || event.key === ' ')
        ) {
          event.preventDefault();
          open(note.subject);
        }
      });
    }

    if (note.kind === 'list' || note.items.length) {
      const { unchecked, checked } = partition(note.items);

      const renderItems = (items: typeof unchecked, groupLabel: string) => {
        const list = el('ul', '', 'keep-items');
        list.setAttribute('aria-label', groupLabel);

        for (const item of items) {
          const row = el('li', '', item.under ? 'keep-indented' : '');
          row.dataset.subject = item.subject;
          const label = el('label', '', item.done ? 'keep-done' : '');
          const checkbox = el('input');
          checkbox.type = 'checkbox';
          checkbox.checked = item.done;
          checkbox.disabled = !canEdit;
          checkbox.setAttribute('aria-label', item.text || 'Empty item');
          checkbox.addEventListener('change', () => {
            checkbox.disabled = true;
            void setDone(store, snapshot, item.subject, checkbox.checked)
              .then(load)
              .catch(error => {
                checkbox.checked = item.done;
                checkbox.disabled = !canEdit;
                showError(error);
              });
          });
          label.append(checkbox, el('span', item.text));
          row.append(label);
          list.append(row);
        }

        return list;
      };

      article.append(renderItems(unchecked, 'Unchecked items'));

      if (checked.length) {
        const details = el('details', '', 'keep-completed');
        details.open = expanded.has(note.subject);
        details.append(
          el(
            'summary',
            `${checked.length} completed ${checked.length === 1 ? 'item' : 'items'}`,
          ),
          renderItems(checked, 'Completed items'),
        );
        details.addEventListener('toggle', () =>
          details.open
            ? expanded.add(note.subject)
            : expanded.delete(note.subject),
        );
        article.append(details);
      }

      if (!note.items.length)
        article.append(el('p', 'No list items yet.', 'keep-muted'));
    } else if (note.body) article.append(el('p', note.body, 'keep-body'));
    if (note.presence && !['present', 'local'].includes(note.presence))
      article.append(el('p', `In Google Keep: ${note.presence}`, 'keep-badge'));
    if (note.hold)
      article.append(
        el(
          'p',
          note.hold === 'conflict'
            ? 'Changed on both sides · open the sync app to resolve'
            : `Sync held: ${note.hold}`,
          'keep-badge',
        ),
      );

    if (store.openResource && !snapshot.single) {
      const footer = el('footer');
      footer.append(button('Open note', () => open(note.subject)));
      article.append(footer);
    }

    return article;
  };

  const render = () => {
    const visible = snapshot.notes.filter(note => matches(note, search.value));
    grid.replaceChildren(...visible.map(card));
    status.hidden = !!snapshot.single;
    status.classList.remove('keep-error');
    status.textContent = !source
      ? 'No compatible note or checklist tables yet. Import your Keep data, then refresh.'
      : !snapshot.notes.length
        ? 'No notes yet. Notes will appear after Google Keep syncs.'
        : !visible.length
          ? 'No matching notes.'
          : `${visible.length} ${visible.length === 1 ? 'note' : 'notes'}`;
  };

  search.addEventListener('input', render);
  picker.addEventListener('change', () => {
    source = available.find(item => item.table === picker.value);
    void load();
  });

  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void load(), 200);
  };

  async function load(): Promise<void> {
    if (stopped) return;

    if (pending) {
      reloadAgain = true;

      return;
    }

    pending = true;
    refresh.disabled = true;

    try {
      const data = await store.getData();
      let attached = false;

      if (data?.resource) {
        snapshot = await readResource(store, data.resource);
        source = { table: data.resource, rowClass: '', name: snapshot.title! };
        pickerLabel.hidden = true;
      } else {
        const currentTable = data?.table
          ? await store.getResource(data.table)
          : undefined;
        const rowClass =
          data?.rowClass ||
          currentTable?.get('https://atomicdata.dev/properties/classtype');
        const klass =
          typeof rowClass === 'string'
            ? await store.getResource(rowClass)
            : undefined;
        attached =
          typeof rowClass === 'string' &&
          !!klass &&
          (await acceptsClass(store, rowClass));

        if (
          data &&
          currentTable &&
          !attached &&
          currentTable.get('https://atomicdata.dev/properties/parent') !==
            (await store.getApp())
        )
          throw new Error(
            'This table needs a text column and a boolean Checked or Done column to use this view.',
          );

        if (attached && data?.table && typeof rowClass === 'string')
          source = { table: data.table, rowClass, name: 'Google Keep' };
        else {
          available = await sources(store);
          if (!available.some(item => item.table === source?.table))
            source = available[0];
          picker.replaceChildren(
            ...available.map(item => {
              const option = el('option', item.name);
              option.value = item.table;

              return option;
            }),
          );
          picker.value = source?.table ?? '';
          pickerLabel.hidden = available.length < 2;
          await register(
            store,
            available.map(item => item.rowClass),
          );
        }

        snapshot = source
          ? await read(store, source)
          : { notes: [], watches: [] };
      }

      heading.textContent = snapshot.title || 'Google Keep';
      search.hidden = !!snapshot.single;
      layout.hidden = !!snapshot.single;
      back.hidden =
        !snapshot.single || !snapshot.container || !store.openResource;
      grid.classList.toggle('keep-single', !!snapshot.single);
      grid.setAttribute('aria-label', snapshot.single ? 'Note' : 'Notes');
      canEdit = !!(
        !data?.resource &&
        attached &&
        data?.table === snapshot.itemTable &&
        (await store.rowAccess?.())?.status === 'granted'
      );
      allow.hidden = !(
        !data?.resource &&
        attached &&
        data?.table === snapshot.itemTable &&
        !canEdit &&
        store.requestRowAccess
      );
      notice.hidden = canEdit || !source;
      notice.replaceChildren(doc.createTextNode('Read-only.'));
      if (
        snapshot.itemTable &&
        data?.table !== snapshot.itemTable &&
        store.openResource &&
        (!data?.resource ||
          snapshot.notes.some(
            note => note.kind === 'list' || note.items.length,
          ))
      )
        notice.append(
          doc.createTextNode(' '),
          button('Open editing view', () => open(snapshot.itemTable!)),
        );
      else if (!data?.resource)
        notice.append(' Allow editing to tick list items.');
      const watches = new Set(snapshot.watches);

      for (const [subject, stop] of subscriptions)
        if (!watches.has(subject)) {
          stop();
          subscriptions.delete(subject);
        }

      for (const subject of watches)
        if (!subscriptions.has(subject))
          subscriptions.set(subject, store.subscribe(subject, later));
      render();
    } catch (error) {
      showError(error);
    } finally {
      pending = false;
      refresh.disabled = false;

      if (reloadAgain) {
        reloadAgain = false;
        void load();
      }
    }
  }

  doc.defaultView?.addEventListener(
    'pagehide',
    () => {
      stopped = true;
      clearTimeout(timer);
      stopTheme?.();
      for (const stop of subscriptions.values()) stop();
    },
    { once: true },
  );
  await load();
}
