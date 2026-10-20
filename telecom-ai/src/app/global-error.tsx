"use client";
import { ErrorDetails } from "@/components/ErrorDetails";
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body>
        <ErrorDetails error={error} reset={reset} />
      </body>
    </html>
  );
}
