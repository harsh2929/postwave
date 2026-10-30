// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Toaster as SonnerToaster, type ToasterProps } from "sonner";

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <SonnerToaster
      theme="light"
      className="toaster group"
      closeButton
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-card group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:rounded-lg group-[.toaster]:shadow-pw-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton:
            "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton:
            "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
          // Sonner's stock close control is only 20px square. Keep the visual
          // chrome compact while making the actual phone target 44px (32px on
          // larger pointer layouts), with the focus ring on the visible disc.
          closeButton:
            "!h-11 !w-11 !border-transparent !bg-transparent before:pointer-events-none before:absolute before:inset-3 before:z-0 before:rounded-full before:border before:border-border before:bg-card before:content-[''] before:shadow-sm before:transition-colors hover:before:bg-muted focus-visible:!shadow-none focus-visible:before:ring-2 focus-visible:before:ring-ring focus-visible:before:ring-offset-2 [&>svg]:relative [&>svg]:z-10 sm:!h-8 sm:!w-8 sm:before:inset-1.5",
          // Per-type semantic tint: a colored left-accent + icon so success /
          // error / warning / info toasts are instantly distinguishable
          // without the garish full-color fills of richColors.
          success:
            "group-[.toaster]:!border-l-4 group-[.toaster]:!border-l-success [&_[data-icon]]:text-success",
          error:
            "group-[.toaster]:!border-l-4 group-[.toaster]:!border-l-destructive [&_[data-icon]]:text-destructive",
          warning:
            "group-[.toaster]:!border-l-4 group-[.toaster]:!border-l-warning-emphasis [&_[data-icon]]:text-warning-emphasis",
          info: "group-[.toaster]:!border-l-4 group-[.toaster]:!border-l-info [&_[data-icon]]:text-info",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
