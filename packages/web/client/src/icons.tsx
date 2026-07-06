import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;

export const I = {
  search: (p: P) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" {...p}><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>,
  plus: (p: P) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" {...p}><path d="M12 5v14M5 12h14"/></svg>,
  branch: (p: P) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="7" r="2.5"/><path d="M6 8.5v7M18 9.5c0 3-3 3.5-6 4"/></svg>,
  bot: (p: P) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 8V4M8 13h.01M16 13h.01M9 16.5h6"/></svg>,
  person: (p: P) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="12" cy="8" r="3.4"/><path d="M5.5 19a6.5 6.5 0 0 1 13 0"/></svg>,
  link: (p: P) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M10 14a4 4 0 0 0 6 .5l2.5-2.5a4 4 0 0 0-5.6-5.6L11 8"/><path d="M14 10a4 4 0 0 0-6-.5L5.5 12a4 4 0 0 0 5.6 5.6L13 16"/></svg>,
  comment: (p: P) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-4 3.5V6a1 1 0 0 1 1-1z"/></svg>,
  clock: (p: P) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="12" cy="12" r="8.5"/><path d="M12 8v4.5l3 2"/></svg>,
  check: (p: P) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M5 12.5 10 17l9-10"/></svg>,
  chev: (p: P) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="m6 9 6 6 6-6"/></svg>,
  folder: (p: P) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M4 7a2 2 0 0 1 2-2h3l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/></svg>,
  board: (p: P) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><rect x="4" y="4" width="6" height="16" rx="1.5"/><rect x="14" y="4" width="6" height="10" rx="1.5"/></svg>,
  list: (p: P) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg>,
  chart: (p: P) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>,
  info: (p: P) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>,
  expand: (p: P) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M9 4H4v5M20 9V4h-5M4 15v5h5M15 20h5v-5"/></svg>,
  collapse: (p: P) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M4 9h5V4M15 4v5h5M20 15h-5v5M9 20v-5H4"/></svg>,
  pencil: (p: P) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17z"/><path d="m13.5 6.5 3 3"/></svg>,
};

export function Mark() {
  return (
    <svg viewBox="0 0 32 32" className="af-mark" aria-hidden="true">
      <rect x="2" y="3" width="28" height="26" rx="7" fill="#1E293B" stroke="#2C3A55"/>
      <rect x="7" y="9.5" width="13" height="3" rx="1.5" fill="var(--accent)"/>
      <rect x="7" y="15" width="17" height="3" rx="1.5" fill="#3A4D70"/>
      <rect x="7" y="20.5" width="9" height="3" rx="1.5" fill="#3A4D70"/>
      <circle cx="24.5" cy="10" r="3.2" fill="var(--active)"/>
    </svg>
  );
}
