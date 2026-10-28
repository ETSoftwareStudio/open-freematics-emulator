import { useAtom } from "@effect/atom-react";
import { XIcon } from "lucide-react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { lastErrorAtom } from "~/rpc/hooks";

export function ErrorBanner() {
  const [error, setError] = useAtom(lastErrorAtom);
  if (error === null) return null;
  return (
    <Alert variant="error">
      <AlertTitle>Command failed</AlertTitle>
      <AlertDescription>{error}</AlertDescription>
      <AlertAction>
        <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={() => setError(null)}>
          <XIcon />
        </Button>
      </AlertAction>
    </Alert>
  );
}
