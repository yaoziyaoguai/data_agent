const paths = {
  logo: "M12 2.5 20.5 7.5v9L12 21.5 3.5 16.5v-9L12 2.5Zm0 0v9.5m8.5-4.5L12 12 3.5 7.5",
  chat: "M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z",
  book: "M4 5.5A2.5 2.5 0 0 1 6.5 3H19v16H6.5A2.5 2.5 0 0 0 4 21.5v-16Zm0 13A2.5 2.5 0 0 1 6.5 16H19M8 7.5h7M8 11h5",
  bookmark: "M6 3h12v18l-6-4-6 4V3Z",
  layers: "m12 3 10 5-10 5L2 8l10-5Zm-10 9 10 5 10-5M2 16l10 5 10-5",
  sliders: "M4 6h9m4 0h3M15 4v4M4 12h3m4 0h9M9 10v4M4 18h11m4 0h1M17 16v4",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm9 2-4.2-4.2",
  table: "M3.5 5.5h17v13h-17v-13Zm0 4.5h17M9.5 10v8.5",
  metric: "M4 18.5h16M6.5 15l3.5-4 3 2.5 4.5-6",
  doc: "M6 3.5h8.5L18.5 7.5v13H6v-17Zm8 0v4h4M9 11.5h6M9 15h4.5",
  copy: "M9 9h10v11H9V9ZM5 15H4V4h10v1",
  check: "m5 12.5 4.5 4.5L19 7.5",
  arrowRight: "M5 12h14m-5-5 5 5-5 5",
  external: "M14 4h6v6M10 14 20 4M18 13v6H5V6h6",
  refresh: "M20 11a8 8 0 0 0-14.5-4.5M4 4v4h4M4 13a8 8 0 0 0 14.5 4.5M20 20v-4h-4",
  chevronRight: "m9 6 6 6-6 6",
  menu: "M4 6h16M4 12h16M4 18h16",
  plus: "M12 5v14M5 12h14",
  close: "m6 6 12 12M6 18 18 6",
  up: "M12 19V5m-6 6 6-6 6 6",
  info: "M12 11v6M12 7v.1M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z",
  spark: "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z",
} as const;
export type IconName = keyof typeof paths;
export function Icon({ name }: { name: IconName }) {
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]}/></svg>;
}
