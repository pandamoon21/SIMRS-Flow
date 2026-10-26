/** Page arithmetic shared by the data tables. `perPage: 'all'` shows everything on one page. */

export type PerPage = number | 'all';

export interface PageWindow {
  page: number;
  pageCount: number;
  start: number;
  end: number;
}

export function pageWindow(total: number, perPage: PerPage, page: number): PageWindow {
  if (perPage === 'all' || perPage <= 0) return { page: 1, pageCount: 1, start: 0, end: total };
  const pageCount = Math.max(1, Math.ceil(total / perPage));
  const current = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);
  const start = (current - 1) * perPage;
  return { page: current, pageCount, start, end: Math.min(start + perPage, total) };
}

/** Text typed into the "go to page" box → a valid page, or undefined when it is not a number. */
export function parsePageInput(value: string, pageCount: number): number | undefined {
  const n = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(Math.max(1, n), pageCount);
}
