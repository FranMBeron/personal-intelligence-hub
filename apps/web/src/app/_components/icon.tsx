import type { SVGProps } from "react";

export type IconName =
  | "agents"
  | "arrow-up-right"
  | "brain"
  | "calendar"
  | "home"
  | "microphone"
  | "paperclip"
  | "refresh"
  | "send"
  | "spark"
  | "system";

const paths: Record<IconName, React.ReactNode> = {
  home: <path d="M3.5 10.5 12 3l8.5 7.5v9a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5zM9 21v-7h6v7" />,
  agents: <><path d="M16 20v-1.5A3.5 3.5 0 0 0 12.5 15h-5A3.5 3.5 0 0 0 4 18.5V20" /><circle cx="10" cy="8" r="3" /><path d="M16 5.2a3 3 0 0 1 0 5.6M18 15.3a3.5 3.5 0 0 1 2 3.2V20" /></>,
  brain: <><path d="M9.5 4.5A3 3 0 0 0 4 6.2 3.5 3.5 0 0 0 3.5 13 3.5 3.5 0 0 0 8 18.2 3 3 0 0 0 12 21V3a3 3 0 0 0-2.5 1.5Z" /><path d="M14.5 4.5A3 3 0 0 1 20 6.2a3.5 3.5 0 0 1 .5 6.8 3.5 3.5 0 0 1-4.5 5.2A3 3 0 0 1 12 21M8 9h4m4 6h-4" /></>,
  system: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M7 9h3m4 0h3M7 15h6" /><circle cx="17" cy="15" r="1" /></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M8 3v4m8-4v4M3 10h18" /></>,
  refresh: <><path d="M20 7v5h-5" /><path d="M18.1 16a7 7 0 1 1 .4-7.5L20 12" /></>,
  paperclip: <path d="m9 12.5 5.4-5.4a3 3 0 0 1 4.2 4.2l-7.1 7.1a5 5 0 0 1-7.1-7.1l7.4-7.4" />,
  microphone: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21m-3 0h6" /></>,
  send: <path d="m21 3-7.5 18-3.2-7.3L3 10.5zM10.3 13.7 21 3" />,
  "arrow-up-right": <path d="M7 17 17 7M8 7h9v9" />,
  spark: <path d="m12 3 1.3 4.2a5 5 0 0 0 3.3 3.3L21 12l-4.4 1.5a5 5 0 0 0-3.3 3.3L12 21l-1.3-4.2a5 5 0 0 0-3.3-3.3L3 12l4.4-1.5a5 5 0 0 0 3.3-3.3z" />,
};

export function Icon({ name, ...props }: { name: IconName } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="24"
      viewBox="0 0 24 24"
      width="24"
      {...props}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
    >
      {paths[name]}
    </svg>
  );
}
