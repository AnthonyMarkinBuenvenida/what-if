import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

function base({ size = 18, ...rest }: P) {
  return {
    width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true, ...rest,
  };
}

export const IconOverview = (p: P) => <svg {...base(p)}><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="4.5" rx="1.5" /><rect x="13.5" y="11" width="7" height="9.5" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /></svg>;
export const IconStore = (p: P) => <svg {...base(p)}><path d="M4 9.5 5.2 4.5h13.6L20 9.5" /><path d="M4 9.5c0 1.4 1.1 2.5 2.7 2.5S9.3 10.9 9.3 9.5c0 1.4 1.2 2.5 2.7 2.5s2.7-1.1 2.7-2.5c0 1.4 1.1 2.5 2.6 2.5S20 10.9 20 9.5" /><path d="M5.5 12v8h13v-8" /><path d="M10 20v-4.5h4V20" /></svg>;
export const IconTwin = (p: P) => <svg {...base(p)}><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z" /><path d="M12 12 4 7.5M12 12l8-4.5M12 12v9" /></svg>;
export const IconFork = (p: P) => <svg {...base(p)}><circle cx="5" cy="12" r="2" /><path d="M7 12h3c3 0 4-6 7-6h3M10 12c3 0 4 6 7 6h3M10 12h10" /></svg>;
export const IconPlay = (p: P) => <svg {...base(p)}><path d="M7 4.8v14.4a.8.8 0 0 0 1.2.7l11.3-7.2a.8.8 0 0 0 0-1.4L8.2 4.1A.8.8 0 0 0 7 4.8z" /></svg>;
export const IconReport = (p: P) => <svg {...base(p)}><path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z" /><path d="M14 3.5v5h5M9 17v-3M12 17v-5M15 17v-2" /></svg>;
export const IconMuseum = (p: P) => <svg {...base(p)}><path d="M3.5 9 12 4l8.5 5" /><path d="M5 20.5h14M6 18V10.5M10 18v-7.5M14 18v-7.5M18 18v-7.5" /></svg>;
export const IconLoop = (p: P) => <svg {...base(p)}><path d="M20 12a8 8 0 0 1-14.3 4.9M4 12a8 8 0 0 1 14.3-4.9" /><path d="M18.5 3v4.2h-4.2M5.5 21v-4.2h4.2" /></svg>;
export const IconSettings = (p: P) => <svg {...base(p)}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" /></svg>;
export const IconPlus = (p: P) => <svg {...base(p)}><path d="M12 5v14M5 12h14" /></svg>;
export const IconUpload = (p: P) => <svg {...base(p)}><path d="M12 15V4M7.5 8.5 12 4l4.5 4.5" /><path d="M4.5 15v3.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V15" /></svg>;
export const IconCheck = (p: P) => <svg {...base(p)}><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>;
export const IconAlert = (p: P) => <svg {...base(p)}><path d="M12 4 2.8 19.5h18.4z" /><path d="M12 10v4.2M12 17.2v.1" /></svg>;
export const IconInfo = (p: P) => <svg {...base(p)}><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5.5M12 7.8v.1" /></svg>;
export const IconX = (p: P) => <svg {...base(p)}><path d="m6 6 12 12M18 6 6 18" /></svg>;
export const IconStop = (p: P) => <svg {...base(p)}><rect x="6" y="6" width="12" height="12" rx="2" /></svg>;
export const IconRetry = (p: P) => <svg {...base(p)}><path d="M4 12a8 8 0 1 0 2.3-5.6" /><path d="M4 4.5v4h4" /></svg>;
export const IconTrash = (p: P) => <svg {...base(p)}><path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13" /></svg>;
export const IconCopy = (p: P) => <svg {...base(p)}><rect x="8.5" y="8.5" width="11" height="11" rx="2" /><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" /></svg>;
export const IconDownload = (p: P) => <svg {...base(p)}><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5" /><path d="M4.5 15v3.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V15" /></svg>;
export const IconPrint = (p: P) => <svg {...base(p)}><path d="M7 9V3.5h10V9" /><rect x="3.5" y="9" width="17" height="8" rx="2" /><path d="M7 14.5h10v6H7z" /></svg>;
export const IconChevron = (p: P) => <svg {...base(p)}><path d="m9 6 6 6-6 6" /></svg>;
export const IconArrowLeft = (p: P) => <svg {...base(p)}><path d="M19 12H5M11 6l-6 6 6 6" /></svg>;
export const IconMenu = (p: P) => <svg {...base(p)}><path d="M4 7h16M4 12h16M4 17h16" /></svg>;
export const IconSun = (p: P) => <svg {...base(p)}><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" /></svg>;
export const IconMoon = (p: P) => <svg {...base(p)}><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" /></svg>;
export const IconSidebar = (p: P) => <svg {...base(p)}><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M9.5 4.5v15" /></svg>;
export const IconGlobe = (p: P) => <svg {...base(p)}><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.4 2.4 3.5 5.2 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.2-3.5-8.5s1.1-6.1 3.5-8.5z" /></svg>;
export const IconBolt = (p: P) => <svg {...base(p)}><path d="M13 3 5 13.5h6L10 21l8-10.5h-6z" /></svg>;
export const IconEye = (p: P) => <svg {...base(p)}><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="3" /></svg>;
export const IconPresent = (p: P) => <svg {...base(p)}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M12 16v4M8 20.5h8M10 8.5v4l3.5-2z" /></svg>;
export const IconPause = (p: P) => <svg {...base(p)}><path d="M8 5v14M16 5v14" /></svg>;
