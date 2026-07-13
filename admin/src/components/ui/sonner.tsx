"use client"

import { Toaster as Sonner, type ToasterProps } from "sonner"

function Toaster({ ...props }: ToasterProps) {
  return (
    <Sonner
      className="toaster group"
      position="bottom-right"
      closeButton
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:border-border group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:shadow-lg",
          content: "group-[.toast]:min-w-0 group-[.toast]:flex-1",
          title:
            "group-[.toast]:min-w-0 group-[.toast]:pr-5 group-[.toast]:text-sm group-[.toast]:font-medium group-[.toast]:leading-5 group-[.toast]:text-foreground",
          description:
            "group-[.toast]:min-w-0 group-[.toast]:pr-5 group-[.toast]:text-sm group-[.toast]:leading-5 group-[.toast]:text-muted-foreground",
          closeButton:
            "group-[.toast]:border-border group-[.toast]:bg-background group-[.toast]:text-muted-foreground group-[.toast]:hover:bg-muted group-[.toast]:hover:text-foreground",
          actionButton:
            "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton:
            "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
