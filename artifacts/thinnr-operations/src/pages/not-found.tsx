import { AlertCircle } from 'lucide-react';
import { Link } from 'wouter';
import { Card, CardContent } from '@/components/ui/card';

export default function NotFound() {
  return (
    <div className="flex w-full items-center justify-center px-4 py-20 md:py-28">
      <Card className="w-full max-w-md">
        <CardContent className="pt-6">
          <div className="flex items-start gap-4">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-accent text-primary" aria-hidden="true">
              <AlertCircle className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <h1 className="font-serif text-2xl font-bold leading-tight text-navy">Page not found</h1>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                This page isn't part of the operations demo. Check the address, or head back to the overview.
              </p>
            </div>
          </div>
          <Link
            href="/"
            data-testid="link-back-to-overview"
            className="mt-6 inline-flex h-9 items-center rounded-md border border-primary-border bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-xs transition hover:bg-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            Back to overview
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
