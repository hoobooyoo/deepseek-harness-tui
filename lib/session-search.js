function workspaceLabel(cwd) {
  const value = String(cwd ?? '').replace(/[/\\]+$/, '');
  if (value === '') return '';
  return value.split(/[/\\]/).pop() ?? value;
}

function recencyOf(session) {
  const value = session?.createdAt;
  if (typeof value === 'number') return value;
  const parsed = Date.parse(String(value ?? ''));
  return Number.isNaN(parsed) ? 0 : parsed;
}

function byRecency(a, b) {
  const diff = recencyOf(b) - recencyOf(a);
  if (diff !== 0) return diff;
  return String(a.id).localeCompare(String(b.id));
}

/**
 * Match session metadata locally, then append ranked content-search hits.
 * This mirrors the web workspace client's deriveSearchResults contract while
 * keeping the TUI scoped to the records returned by its current workspace.
 */
export function deriveSessionSearchResults(
    sessions, content, query, limit = 20) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (needle === '') return {items: [], hasMore: false};

  const records = Array.isArray(sessions) ? sessions : [];
  const contentItems = Array.isArray(content?.items) ? content.items : [];
  const contentBySession = new Map();
  for (const item of contentItems) {
    const id = String(item?.sessionId ?? '');
    if (id !== '' && !contentBySession.has(id)) contentBySession.set(id, item);
  }

  const local =
      records
          .filter((session) => {
            if (session?.blank === true || session?.id === undefined)
              return false;
            const title = String(session.title ?? '').toLowerCase();
            const workspace =
                String(session.workspace ?? workspaceLabel(session.cwd))
                    .toLowerCase();
            return title.includes(needle) || workspace.includes(needle);
          })
          .sort(byRecency);

  const ordered = [];
  const included = new Set();
  const include = (session) => {
    const id = String(session.id);
    if (included.has(id)) return;
    included.add(id);
    const match = contentBySession.get(id);
    ordered.push(
        match === undefined ? {...session} :
                              {...session, snippet: match.snippet});
  };

  for (const session of local) include(session);
  for (const item of contentItems) {
    const session = records.find(
        (candidate) => String(candidate?.id) === String(item?.sessionId));
    if (session !== undefined && session.blank !== true) include(session);
  }

  const boundedLimit = Math.max(0, Number(limit) || 0);
  return {
    items: ordered.slice(0, boundedLimit),
    hasMore: content?.hasMore === true || ordered.length > boundedLimit,
  };
}