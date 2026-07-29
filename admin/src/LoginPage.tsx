import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";

interface LoginPageProps {
  action: string;
  error?: string;
}

export function LoginPage({ action, error }: LoginPageProps) {
  return (
    <div className="flex min-h-full flex-col bg-background text-foreground">
      <div className="auggy-brand-stripe" aria-hidden="true" />
      <main className="auggy-grid-surface flex flex-1 items-center justify-center px-4 py-10 sm:px-6">
        <div className="w-full max-w-md">
          <div className="mb-7 inline-flex items-center gap-2.5" aria-label="Auggy">
            <span className="font-heading text-3xl font-extrabold tracking-[-0.055em]">Auggy</span>
            <span
              className="size-2.5 rotate-45 rounded-[2px] bg-brand-signal shadow-[0_0_18px_color-mix(in_hsl,var(--brand-signal)_55%,transparent)]"
              aria-hidden="true"
            />
          </div>

          <Card className="border-border/80 bg-card/95 shadow-2xl backdrop-blur-sm">
            <CardHeader className="space-y-2 p-7 pb-5 sm:p-8 sm:pb-5">
              <p className="font-mono text-[11px] font-bold tracking-[0.14em] text-brand-signal uppercase">
                Creator Console
              </p>
              <CardTitle
                role="heading"
                aria-level={1}
                className="font-heading text-3xl font-bold tracking-[-0.04em] sm:text-4xl"
              >
                Welcome back.
              </CardTitle>
              <CardDescription className="pt-1 text-[15px] leading-6">
                Enter <code className="font-mono text-[0.88em] text-foreground">AUGGY_WEB_TOKEN</code>{" "}
                from this agent&apos;s <code className="font-mono text-[0.88em] text-foreground">.env</code>{" "}
                file or deployment secrets.
              </CardDescription>
            </CardHeader>

            <CardContent className="p-7 pt-0 sm:p-8 sm:pt-0">
              {error ? (
                <p
                  className="mb-5 rounded-md border border-brand-signal/45 bg-brand-signal/10 px-3 py-2.5 text-sm text-foreground"
                  role="alert"
                >
                  {error}
                </p>
              ) : null}

              <form method="post" action={action} className="space-y-4">
                <div className="space-y-2">
                  <label htmlFor="password" className="text-sm font-medium">
                    Console password
                  </label>
                  <Input
                    id="password"
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    autoFocus
                    required
                    aria-invalid={error ? true : undefined}
                    className="h-11 bg-background/70"
                  />
                </div>
                <Button type="submit" size="lg" className="h-11 w-full">
                  Open Console
                </Button>
              </form>
            </CardContent>
          </Card>

          <p className="mt-5 text-center text-xs leading-5 text-muted-foreground">
            From your terminal, <code className="font-mono text-foreground">auggy console &lt;agent&gt;</code>{" "}
            opens an automatic one-time sign-in.
          </p>
        </div>
      </main>
    </div>
  );
}
